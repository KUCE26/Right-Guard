// 실사풍 절차적 텍스처 세트 — 보문역 사거리용 (캔버스/ImageData 로만 그림, 외부 에셋 없음)
//
// 모든 세트는 { map, normalMap?, roughnessMap?, metalnessMap?, size:[mU,mV] } 를 돌려준다.
//  - map 은 sRGB, 나머지 데이터 맵은 NoColorSpace, 반복 가능한 세트는 RepeatWrapping, anisotropy 8, 밉맵 켜짐.
//  - facade 세트는 roughnessMap 과 metalnessMap 이 같은 텍스처(ORM 식: R=AO, G=거칠기, B=금속성)라서
//    한 장으로 두 슬롯에 모두 쓸 수 있다.
//  - 같은 인자로 두 번 부르면 같은 객체(캐시). 처음 부를 때만 생성하고 timings() 로 세트별 ms 를 볼 수 있다.
import * as THREE from 'three';

// ───────────────────────── 기본 수학 ─────────────────────────
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 정수 좌표 해시 → [0,1)
function hash2(x, y, s = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul((s | 0) + 0x9e3779b1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

// sstep 같은 곡선을 미리 표로 만들어 두고 픽셀마다 조회한다. t∈[0,1] → fn(t)
function mkLut(n, fn) {
  const L = new Float32Array(n + 1);
  for (let i = 0; i <= n; i++) L[i] = fn(i / n);
  return L;
}

// ───────────────────────── 노이즈 필드 (모두 가로·세로로 이음매 없이 이어짐) ─────────────────────────
// 격자 cx×cy 의 값 노이즈를 lw×lh 에 더한다 (smoothstep 보간, 격자는 감김)
function addLayer(dst, lw, lh, cx, cy, amp, rnd) {
  const lat = new Float32Array(cx * cy);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd();
  const xi = new Int32Array(lw), xj = new Int32Array(lw), xt = new Float32Array(lw);
  for (let x = 0; x < lw; x++) {
    const u = (x * cx) / lw, i = u | 0, t = u - i;
    xi[x] = i;
    xj[x] = (i + 1) % cx;
    xt[x] = t * t * (3 - 2 * t);
  }
  for (let y = 0; y < lh; y++) {
    const v = (y * cy) / lh, j = v | 0, t = v - j, ty = t * t * (3 - 2 * t);
    const r0 = j * cx, r1 = ((j + 1) % cy) * cx, o = y * lw;
    for (let x = 0; x < lw; x++) {
      const a = lat[r0 + xi[x]], b = lat[r0 + xj[x]], c = lat[r1 + xi[x]], d = lat[r1 + xj[x]];
      const tx = xt[x], top = a + (b - a) * tx;
      dst[o + x] += amp * (top + (c + (d - c) * tx - top) * ty);
    }
  }
}

// 작은 필드(sw×sh)를 부드럽게 w×h 로 키운다 (감김 보간)
function upsample(src, sw, sh, w, h, into) {
  const out = into || new Float32Array(w * h);
  const xi = new Int32Array(w), xj = new Int32Array(w), xt = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const u = (x * sw) / w, i = u | 0, t = u - i;
    xi[x] = i;
    xj[x] = (i + 1) % sw;
    xt[x] = t * t * (3 - 2 * t);
  }
  for (let y = 0; y < h; y++) {
    const v = (y * sh) / h, j = v | 0, t = v - j, ty = t * t * (3 - 2 * t);
    const r0 = j * sw, r1 = ((j + 1) % sh) * sw, o = y * w;
    for (let x = 0; x < w; x++) {
      const a = src[r0 + xi[x]], b = src[r0 + xj[x]], c = src[r1 + xi[x]], d = src[r1 + xj[x]];
      const tx = xt[x], top = a + (b - a) * tx;
      out[o + x] = top + (c + (d - c) * tx - top) * ty;
    }
  }
  return out;
}

// fbm: cell = 첫 옥타브의 특징 크기(px), 옥타브마다 절반. ds = 내부 계산 해상도 축소비(속도). 값은 대략 0.15~0.85
function fbm(w, h, { cell = 64, oct = 4, gain = 0.5, seed = 1, ds = 4 } = {}) {
  const lw = Math.max(2, Math.round(w / ds)), lh = Math.max(2, Math.round(h / ds));
  const lo = new Float32Array(lw * lh), rnd = rng(seed);
  let amp = 1, tot = 0, c = cell;
  for (let o = 0; o < oct; o++) {
    const cx = Math.max(2, Math.round(w / c)), cy = Math.max(2, Math.round(h / c));
    if (cx > lw || cy > lh) break;
    addLayer(lo, lw, lh, cx, cy, amp, rnd);
    tot += amp;
    amp *= gain;
    c *= 0.5;
  }
  const inv = 1 / tot;
  for (let i = 0; i < lo.length; i++) lo[i] *= inv;
  return ds > 1 ? upsample(lo, lw, lh, w, h, tmpF(w * h)) : lo;
}

// 흰 잡음(−1..1) — 행 순서 LCG
function whiteNoise(w, h, seed) {
  const out = new Float32Array(w * h);
  let s = (seed * 2654435761) | 0;
  for (let i = 0; i < out.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    out[i] = (s >>> 8) * (2 / 16777216) - 1;
  }
  return out;
}

// [1 2 1]/4 가로·세로 흐림(감김). passes 번 반복
function blur(a, w, h, passes = 1) {
  const t = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      // 가로: a → t (행 순서로만 접근해 캐시 친화)
      const o = y * w;
      t[o] = (a[o + w - 1] + 2 * a[o] + a[o + 1]) * 0.25;
      for (let x = 1; x < w - 1; x++) t[o + x] = (a[o + x - 1] + 2 * a[o + x] + a[o + x + 1]) * 0.25;
      t[o + w - 1] = (a[o + w - 2] + 2 * a[o + w - 1] + a[o]) * 0.25;
    }
    for (let y = 0; y < h; y++) {
      // 세로: t → a (세 행을 함께 훑는다)
      const r0 = ((y + h - 1) % h) * w, r1 = y * w, r2 = ((y + 1) % h) * w;
      for (let x = 0; x < w; x++) a[r1 + x] = (t[r0 + x] + 2 * t[r1 + x] + t[r2 + x]) * 0.25;
    }
  }
  return a;
}

// 낟알 질감: 흐린 흰 잡음을 표준편차 ≈0.5 로 정규화 (blurPasses 1 → 고운 알갱이, 2 → 굵은 알갱이)
function grain(w, h, seed, blurPasses = 1) {
  const g = blur(whiteNoise(w, h, seed), w, h, blurPasses);
  const k = blurPasses === 1 ? 2.3 : blurPasses === 2 ? 6.2 : 14;
  for (let i = 0; i < g.length; i++) g[i] *= k;
  return g;
}

// 감기는 1차원 노이즈 (선 흔들림용). cells 는 정수, 값 0..1
function noise1(cells, seed) {
  const rnd = rng(seed), v = new Float32Array(cells);
  for (let i = 0; i < cells; i++) v[i] = rnd();
  return (t) => {
    // t: 0..1 (한 주기)
    const u = (((t % 1) + 1) % 1) * cells, i = u | 0, f = u - i, s = f * f * (3 - 2 * f);
    return mix(v[i], v[(i + 1) % cells], s);
  };
}

// 원형 스탬프 (감김). val 을 f=1−d²/r² 가중으로 더함
function stamp(buf, w, h, x, y, r, val) {
  const ri = Math.ceil(r), r2 = r * r;
  for (let dy = -ri; dy <= ri; dy++) {
    const yy = (((y + dy) % h) + h) % h;
    for (let dx = -ri; dx <= ri; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      buf[yy * w + ((((x + dx) % w) + w) % w)] += val * (1 - d2 / r2);
    }
  }
}

// 알갱이 하나를 두 버퍼에 한 번에 (가장자리가 또렷한 원판)
function stamp2(b1, v1, b2, v2, w, h, x, y, r) {
  const ri = Math.ceil(r), r2 = r * r;
  for (let dy = -ri; dy <= ri; dy++) {
    const row = ((((y + dy) % h) + h) % h) * w;
    for (let dx = -ri; dx <= ri; dx++) {
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const f = 1 - (0.4 * d2) / r2, i = row + ((((x + dx) % w) + w) % w);
      b1[i] += v1 * f;
      b2[i] += v2 * f;
    }
  }
}

// 감기는 균열 (무작위 걸음). mask 에 max 로 칠함
function crack(mask, w, h, rnd, x, y, ang, len, wid, branch, depth = 0) {
  const step = 1;
  let px = x, py = y, a = ang, dev = 0;
  const r = Math.max(0.5, wid * 0.5);
  for (let s = 0; s < len; s += step) {
    // 처음 방향에서 크게 벗어나지 않는 완만한 흔들림 + 드문 꺾임 (고리·철사처럼 꼬이지 않게)
    dev = dev * 0.97 + (rnd() - 0.5) * 0.12 + (rnd() < 0.012 ? (rnd() - 0.5) * 0.8 : 0);
    dev = dev < -0.7 ? -0.7 : dev > 0.7 ? 0.7 : dev;
    a = ang + dev;
    px += Math.cos(a) * step;
    py += Math.sin(a) * step;
    const fade = depth === 0 ? 1 : 1 - s / len;
    const rr = r * (0.55 + 0.45 * fade);
    const ri = Math.ceil(rr);
    for (let dy = -ri; dy <= ri; dy++) {
      for (let dx = -ri; dx <= ri; dx++) {
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > rr + 0.4) continue;
        const xx = ((((px + dx) | 0) % w) + w) % w, yy = ((((py + dy) | 0) % h) + h) % h;
        const v = clamp01(1.2 - d / (rr + 0.4));
        if (v > mask[yy * w + xx]) mask[yy * w + xx] = v;
      }
    }
    if (depth < 2 && rnd() < branch) {
      crack(mask, w, h, rnd, px, py, a + (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.9), len * (0.25 + rnd() * 0.3), wid * 0.7, branch * 0.6, depth + 1);
    }
  }
}

// 보로노이 균열망: F2−F1 (px 단위), 감김. cx×cy 셀
function voronoiEdge(w, h, cx, cy, seed, jitter = 0.9) {
  const px = new Float32Array(cx * cy), py = new Float32Array(cx * cy);
  for (let j = 0; j < cy; j++) {
    for (let i = 0; i < cx; i++) {
      px[j * cx + i] = i + 0.5 + (hash2(i, j, seed) - 0.5) * jitter;
      py[j * cx + i] = j + 0.5 + (hash2(i, j, seed + 77) - 0.5) * jitter;
    }
  }
  const out = tmpF(w * h), sx = cx / w, sy = cy / h, pxs = w / cx, pys = h / cy;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) * sy, cj = v | 0;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) * sx, ci = u | 0;
      let f1 = 1e9, f2 = 1e9;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = (cj + dj + cy) % cy, offY = cj + dj < 0 ? -cy : cj + dj >= cy ? cy : 0;
        for (let di = -1; di <= 1; di++) {
          const ii = (ci + di + cx) % cx, offX = ci + di < 0 ? -cx : ci + di >= cx ? cx : 0;
          const qx = px[jj * cx + ii] + offX - u, qy = py[jj * cx + ii] + offY - v;
          const d = qx * qx + qy * qy;
          if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
      }
      out[y * w + x] = (Math.sqrt(f2) - Math.sqrt(f1)) * ((pxs + pys) * 0.5);
    }
  }
  return out;
}

// ───────────────────────── 높이 → 노멀 (Sobel, 감김) ─────────────────────────
// strength: 높이 1 변화/px 가 얼마나 기울어 보이게 할지. OpenGL 규약(+Y=텍스처 위쪽)
function normalFromHeight(hf, w, h, strength, wrap = true) {
  // Sobel 을 세로 합 sv=[1 2 1], 세로 차분 dv 두 줄로 나눠 한 줄씩 훑는다 (읽기 3번/픽셀). 32비트 한 번에 기록.
  const out = new Uint8ClampedArray(w * h * 4), o32 = new Uint32Array(out.buffer);
  const k = strength * 0.125, sv = new Float32Array(w + 2), dv = new Float32Array(w + 2);
  for (let y = 0; y < h; y++) {
    const ym = wrap ? (y + h - 1) % h : y > 0 ? y - 1 : 0, yp = wrap ? (y + 1) % h : y < h - 1 ? y + 1 : h - 1;
    const r0 = ym * w, r1 = y * w, r2 = yp * w;
    for (let x = 0; x < w; x++) {
      const t = hf[r0 + x], m = hf[r1 + x], b = hf[r2 + x];
      sv[x + 1] = t + 2 * m + b;
      dv[x + 1] = b - t;
    }
    if (wrap) { sv[0] = sv[w]; dv[0] = dv[w]; sv[w + 1] = sv[1]; dv[w + 1] = dv[1]; }
    else { sv[0] = sv[1]; dv[0] = dv[1]; sv[w + 1] = sv[w]; dv[w + 1] = dv[w]; }
    for (let x = 1; x <= w; x++) {
      const dx = (sv[x + 1] - sv[x - 1]) * k, dy = (dv[x - 1] + 2 * dv[x] + dv[x + 1]) * k; // 캔버스 y 는 아래로 증가
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const r = ((-dx * inv * 0.5 + 0.5) * 255 + 0.5) | 0, g = ((dy * inv * 0.5 + 0.5) * 255 + 0.5) | 0, bl = ((inv * 0.5 + 0.5) * 255 + 0.5) | 0;
      o32[r1 + x - 1] = r | (g << 8) | (bl << 16) | 0xff000000;
    }
  }
  return out;
}

// ───────────────────────── 텍스처 만들기 ─────────────────────────
function makeTexture(rgba, w, h, { srgb = false, repeat = true } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').putImageData(new ImageData(rgba, w, h), 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

// 회색 한 장(0..255 Uint8ClampedArray) → RGBA
function grayRGBA(g, n = g.length) {
  const o = new Uint8ClampedArray(n * 4), o32 = new Uint32Array(o.buffer);
  for (let i = 0; i < n; i++) {
    const v = g[i];
    o32[i] = v | (v << 8) | (v << 16) | 0xff000000;
  }
  return o;
}

// ───────────────────────── 캐시·시간 측정 ─────────────────────────
const cache = new Map();
const times = {};

// 임시 버퍼 은행: 세트 하나를 만드는 동안만 쓰는 큰 배열(높이·마스크·잡음)을 세트 사이에 재사용해 GC 를 줄인다.
// 반환 배열은 요청한 n 보다 길 수 있으니 반드시 n 까지만 쓴다. 세트가 끝나면 2 초 뒤(유휴 시) 메모리를 돌려준다.
const ARENA_F = [], ARENA_U = [];
let arenaFi = 0, arenaUi = 0, relTimer = 0;
function tmpF(n, zero = false) {
  let a = ARENA_F[arenaFi];
  if (!a || a.length < n) a = ARENA_F[arenaFi] = new Float32Array(n);
  arenaFi++;
  if (zero) a.fill(0, 0, n);
  return a;
}
function tmpU(n, v = 0) {
  let a = ARENA_U[arenaUi];
  if (!a || a.length < n) a = ARENA_U[arenaUi] = new Uint8ClampedArray(n);
  arenaUi++;
  a.fill(v, 0, n);
  return a;
}
/** 임시 버퍼 은행을 비운다 (generateAll 이 끝나면 자동 호출, 개별 세트는 유휴 2 초 뒤 자동) */
export function releaseScratch() {
  ARENA_F.length = 0;
  ARENA_U.length = 0;
}
function memo(key, fn) {
  if (cache.has(key)) return cache.get(key);
  const t0 = nowMs();
  arenaFi = arenaUi = 0;
  const v = fn();
  times[key] = Math.round((nowMs() - t0) * 10) / 10;
  cache.set(key, v);
  if (typeof setTimeout === 'function') {
    if (relTimer) clearTimeout(relTimer);
    relTimer = setTimeout(releaseScratch, 2000);
    if (relTimer && relTimer.unref) relTimer.unref();
  }
  return v;
}

/** 지금까지 만든 세트별 생성 시간(ms)과 합계 */
export function timings() {
  const t = { ...times };
  t.total = Math.round(Object.values(times).reduce((a, b) => a + b, 0) * 10) / 10;
  return t;
}

// ───────────────────────── 아스팔트 (4 m × 4 m) ─────────────────────────
// 감기는 이음선(타르 실링) 한 줄. horizontal 이면 y≈pos 로 가로지른다.
function seamLine(mask, N, horizontal, pos, halfW, wob, seed, soft = 1.2, gain = 1, gaps = true) {
  const nz = noise1(9, seed), nz2 = noise1(23, seed + 5), nz3 = noise1(5, seed + 9);
  for (let t = 0; t < N; t++) {
    const off = (nz(t / N) - 0.5) * wob;
    const hw = halfW * (0.7 + 0.7 * nz2(t / N));
    const vis = (gaps ? 0.35 + 0.65 * sstep(0.08, 0.4, nz3((t / N + 0.37) % 1)) : 1) * gain;
    const c = pos + off, ci = Math.round(c), fr = c - ci, r = Math.ceil(hw + soft + 1);
    for (let d = -r; d <= r; d++) {
      const v = (1 - sstep(hw - soft, hw + soft, Math.abs(d - fr))) * vis;
      if (v <= 0) continue;
      const q = (((ci + d) % N) + N) % N, idx = horizontal ? q * N + t : t * N + q;
      if (v > mask[idx]) mask[idx] = v;
    }
  }
}

/** 도로 아스팔트: 4 m × 4 m, 1024². 짙은 청회색, 골재 알갱이, 타르 이음선/패치, 실금, 기름 얼룩. */
export function asphaltSet({ seed = 1 } = {}) {
  return memo(`asphalt(${seed})`, () => {
    const N = 1024, n2 = N * N, rnd = rng(seed * 7919 + 11);
    const gF = grainField(N, N, 'f', seed * 31 + 1);
    const gM = grainField(N, N, 'm', seed * 31 + 2);
    const b1 = fbm(N, N, { cell: 512, oct: 4, gain: 0.55, seed: seed * 31 + 3, ds: 8 });
    const b2 = fbm(N, N, { cell: 96, oct: 3, gain: 0.5, seed: seed * 31 + 4, ds: 4 });
    const lum = tmpF(n2, true), hgt = tmpF(n2, true);
    // 골재 알갱이: 밝은 석영 / 어두운 바인더 / 중간
    for (let i = 0; i < 24000; i++) {
      const x = (rnd() * N) | 0, y = (rnd() * N) | 0, r = 0.8 + 2.2 * rnd() * rnd(), t = rnd();
      const v = t < 0.3 ? 0.6 + 0.4 * rnd() : t < 0.62 ? -(0.5 + 0.5 * rnd()) : (rnd() - 0.5) * 0.7;
      stamp2(lum, v, hgt, 0.45 + 0.55 * rnd(), N, N, x, y, r);
    }
    const tar = tmpF(n2, true), crk = tmpF(n2, true), oil = tmpF(n2, true), pat = tmpF(n2, true);
    seamLine(tar, N, false, 0.74 * N, 2.4, 22, seed * 5 + 2, 1.2, 0.8); // 포장 이음선(세로)
    seamLine(tar, N, true, 0.31 * N, 1.8, 30, seed * 5 + 1, 1.2, 0.3); // 아주 옅은 가로 이음
    // 직사각 보수 패치 (절단선을 따라 타르)
    {
      const x0 = (0.08 * N) | 0, x1 = (0.42 * N) | 0, y0 = (0.56 * N) | 0, y1 = (0.78 * N) | 0;
      for (let y = y0 - 8; y < y1 + 8; y++) {
        for (let x = x0 - 8; x < x1 + 8; x++) {
          const i = y * N + x, e = (b2[i] - 0.5) * 12;
          const d = Math.min(x - x0 + e, x1 - x - e, y - y0 + e, y1 - y - e);
          if (d > 0) pat[i] = 1;
          const l = (1 - sstep(0.7, 2.6, Math.abs(d))) * 0.5 * (0.35 + 0.65 * sstep(0.38, 0.56, b2[i]));
          if (l > tar[i]) tar[i] = l;
        }
      }
    }
    // 기름 얼룩
    for (let k = 0; k < 4; k++) {
      const cx = rnd() * N, cy = rnd() * N, rad = 24 + 36 * rnd(), ratio = 1 + 1.1 * rnd(), ang = rnd() * Math.PI, str = 0.2 + 0.3 * rnd();
      const ca = Math.cos(ang), sa = Math.sin(ang), R = Math.ceil(rad * ratio * 1.7);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const u = (dx * ca + dy * sa) / rad, v = (-dx * sa + dy * ca) / (rad * ratio);
          const x = (((cx + dx) | 0) % N + N) % N, y = (((cy + dy) | 0) % N + N) % N, i = y * N + x;
          const d = Math.sqrt(u * u + v * v) + (b2[i] - 0.5) * 1.1 + gM[i] * 0.05;
          const s = (1 - sstep(0.2, 1.0, d)) * str;
          if (s > oil[i]) oil[i] = s;
        }
      }
    }
    // 실금
    for (let k = 0; k < 7; k++) crack(crk, N, N, rnd, rnd() * N, rnd() * N, rnd() * Math.PI * 2, 120 + rnd() * 320, 0.9 + rnd() * 0.6, 0.006);
    for (let k = 0; k < 9; k++) crack(crk, N, N, rnd, rnd() * N, rnd() * N, rnd() * Math.PI * 2, 30 + rnd() * 80, 0.8, 0.01);

    const col = new Uint8ClampedArray(n2 * 4), hm = tmpF(n2), rg = tmpU(n2);
    for (let i = 0; i < n2; i++) {
      const l = lum[i] > 1.2 ? 1.2 : lum[i] < -1.2 ? -1.2 : lum[i], f = gF[i], m = gM[i];
      const t = tar[i], o = oil[i], c = crk[i], p = pat[i];
      let v = 1 + 0.1 * f + 0.05 * m + 0.34 * l + (b1[i] - 0.5) * 0.34 + (b2[i] - 0.5) * 0.2;
      v *= (1 - 0.42 * t) * (1 - 0.34 * o) * (1 - 0.035 * p) * (1 - 0.48 * c);
      const j = i * 4;
      col[j] = 104 * v * (1 + 0.03 * l) * (1 + 0.04 * t);
      col[j + 1] = 106 * v;
      col[j + 2] = 112 * v * (1 - 0.025 * l) * (1 + 0.05 * o);
      col[j + 3] = 255;
      hm[i] = hgt[i] + 0.3 * f + 0.12 * m - 1.8 * c - 0.25 * t;
      let r = 0.93 + 0.04 * f - 0.1 * (l > 0 ? l : 0) - 0.4 * o - 0.22 * t + 0.04 * c - 0.03 * p;
      rg[i] = (r < 0.4 ? 0.4 : r > 1 ? 1 : r) * 255;
    }
    const nrm = normalFromHeight(hm, N, N, 0.7);
    return {
      map: makeTexture(col, N, N, { srgb: true }),
      normalMap: makeTexture(nrm, N, N),
      roughnessMap: makeTexture(grayRGBA(rg, n2), N, N),
      size: [4, 4],
    };
  });
}

// ───────────────────────── 노면표시 마모 마스크 (2 m) ─────────────────────────
/** 닳은 흰/노란 도색용 마스크, 2 m, 512². alphaMap(1=도료, 0=벗겨짐) + 회색 오염 map + 두께 normal + roughness.
 *  흰색 material.color 에 곱해 쓰고, transparent:true 또는 alphaTest≈0.35 로 쓴다. */
export function paintWearSet() {
  return memo('paintWear', () => {
    const N = 512, n2 = N * N;
    const gF = grainField(N, N, 'f', 901), gM = grainField(N, N, 'm', 902);
    const wz = fbm(N, N, { cell: 256, oct: 3, gain: 0.5, seed: 903, ds: 4 });
    const wz2 = fbm(N, N, { cell: 128, oct: 3, gain: 0.5, seed: 904, ds: 4 });
    const chipN = fbm(N, N, { cell: 40, oct: 4, gain: 0.55, seed: 905, ds: 2 });
    const vA = voronoiEdge(N, N, 36, 36, 906, 0.85);
    const al = tmpU(n2), mp = tmpU(n2), rg = tmpU(n2), hm = tmpF(n2);
    for (let i = 0; i < n2; i++) {
      const zone = sstep(0.5, 0.6, wz[i]);
      const lineA = (1 - sstep(0.35, 1.3, vA[i])) * zone, lineB = 0;
      let a = 1 - 0.42 * lineA;
      const T = 0.27 + 0.08 * wz[i];
      a *= sstep(T - 0.012, T + 0.015, chipN[i] + 0.03 * gF[i]);
      if (gF[i] < -1.55) a *= 0.4;
      if (a < 0) a = 0;
      al[i] = a * 255;
      const g = 0.95 + 0.05 * (wz2[i] - 0.5) * 2 + 0.03 * gM[i] - 0.2 * lineA;
      mp[i] = (g < 0.55 ? 0.55 : g > 1 ? 1 : g) * 255;
      hm[i] = a * (1 + 0.25 * gF[i] + 0.12 * gM[i]);
      const r = 0.64 + 0.07 * gF[i] + 0.3 * (1 - a);
      rg[i] = (r > 1 ? 1 : r) * 255;
    }
    return {
      alphaMap: makeTexture(grayRGBA(al, n2), N, N),
      map: makeTexture(grayRGBA(mp, n2), N, N, { srgb: true }),
      normalMap: makeTexture(normalFromHeight(hm, N, N, 1.1), N, N),
      roughnessMap: makeTexture(grayRGBA(rg, n2), N, N),
      size: [2, 2],
    };
  });
}

// ───────────────────────── 보도블록 (2 m) ─────────────────────────
// 20×10 cm 직사각 블록을 90° 헤링본으로 깐다. 10 cm 칸 20×20, 셀 (x−y) mod 4 로 블록 방향이 정해진다.
const PAVER_PAL = [
  [0.3, [152, 152, 151]], [0.32, [178, 178, 175]], [0.24, [184, 175, 158]], [0.08, [166, 160, 152]], [0.03, [170, 120, 106]], [0.03, [124, 124, 127]],
];
function pickPal(pal, r) {
  let a = 0;
  for (const [w, c] of pal) { a += w; if (r < a) return c; }
  return pal[pal.length - 1][1];
}

/** 서울식 인터로킹 보도블록: 2 m × 2 m, 1024². 회색·연회색·베이지 + 가끔 붉은 블록, 오목한 줄눈, 얼룩. */
export function sidewalkSet({ seed = 1 } = {}) {
  return memo(`sidewalk(${seed})`, () => {
    const N = 1024, n2 = N * N, U = 20, PX = N / U;
    const cB = new Int32Array(U * U), cOX = new Float32Array(U * U), cOY = new Float32Array(U * U), cBW = new Float32Array(U * U), cBH = new Float32Array(U * U);
    for (let cy = 0; cy < U; cy++) {
      for (let cx = 0; cx < U; cx++) {
        const d = (((cx - cy) % 4) + 4) % 4, c = cy * U + cx;
        let ox = cx, oy = cy, bw = 2, bh = 1, fx = 0, fy = 0;
        if (d === 1) { ox = cx - 1; fx = 1; } else if (d === 3) { bw = 1; bh = 2; } else if (d === 2) { bw = 1; bh = 2; oy = cy - 1; fy = 1; }
        cB[c] = ((oy + U) % U) * U + ((ox + U) % U);
        cOX[c] = fx; cOY[c] = fy; cBW[c] = bw; cBH[c] = bh;
      }
    }
    const bR = new Float32Array(U * U), bG = new Float32Array(U * U), bB = new Float32Array(U * U), bTone = new Float32Array(U * U);
    const bHo = new Float32Array(U * U), bKx = new Float32Array(U * U), bKy = new Float32Array(U * U);
    for (let b = 0; b < U * U; b++) {
      const bx = b % U, by = (b / U) | 0, col = pickPal(PAVER_PAL, hash2(bx, by, seed));
      const t = 0.95 + 0.1 * hash2(bx, by, seed + 1);
      bR[b] = col[0]; bG[b] = col[1]; bB[b] = col[2]; bTone[b] = t;
      bHo[b] = (hash2(bx, by, seed + 2) - 0.5) * 1.4;
      bKx[b] = (hash2(bx, by, seed + 3) - 0.5) * 0.5;
      bKy[b] = (hash2(bx, by, seed + 4) - 0.5) * 0.5;
    }
    const cxA = new Int32Array(N), fxA = new Float32Array(N);
    for (let x = 0; x < N; x++) { const u = x / PX; cxA[x] = u | 0; fxA[x] = u - (u | 0); }
    const gF = grainField(N, N, 'f', seed * 17 + 1), gM = grainField(N, N, 'm', seed * 17 + 2);
    const st = fbm(N, N, { cell: 300, oct: 4, gain: 0.55, seed: seed * 17 + 3, ds: 8 });
    const st2 = fbm(N, N, { cell: 64, oct: 3, gain: 0.5, seed: seed * 17 + 4, ds: 4 });
    const spot = tmpF(n2, true), rnd = rng(seed * 101 + 5);
    for (let k = 0; k < 16; k++) stamp(spot, N, N, (rnd() * N) | 0, (rnd() * N) | 0, 2.5 + rnd() * 3.5, 1.6);
    for (let k = 0; k < 5; k++) stamp(spot, N, N, (rnd() * N) | 0, (rnd() * N) | 0, 14 + rnd() * 18, 0.5);
    const col = new Uint8ClampedArray(n2 * 4), hm = tmpF(n2), rg = tmpU(n2);
    const EK = 16, EM = 12 * EK; // 가장자리 거리(px) 조회표
    const lJ = mkLut(EM, (t) => 1 - sstep(1.0, 2.3, t * 12)), lB = mkLut(EM, (t) => sstep(1.5, 4.8, t * 12));
    const lD = mkLut(EM, (t) => 1 - 0.14 * (1 - sstep(1.5, 11, t * 12))), lS = mkLut(255, (t) => 0.84 + 0.16 * sstep(0.3, 0.62, t));
    for (let y = 0; y < N; y++) {
      const uy = y / PX, cy = uy | 0, fy = uy - cy, rb = cy * U;
      for (let x = 0; x < N; x++) {
        const i = y * N + x, c = rb + cxA[x], b = cB[c];
        const lx = cOX[c] + fxA[x], ly = cOY[c] + fy, bw = cBW[c], bh = cBH[c];
        let e = lx < bw - lx ? lx : bw - lx;
        const e2 = ly < bh - ly ? ly : bh - ly;
        if (e2 < e) e = e2;
        e *= PX;
        const ei = ((e > 12 ? 12 : e) * EK) | 0, jm = lJ[ei], bev = lB[ei], dirt = lD[ei];
        const g = 0.07 * gF[i] + 0.045 * gM[i];
        const sp = spot[i] > 1 ? 1 : spot[i];
        const v = bTone[b] * (1 + g) * dirt * lS[(st[i] * 255 + 0.5) | 0] * (1 - 0.4 * sp) * (0.97 + 0.06 * st2[i]);
        const j = i * 4, jc = 128 * (1 + g * 1.2) * (0.85 + 0.3 * st2[i]);
        col[j] = bR[b] * v * (1 - jm) + jc * jm;
        col[j + 1] = bG[b] * v * (1 - jm) + jc * 0.95 * jm;
        col[j + 2] = bB[b] * v * (1 - jm) + jc * 0.85 * jm;
        col[j + 3] = 255;
        hm[i] = -3.2 * (1 - bev) + bHo[b] + bKx[b] * (lx - bw * 0.5) + bKy[b] * (ly - bh * 0.5) + 0.22 * gF[i] + 0.12 * gM[i] - 0.5 * sp;
        const r = 0.88 + 0.05 * gF[i] - 0.4 * sp + 0.1 * jm;
        rg[i] = (r < 0.4 ? 0.4 : r > 1 ? 1 : r) * 255;
      }
    }
    return {
      map: makeTexture(col, N, N, { srgb: true }),
      normalMap: makeTexture(normalFromHeight(hm, N, N, 0.51), N, N),
      roughnessMap: makeTexture(grayRGBA(rg, n2), N, N),
      size: [2, 2],
    };
  });
}

// ───────────────────────── 점자블록 (0.6 m) ─────────────────────────
/** 노란 점자블록: 30 cm 블록 2×2 = 0.6 m, 512². kind 'dots'(점형·정지) | 'bars'(선형·진행). 막대는 텍스처 세로(V) 방향. */
export function tactileSet(kind = 'dots') {
  return memo(`tactile:${kind}`, () => {
    const N = 512, n2 = N * N, B = N / 2, bars = kind === 'bars';
    const gF = grainField(N, N, 'f', bars ? 602 : 601), gM = grainField(N, N, 'm', bars ? 604 : 603);
    const wear = fbm(N, N, { cell: 128, oct: 3, gain: 0.5, seed: bars ? 606 : 605, ds: 2 });
    const col = new Uint8ClampedArray(n2 * 4), hm = tmpF(n2), rg = tmpU(n2);
    const P = B / 6, BP = B / 4, EK = 16, EM = 12 * EK;
    const lTop = mkLut(EM, (t) => 1 - sstep(bars ? 7.3 : 5.0, bars ? 11.5 : 10.7, t * 12)); // 돌기 윗면(중심까지 거리 px)
    const lJ = mkLut(EM, (t) => 1 - sstep(1.2, 3.2, t * 12)), lB = mkLut(EM, (t) => sstep(1.5, 6.5, t * 12));
    const lWorn = mkLut(255, (t) => 0.3 + 0.7 * sstep(0.4, 0.62, t)), lDirt = mkLut(255, (t) => 0.08 * sstep(0.35, 0.65, 1 - t));
    const toneB = [0, 1, 2, 3].map((q) => 0.96 + 0.08 * hash2(q, 3, 77));
    const dxT = new Float32Array(N), dyT = new Float32Array(N); // 열·행마다 돌기 중심까지의 가로·세로 오프셋
    for (let k = 0; k < N; k++) {
      const q = k % B;
      dxT[k] = q - (Math.floor(q / (bars ? BP : P)) + 0.5) * (bars ? BP : P);
      dyT[k] = bars ? (q < 15 ? 15 - q : q > B - 16 ? q - (B - 16) : 0) : q - (Math.floor(q / P) + 0.5) * P;
    }
    for (let y = 0; y < N; y++) {
      const by = y % B, byI = (y / B) | 0, ey = by < B - 1 - by ? by : B - 1 - by, dy = dyT[y];
      for (let x = 0; x < N; x++) {
        const i = y * N + x, bx = x % B;
        let e = bx < B - 1 - bx ? bx : B - 1 - bx;
        if (ey < e) e = ey;
        const dx = dxT[x], d = Math.sqrt(dx * dx + dy * dy), top = lTop[((d > 12 ? 12 : d) * EK) | 0];
        const ei = ((e > 12 ? 12 : e) * EK) | 0, jm = lJ[ei], bev = lB[ei];
        const wi = (wear[i] * 255 + 0.5) | 0, worn = lWorn[wi] * top * 0.6;
        const g = 0.06 * gF[i] + 0.035 * gM[i];
        const v = toneB[((x / B) | 0) + 2 * byI] * (1 + g) * (1 - (1 - top) * lDirt[wi]);
        const j = i * 4, jc = 128 * (1 + g);
        const R = (232 * (1 - worn) + 238 * worn) * v, G = (194 * (1 - worn) + 216 * worn) * v, Bc = (58 * (1 - worn) + 132 * worn) * v;
        col[j] = R * (1 - jm) + jc * jm;
        col[j + 1] = G * (1 - jm) + jc * 0.97 * jm;
        col[j + 2] = Bc * (1 - jm) + jc * 0.88 * jm;
        col[j + 3] = 255;
        hm[i] = -2.2 * (1 - bev) + 5 * top + 0.18 * gF[i] + 0.1 * gM[i];
        const r = (0.78 - 0.22 * top * (0.4 + worn) + 0.04 * gF[i]) + 0.15 * jm;
        rg[i] = (r < 0.35 ? 0.35 : r > 1 ? 1 : r) * 255;
      }
    }
    return {
      map: makeTexture(col, N, N, { srgb: true }),
      normalMap: makeTexture(normalFromHeight(hm, N, N, 0.85), N, N),
      roughnessMap: makeTexture(grayRGBA(rg, n2), N, N),
      size: [0.6, 0.6],
    };
  });
}

// ───────────────────────── 화강암 경계석 (1 m) ─────────────────────────
/** 화강암 경계석: 1 m × 1 m, 512². 연회색 반점. U 방향이 연석 길이, u=0 에 가는 줄눈(1 m 마다). */
export function curbSet() {
  return memo('curb', () => {
    const N = 512, n2 = N * N, rnd = rng(4242);
    const gF = grainField(N, N, 'f', 801), gM = grainField(N, N, 'm', 802);
    const b1 = fbm(N, N, { cell: 256, oct: 4, gain: 0.55, seed: 803, ds: 4 });
    const b2 = fbm(N, N, { cell: 48, oct: 3, gain: 0.5, seed: 804, ds: 2 });
    const lum = tmpF(n2, true), pink = tmpF(n2, true), hgt = tmpF(n2, true);
    for (let i = 0; i < 15000; i++) {
      const x = (rnd() * N) | 0, y = (rnd() * N) | 0, r = 0.7 + 1.5 * rnd() * rnd(), t = rnd();
      if (t < 0.4) stamp(lum, N, N, x, y, r, -(0.55 + 0.45 * rnd()));
      else if (t < 0.7) stamp(lum, N, N, x, y, r, 0.3 + 0.5 * rnd());
      else if (t < 0.85) stamp(pink, N, N, x, y, r * 1.3, 0.6 + 0.4 * rnd());
      stamp(hgt, N, N, x, y, r, 0.3 + 0.7 * rnd());
    }
    const col = new Uint8ClampedArray(n2 * 4), hm = tmpF(n2), rg = tmpU(n2);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x, ex = x < N - 1 - x ? x : N - 1 - x, jm = 1 - sstep(0.5, 3.2, ex);
        const l = lum[i] > 1.1 ? 1.1 : lum[i] < -1.1 ? -1.1 : lum[i], p = pink[i] > 1 ? 1 : pink[i];
        const v = (1 + 0.07 * gF[i] + 0.05 * gM[i] + 0.5 * l + (b1[i] - 0.5) * 0.24 + (b2[i] - 0.5) * 0.12) * (1 - 0.55 * jm);
        const j = i * 4;
        col[j] = 176 * v * (1 + 0.09 * p);
        col[j + 1] = 176 * v * (1 - 0.03 * p);
        col[j + 2] = 173 * v * (1 - 0.07 * p);
        col[j + 3] = 255;
        hm[i] = -2.6 * jm + 0.4 * hgt[i] + 0.2 * gF[i] + 0.1 * gM[i];
        const r = 0.8 + 0.05 * gF[i] - 0.28 * (l > 0 ? l : 0) + 0.12 * jm;
        rg[i] = (r < 0.4 ? 0.4 : r > 1 ? 1 : r) * 255;
      }
    }
    return {
      map: makeTexture(col, N, N, { srgb: true }),
      normalMap: makeTexture(normalFromHeight(hm, N, N, 0.51), N, N),
      roughnessMap: makeTexture(grayRGBA(rg, n2), N, N),
      size: [1, 1],
    };
  });
}

// ───────────────────────── 파사드 공통 도구 ─────────────────────────
// 한 층(3.2 m) × bays(≈3 m) 한 장. 1 m = 128 px. 평면 배열(Surf)에 사각형을 채우듯 그리고 마지막에 한 번에 포장한다.
const PPM = 128;
const px = (m) => Math.round(m * PPM);

// 공유 알갱이 은행: 1024² 두 장을 한 번만 만들고 세트마다 오프셋을 달리해 복사해 쓴다 (세트 생성 시간 절약)
let BANK = null;
const BS = 512;
function grainField(w, h, kind, seed) {
  if (!BANK) BANK = { f: grain(BS, BS, 11, 1), m: grain(BS, BS, 12, 2) }; // 512² 를 타일처럼 감아 쓴다(미세 잡음이라 반복이 보이지 않음)
  const src = BANK[kind], out = tmpF(w * h);
  const ox = (hash2(seed, 1, 5) * BS) | 0, oy = (hash2(seed, 2, 5) * BS) | 0;
  for (let y = 0; y < h; y++) {
    const sy = ((y + oy) & (BS - 1)) * BS;
    for (let x = 0; x < w; ) {
      const sx = (x + ox) & (BS - 1), n = Math.min(w - x, BS - sx);
      out.set(src.subarray(sy + sx, sy + sx + n), y * w + x);
      x += n;
    }
  }
  return out;
}

function newSurf(w, h, seed) {
  const n = w * h;
  return {
    w, h, seed,
    r: tmpU(n), g: tmpU(n), b: tmpU(n), hh: tmpF(n), ro: tmpU(n, 230), me: tmpU(n), em: tmpU(n),
  };
}

// px 사각형 [x0,x1)×[y0,y1) 채우기. null/undefined 인 속성은 건드리지 않는다
function fillR(S, x0, y0, x1, y1, c, hv, rv, mv) {
  x0 = x0 < 0 ? 0 : x0; y0 = y0 < 0 ? 0 : y0; x1 = x1 > S.w ? S.w : x1; y1 = y1 > S.h ? S.h : y1;
  if (x1 <= x0 || y1 <= y0) return;
  for (let y = y0; y < y1; y++) {
    const a = y * S.w + x0, b = y * S.w + x1;
    if (c) { S.r.fill(c[0], a, b); S.g.fill(c[1], a, b); S.b.fill(c[2], a, b); }
    if (hv != null) S.hh.fill(hv, a, b);
    if (rv != null) S.ro.fill(rv, a, b);
    if (mv != null) S.me.fill(mv, a, b);
  }
}
// 미터 단위 상자 (x: 왼쪽에서, y: 층 바닥에서 위로)
function box(S, x, y, w, h, c, hv, rv, mv) {
  fillR(S, px(x), S.h - px(y + h), px(x + w), S.h - px(y), c, hv, rv, mv);
}
function shade(S, x0, y0, x1, y1, k0, k1 = k0, vertical = true) {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(S.w, x1); y1 = Math.min(S.h, y1);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const t = vertical ? (y - y0) / Math.max(1, y1 - y0 - 1) : (x - x0) / Math.max(1, x1 - x0 - 1), k = k0 + (k1 - k0) * t, i = y * S.w + x;
      S.r[i] *= k; S.g[i] *= k; S.b[i] *= k;
    }
  }
}
// 감기는 빗물 줄무늬 (위→아래)
function streak(S, xp, y0, len, wid, k, seed) {
  const rnd = rng(seed), { w, h } = S;
  for (let d = 0; d < len; d++) {
    const y = (y0 + d) % h, a = k * Math.pow(1 - d / len, 1.4) * (0.6 + 0.4 * rnd());
    for (let dx = -wid; dx <= wid; dx++) {
      const e = 1 - Math.abs(dx) / (wid + 0.6), m = 1 - a * e * e, i = y * w + ((((xp + dx) % w) + w) % w);
      S.r[i] *= m; S.g[i] *= m; S.b[i] *= m * (1 - 0.05 * a);
    }
  }
}
// 큰 얼룩(어두워짐 + 약간 누래짐)
function stainPass(S, seed, k, cell) {
  const f = fbm(S.w, S.h, { cell, oct: 4, gain: 0.55, seed, ds: 8 }), n = S.w * S.h;
  for (let i = 0; i < n; i++) {
    const t = sstep(0.38, 0.72, f[i]) * k, m = 1 - t;
    S.r[i] *= m; S.g[i] *= m; S.b[i] *= m * (1 - 0.14 * t);
  }
}

// 벽돌·타일 러닝본드. 줄눈은 모듈 경계에 걸쳐 그린다. 가로 모듈 수는 정수라 좌우로 이어진다.
function paintBond(S, o) {
  const { w, h } = S, cols = Math.round(w / (o.tw * PPM)), rows = Math.round(h / (o.th * PPM));
  const pw = w / cols, ph = h / rows, jh = o.jw * PPM * 0.5, jc = o.joint;
  const gF = grainField(w, h, 'f', S.seed), gM = grainField(w, h, 'm', S.seed + 1);
  const nb = cols * rows, pr = new Float32Array(nb), pg = new Float32Array(nb), pb = new Float32Array(nb);
  const pt = new Float32Array(nb), pho = new Float32Array(nb), pro = new Float32Array(nb);
  const EKb = 32, EMb = Math.ceil((jh + o.bevel + 1) * EKb), lJm = new Float32Array(EMb + 1), lBv = new Float32Array(EMb + 1);
  for (let q = 0; q <= EMb; q++) { const e = q / EKb; lJm[q] = 1 - sstep(jh - 0.5, jh + 0.5, e); lBv[q] = sstep(jh, jh + o.bevel, e); }
  for (let rr = 0; rr < rows; rr++) {
    for (let cc = 0; cc < cols; cc++) {
      const q = rr * cols + cc, c = o.pal(hash2(cc, rr, S.seed + 31), hash2(cc, rr, S.seed + 32));
      pr[q] = c[0]; pg[q] = c[1]; pb[q] = c[2];
      pt[q] = 1 + (hash2(cc, rr, S.seed + 33) - 0.5) * o.tone;
      pho[q] = (hash2(cc, rr, S.seed + 34) - 0.5) * o.hjit;
      pro[q] = o.rough[0] + (o.rough[1] - o.rough[0]) * hash2(cc, rr, S.seed + 35);
    }
  }
  for (let y = 0; y < h; y++) {
    const rr = Math.min(rows - 1, (y / ph) | 0), v = y - rr * ph, off = rr & 1 ? pw * 0.5 : 0, ev = Math.min(v, ph - v);
    for (let x = 0; x < w; x++) {
      let xx = x + off;
      if (xx >= w) xx -= w;
      const cc = Math.min(cols - 1, (xx / pw) | 0), u = xx - cc * pw, e = Math.min(ev, u, pw - u);
      const q = rr * cols + cc, i = y * w + x;
      let ei = (e * EKb) | 0;
      if (ei > EMb) ei = EMb;
      const jm = lJm[ei], bev = lBv[ei];
      const k = pt[q] * (1 + o.gf * gF[i] + o.gm * gM[i]), kj = (1 + 0.12 * gF[i]) * jm, kb = k * (1 - jm);
      S.r[i] = pr[q] * kb + jc[0] * kj;
      S.g[i] = pg[q] * kb + jc[1] * kj;
      S.b[i] = pb[q] * kb + jc[2] * kj;
      S.hh[i] = -o.depth * (1 - bev) + pho[q] + 0.25 * gF[i];
      S.ro[i] = pro[q] * (1 - jm) + 238 * jm;
    }
  }
}
// 균일한 도장/미장/콘크리트 벽
function paintFlat(S, base, o) {
  const { w, h } = S, n = w * h, gF = grainField(w, h, 'f', S.seed + 2), gM = grainField(w, h, 'm', S.seed + 3);
  for (let i = 0; i < n; i++) {
    const k = 1 + o.gf * gF[i] + o.gm * gM[i];
    S.r[i] = base[0] * k; S.g[i] = base[1] * k; S.b[i] = base[2] * k;
    S.hh[i] = o.hg * (gF[i] * 0.6 + gM[i] * 0.4);
  }
  S.ro.fill(o.rough);
}

// ── 유리창 한 칸 ──
const CURTAINS = [[142, 134, 118], [124, 120, 112], [104, 114, 122], [134, 112, 104], [156, 154, 146], [118, 110, 96]];
function paintPane(S, x0, y0, x1, y1, g, style, rv, lit, lv) {
  const w = x1 - x0, h = y1 - y0;
  if (w < 2 || h < 2) return;
  const W = S.w, base = g.base;
  for (let y = y0; y < y1; y++) {
    const k = 1.2 - 0.5 * ((y - y0) / h), a = y * W + x0, b = y * W + x1;
    S.r.fill(base[0] * k, a, b); S.g.fill(base[1] * k, a, b); S.b.fill(base[2] * k, a, b);
  }
  fillR(S, x0, y0, x1, y1, null, -10, g.rough * 255, g.metal * 255);
  if (style === 'curtain') {
    const cc = CURTAINS[(rv * 997 | 0) % CURTAINS.length], xe = x0 + Math.round(w * (0.5 + 0.5 * ((rv * 31) % 1)));
    for (let x = x0; x < xe; x++) {
      const fold = 0.84 + 0.16 * Math.sin((x - x0) * 0.75 + rv * 6);
      for (let y = y0; y < y1; y++) {
        const k = fold * (0.78 + 0.27 * (1 - (y - y0) / h)), i = y * W + x;
        S.r[i] = cc[0] * k; S.g[i] = cc[1] * k; S.b[i] = cc[2] * k;
      }
    }
    fillR(S, x0, y0, xe, y1, null, null, 120, 60);
  } else if (style === 'blind') {
    const ye = y0 + Math.round(h * (0.3 + 0.65 * ((rv * 13) % 1)));
    for (let y = y0; y < ye; y++) {
      const s = ((y - y0) & 3) < 3 ? 1 : 0.6, a = y * W + x0, b = y * W + x1;
      S.r.fill(150 * s, a, b); S.g.fill(147 * s, a, b); S.b.fill(140 * s, a, b);
    }
    fillR(S, x0, ye, x1, Math.min(y1, ye + 2), [96, 93, 88], null, null, null);
    fillR(S, x0, y0, x1, Math.min(y1, ye + 2), null, null, 115, 50);
  } else if (style === 'room') {
    const ym = y0 + Math.round(h * 0.6);
    for (let y = y0; y < y1; y++) {
      const c = y < ym ? [150, 142, 128] : [74, 64, 56], k = 1.05 - 0.4 * ((y - y0) / h), a = y * W + x0, b = y * W + x1;
      S.r.fill(c[0] * k, a, b); S.g.fill(c[1] * k, a, b); S.b.fill(c[2] * k, a, b);
    }
    fillR(S, x0, y0, x1, y1, null, null, 100, 90);
  }
  if (lit) for (let y = y0; y < y1; y++) S.em.fill(255 * lv, y * W + x0, y * W + x1);
}
// 불 켜진 창 선택: 황금비 수열이라 확률 p 에 가깝게, 고르게 흩어진다 (해시 운에 맡기지 않음)
function litNext(S, p) {
  S.pn = (S.pn || 0) + 1;
  return (S.pn * 0.6180339887 + S.seed * 0.0137) % 1 < p;
}
function pickStyle(r, mix) {
  if (r < mix[0]) return 'dark';
  if (r < mix[0] + mix[1]) return 'curtain';
  if (r < mix[0] + mix[1] + mix[2]) return 'blind';
  return 'room';
}
// 창: 위치·크기(m), o = { fc,fr,fm(틀 색·거칠기·금속), fw,dw(틀·살 두께 m), nx,ny, glass, mix, lit, key, sill, bars, style }
function win(S, x, y, w, h, o) {
  const X0 = px(x), X1 = px(x + w), Y1 = S.h - px(y), Y0 = S.h - px(y + h);
  fillR(S, X0, Y0, X1, Y1, o.fc, -9, o.fr, o.fm);
  const fw = Math.max(1, px(o.fw)), dw = Math.max(1, px(o.dw || o.fw)), nx = o.nx || 1, ny = o.ny || 1;
  const ix0 = X0 + fw, iy0 = Y0 + fw, ix1 = X1 - fw, iy1 = Y1 - fw;
  const pw = (ix1 - ix0 - dw * (nx - 1)) / nx, ph = (iy1 - iy0 - dw * (ny - 1)) / ny;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const p0 = Math.round(ix0 + i * (pw + dw)), q0 = Math.round(iy0 + j * (ph + dw));
      const key = hash2(o.key + i, o.key2 + j, S.seed + 91), lit = litNext(S, o.lit);
      paintPane(S, p0, q0, Math.round(p0 + pw), Math.round(q0 + ph), o.glass, o.style || pickStyle(key, o.mix), key, lit, 0.8 + 0.2 * hash2(o.key + i, j, S.seed + 93));
    }
  }
  // 안쪽으로 들어간 창의 그림자(AO): 위가 가장 어둡고 양옆·아래는 약하게
  const ao = Math.max(3, px(0.14));
  shade(S, X0, Y0, X1, Math.min(Y1, Y0 + ao), 0.64, 1);
  shade(S, X0, Y0, X0 + Math.max(2, px(0.05)), Y1, 0.82, 1, false);
  shade(S, X1 - Math.max(2, px(0.05)), Y0, X1, Y1, 1, 0.9, false);
  if (o.bars) {
    const step = px(0.11), bw = Math.max(1, px(0.016));
    for (let xx = X0 + step * 0.5; xx < X1; xx += step) fillR(S, Math.round(xx), Y0, Math.round(xx) + bw, Y1, [58, 58, 60], 6, 120, 190);
    fillR(S, X0, Y0 + Math.round((Y1 - Y0) * 0.5), X1, Y0 + Math.round((Y1 - Y0) * 0.5) + bw, [58, 58, 60], 6, 120, 190);
  }
  if (o.sill) {
    const e = px(o.sill.ext || 0.04), sh = Math.max(2, px(o.sill.th || 0.05));
    fillR(S, X0 - e, Y1, X1 + e, Y1 + sh, o.sill.c, 7, 215, 0);
    fillR(S, X0 - e, Y1, X1 + e, Y1 + 1, [Math.min(255, o.sill.c[0] * 1.1), Math.min(255, o.sill.c[1] * 1.1), Math.min(255, o.sill.c[2] * 1.1)], 8, 200, 0);
    shade(S, X0 - e, Y1 + sh, X1 + e, Y1 + sh + px(0.08), 0.74, 1);
  }
}
// 난간(세로살 + 가로대)
function railing(S, x, y, w, h, c) {
  const X0 = px(x), X1 = px(x + w), Y1 = S.h - px(y), Y0 = S.h - px(y + h), t = Math.max(2, px(0.035));
  fillR(S, X0, Y0, X1, Y0 + t, c, 12, 115, 215);
  fillR(S, X0, Y1 - t, X1, Y1, c, 12, 115, 215);
  const step = px(0.11), bw = Math.max(1, px(0.014));
  for (let xx = X0 + step * 0.5; xx < X1; xx += step) fillR(S, Math.round(xx), Y0 + t, Math.round(xx) + bw, Y1 - t, c, 10, 115, 215);
}
// 에어컨 실외기 (본체 + 팬 그릴) 와 루버 패널
function acUnit(S, x, y, w, h) {
  const X0 = px(x), X1 = px(x + w), Y1 = S.h - px(y), Y0 = S.h - px(y + h);
  fillR(S, X0, Y0, X1, Y1, [214, 216, 214], 22, 135, 20);
  const cx = X0 + (X1 - X0) * 0.36, cy = (Y0 + Y1) * 0.5, rad = (Y1 - Y0) * 0.38;
  for (let yy = Math.floor(cy - rad); yy <= cy + rad; yy++) {
    for (let xx = Math.floor(cx - rad); xx <= cx + rad; xx++) {
      const d = Math.hypot(xx - cx, yy - cy);
      if (d > rad) continue;
      const ring = ((d * 0.55) | 0) & 1 ? 0.8 : 1, i = yy * S.w + xx;
      S.r[i] = 70 * ring; S.g[i] = 72 * ring; S.b[i] = 74 * ring; S.hh[i] = 8; S.ro[i] = 120; S.me[i] = 150;
    }
  }
  for (let yy = Y0 + 3; yy < Y1 - 2; yy += 3) fillR(S, Math.round(X0 + (X1 - X0) * 0.74), yy, X1 - 3, yy + 1, [160, 162, 160], 18, 150, 20);
  shade(S, X0 - 1, Y1, X1 + 1, Y1 + px(0.1), 0.62, 1);
}
function louver(S, x, y, w, h, c) {
  const X0 = px(x), X1 = px(x + w), Y1 = S.h - px(y), Y0 = S.h - px(y + h);
  fillR(S, X0 - 2, Y0 - 2, X1 + 2, Y1 + 2, [c[0] * 0.8, c[1] * 0.8, c[2] * 0.8], 14, 150, 170);
  for (let yy = Y0; yy < Y1 - 2; yy += px(0.028)) {
    fillR(S, X0, yy, X1, yy + 2, c, 20, 120, 190);
    fillR(S, X0, yy + 2, X1, yy + 3, [c[0] * 0.45, c[1] * 0.45, c[2] * 0.45], 8, 200, 60);
  }
  shade(S, X0 - 2, Y1 + 2, X1 + 2, Y1 + px(0.08), 0.7, 1);
}

// 포장: 색 / 노멀 / ORM(R=1, G=거칠기, B=금속성) / 발광(절반 해상도)
function finishFacade(S, normK) {
  const { w, h } = S, n = w * h, col = new Uint8ClampedArray(n * 4), orm = new Uint8ClampedArray(n * 4);
  const c32 = new Uint32Array(col.buffer), o32 = new Uint32Array(orm.buffer), { r, g, b, ro, me } = S;
  for (let i = 0; i < n; i++) {
    c32[i] = r[i] | (g[i] << 8) | (b[i] << 16) | 0xff000000;
    o32[i] = 255 | (ro[i] << 8) | (me[i] << 16) | 0xff000000;
  }
  const w2 = w >> 1, h2 = h >> 1, emi = new Uint8ClampedArray(w2 * h2 * 4), e32 = new Uint32Array(emi.buffer);
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      const a = 2 * y * w + 2 * x, v = (S.em[a] + S.em[a + 1] + S.em[a + w] + S.em[a + w + 1]) >> 2;
      e32[y * w2 + x] = v | (v << 8) | (v << 16) | 0xff000000;
    }
  }
  const ormTex = makeTexture(orm, w, h);
  return {
    map: makeTexture(col, w, h, { srgb: true }),
    normalMap: makeTexture(normalFromHeight(S.hh, w, h, normK), w, h),
    roughnessMap: ormTex,
    metalnessMap: ormTex,
    emissiveMap: makeTexture(emi, w2, h2, { srgb: true }),
  };
}

// ───────────────────────── 파사드 종류 ─────────────────────────
const FR_ALU = { fc: [184, 186, 190], fr: 100, fm: 215 };
const FR_DARK = { fc: [54, 56, 60], fr: 112, fm: 200 };
const FR_PVC = { fc: [230, 229, 224], fr: 125, fm: 0 };
const FR_OLD = { fc: [150, 148, 142], fr: 150, fm: 150 };
const GL = {
  tile: { base: [74, 92, 108], metal: 0.6, rough: 0.08 },
  brick: { base: [70, 88, 104], metal: 0.55, rough: 0.1 },
  curt: { base: [80, 100, 122], metal: 0.7, rough: 0.05 },
  apt: { base: [62, 76, 90], metal: 0.5, rough: 0.1 },
  conc: { base: [84, 94, 100], metal: 0.4, rough: 0.28 },
  shop: { base: [52, 64, 76], metal: 0.6, rough: 0.06 },
};
const SHOPCOL = [[168, 52, 46], [214, 190, 70], [60, 110, 150], [230, 226, 214], [72, 120, 84], [190, 120, 60], [120, 70, 110], [150, 150, 154]];
const FASCIA = [[216, 212, 200], [58, 92, 80], [42, 58, 92], [168, 62, 50], [208, 168, 58], [74, 76, 80], [236, 236, 232], [124, 92, 72]];

// 세부 장식 아래 그림자 + 층 띠(슬래브)
function slabBand(S, W, hgt, c) {
  box(S, 0, 0, W, hgt, c, 9, 215, 0);
  box(S, 0, hgt - 0.015, W, 0.015, [c[0] * 1.08, c[1] * 1.08, c[2] * 1.08], 10, 205, 0);
  shade(S, 0, 0, S.w, px(0.14), 0.76, 1); // 윗층 띠가 이 층 위쪽에 드리우는 그림자(타일 맨 위)
}
// 세로 우수관(원통 음영 + 고정 밴드). 위아래로 이어져도 끊기지 않는다
function pipe(S, xm, wm = 0.09) {
  const X0 = px(xm), X1 = px(xm + wm), w = X1 - X0;
  for (let y = 0; y < S.h; y++) {
    for (let x = X0; x < X1; x++) {
      const t = (x - X0 + 0.5) / w, sn = Math.sin(t * Math.PI), k = 0.5 + 0.65 * sn, i = y * S.w + x;
      S.r[i] = 150 * k; S.g[i] = 152 * k; S.b[i] = 150 * k; S.hh[i] = 10 * sn; S.ro[i] = 120; S.me[i] = 160;
    }
  }
  for (const ym of [0.45, 1.5, 2.6]) box(S, xm - 0.015, ym, wm + 0.03, 0.05, [118, 120, 118], 12, 110, 180);
  shade(S, X1, 0, X1 + 3, S.h, 0.78, 1, false);
}
function sillStreaks(S, wins, len, k, seed) {
  wins.forEach(([xc, yb], i) => streak(S, px(xc), S.h - px(yb) + px(0.06), px(len), 4, k, seed + i));
}

function kTileCream(S, bays, seed) {
  const W = bays * 3;
  paintBond(S, {
    tw: 0.3, th: 0.1, jw: 0.005, joint: [172, 166, 152], bevel: 1.1, depth: 0.7, tone: 0.08, hjit: 0.5, gf: 0.035, gm: 0.025, rough: [90, 140],
    pal: (a, b) => [206 + (a - 0.5) * 12, 193 + (a - 0.5) * 11 - b * 3, 164 + (a - 0.5) * 14 - b * 5],
  });
  slabBand(S, W, 0.17, [196, 188, 172]);
  pipe(S, 6 - 0.045);
  const wins = [];
  for (let b = 0; b < bays; b++) {
    const t = hash2(b, 1, seed + 5), x = b * 3 + 0.45;
    win(S, x, 0.92, 2.1, 1.35, { ...FR_ALU, fw: 0.045, dw: 0.05, nx: t < 0.7 ? 2 : 3, ny: 1, glass: GL.tile, mix: [0.5, 0.2, 0.2], lit: 0.4, key: b * 4, key2: 0, sill: { c: [198, 194, 184], ext: 0.05, th: 0.05 } });
    wins.push([x + 1.05, 0.92]);
  }
  sillStreaks(S, wins, 1.5, 0.22, seed + 40);
  stainPass(S, seed + 5, 0.08, 110);
  return 0.45;
}

function kBrickRed(S, bays, seed) {
  const W = bays * 3;
  paintBond(S, {
    tw: 0.2, th: 0.0667, jw: 0.01, joint: [166, 156, 140], bevel: 1.0, depth: 1.2, tone: 0.16, hjit: 0.9, gf: 0.05, gm: 0.03, rough: [200, 235],
    pal: (a, b) => (a < 0.12 ? [106, 54, 44] : a < 0.28 ? [160, 92, 64] : a < 0.36 ? [122, 64, 52] : [142 + (b - 0.5) * 16, 70 + (b - 0.5) * 10, 52 + (b - 0.5) * 8]),
  });
  slabBand(S, W, 0.14, [188, 182, 170]);
  pipe(S, 6 - 0.045);
  const wins = [];
  for (let b = 0; b < bays; b++) {
    const x = b * 3 + 0.55;
    box(S, x - 0.1, 0.9 + 1.35 + 0.04, 2.1, 0.11, [192, 186, 174], 6, 215, 0); // 석재 인방
    win(S, x, 0.9, 1.9, 1.35, { ...FR_PVC, fw: 0.05, dw: 0.06, nx: 2, ny: 1, glass: GL.brick, mix: [0.45, 0.25, 0.2], lit: 0.35, key: b * 4, key2: 1, sill: { c: [194, 188, 176], ext: 0.05, th: 0.06 } });
    wins.push([x + 0.95, 0.9]);
  }
  sillStreaks(S, wins, 1.3, 0.2, seed + 41);
  stainPass(S, seed + 6, 0.09, 90);
  return 0.55;
}

function kGlassCurtain(S, bays, seed) {
  const W = bays * 3, nm = bays * 2, cap = [118, 121, 126];
  fillR(S, 0, 0, S.w, S.h, [44, 47, 52], -2, 105, 210);
  for (let m = 0; m < nm; m++) {
    const x = m * 1.5, t = hash2(m, 3, seed + 6), g = { base: [74 + t * 10, 94 + t * 8, 118 - t * 8], metal: 0.7, rough: 0.05 };
    paintPane(S, px(x + 0.04), S.h - px(3.02), px(x + 1.46), S.h - px(0.97), g, pickStyle(hash2(m, 4, seed + 7), [0.8, 0.04, 0.08]), hash2(m, 5, seed + 7), litNext(S, 0.4), 0.8 + 0.2 * hash2(m, 7, seed));
    box(S, x + 0.04, 0.04, 1.42, 0.89, [58, 64, 70], -5, 62, 130); // 스팬드럴
    box(S, x + 0.04, 3.06, 1.42, 0.09, [58, 64, 70], -5, 62, 130);
    box(S, x - 0.03, 0, 0.06, 3.2, cap, 3, 95, 225); // 세로 멀리언 캡
  }
  box(S, 0, 0.93, W, 0.04, cap, 3, 95, 225); // 트랜섬 캡
  box(S, 0, 3.02, W, 0.04, cap, 3, 95, 225);
  box(S, 0, 0, W, 0.04, cap, 3, 95, 225);
  box(S, 0, 3.16, W, 0.04, cap, 3, 95, 225);
  box(S, 0, 0, 0.03, 3.2, cap, 3, 95, 225);
  box(S, W - 0.03, 0, 0.03, 3.2, cap, 3, 95, 225);
  // 약한 얼룩 + 세로 빗물 자국
  for (let k = 0; k < bays * 3; k++) streak(S, px(hash2(k, 8, seed) * W), px(0.1 + hash2(k, 9, seed) * 2.5), px(1.2 + hash2(k, 10, seed)), 3, 0.18, seed + k);
  return 0.35;
}

function kApartment(S, bays, seed) {
  const W = bays * 3;
  paintFlat(S, [204, 196, 178], { gf: 0.03, gm: 0.02, hg: 0.25, rough: 232 });
  for (let x = 0; x < W - 0.01; x += 1.5) fillR(S, px(x), 0, px(x) + 1, S.h, [178, 171, 157], -3, 240, 0);
  slabBand(S, W, 0.24, [194, 186, 168]);
  const rail = [52, 54, 58], wins = [];
  for (let b = 0; b < bays; b++) {
    const t = hash2(b, 2, seed + 7), bx = b * 3;
    if (t < 0.42) {
      for (let k = 0; k < 2; k++) {
        const x = bx + 0.22 + k * 0.98;
        win(S, x, 0.2, 0.86, 2.1, { ...FR_DARK, fw: 0.04, dw: 0.04, nx: 1, ny: 2, glass: GL.apt, mix: [0.4, 0.3, 0.15], lit: 0.45, key: b * 5 + k, key2: 2 });
        railing(S, x - 0.05, 0.2, 0.96, 0.95, rail);
      }
      win(S, bx + 2.28, 1.42, 0.55, 0.66, { ...FR_DARK, fw: 0.035, nx: 1, ny: 1, glass: GL.apt, mix: [0.8, 0.1, 0.1], lit: 0.3, key: b * 5 + 2, key2: 3 });
      wins.push([bx + 0.65, 0.2], [bx + 1.63, 0.2], [bx + 2.55, 1.42]);
    } else if (t < 0.74) {
      win(S, bx + 0.2, 0.82, 1.75, 1.45, { ...FR_DARK, fw: 0.045, dw: 0.05, nx: 2, ny: 1, glass: GL.apt, mix: [0.4, 0.3, 0.2], lit: 0.45, key: b * 5, key2: 4 });
      if (hash2(b, 12, seed) > 0.5) acUnit(S, bx + 2.2, 0.9, 0.62, 0.5);
      else louver(S, bx + 2.1, 0.4, 0.7, 0.95, [172, 174, 172]);
      wins.push([bx + 1.07, 0.82]);
    } else {
      win(S, bx + 0.2, 0.68, 2.6, 1.78, { ...FR_PVC, fw: 0.04, dw: 0.045, nx: 4, ny: 1, glass: GL.apt, mix: [0.4, 0.3, 0.2], lit: 0.45, key: b * 5, key2: 5 });
      wins.push([bx + 1.5, 0.68]);
    }
  }
  sillStreaks(S, wins, 1.2, 0.14, seed + 42);
  stainPass(S, seed + 7, 0.06, 120);
  return 0.35;
}

function kConcreteGray(S, bays, seed) {
  const W = bays * 3, rnd = rng(seed * 977 + 3);
  paintFlat(S, [152, 150, 144], { gf: 0.06, gm: 0.05, hg: 0.6, rough: 242 });
  for (let k = 1; k < 22; k++) { // 거푸집 판 자국
    const y = S.h - px(k * 0.15);
    shade(S, 0, y, S.w, y + 1, 0.9);
    for (let x = 0; x < S.w; x++) S.hh[y * S.w + x] -= 0.8;
  }
  for (let b = 0; b < bays; b++) fillR(S, px(b * 3) - 1, 0, px(b * 3) + 2, S.h, [96, 94, 90], -4, 245, 0); // 신축줄눈
  slabBand(S, W, 0.2, [142, 140, 134]);
  pipe(S, 6.05);
  const wins = [];
  for (let b = 0; b < bays; b++) {
    const bx = b * 3;
    win(S, bx + 0.85, 1.05, 1.25, 1.0, { ...FR_OLD, fw: 0.04, dw: 0.045, nx: 2, ny: 1, glass: GL.conc, mix: [0.45, 0.2, 0.25], lit: 0.25, key: b * 4, key2: 6, bars: hash2(b, 15, seed) < 0.4, sill: { c: [138, 136, 130], ext: 0.06, th: 0.07 } });
    wins.push([bx + 1.47, 1.05]);
    if (hash2(b, 16, seed) < 0.5) win(S, bx + 2.45, 1.55, 0.45, 0.5, { ...FR_OLD, fw: 0.035, nx: 1, ny: 1, glass: GL.conc, mix: [0.7, 0.1, 0.2], lit: 0.15, key: b * 4 + 2, key2: 7 });
  }
  const mask = tmpF(S.w * S.h, true); // 실금
  for (let k = 0; k < bays * 2; k++) crack(mask, S.w, S.h, rnd, rnd() * S.w, rnd() * S.h, rnd() * 6.28, 40 + rnd() * 120, 1, 0.02);
  for (let i = 0, nn = S.w * S.h; i < nn; i++) {
    const c = mask[i];
    if (c > 0) { const m = 1 - 0.45 * c; S.r[i] *= m; S.g[i] *= m; S.b[i] *= m; S.hh[i] -= 1.5 * c; }
  }
  stainPass(S, seed + 8, 0.15, 130);
  sillStreaks(S, wins, 1.7, 0.42, seed + 43);
  return 0.45;
}

// 가게 유리 안쪽: 어두운 실내 + 천장 조명 띠 + 선반·상품 + 카운터 (글자·로고 없음)
function paintShop(S, x0, y0, x1, y1, key, lit) {
  paintPane(S, x0, y0, x1, y1, GL.shop, 'dark', key, false, 1);
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return;
  const rnd = rng((key * 4294967296) | 0 || 1), dim = key < 0.18, a = dim ? 0.45 : 1;
  fillR(S, x0, y0, x1, y0 + Math.max(2, (h * 0.05) | 0), [150 * a, 154 * a, 160 * a], null, null, null);
  const pa = a * 0.45;
  for (const sy of [0.3, 0.5, 0.7]) {
    const yy = y0 + Math.round(h * sy);
    fillR(S, x0 + 2, yy, x1 - 2, yy + 2, [84 * a, 78 * a, 72 * a], null, null, null);
    let xx = x0 + 3 + Math.round(rnd() * 8);
    while (xx < x1 - 8) {
      const bw = Math.round(px(0.1) + rnd() * px(0.22)), bh = Math.round(px(0.12) + rnd() * px(0.22)), c = SHOPCOL[(rnd() * SHOPCOL.length) | 0];
      fillR(S, xx, yy - bh, Math.min(x1 - 3, xx + bw), yy, [c[0] * pa, c[1] * pa, c[2] * pa], null, null, null);
      xx += bw + Math.round(px(0.04) + rnd() * px(0.2));
    }
  }
  const yc = y0 + Math.round(h * 0.82);
  fillR(S, x0, yc, x1, y1, [60 * a, 56 * a, 52 * a], null, null, null);
  fillR(S, x0, yc, x1, yc + 2, [150 * a, 140 * a, 128 * a], null, null, null);
  if (lit && !dim) {
    const lv = 255 * (0.75 + 0.25 * rnd());
    for (let y = y0; y < y1; y++) S.em.fill(lv, y * S.w + x0, y * S.w + x1);
  }
}
function awning(S, x, y, w, h, c) {
  const X0 = px(x), X1 = px(x + w), Y1 = S.h - px(y), Y0 = S.h - px(y + h);
  fillR(S, X0, Y0, X1, Y1, c, 14, 200, 0);
  for (let xx = X0; xx < X1; xx += px(0.1)) fillR(S, xx, Y0, xx + px(0.05), Y1, [c[0] * 0.86, c[1] * 0.86, c[2] * 0.86], 12, 205, 0);
  fillR(S, X0, Y1 - px(0.07), X1, Y1, [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7], 22, 195, 0);
  shade(S, X0, Y1, X1, Y1 + px(0.32), 0.5, 1);
}
function kStorefront(S, bays, seed) {
  const W = bays * 3;
  paintFlat(S, [200, 192, 176], { gf: 0.03, gm: 0.02, hg: 0.3, rough: 232 });
  for (let b = 0; b < bays; b++) {
    const bx = b * 3, x0 = bx + 0.14, gw = 2.72, t = hash2(b, 20, seed), fr = hash2(b, 21, seed) < 0.5 ? FR_ALU : FR_DARK;
    box(S, bx, 0, 3, 0.55, [60, 58, 57], 3, 90, 0); // 하부 화강암 가림판
    box(S, bx, 0.55, 3, 0.02, [150, 146, 138], 5, 160, 100);
    box(S, x0, 0.57, gw, 2.78, fr.fc, -8, fr.fr, fr.fm); // 유리 틀
    const hasDoor = t < 0.35, nx = 3, dw = 0.06, pw = (gw - 0.1 - dw * (nx - 1)) / nx;
    for (let i = 0; i < nx; i++) {
      const xa = x0 + 0.05 + i * (pw + dw), key = hash2(b * 3 + i, 22, seed), lit = litNext(S, 0.75);
      if (hasDoor && i === 1) { // 유리문
        box(S, xa - 0.01, 0.57, pw + 0.02, 2.1, fr.fc, -6, fr.fr, fr.fm);
        paintShop(S, px(xa + 0.07), S.h - px(2.62), px(xa + pw - 0.07), S.h - px(0.8), key, lit);
        box(S, xa + 0.07, 0.62, pw - 0.14, 0.16, [196, 198, 202], 4, 90, 230); // 킥플레이트
        box(S, xa + pw - 0.17, 1.0, 0.025, 0.7, [226, 228, 232], 18, 70, 255); // 손잡이
      } else {
        paintShop(S, px(xa), S.h - px(2.86), px(xa + pw), S.h - px(0.62), key, lit);
      }
      paintPane(S, px(xa), S.h - px(3.3), px(xa + pw), S.h - px(2.93), GL.shop, 'dark', hash2(b * 3 + i, 24, seed), lit, 0.9);
    }
    box(S, x0, 2.88, gw, 0.05, fr.fc, -4, fr.fr, fr.fm);
    const fc = FASCIA[(hash2(b, 25, seed) * FASCIA.length) | 0];
    box(S, bx, 3.4, 3, 0.72, fc, 5, 150, 40); // 글자 없는 간판 면
    box(S, bx, 3.4, 3, 0.03, [fc[0] * 0.7, fc[1] * 0.7, fc[2] * 0.7], 7, 160, 40);
    box(S, bx, 4.09, 3, 0.03, [fc[0] * 0.7, fc[1] * 0.7, fc[2] * 0.7], 7, 160, 40);
    shade(S, px(bx), S.h - px(3.4), px(bx + 3), S.h - px(3.4) + px(0.12), 0.7, 1);
    if (hash2(b, 26, seed) < 0.4) awning(S, x0 + 0.1, 2.58, gw - 0.2, 0.72, [[58, 120, 104], [44, 70, 122], [150, 54, 46]][(hash2(b, 27, seed) * 3) | 0]);
  }
  box(S, 0, 4.12, W, 0.08, [200, 194, 178], 6, 215, 0);
  box(S, 0, 3.3, W, 0.1, [200, 194, 178], 4, 215, 0);
  stainPass(S, seed + 9, 0.05, 100);
  return 0.35;
}

const FACADES = { tile_cream: kTileCream, brick_red: kBrickRed, glass_curtain: kGlassCurtain, apartment: kApartment, concrete_gray: kConcreteGray, storefront: kStorefront };
const FACADE_KINDS = Object.keys(FACADES);

/** 한 층 파사드(3.2 m, storefront 는 4.2 m) × bays(3 m). 위아래·좌우로 이어 붙이는 용도.
 *  roughnessMap === metalnessMap (G=거칠기, B=금속성). emissiveMap: 불 켜진 창만 흰색, 나머지는 검정(절반 해상도). */
export function facadeSet(kind = 'tile_cream', { seed = 1, bays = 4 } = {}) {
  if (!FACADES[kind]) throw new Error(`facadeSet: unknown kind "${kind}" (${FACADE_KINDS.join(', ')})`);
  return memo(`facade:${kind}(${seed},${bays})`, () => {
    const H = kind === 'storefront' ? 4.2 : 3.2, S = newSurf(bays * 3 * PPM, px(H), seed * 13 + FACADE_KINDS.indexOf(kind) * 101);
    const normK = FACADES[kind](S, bays, seed);
    return { ...finishFacade(S, normK), size: [bays * 3, H] };
  });
}

// ───────────────────────── 옥상 우레탄 방수 (6 m) ─────────────────────────
/** 녹색 우레탄 방수 옥상 슬래브: 6 m × 6 m, 1024². 3 m 간격 줄눈, 물길(드레인 라인), 고인 물 자국, 보수 패치, 부풀음. */
export function roofSet() {
  return memo('roof', () => {
    const N = 1024, n2 = N * N, rnd = rng(6006), H2 = N / 2;
    const gF = grainField(N, N, 'f', 1201), gM = grainField(N, N, 'm', 1202);
    const s1 = fbm(N, N, { cell: 400, oct: 4, gain: 0.55, seed: 1203, ds: 8 });
    const s2 = fbm(N, N, { cell: 80, oct: 4, gain: 0.55, seed: 1204, ds: 4 });
    const drain = tmpF(n2, true), pat = tmpF(n2, true), blis = tmpF(n2, true);
    seamLine(drain, N, false, 0.27 * N, 11, 70, 1301, 9, 0.85, false);
    seamLine(drain, N, false, 0.8 * N, 8, 50, 1302, 8, 0.7, false);
    seamLine(drain, N, true, 0.62 * N, 10, 60, 1303, 9, 0.8, false);
    for (let k = 0; k < 3; k++) { // 재도장 패치
      const x0 = (rnd() * N) | 0, y0 = (rnd() * N) | 0, w = 120 + ((rnd() * 220) | 0), h = 90 + ((rnd() * 180) | 0);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pat[((y0 + y) % N) * N + ((x0 + x) % N)] = 1;
    }
    for (let k = 0; k < 26; k++) stamp(blis, N, N, (rnd() * N) | 0, (rnd() * N) | 0, 3 + rnd() * 5, 1);
    const col = new Uint8ClampedArray(n2 * 4), hm = tmpF(n2), rg = tmpU(n2);
    const EK = 16, EM = 12 * EK, lJ = mkLut(EM, (t) => 1 - sstep(1.5, 4.2, t * 12));
    const lFade = mkLut(255, (t) => sstep(0.45, 0.7, t)), lD1 = mkLut(255, (t) => sstep(0.5, 0.72, 1 - t) * 0.6), lD2 = mkLut(255, (t) => sstep(0.58, 0.7, t) * 0.5);
    const lRim = mkLut(255, (t) => sstep(0.56, 0.6, t) * (1 - sstep(0.6, 0.64, t))), lPond = mkLut(255, (t) => sstep(0.6, 0.66, t));
    for (let y = 0; y < N; y++) {
      const ey = Math.min(y % H2, H2 - (y % H2));
      for (let x = 0; x < N; x++) {
        const i = y * N + x, ex = Math.min(x % H2, H2 - (x % H2)), e = ex < ey ? ex : ey;
        const jm = lJ[((e > 12 ? 12 : e) * EK) | 0];                // 줄눈 (폭 ≈ 2.5 cm)
        const a1 = (s1[i] * 255 + 0.5) | 0, a2 = (s2[i] * 255 + 0.5) | 0;
        const fade = lFade[a1], dirt = lD1[a1] + lD2[a2], rim = lRim[a2], pond = lPond[a2];
        const dr = drain[i] > 1 ? 1 : drain[i], p = pat[i], bl = blis[i] > 1 ? 1 : blis[i];
        const g = 0.05 * gF[i] + 0.035 * gM[i];
        let R = 78, G = 122, B = 82;
        R += 30 * fade * 0.7; G += 26 * fade * 0.7; B += 22 * fade * 0.7;      // 햇빛에 바랜 부분
        R += 8 * p; G += 6 * p; B += 3 * p;                                    // 새로 칠한 패치는 조금 진함
        const dk = 1 - 0.2 * dirt - 0.2 * dr - 0.1 * pond;                      // 때·물길·고인 물
        R = (R * dk + 16 * rim) * (1 + g); G = (G * dk + 15 * rim) * (1 + g); B = (B * dk + 12 * rim) * (1 + g);
        const j = i * 4, jc = 62 * (1 + g);
        col[j] = R * (1 - jm) + jc * jm * 0.95;
        col[j + 1] = G * (1 - jm) + jc * 1.05 * jm;
        col[j + 2] = B * (1 - jm) + jc * 0.95 * jm;
        col[j + 3] = 255;
        hm[i] = -2.4 * jm + 1.3 * bl + 0.3 * gF[i] + 0.18 * gM[i] - 0.4 * dr;
        const r = 0.7 + 0.06 * gF[i] + 0.14 * dirt - 0.12 * p + 0.1 * jm - 0.14 * pond;
        rg[i] = (r < 0.3 ? 0.3 : r > 1 ? 1 : r) * 255;
      }
    }
    return {
      map: makeTexture(col, N, N, { srgb: true }),
      normalMap: makeTexture(normalFromHeight(hm, N, N, 0.26), N, N),
      roughnessMap: makeTexture(grayRGBA(rg, n2), N, N),
      size: [6, 6],
    };
  });
}

// ───────────────────────── 맨홀 뚜껑 (1 m, 데칼) ─────────────────────────
/** 주철 맨홀: 1 m × 1 m 한 장(반복 없음), 512². 원 바깥은 투명, 틀 바깥 3 cm 는 타르 테두리(반투명).
 *  roughnessMap === metalnessMap (ORM). 도로 위 데칼(transparent, polygonOffset)로 쓴다. */
export function manholeSet() {
  return memo('manhole', () => {
    const N = 512, n2 = N * N, inv = 1 / N;
    const gF = grainField(N, N, 'f', 91), gM = grainField(N, N, 'm', 92);
    const wear = fbm(N, N, { cell: 128, oct: 4, gain: 0.55, seed: 93, ds: 2 });
    const rust = fbm(N, N, { cell: 40, oct: 4, gain: 0.55, seed: 94, ds: 2 });
    const col = new Uint8ClampedArray(n2 * 4), orm = new Uint8ClampedArray(n2 * 4), hm = tmpF(n2);
    const PITCH = 0.052, S2 = Math.SQRT1_2;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = y * N + x, j = i * 4, u = (x + 0.5) * inv - 0.5, v = (y + 0.5) * inv - 0.5, r = Math.sqrt(u * u + v * v);
        const g = 0.12 * gF[i] + 0.06 * gM[i];
        orm[j] = 255; orm[j + 3] = 255;
        if (r > 0.5) { col[j + 3] = 0; orm[j + 1] = 220; orm[j + 2] = 0; continue; }
        if (r > 0.468) { // 타르 테두리
          const a = (1 - sstep(0.468, 0.5, r)) * 0.9;
          col[j] = 26 * (1 + g); col[j + 1] = 26 * (1 + g); col[j + 2] = 28 * (1 + g); col[j + 3] = a * 255;
          orm[j + 1] = 215; orm[j + 2] = 0;
          continue;
        }
        let h = 0, polish = 0, base = 1, dust = 0;
        if (r > 0.362) { // 틀
          h = 4 - 3.2 * (1 - sstep(0, 0.02, 0.468 - r)) - 2.4 * (1 - sstep(0.002, 0.006, Math.abs(r - 0.415)));
          const tick = Math.abs(r - 0.44) < 0.013 && (((Math.atan2(v, u) * 36) / (2 * Math.PI)) % 1 + 1) % 1 < 0.4;
          if (tick) h += 1.6;
          polish = sstep(0.52, 0.7, wear[i]) * (0.4 + 0.6 * sstep(0.38, 0.45, r));
        } else if (r > 0.356) { // 뚜껑과 틀 사이 틈
          h = -5; base = 0.4;
        } else { // 뚜껑: 마름모 돌기 + 중앙 링 + 열쇠 구멍
          h = 2;
          const p = (u + v) * S2 / PITCH, q = (u - v) * S2 / PITCH, fp = p - Math.floor(p), fq = q - Math.floor(q);
          const m = Math.min(Math.min(fp, 1 - fp), Math.min(fq, 1 - fq));
          const stud = sstep(0.1, 0.3, m);
          const ring = Math.abs(r - 0.1) < 0.008 || Math.abs(r - 0.135) < 0.006 || r < 0.045;
          h += 3.2 * stud + (ring ? 2.2 : 0);
          base = 0.8 + 0.32 * stud + (ring ? 0.1 : 0);
          const kx = Math.abs(Math.abs(u) - 0.21), ky = Math.abs(v);
          if (kx < 0.028 && ky < 0.011) { h = -6; base = 0.2; }
          polish = sstep(0.5, 0.68, wear[i]) * (0.25 + 0.75 * stud);
          dust = (1 - stud) * 0.5;
        }
        const rs = sstep(0.58, 0.72, rust[i]) * (0.35 + 0.65 * sstep(0.3, 0.46, r));
        let R = 56, G = 52, B = 49;
        R += 46 * polish; G += 44 * polish; B += 40 * polish;
        R = R * (1 - 0.5 * rs) + 112 * rs * 0.5; G = G * (1 - 0.5 * rs) + 66 * rs * 0.5; B = B * (1 - 0.5 * rs) + 40 * rs * 0.5;
        R = R * (1 - 0.35 * dust) + 76 * dust * 0.35; G = G * (1 - 0.35 * dust) + 68 * dust * 0.35; B = B * (1 - 0.35 * dust) + 58 * dust * 0.35;
        col[j] = R * base * (1 + g); col[j + 1] = G * base * (1 + g); col[j + 2] = B * base * (1 + g); col[j + 3] = 255;
        hm[i] = h + 0.25 * gF[i] + 0.15 * gM[i];
        orm[j + 1] = (0.82 - 0.3 * polish + 0.1 * rs) * 255;
        orm[j + 2] = (0.22 + 0.5 * polish * (1 - rs)) * 255;
      }
    }
    const rm = makeTexture(orm, N, N, { repeat: false });
    return {
      map: makeTexture(col, N, N, { srgb: true, repeat: false }),
      normalMap: makeTexture(normalFromHeight(hm, N, N, 0.66, false), N, N, { repeat: false }),
      roughnessMap: rm,
      metalnessMap: rm,
      size: [1, 1],
    };
  });
}

// ───────────────────────── 한꺼번에 만들기 / 정리 ─────────────────────────
export { FACADE_KINDS };

/** 모든 세트를 미리 만든다(로딩 화면용). 세트별 ms 와 합계를 돌려준다. */
export function generateAll({ seed = 1, bays = 4 } = {}) {
  asphaltSet({ seed });
  paintWearSet();
  sidewalkSet({ seed });
  tactileSet('dots');
  tactileSet('bars');
  curbSet();
  roofSet();
  manholeSet();
  for (const k of FACADE_KINDS) facadeSet(k, { seed, bays });
  releaseScratch();
  return timings();
}

/** 만든 텍스처를 모두 dispose 하고 캐시를 비운다 */
export function disposeAll() {
  const seen = new Set();
  for (const set of cache.values()) {
    for (const v of Object.values(set)) if (v && v.isTexture && !seen.has(v)) { seen.add(v); v.dispose(); }
  }
  cache.clear();
  for (const k of Object.keys(times)) delete times[k];
  BANK = null;
}
