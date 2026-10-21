// =====================================================================
//  trees3d.js — 실사풍 가로수 (느티나무형 2종 + 양버즘나무형 1종)
//  · 전부 코드로 만든 지오메트리 + 캔버스 텍스처 (외부 에셋/네트워크 없음)
//  · 단위: 1 unit = 1 m, Y up, 줄기 밑동이 원점
//
//  export
//    buildTreeVariants({ count = 3, seed = 7, detail = 1 })
//                           -> [{ trunkGeo, leafGeo, trunkMat, leafMat, height, canopyRadius, species, detail, tris }]
//      detail (0,1]: 같은 count/seed 면 종·키·수관 구조·외곽은 같고 삼각형만 줄어든다(0.2 ≈ 3.1~4.7k tris, 0.5 ≈ 8~11.5k).
//      같은 seed 의 LOD 들은 머티리얼(과 텍스처) 객체를 공유한다.
//      변형마다 줄기 InstancedMesh 1개 + 잎 InstancedMesh 1개 (draw call 2).
//      instance 는 0.85~1.15 배, Y축 임의 회전해서 쓰면 된다.
//    buildTreeGrate() -> { geo, mat }      1.2 m 주철 수목 보호덮개 (윗면 y = 0.005)
//    applyWind(material, { strength = 1 }) 잎/줄기 머티리얼에 잔잔한 흔들림 주입 (선택)
//      -> { uniforms:{uWindTime,uWindStrength}, update(t) }  (기본은 material.onBeforeRender 가 시간을 자동 갱신)
//    treeTimings   디버그용 { 키: ms } (텍스처 생성 시간 등)
//
//  잎 머티리얼은 onBeforeCompile 로 (1) 양면 법선 뒤집기 제거(휘어진 법선 유지),
//  (2) 랩 라이팅 + 투과광(역광에서 잎이 비침) 을 쓴다. 기본 라이트 구성(MeshStandard) 그대로 동작.
// =====================================================================
import * as THREE from 'three';

/* ───────────────────────── 공통 도구 ───────────────────────── */
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const V3 = THREE.Vector3;

function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (n) => Math.floor(next() * n);
  next.chance = (p) => next() < p;
  next.gauss = () => {
    let u = 0, v = 0;
    while (u === 0) u = next();
    while (v === 0) v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  };
  next.unit = (o = new V3()) => {
    const z = next() * 2 - 1, t = next() * TAU, r = Math.sqrt(1 - z * z);
    return o.set(r * Math.cos(t), z, r * Math.sin(t));
  };
  next.setState = (v) => { a = v >>> 0; };
  next.fork = () => { const f = makeRng(1); f.setState(a); return f; };   // 같은 상태에서 갈라져 나온 독립 난수
  return next;
}

function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e3779b9; h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }
  return new OffscreenCanvas(w, h);
}

// 주기(타일링) 값 노이즈 격자
function makeGrid(nx, ny, rng) {
  const d = new Float32Array(nx * ny);
  for (let i = 0; i < d.length; i++) d[i] = rng();
  return { nx, ny, d };
}
function sampleGrid(g, u, v) {
  const { nx, ny, d } = g;
  const x0 = Math.floor(u), y0 = Math.floor(v);
  const fx = u - x0, fy = v - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const xa = ((x0 % nx) + nx) % nx, xb = (xa + 1) % nx;
  const ya = ((y0 % ny) + ny) % ny, yb = (ya + 1) % ny;
  const a = d[ya * nx + xa], b = d[ya * nx + xb], c = d[yb * nx + xa], e = d[yb * nx + xb];
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + e) * sx * sy;
}

// 높이맵 -> 접선공간 법선맵 (OpenGL 규약, 이미지 위쪽 = +v)
function heightToNormal(h, W, H, k) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const ym = ((y - 1 + H) % H) * W, y0 = y * W, yp = ((y + 1) % H) * W;
    for (let x = 0; x < W; x++) {
      const xm = (x - 1 + W) % W, xp = (x + 1) % W;
      const dx = (h[y0 + xm] - h[y0 + xp]) * k;
      const dy = (h[yp + x] - h[ym + x]) * k;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const o = (y0 + x) * 4;
      out[o] = (dx * inv * 0.5 + 0.5) * 255;
      out[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      out[o + 2] = (inv * 0.5 + 0.5) * 255;
      out[o + 3] = 255;
    }
  }
  return out;
}

function canvasFromRGBA(data, W, H) {
  const cv = makeCanvas(W, H);
  cv.getContext('2d').putImageData(new ImageData(data, W, H), 0, 0);
  return cv;
}

export const treeTimings = {};      // 디버그용: 텍스처/변형 생성 시간(ms)
const _cache = {};
function cached(key, fn) {
  if (!_cache[key]) {
    const t = nowMs();
    _cache[key] = fn();
    treeTimings[key] = Math.round((nowMs() - t) * 10) / 10;
  }
  return _cache[key];
}

/* ───────────────────────── 나무껍질 텍스처 ─────────────────────────
   주기 보로노이(세포) + 와프 + 캔버스 합성. 가로 방향으로 줄기를 한 바퀴 감는 이음매 없는 타일. */
function paintBark(kind) {
  const W = 256, H = 256;
  const plane = kind === 'plane';
  const rng = makeRng(plane ? 40411 : 17713);
  const GX = plane ? 11 : 15, GY = plane ? 11 : 8;
  const nC = GX * GY;
  const fpx = new Float32Array(nC), fpy = new Float32Array(nC), tone = new Float32Array(nC), cls = new Float32Array(nC);
  for (let i = 0; i < nC; i++) {
    fpx[i] = 0.12 + 0.76 * rng(); fpy[i] = 0.12 + 0.76 * rng();
    tone[i] = rng(); cls[i] = rng();
  }
  const GN = 12;
  const warpU = makeGrid(GN, GN, rng), warpV = makeGrid(GN, GN, rng), low = makeGrid(8, 8, rng), mid = makeGrid(32, 32, rng);
  const lent = makeGrid(36, 150, rng);
  const bl1 = makeGrid(6, 6, rng), bl2 = makeGrid(14, 14, rng), bl3 = makeGrid(30, 30, rng);
  const img = new Uint8ClampedArray(W * H * 4);
  const hm = new Float32Array(W * H);
  const wAmp = plane ? 0.55 : 0.38;
  // 양버즘나무 팔레트
  const PL = [[212, 206, 176], [172, 172, 130], [128, 126, 96], [106, 95, 82], [80, 71, 62]];
  for (let y = 0; y < H; y++) {
    const ny = y / H;
    for (let x = 0; x < W; x++) {
      const nx = x / W;
      const u = nx * GX + (sampleGrid(warpU, nx * GN, ny * GN) - 0.5) * wAmp * (plane ? 1.0 : 0.6);
      const v = ny * GY + (sampleGrid(warpV, nx * GN, ny * GN) - 0.5) * wAmp * (plane ? 1.0 : 1.4);
      const cx = Math.floor(u), cy = Math.floor(v);
      let f1 = 9, f2 = 9, id = 0;
      for (let j = -1; j <= 1; j++) {
        const yy = cy + j, wy = ((yy % GY) + GY) % GY;
        for (let i = -1; i <= 1; i++) {
          const xx = cx + i, wx = ((xx % GX) + GX) % GX;
          const k = wy * GX + wx;
          const dx = xx + fpx[k] - u, dy = yy + fpy[k] - v;
          const d = dx * dx + dy * dy;
          if (d < f1) { f2 = f1; f1 = d; id = k; } else if (d < f2) f2 = d;
        }
      }
      const e = Math.sqrt(f2) - Math.sqrt(f1);
      const tn = tone[id], cl = cls[id];
      const lo = sampleGrid(low, nx * 8, ny * 8), md = sampleGrid(mid, nx * 32, ny * 32), fn = rng();
      let r, g, b, h;
      if (!plane) {
        // 느티나무: 회갈색 비늘 + 가로 껍질눈 + 이따금 주황빛 판
        r = lerp(96, 138, tn); g = lerp(91, 132, tn); b = lerp(84, 122, tn);
        if (cl < 0.12) { r = lerp(r, 142, 0.4); g = lerp(g, 112, 0.4); b = lerp(b, 84, 0.4); }
        else if (cl > 0.86) { r = lerp(r, 96, 0.5); g = lerp(g, 108, 0.5); b = lerp(b, 84, 0.5); }
        const m = 0.82 + 0.34 * lo + 0.18 * (md - 0.5);
        r *= m; g *= m; b *= m;
        const bevel = smooth(0.0, 0.42, e);
        const sh = lerp(0.66, 1.0, bevel);
        r *= sh; g *= sh; b *= sh;
        const crack = 1 - smooth(0.02, 0.09, e);
        r = lerp(r, 34, crack * 0.68); g = lerp(g, 29, crack * 0.68); b = lerp(b, 26, crack * 0.68);
        const lm = smooth(0.70, 0.83, sampleGrid(lent, nx * 36, ny * 150));
        r = lerp(r, 178, lm * 0.42); g = lerp(g, 160, lm * 0.42); b = lerp(b, 134, lm * 0.42);
        h = (0.50 + 0.30 * tn + 0.12 * (md - 0.5)) * bevel - lm * 0.08;
        const gr = (fn - 0.5) * 16;
        r += gr; g += gr; b += gr;
      } else {
        // 양버즘나무: 부드럽게 번지는 얼룩무늬(벗겨진 크림색 / 회올리브 / 짙은 갈색) + 잔 비늘
        const f = 0.5 * sampleGrid(bl1, nx * 6, ny * 6) + 0.3 * sampleGrid(bl2, nx * 14, ny * 14) + 0.2 * sampleGrid(bl3, nx * 30, ny * 30);
        const t1 = smooth(0.34, 0.50, f), t2 = smooth(0.52, 0.68, f);
        r = lerp(lerp(122, 152, t1), 198, t2); g = lerp(lerp(112, 150, t1), 194, t2); b = lerp(lerp(96, 128, t1), 170, t2);
        const fl = 0.94 + 0.12 * tn;
        r *= fl; g *= fl; b *= fl;
        const edge = (1 - smooth(0.0, 0.10, e)) * 0.13 * (1 - t2);
        r *= 1 - edge; g *= 1 - edge; b *= 1 - edge;
        const gr = (fn - 0.5) * 14;
        r += gr; g += gr; b += gr * 0.9;
        g += 2 * t1 * (1 - t2);
        h = lerp(lerp(1.0, 0.55, t1), 0.25, t2) + 0.14 * (smooth(0.0, 0.2, e) - 0.5) + 0.06 * (md - 0.5);
      }
      const o = (y * W + x) * 4;
      img[o] = r; img[o + 1] = g; img[o + 2] = b; img[o + 3] = 255;
      hm[y * W + x] = h;
    }
  }
  const nrm = heightToNormal(hm, W, H, (plane ? 3.4 : 7.0) * (W / 512));
  return { color: canvasFromRGBA(img, W, H), normal: canvasFromRGBA(nrm, W, H) };
}

function barkTextures(kind) {
  return cached('bark:' + kind, () => {
    const { color, normal } = paintBark(kind);
    const map = new THREE.CanvasTexture(color);
    map.colorSpace = THREE.SRGBColorSpace;
    const nm = new THREE.CanvasTexture(normal);
    for (const t of [map, nm]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
    return { map, normal: nm };
  });
}

/* ───────────────────────── 잎 아틀라스 ─────────────────────────
   1024x512 = 256px 칸 8개. 칸마다 잎 여러 장이 달린 가지(spray) 하나.
   알파는 mip 마다 '덮는 면적'을 보존해서 멀리서도 숱이 줄지 않게 한다. */
const rgbStr = (c, m = 1, a = 1) =>
  `rgba(${clamp(c[0] * m, 0, 255) | 0},${clamp(c[1] * m, 0, 255) | 0},${clamp(c[2] * m, 0, 255) | 0},${a})`;

function zelkovaOutline(len, wid, rng) {
  const N = 8 + rng.int(3);
  const asym = rng.range(0.9, 1.1);
  const pts = [];
  const prof = (t) => Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.9) * wid * 0.5;
  const side = (sgn, k) => {
    const arr = [];
    for (let i = 0; i <= 2 * N; i++) {
      const t = i / (2 * N);
      let w = prof(t) * k;
      if (t > 0.1 && t < 0.97) w *= (i % 2 === 1) ? 1.0 : 0.84;
      const xx = t * len + ((i % 2 === 1) ? 0.45 : 0) * (len / (2 * N));
      arr.push([xx, sgn * w]);
    }
    return arr;
  };
  const a = side(1, asym), b = side(-1, 2 - asym).reverse();
  for (const p of a) pts.push(p);
  for (const p of b) pts.push(p);
  return pts;
}

function planeOutline(R) {
  // 3~5 갈래로 갈라진 손바닥 모양 + 큰 톱니
  const tips = [[-78, 0.50], [-40, 0.86], [0, 1.0], [40, 0.86], [78, 0.50]];
  const pts = [[0, 0]];
  const polar = (deg, r) => [Math.cos(deg * DEG) * r * R, Math.sin(deg * DEG) * r * R];
  pts.push(polar(-112, 0.42));
  for (let i = 0; i < tips.length; i++) {
    const [a, r] = tips[i];
    if (i > 0) {
      const [pa, pr] = tips[i - 1];
      pts.push(polar((a + pa) / 2, 0.40 * Math.min(r, pr) + 0.12));
      pts.push(polar(a - 11, r * 0.78));
    } else pts.push(polar(a - 10, r * 0.72));
    pts.push(polar(a - 4, r * 0.92));
    pts.push(polar(a, r));
    pts.push(polar(a + 4, r * 0.92));
    pts.push(polar(a + 11, r * 0.78));
  }
  pts.push(polar(112, 0.42));
  return pts;
}

function drawLeafShape(g, pts, col, len, wid, veinsFn) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.closePath();
  // 잎끼리 겹칠 때 아래 잎에 드리우는 짧은 그림자 (이미 그려진 곳에만)
  g.save();
  g.globalCompositeOperation = 'source-atop';
  g.translate(2.2, 3.0);
  g.fillStyle = 'rgba(8,18,4,0.34)';
  g.fill();
  g.restore();
  const grd = g.createLinearGradient(0, 0, len, 0);
  grd.addColorStop(0, rgbStr(col, 0.74));
  grd.addColorStop(0.5, rgbStr(col, 1.0));
  grd.addColorStop(1, rgbStr(col, 1.14));
  g.fillStyle = grd;
  g.fill();
  veinsFn(g);
  g.lineWidth = 0.9;
  g.strokeStyle = 'rgba(16,32,8,0.55)';
  g.stroke();
}

function paintZelkovaSpray(g, ox, oy, S, rng, variant) {
  g.save();
  g.beginPath(); g.rect(ox + 9, oy + 9, S - 18, S - 18); g.clip();
  const bx = ox + S * (0.5 + (rng() - 0.5) * 0.12), by = oy + S * 0.965;
  const nShoot = variant % 4 === 3 ? 1 : variant % 4 === 0 ? 3 : 2 + (rng() < 0.5 ? 1 : 0);
  const sparse = variant % 4 === 2;
  const PAL = [[44, 80, 33], [58, 96, 38], [72, 116, 42], [82, 126, 46], [100, 142, 52], [126, 166, 62]];
  const W_PAL = [0.14, 0.2, 0.26, 0.2, 0.13, 0.07];
  const pickCol = () => { let r = rng(), i = 0; while (i < 5 && r > W_PAL[i]) { r -= W_PAL[i]; i++; } return PAL[i]; };
  const leaves = [], twigs = [];
  for (let s = 0; s < nShoot; s++) {
    const spread = nShoot === 1 ? rng.range(-0.1, 0.1) : (s / (nShoot - 1) - 0.5) * 2 * 0.62 + rng.range(-0.08, 0.08);
    const L = S * rng.range(0.62, 0.84) * (nShoot === 1 ? 1.12 : 1);
    const a0 = -Math.PI / 2 + spread;
    const bend = rng.range(-0.35, 0.35);
    const p0 = [bx, by];
    const p2 = [bx + Math.cos(a0 + bend) * L, by + Math.sin(a0 + bend) * L];
    const p1 = [bx + Math.cos(a0) * L * 0.55, by + Math.sin(a0) * L * 0.55];
    const bez = (t) => [
      (1 - t) * (1 - t) * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
      (1 - t) * (1 - t) * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]];
    const tan = (t) => {
      const dx = 2 * (1 - t) * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
      const dy = 2 * (1 - t) * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
      return Math.atan2(dy, dx);
    };
    twigs.push({ bez, tan, w: 2.2 });
    const m = (sparse ? 5 : 8) + rng.int(sparse ? 2 : 4);
    for (let k = 0; k < m; k++) {
      const t = 0.17 + 0.83 * (k + rng.range(0.1, 0.9)) / m;
      const side = (k % 2 ? 1 : -1);
      const [px, py] = bez(t);
      const ang = tan(t) + side * rng.range(0.62, 1.15);
      const len = S * lerp(0.225, 0.14, t) * rng.range(0.85, 1.15);
      leaves.push({ x: px, y: py, ang, len, wid: len * rng.range(0.40, 0.54), col: pickCol(), z: rng() });
    }
    const [tx, ty] = bez(1);
    const tl = S * 0.115 * rng.range(0.9, 1.2);
    leaves.push({ x: tx, y: ty, ang: tan(1) + rng.range(-0.25, 0.25), len: tl, wid: tl * 0.5, col: PAL[4 + rng.int(2)], z: rng() });
  }
  // 가지(가는 잔가지)
  for (const tw of twigs) {
    g.beginPath();
    for (let i = 0; i <= 16; i++) { const [x, y] = tw.bez(i / 16); i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.lineWidth = tw.w; g.lineCap = 'round';
    g.strokeStyle = 'rgb(70,54,38)'; g.stroke();
    g.lineWidth = 0.8; g.strokeStyle = 'rgba(138,112,80,0.7)'; g.stroke();
  }
  leaves.sort((a, b) => a.z - b.z);
  for (const lf of leaves) {
    g.save();
    g.translate(lf.x, lf.y); g.rotate(lf.ang);
    g.scale(1, rng.range(0.7, 1.0));
    const pts = zelkovaOutline(lf.len, lf.wid, rng);
    const bright = rng.range(0.9, 1.1);
    const col = [lf.col[0] * bright, lf.col[1] * bright, lf.col[2] * bright];
    drawLeafShape(g, pts, col, lf.len, lf.wid, (gg) => {
      gg.lineCap = 'round';
      gg.strokeStyle = 'rgba(206,226,150,0.55)'; gg.lineWidth = 1.15;
      gg.beginPath(); gg.moveTo(0, 0); gg.lineTo(lf.len * 0.97, 0); gg.stroke();
      gg.strokeStyle = 'rgba(190,214,130,0.32)'; gg.lineWidth = 0.7;
      gg.beginPath();
      for (let i = 1; i <= 6; i++) {
        const t = 0.12 + i * 0.125;
        const ww = lf.wid * 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.72)), 0.9) * 0.9;
        gg.moveTo(t * lf.len, 0); gg.lineTo(Math.min(lf.len, t * lf.len + lf.len * 0.1), ww);
        gg.moveTo(t * lf.len, 0); gg.lineTo(Math.min(lf.len, t * lf.len + lf.len * 0.1), -ww);
      }
      gg.stroke();
    });
    g.restore();
  }
  g.restore();
}

function paintPlaneSpray(g, ox, oy, S, rng, variant) {
  g.save();
  g.beginPath(); g.rect(ox + 8, oy + 8, S - 16, S - 16); g.clip();
  const PAL = [[50, 84, 32], [62, 100, 36], [76, 114, 40], [92, 128, 46], [108, 142, 54]];
  const n = 3 + (variant % 3 === 0 ? 1 : 0) + (rng() < 0.3 ? 1 : 0);
  const bx = ox + S * 0.5, by = oy + S * 0.95;
  const leaves = [];
  for (let k = 0; k < n; k++) {
    const spread = n === 1 ? 0 : (k / (n - 1) - 0.5) * 2 * 0.95 + rng.range(-0.12, 0.12);
    const pet = S * rng.range(0.16, 0.36);
    const a = -Math.PI / 2 + spread * 0.75;
    const lx = bx + Math.cos(a) * pet * 1.0, ly = by + Math.sin(a) * pet * 1.0;
    const R = S * rng.range(0.30, 0.40);
    leaves.push({ lx, ly, a: a + rng.range(-0.3, 0.3) + (spread * 0.35), R, col: PAL[rng.int(PAL.length)], z: rng() });
  }
  leaves.sort((a, b) => a.z - b.z);
  for (const lf of leaves) {
    g.beginPath(); g.moveTo(bx, by); g.lineTo(lf.lx, lf.ly);
    g.lineWidth = 2.6; g.lineCap = 'round'; g.strokeStyle = 'rgb(84,86,44)'; g.stroke();
    g.save();
    g.translate(lf.lx, lf.ly); g.rotate(lf.a);
    g.scale(1, rng.range(0.78, 1.0));
    const pts = planeOutline(lf.R);
    const bright = rng.range(0.92, 1.08);
    const col = [lf.col[0] * bright, lf.col[1] * bright, lf.col[2] * bright];
    drawLeafShape(g, pts, col, lf.R, lf.R, (gg) => {
      gg.lineCap = 'round';
      gg.strokeStyle = 'rgba(220,236,160,0.5)'; gg.lineWidth = 1.5;
      gg.beginPath();
      for (const ang of [-78, -40, 0, 40, 78]) {
        const L = lf.R * (Math.abs(ang) > 60 ? 0.42 : Math.abs(ang) > 20 ? 0.74 : 0.88);
        gg.moveTo(0, 0); gg.lineTo(Math.cos(ang * DEG) * L, Math.sin(ang * DEG) * L);
      }
      gg.stroke();
      gg.strokeStyle = 'rgba(205,224,140,0.28)'; gg.lineWidth = 0.8;
      gg.beginPath();
      for (const ang of [-40, 0, 40]) {
        const c = Math.cos(ang * DEG), s = Math.sin(ang * DEG);
        for (let i = 1; i <= 4; i++) {
          const t = 0.2 * i * lf.R;
          gg.moveTo(c * t, s * t);
          gg.lineTo(c * t + Math.cos((ang + 40) * DEG) * lf.R * 0.1, s * t + Math.sin((ang + 40) * DEG) * lf.R * 0.1);
          gg.moveTo(c * t, s * t);
          gg.lineTo(c * t + Math.cos((ang - 40) * DEG) * lf.R * 0.1, s * t + Math.sin((ang - 40) * DEG) * lf.R * 0.1);
        }
      }
      gg.stroke();
    });
    g.restore();
  }
  g.restore();
}

let _lin, _enc;
function srgbTables() {
  if (_lin) return;
  _lin = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; _lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  _enc = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) { const c = i / 4095; _enc[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); }
}

// RGBA(투명 영역 색 채움) + 알파 보존 mip 체인 (행 순서는 DataTexture 에 맞춰 뒤집음)
function buildAtlasTexture(src, W, H) {
  srgbTables();
  let sr = 0, sg = 0, sb = 0, cnt = 0;
  for (let i = 0; i < W * H; i++) {
    if (src[i * 4 + 3] > 220) { sr += src[i * 4]; sg += src[i * 4 + 1]; sb += src[i * 4 + 2]; cnt++; }
  }
  const avg = cnt ? [sr / cnt, sg / cnt, sb / cnt] : [70, 110, 40];
  const l0 = new Uint8Array(W * H * 4);
  let cover0 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4, di = ((H - 1 - y) * W + x) * 4;
      const a = src[si + 3];
      if (a < 10) { l0[di] = avg[0]; l0[di + 1] = avg[1]; l0[di + 2] = avg[2]; l0[di + 3] = 0; }
      else { l0[di] = src[si]; l0[di + 1] = src[si + 1]; l0[di + 2] = src[si + 2]; l0[di + 3] = a; }
      if (a >= 128) cover0++;
    }
  }
  cover0 /= W * H;
  const mips = [{ data: l0, width: W, height: H }];
  let w = W, h = H, prev = l0;
  while (w > 1 || h > 1) {
    const w2 = Math.max(1, w >> 1), h2 = Math.max(1, h >> 1);
    const nd = new Uint8Array(w2 * h2 * 4);
    const hist = new Uint32Array(256);
    const tmpA = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) {
      for (let x = 0; x < w2; x++) {
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let dy = 0; dy < (h > 1 ? 2 : 1); dy++) {
          for (let dx = 0; dx < (w > 1 ? 2 : 1); dx++) {
            const si = (((y * 2 + dy) % h) * w + ((x * 2 + dx) % w)) * 4;
            r += _lin[prev[si]]; g += _lin[prev[si + 1]]; b += _lin[prev[si + 2]]; a += prev[si + 3]; n++;
          }
        }
        const o = (y * w2 + x) * 4;
        nd[o] = _enc[(clamp(r / n, 0, 1) * 4095) | 0];
        nd[o + 1] = _enc[(clamp(g / n, 0, 1) * 4095) | 0];
        nd[o + 2] = _enc[(clamp(b / n, 0, 1) * 4095) | 0];
        const av = a / n;
        tmpA[y * w2 + x] = av;
        hist[Math.min(255, av | 0)]++;
      }
    }
    // 덮는 면적이 level0 과 같도록 알파 배율 결정
    const target = cover0 * w2 * h2;
    let acc = 0, th = 255;
    for (let v = 255; v >= 1; v--) { acc += hist[v]; if (acc >= target) { th = v; break; } }
    const sc = clamp(128 / Math.max(1, th), 0.8, 3.2);
    for (let i = 0; i < w2 * h2; i++) nd[i * 4 + 3] = Math.min(255, Math.round(tmpA[i] * sc));
    mips.push({ data: nd, width: w2, height: h2 });
    prev = nd; w = w2; h = h2;
  }
  const tex = new THREE.DataTexture(l0, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = mips;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

const ATLAS_COLS = 4, ATLAS_ROWS = 2, ATLAS_S = 256;
function leafAtlas(kind) {
  return cached('atlas:' + kind, () => {
    const W = ATLAS_S * ATLAS_COLS, H = ATLAS_S * ATLAS_ROWS;
    const cv = makeCanvas(W, H);
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, W, H);
    const rng = makeRng(kind === 'plane' ? 9091 : 3131);
    for (let c = 0; c < ATLAS_COLS * ATLAS_ROWS; c++) {
      const ox = (c % ATLAS_COLS) * ATLAS_S, oy = Math.floor(c / ATLAS_COLS) * ATLAS_S;
      if (kind === 'plane') paintPlaneSpray(g, ox, oy, ATLAS_S, rng, c);
      else paintZelkovaSpray(g, ox, oy, ATLAS_S, rng, c);
    }
    const data = g.getImageData(0, 0, W, H).data;
    return { map: buildAtlasTexture(data, W, H), cv };
  });
}

/* ───────────────────────── 수종 설정 ───────────────────────── */
const SPECIES = {
  // 느티나무 — 넓게 퍼진 둥근 수관, 층층이 겹친 잎 다발
  zelkova: {
    bark: 'zelkova', leaf: 'zelkova',
    H: [10.0, 10.8], T: [2.75, 2.95], R: [2.55, 2.85], trunkR: 0.215,
    profile: [[0, 0.50], [0.10, 0.82], [0.28, 0.98], [0.50, 1.0], [0.72, 0.94], [0.88, 0.74], [0.96, 0.42], [1, 0.05]],
    limbs: 6, limbSpan: 2.4, elev: [30, 58], l2: 6, l3: 4,
    padFlat: 0.6, padR: 0.62, upBias: 0.45, faceOut: 0.6, card: [0.60, 0.95], aspect: 0.96,
    cardsMax: 11000, aoMin: 0.30, fillGap: 0.85, fillMax: 150, capMax: 110,
  },
  // 느티나무(수직형) — 가로수로 많이 쓰는 좁고 높은 술잔형 수관
  zelkovaTall: {
    bark: 'zelkova', leaf: 'zelkova',
    H: [11.4, 12.0], T: [2.85, 3.0], R: [2.2, 2.45], trunkR: 0.20,
    profile: [[0, 0.34], [0.14, 0.62], [0.40, 0.90], [0.62, 1.0], [0.80, 0.92], [0.92, 0.66], [0.98, 0.34], [1, 0.05]],
    limbs: 5, limbSpan: 3.0, elev: [44, 68], l2: 6, l3: 4,
    padFlat: 0.68, padR: 0.58, upBias: 0.4, faceOut: 0.6, card: [0.56, 0.90], aspect: 0.96,
    cardsMax: 11000, aoMin: 0.30, fillGap: 0.8, fillMax: 150, capMax: 100,
  },
  // 양버즘나무 — 얼룩 껍질, 큰 손바닥잎
  plane: {
    bark: 'plane', leaf: 'plane',
    H: [9.6, 10.2], T: [2.7, 2.9], R: [2.5, 2.8], trunkR: 0.235,
    profile: [[0, 0.52], [0.12, 0.88], [0.30, 1.0], [0.55, 1.0], [0.78, 0.88], [0.92, 0.6], [1, 0.05]],
    limbs: 6, limbSpan: 2.2, elev: [34, 60], l2: 5, l3: 4,
    padFlat: 0.8, padR: 0.72, upBias: 0.3, faceOut: 0.5, card: [0.78, 1.12], aspect: 0.98,
    cardsMax: 7000, aoMin: 0.30, fillGap: 1.0, fillMax: 100, capMax: 70,
  },
};
const SPECIES_ORDER = ['zelkova', 'zelkovaTall', 'plane'];

/* ───────────────────────── 수관 영역 (envelope) ───────────────────────── */
function makeEnvelope(P, rng) {
  const p2 = rng() * TAU, p3 = rng() * TAU, p5 = rng() * TAU;
  const prof = P.profile;
  const profAt = (f) => {
    if (f <= prof[0][0]) return prof[0][1];
    for (let i = 1; i < prof.length; i++) {
      if (f <= prof[i][0]) {
        const t = (f - prof[i - 1][0]) / (prof[i][0] - prof[i - 1][0]);
        const s = t * t * (3 - 2 * t);
        return lerp(prof[i - 1][1], prof[i][1], s);
      }
    }
    return prof[prof.length - 1][1];
  };
  const env = {
    cx: 0, cz: 0, R: P.R, yb: P.yb, H: P.Hc,
    radius(phi, y) {
      const f = clamp((y - P.yb) / (P.Hc - P.yb), 0, 1);
      const lump = 1 + 0.15 * Math.sin(2 * phi + p2 + y * 0.22) + 0.10 * Math.sin(3 * phi + p3 - y * 0.37) + 0.065 * Math.sin(5 * phi + p5 + y * 0.6);
      const tier = 1 + 0.055 * Math.sin((y - P.yb) * (TAU / 2.3) + p5 * 2);
      return P.R * profAt(f) * lump * tier;
    },
    depth(x, y, z) {
      if (y > P.Hc) return 2;
      const dx = x - env.cx, dz = z - env.cz;
      const rr = env.radius(Math.atan2(dz, dx), y);
      return Math.hypot(dx, dz) / Math.max(rr, 0.05);
    },
  };
  return env;
}

/* ───────────────────────── 가지 뼈대 ───────────────────────── */
function perp(v) {
  const h = Math.abs(v.y) < 0.9 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  return new V3().crossVectors(v, h).normalize();
}

function growSkeleton(P, rng, env) {
  const UP = new V3(0, 1, 0);
  // 줄기 + 리더
  const lean = new THREE.Vector2(rng.range(-1, 1), rng.range(-1, 1)).normalize().multiplyScalar(rng.range(0.10, 0.26));
  const ph1 = rng() * TAU, ph2 = rng() * TAU;
  const yTop = P.Hc * 0.80;
  const ys = [-0.05, 0.0, 0.08, 0.18, 0.32, 0.5, 0.75, 1.05, 1.4, 1.8, 2.2, 2.6];
  for (let y = 2.6 + 0.4; y < P.T + 0.45; y += 0.4) ys.push(y);
  for (let y = P.T + 0.5; y < yTop - 0.3; y += 0.6) ys.push(y);
  ys.push(yTop);
  const rT = P.trunkR * 0.76;
  const tPts = [], tR = [];
  let wx = 0, wz = 0;
  for (const y of ys) {
    const q = Math.min(Math.max(y, 0) / P.T, 1.0);
    let cx = lean.x * Math.pow(q, 1.7) + 0.045 * Math.sin(y * 1.35 + ph1);
    let cz = lean.y * Math.pow(q, 1.7) + 0.045 * Math.sin(y * 1.1 + ph2);
    if (y > P.T) { wx += rng.gauss() * 0.07; wz += rng.gauss() * 0.07; wx *= 0.9; wz *= 0.9; cx += wx; cz += wz; }
    tPts.push(new V3(cx, y, cz));
    let r;
    if (y <= P.T) r = lerp(P.trunkR, rT, Math.max(y, 0) / P.T);
    else r = Math.max(0.022, rT * Math.exp(-0.52 * (y - P.T)));
    tR.push(r);
  }
  env.cx = tPts.find((p) => p.y >= P.T).x * 0.8;
  env.cz = tPts.find((p) => p.y >= P.T).z * 0.8;
  const trunkAt = (y) => {
    for (let i = 1; i < tPts.length; i++) {
      if (tPts[i].y >= y) {
        const t = (y - tPts[i - 1].y) / Math.max(1e-4, tPts[i].y - tPts[i - 1].y);
        return { p: tPts[i - 1].clone().lerp(tPts[i], t), r: lerp(tR[i - 1], tR[i], t) };
      }
    }
    return { p: tPts[tPts.length - 1].clone(), r: tR[tR.length - 1] };
  };
  const branches = [{ pts: tPts, radii: tR, level: 0, sides: 12 }];

  const grow = (cfg) => {
    const pts = [cfg.start.clone()];
    const d = cfg.dir.clone().normalize();
    const maxN = Math.max(1, Math.ceil(cfg.maxLen / cfg.seg));
    let L = 0;
    for (let i = 0; i < maxN; i++) {
      const t = i / maxN;
      d.x += rng.gauss() * cfg.jit; d.y += rng.gauss() * cfg.jit; d.z += rng.gauss() * cfg.jit;
      d.y += cfg.tropism(t);
      const last = pts[pts.length - 1];
      if (cfg.outward) {
        const hx = last.x - env.cx, hz = last.z - env.cz, h = Math.hypot(hx, hz) + 1e-3;
        d.x += (hx / h) * cfg.outward; d.z += (hz / h) * cfg.outward;
      }
      d.normalize();
      const step = cfg.seg * rng.range(0.88, 1.12);
      const np = last.clone().addScaledVector(d, step);
      pts.push(np); L += step;
      if (env.depth(np.x, np.y, np.z) >= cfg.stopDepth) break;
    }
    const n = pts.length;
    const radii = pts.map((_, i) => lerp(cfg.r0, cfg.r1, Math.pow(i / (n - 1), 0.85)));
    const br = { pts, radii, level: cfg.level, len: L, sides: cfg.sides };
    branches.push(br);
    return br;
  };

  const spawn = (parent, n, o) => {
    const m = parent.pts.length - 1;
    const phase = rng() * TAU;
    const out = [];
    for (let k = 0; k < n; k++) {
      if (o.skip && rng.chance(o.skip)) continue;
      const t = lerp(o.t0, o.t1, (k + rng.range(0.15, 0.85)) / n);
      const fi = t * m, i0 = Math.min(m - 1, Math.floor(fi)), fr = fi - i0;
      const p = parent.pts[i0].clone().lerp(parent.pts[i0 + 1], fr);
      const tg = parent.pts[i0 + 1].clone().sub(parent.pts[i0]).normalize();
      const rr = lerp(parent.radii[i0], parent.radii[i0 + 1], fr);
      const nn = perp(tg), bb = new V3().crossVectors(tg, nn);
      const psi = phase + k * 2.39996 + rng.range(-0.45, 0.45);
      const ang = rng.range(o.a0, o.a1) * DEG;
      const dir = tg.clone().multiplyScalar(Math.cos(ang)).addScaledVector(nn, Math.cos(psi) * Math.sin(ang)).addScaledVector(bb, Math.sin(psi) * Math.sin(ang));
      dir.y += o.up;
      dir.normalize();
      const start = p.clone().addScaledVector(dir, rr * 0.45);
      const cfg = o.cfg(t, rr);
      cfg.start = start; cfg.dir = dir;
      out.push(grow(cfg));
    }
    return out;
  };

  // 1차 가지(주지)
  const limbs = [];
  const phi0 = rng() * TAU;
  for (let i = 0; i < P.limbs; i++) {
    const fy = (i + 0.5) / P.limbs;
    const yS = P.T - 0.12 + Math.pow(fy, 1.2) * P.limbSpan + rng.range(-0.1, 0.1);
    const phi = phi0 + i * 2.39996 + rng.range(-0.22, 0.22);
    const elev = lerp(P.elev[0], P.elev[1], fy) * DEG + rng.range(-0.07, 0.07);
    const dir = new V3(Math.cos(phi) * Math.cos(elev), Math.sin(elev), Math.sin(phi) * Math.cos(elev));
    const tr = trunkAt(yS);
    const start = tr.p.clone().addScaledVector(new V3(dir.x, 0, dir.z).normalize(), tr.r * 0.6);
    const limbTrop = P.limbTrop;
    limbs.push(grow({
      start, dir, level: 1, r0: Math.max(0.05, tr.r * lerp(0.62, 0.5, fy)), r1: 0.026, seg: 0.62, maxLen: 7.5,
      stopDepth: rng.range(0.80, 0.95), jit: 0.07, tropism: (t) => limbTrop[0] + limbTrop[1] * t, outward: 0.03, sides: 7,
    }));
  }
  // 2차 / 3차 가지
  const l2s = [];
  for (const limb of limbs) {
    l2s.push(...spawn(limb, P.l2, {
      t0: 0.2, t1: 0.96, a0: 36, a1: 62, up: 0.22,
      cfg: (t, rr) => ({
        level: 2, r0: Math.max(0.022, rr * 0.5), r1: 0.011, seg: 0.5,
        maxLen: clamp(limb.len * (0.5 - 0.28 * t), 1.1, 3.2), stopDepth: rng.range(0.9, 1.0),
        jit: 0.08, tropism: (u) => 0.05 - 0.12 * u, outward: 0.05, sides: 5,
      }),
    }));
  }
  for (const l2 of l2s) {
    spawn(l2, P.l3, {
      t0: 0.25, t1: 1.0, a0: 34, a1: 68, up: 0.16, skip: 0.08,
      cfg: (t, rr) => ({
        level: 3, r0: Math.max(0.009, rr * 0.55), r1: 0.0045, seg: 0.46,
        maxLen: rng.range(0.75, 1.55) * (1 - 0.3 * t), stopDepth: 1.0,
        jit: 0.09, tropism: () => 0.025, outward: 0.04, sides: 3,
      }),
    });
  }

  // 잎 다발 앵커
  const anchors = [];
  const at = (br, t) => {
    const m = br.pts.length - 1, fi = t * m, i0 = Math.min(m - 1, Math.floor(fi));
    return br.pts[i0].clone().lerp(br.pts[i0 + 1], fi - i0);
  };
  const push = (p, s, lvl) => {
    if (p.y < P.yb - 0.1) return;
    anchors.push({ p, s, lvl, depth: env.depth(p.x, p.y, p.z) });
  };
  for (const br of branches) {
    const tip = br.pts[br.pts.length - 1];
    if (br.level === 3) { push(tip, 1.0, 3); if (rng.chance(0.55)) push(at(br, 0.55), 0.62, 3); }
    else if (br.level === 2) { push(tip, 1.15, 2); if (rng.chance(0.55)) push(at(br, 0.62), 0.8, 2); }
    else if (br.level === 1) { push(tip, 1.3, 1); push(at(br, 0.82), 0.9, 1); }
  }
  // 겉면 보강용 앵커: 가지 없이 잎만 — 수관 바깥 껍질에서 간격이 비는 곳을 메운다
  const fills = [];
  const gap2 = P.fillGap * P.fillGap;
  const bx = P.R * 1.3;
  for (let tries = 0; tries < 2200 && fills.length < P.fillMax; tries++) {
    const x = env.cx + rng.range(-bx, bx), z = env.cz + rng.range(-bx, bx), y = rng.range(P.yb, P.Hc);
    const dep = env.depth(x, y, z);
    if (dep < 0.82 || dep > 0.98) continue;
    const p = new V3(x, y, z);
    let ok = true;
    for (const a of anchors) if (a.p.distanceToSquared(p) < gap2) { ok = false; break; }
    if (ok) for (const a of fills) if (a.p.distanceToSquared(p) < gap2) { ok = false; break; }
    if (ok) fills.push({ p, s: 0.95, lvl: 0, depth: dep });
  }
  anchors.push(...fills);
  // 윗면·밑면 껍질 앵커: 위(드론)·아래(가로)에서 올려다본 면적을 메운다
  const shellY = (x, z, top) => {
    if (top) { for (let y = P.Hc; y >= P.yb; y -= 0.05) if (env.depth(x, y, z) <= 0.92) return y; }
    else { for (let y = P.yb; y <= P.Hc; y += 0.05) if (env.depth(x, y, z) <= 0.92) return y; }
    return null;
  };
  const caps = [];
  for (let tries = 0; tries < 1400 && caps.length < P.capMax; tries++) {
    const ang = rng() * TAU, rr = P.R * 1.05 * Math.sqrt(rng());
    const x = env.cx + Math.cos(ang) * rr, z = env.cz + Math.sin(ang) * rr;
    const top = rng() < 0.75;
    if (!top && rr < P.R * 0.5) continue;             // 밑면 중앙은 비워 둬서 줄기·주지가 올려다보이게
    const y = shellY(x, z, top);
    if (y === null) continue;
    const p = new V3(x, y, z);
    const g2 = gap2 * (top ? 0.64 : 1.56);
    let ok = true;
    for (const a of anchors) if (a.p.distanceToSquared(p) < g2) { ok = false; break; }
    if (ok) for (const a of caps) if (a.p.distanceToSquared(p) < g2) { ok = false; break; }
    if (ok) caps.push({ p, s: top ? 1.1 : 0.95, lvl: 0, depth: env.depth(x, y, z) });
  }
  anchors.push(...caps);
  return { branches, anchors, trunkAt };
}

/* ───────────────────────── 지오메트리 빌더 ───────────────────────── */
class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; this.idx = []; this.n = 0; }
  vert(px, py, pz, nx, ny, nz, u, v, r, g, b) {
    this.pos.push(px, py, pz); this.nor.push(nx, ny, nz); this.uv.push(u, v); this.col.push(r, g, b);
    return this.n++;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  geometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    const IdxArr = this.n > 65535 ? Uint32Array : Uint16Array;
    geo.setIndex(new THREE.BufferAttribute(new IdxArr(this.idx), 1));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

function addTube(B, pts, radii, sides, o = {}) {
  const n = pts.length;
  if (n < 2) return;
  const T = [], N = [], Bi = [], arc = [0];
  for (let i = 0; i < n; i++) T.push(pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize());
  N.push(perp(T[0]));
  for (let i = 1; i < n; i++) N.push(N[i - 1].clone().addScaledVector(T[i], -N[i - 1].dot(T[i])).normalize());
  for (let i = 0; i < n; i++) Bi.push(new V3().crossVectors(T[i], N[i]));
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const uRep = o.uRep || 1, vScale = o.vScale || 1;
  const first = B.n;
  for (let i = 0; i < n; i++) {
    const ia = Math.max(0, i - 1), ib = Math.min(n - 1, i + 1);
    const slope = -(radii[ib] - radii[ia]) / Math.max(1e-4, arc[ib] - arc[ia]);
    for (let s = 0; s <= sides; s++) {
      const th = (s / sides) * TAU, c = Math.cos(th), sn = Math.sin(th);
      const nx = N[i].x * c + Bi[i].x * sn, ny = N[i].y * c + Bi[i].y * sn, nz = N[i].z * c + Bi[i].z * sn;
      let rad = radii[i];
      if (o.mod) rad *= o.mod(th, i, pts[i]);
      const px = pts[i].x + nx * rad, py = pts[i].y + ny * rad, pz = pts[i].z + nz * rad;
      let ax = nx + T[i].x * slope, ay = ny + T[i].y * slope, az = nz + T[i].z * slope;
      const il = 1 / Math.hypot(ax, ay, az);
      ax *= il; ay *= il; az *= il;
      const col = o.color ? o.color(px, py, pz, i, th) : [1, 1, 1];
      B.vert(px, py, pz, ax, ay, az, (s / sides) * uRep, arc[i] * vScale, col[0], col[1], col[2]);
    }
  }
  const row = sides + 1;
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < sides; s++) {
      const a = first + i * row + s, b = a + 1, c = a + row, d = c + 1;
      B.tri(a, b, c); B.tri(b, d, c);
    }
  }
}

/* ───────────────────────── LOD (detail) 보조 ─────────────────────────
   뼈대(growSkeleton)와 난수 소비는 detail 과 무관 — 같은 종/키/수관 구조를 유지하고
   튜브 링 수·변 수·잎 카드 수/크기만 줄인다. */
function lodSpec(detail) {
  const d = clamp(detail, 0.05, 1);
  if (d >= 0.999) return null;                          // 전체 디테일 = 기존 경로 그대로
  const t = clamp((d - 0.2) / 0.8, 0, 1);               // detail 0.2 이하면 0, 1이면 1
  return {
    d,
    sides: [Math.round(lerp(6, 12, t)), Math.round(lerp(4, 7, t)), Math.round(lerp(3, 5, t)), 3],
    keep: lerp(0.3, 1, t),                              // 링을 남기는 비율
    dropL3: d < 0.7,                                    // 가는 3차 가지는 잎에 가려 보이지 않음
    sizeScale: 1, ref: null,
  };
}

// 호 길이 기준으로 고르게 링을 솎아낸다 (처음·끝은 유지)
function decimatePath(pts, radii, frac, minPts) {
  const n = pts.length;
  const target = Math.max(Math.min(minPts, n), Math.round(1 + (n - 1) * frac));
  if (target >= n) return { pts, radii };
  const arc = [0];
  for (let i = 1; i < n; i++) arc.push(arc[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const idx = [0];
  for (let k = 1; k < target - 1; k++) {
    const want = (arc[n - 1] * k) / (target - 1);
    let best = idx[idx.length - 1] + 1, bd = Infinity;
    for (let i = idx[idx.length - 1] + 1; i < n - 1; i++) {
      const dd = Math.abs(arc[i] - want);
      if (dd < bd) { bd = dd; best = i; }
    }
    if (best < n - 1) idx.push(best);
  }
  idx.push(n - 1);
  return { pts: idx.map((i) => pts[i]), radii: idx.map((i) => radii[i]) };
}

const fullTrunkTris = (skel) => skel.branches.reduce((a, br) => a + (br.pts.length - 1) * br.sides * 2, 0);

function buildTrunkGeometry(P, rng, env, skel, lod) {
  const B = new Builder();
  const flarePh = rng() * TAU;
  const nzPh = rng() * 100;
  const hash = (a) => { const s = Math.sin(a * 127.1 + nzPh) * 43758.5453; return s - Math.floor(s); };
  for (const br of skel.branches) {
    const lvl = br.level;
    if (lod && lvl === 3 && lod.dropL3) continue;
    let pts = br.pts, radii = br.radii, sides = br.sides;
    if (lod) {
      const dec = decimatePath(pts, radii, lod.keep, lvl === 0 ? 6 : lvl === 1 ? 3 : 2);
      pts = dec.pts; sides = lod.sides[lvl];
      const kSide = Math.pow(TAU / (sides * Math.sin(TAU / sides)), 0.25);   // 변이 적은 다각형이 가늘어 보이지 않도록 반지름 보정
      radii = dec.radii.map((r) => r * kSide);
    }
    const r0 = br.radii[0];
    const circ = TAU * Math.max(r0, 0.02);
    const uRep = lvl === 0 ? 3 : Math.max(1, Math.round(circ / 0.5));
    const vScale = uRep / circ;
    const mod = lvl === 0
      ? (th, i, p) => {
        const y = Math.max(0, p.y);
        const flare = 0.34 * Math.exp(-y / 0.32) * (0.12 + 0.88 * Math.pow(0.5 + 0.5 * Math.cos(3 * th + flarePh), 1.4));
        const bulge = 1 + 0.05 * Math.sin(th * 2 + y * 1.3 + flarePh) + 0.03 * Math.sin(th * 5 - y * 2.1);
        return (1 + flare) * bulge;
      }
      : null;
    const tint = lvl === 0 ? [1, 1, 1] : lvl === 1 ? [0.92, 0.88, 0.84] : [0.8, 0.74, 0.62];
    const color = (x, y, z) => {
      const dep = env.depth(x, y, z);
      const inCrown = smooth(P.T - 0.1, P.T + 1.4, y);
      const ao = lerp(1, lerp(0.34, 0.86, smooth(0.1, 0.95, dep)), inCrown);
      const ground = lerp(0.86, 1, smooth(0, 0.5, y));
      const v = ao * ground;
      return [v * tint[0], v * tint[1], v * tint[2]];
    };
    addTube(B, pts, radii, sides, { uRep, vScale, mod, color });
  }
  return B.geometry();
}

/* 잎 카드 — 앵커(가지 끝)마다 납작한 패드 하나: 카드의 일부는 수관 바깥을 향하게(밖에서 잎면이 보이도록),
   나머지는 아무 방향. 법선은 수관 전체 타원체 + 패드 중심에서 바깥 + 카드 법선을 섞어
   덩어리진 부드러운 볼륨으로 음영이 지게 한다. */
function buildLeafGeometry(P, rng, env, skel, nBudget, lod) {
  const anchors = skel.anchors;
  let totalW = 0;
  for (const a of anchors) { a.w = a.s * a.s * (0.2 + 0.8 * smooth(0.3, 0.85, a.depth)); totalW += a.w; }
  const pos = new Float32Array(nBudget * 12), nor = new Float32Array(nBudget * 12);
  const uvs = new Float32Array(nBudget * 8), col = new Float32Array(nBudget * 12);
  const idx = new Uint32Array(nBudget * 6);
  const cenR = [];
  let nc = 0, maxY = 0;
  const cells = ATLAS_COLS * ATLAS_ROWS;
  const uInset = 2 / (ATLAS_S * ATLAS_COLS), vInset = 2 / (ATLAS_S * ATLAS_ROWS);
  const yMid = lerp(P.yb, P.Hc, 0.5) - 0.3;
  const ryN = (P.Hc - P.yb) * 0.55 + 0.6, rxN = P.R * 1.12;
  const dir = new V3(), nd = new V3(), right = new V3(), base = new V3(), cen = new V3(), off = new V3(), ncA = new V3();
  const corner = [new V3(), new V3(), new V3(), new V3()];
  const sunCol = [1.02, 1.01, 0.86], shadeCol = [0.56, 0.76, 0.62];
  const floorY = (rho) => P.yb - 0.1 + 0.30 * rho;       // 차도 쪽으로 갈수록 높아지는 잎 하한 (버스 통과)
  const UPV = new V3(0, 1, 0);
  const S = lod ? lod.sizeScale : 1;                    // LOD: 카드 수가 줄어든 만큼 카드를 키워 숱을 유지
  const sizeMean = (P.card[0] + P.card[1]) / 2;
  let carry = 0;

  for (const a of anchors) {
    let nCard;
    if (!lod) nCard = Math.round(nBudget * a.w / totalW);
    else { carry += nBudget * a.w / totalW; nCard = Math.floor(carry + 1e-9); carry -= nCard; }   // 오차 확산 반올림
    if (nCard < 1) continue;
    const padBright = rng.range(0.9, 1.1), padHue = rng.range(-0.04, 0.04);
    const ao0 = lerp(P.aoMin, 1.0, smooth(0.28, 0.95, a.depth));
    ncA.set((a.p.x - env.cx) / (rxN * rxN), (a.p.y - yMid) / (ryN * ryN), (a.p.z - env.cz) / (rxN * rxN)).normalize();
    const padR = P.padR * a.s;
    const padOff = lod ? Math.max(0.1, padR - 0.69 * (S - 1) * sizeMean) : padR;   // 카드가 커진 만큼 흩어짐을 줄여 외곽 유지
    for (let k = 0; k < nCard && nc < nBudget; k++) {
      // 면 방향
      if (rng() < P.faceOut) { rng.unit(nd).multiplyScalar(0.65).addScaledVector(ncA, 1.0); nd.y += 0.1; }
      else rng.unit(nd);
      nd.normalize();
      // 잎 다발 축: 카드 평면 안의 임의 방향 (위쪽으로 약간 치우침)
      rng.unit(dir); dir.y += 0.35;
      dir.addScaledVector(nd, -dir.dot(nd));
      if (dir.lengthSq() < 1e-4) dir.copy(perp(nd));
      dir.normalize();
      right.crossVectors(nd, dir).normalize();
      const size = rng.range(P.card[0], P.card[1]) * (0.8 + 0.2 * a.s) * S;
      const w = size * P.aspect;
      // 카드 중심: 앵커 주변 납작한 타원체(표면 쪽으로 치우침)
      rng.unit(off); off.y *= P.padFlat; off.multiplyScalar(padOff * Math.pow(rng(), 0.5));
      cen.copy(a.p).add(off).addScaledVector(ncA, padR * 0.25);
      base.copy(cen).addScaledVector(dir, -size * 0.5);
      corner[0].copy(base).addScaledVector(right, -w / 2);
      corner[1].copy(base).addScaledVector(right, w / 2);
      corner[2].copy(base).addScaledVector(dir, size).addScaledVector(right, w / 2);
      corner[3].copy(base).addScaledVector(dir, size).addScaledVector(right, -w / 2);
      // 하한 (버스 통과 높이)
      let need = 0;
      for (const c of corner) need = Math.max(need, floorY(Math.hypot(c.x - env.cx, c.z - env.cz)) - c.y);
      if (need > 0) { for (const c of corner) c.y += need; cen.y += need; }
      // 밝기·색
      const dep = env.depth(cen.x, cen.y, cen.z);
      const ao = clamp(ao0 * 0.5 + lerp(P.aoMin, 1.0, smooth(0.28, 0.95, dep)) * 0.5, 0.2, 1);
      const th = smooth(0.15, 1.0, (cen.y - P.yb) / (P.Hc - P.yb));
      const sun = clamp(0.5 * th + 0.5 * smooth(0.45, 1.0, dep) + (rng() - 0.5) * 0.25, 0, 1);
      const bright = ao * padBright * rng.range(0.92, 1.08) * lerp(0.96, 1.16, th);
      const cR = lerp(shadeCol[0], sunCol[0], sun), cG = lerp(shadeCol[1], sunCol[1], sun), cB = lerp(shadeCol[2], sunCol[2], sun);
      // 아틀라스 칸
      const ci = rng.int(cells), ccx = ci % ATLAS_COLS, ccy = Math.floor(ci / ATLAS_COLS);
      let u0 = ccx / ATLAS_COLS + uInset, u1 = (ccx + 1) / ATLAS_COLS - uInset;
      const v0 = 1 - (ccy + 1) / ATLAS_ROWS + vInset, v1 = 1 - ccy / ATLAS_ROWS - vInset;
      if (rng() < 0.5) { const t = u0; u0 = u1; u1 = t; }
      const cuv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      const vShade = [0.74, 0.74, 1.06, 1.06];
      const sgn = nd.dot(ncA) >= 0 ? 1 : -1;
      for (let c = 0; c < 4; c++) {
        const p = corner[c];
        const o3 = (nc * 4 + c) * 3, o2 = (nc * 4 + c) * 2;
        pos[o3] = p.x; pos[o3 + 1] = p.y; pos[o3 + 2] = p.z;
        let nx = (p.x - env.cx) / (rxN * rxN), ny = (p.y - yMid) / (ryN * ryN), nz = (p.z - env.cz) / (rxN * rxN);
        let l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        let mx = p.x - a.p.x, my = (p.y - a.p.y) * 1.25 + 0.12, mz = p.z - a.p.z;
        l = Math.hypot(mx, my, mz) || 1; mx /= l; my /= l; mz /= l;
        const fx = nx * 0.62 + mx * 0.52 + nd.x * sgn * 0.26;
        const fy = ny * 0.62 + my * 0.52 + nd.y * sgn * 0.26 + 0.05;
        const fz = nz * 0.62 + mz * 0.52 + nd.z * sgn * 0.26;
        l = Math.hypot(fx, fy, fz) || 1;
        let qx = fx / l, qy = fy / l, qz = fz / l;
        if (qy < -0.45) {                       // 아래를 향한 법선은 하늘빛을 조금 받도록 끌어올림
          const k = Math.sqrt(1 - 0.2025) / (Math.hypot(qx, qz) || 1);
          qx *= k; qz *= k; qy = -0.45;
        }
        nor[o3] = qx; nor[o3 + 1] = qy; nor[o3 + 2] = qz;
        uvs[o2] = cuv[c][0]; uvs[o2 + 1] = cuv[c][1];
        const bv = bright * vShade[c] * (1 + (rng() - 0.5) * 0.06);
        col[o3] = bv * (cR + padHue); col[o3 + 1] = bv * cG; col[o3 + 2] = bv * (cB - padHue * 0.6);
        if (p.y > maxY) maxY = p.y;
      }
      cenR.push(Math.hypot(cen.x - env.cx, cen.z - env.cz));
      const b4 = nc * 4, i6 = nc * 6;
      idx[i6] = b4; idx[i6 + 1] = b4 + 1; idx[i6 + 2] = b4 + 2;
      idx[i6 + 3] = b4; idx[i6 + 4] = b4 + 2; idx[i6 + 5] = b4 + 3;
      nc++;
    }
  }
  if (lod && lod.ref && nc > 0) {
    // 카드가 커진 만큼 바깥으로 삐져나온 외곽을, 카드 크기(=숱)는 그대로 두고 카드 중심만 옮겨
    // detail=1 의 외곽 상자에 맞춘다 (축마다 중심 간격을 조절한 뒤 평행이동, 3회 반복).
    const rb = lod.ref.box;
    const rmin = [rb.min.x, rb.min.y, rb.min.z], rmax = [rb.max.x, rb.max.y, rb.max.z];
    const n3 = nc * 12;
    const cen3 = new Float32Array(nc * 3);
    for (let c = 0; c < nc; c++) for (let ax = 0; ax < 3; ax++) {
      let m = 0;
      for (let k = 0; k < 4; k++) m += pos[c * 12 + k * 3 + ax];
      cen3[c * 3 + ax] = m / 4;
    }
    const vExt = (ax) => {
      let lo = 1e9, hi = -1e9;
      for (let i = ax; i < n3; i += 3) { const v = pos[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      return [lo, hi];
    };
    const moveCards = (ax, fn) => {
      for (let c = 0; c < nc; c++) {
        const cur = cen3[c * 3 + ax], nw = fn(cur), d = nw - cur;
        cen3[c * 3 + ax] = nw;
        for (let k = 0; k < 4; k++) pos[c * 12 + k * 3 + ax] += d;
      }
    };
    for (let it = 0; it < 3; it++) {
      for (let ax = 0; ax < 3; ax++) {
        const [v0, v1] = vExt(ax);
        let c0 = 1e9, c1 = -1e9;
        for (let c = 0; c < nc; c++) { const v = cen3[c * 3 + ax]; if (v < c0) c0 = v; if (v > c1) c1 = v; }
        const g = clamp(1 + ((rmax[ax] - rmin[ax]) - (v1 - v0)) / Math.max(1e-3, c1 - c0), 0.7, 1.3);
        const pv = ax === 1 ? c0 : (c0 + c1) / 2;              // 높이는 가장 낮은 카드 기준, 가로는 중심 기준
        moveCards(ax, (v) => pv + (v - pv) * g);
        const [w0, w1] = vExt(ax);
        const shift = ax === 1 ? rmin[1] - w0 : (rmin[ax] + rmax[ax]) / 2 - (w0 + w1) / 2;
        moveCards(ax, (v) => v + shift);
      }
    }
    // 버스 통과용 하한을 다시 보장 (카드를 통째로 올림)
    for (let c = 0; c < nc; c++) {
      let need = 0;
      for (let k = 0; k < 4; k++) {
        const o = c * 12 + k * 3;
        need = Math.max(need, floorY(Math.hypot(pos[o] - env.cx, pos[o + 2] - env.cz)) - pos[o + 1]);
      }
      if (need > 0) for (let k = 0; k < 4; k++) pos[c * 12 + k * 3 + 1] += need;
    }
    maxY = 0;
    for (let i = 1; i < n3; i += 3) if (pos[i] > maxY) maxY = pos[i];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, nc * 12), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor.slice(0, nc * 12), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs.slice(0, nc * 8), 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col.slice(0, nc * 12), 3));
  const ia = nc * 4 > 65535 ? new Uint32Array(idx.slice(0, nc * 6)) : new Uint16Array(idx.slice(0, nc * 6));
  geo.setIndex(new THREE.BufferAttribute(ia, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  cenR.sort((x, y) => x - y);
  geo.userData.cards = nc;
  geo.userData.maxY = maxY;
  geo.userData.canopyR = (cenR[Math.floor(cenR.length * 0.98)] || 0) + 0.3;
  return geo;
}

/* ───────────────────────── 머티리얼 ───────────────────────── */
const LEAF_RE_DIRECT = /* glsl */`
void RE_Direct_Physical( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
	// 잎은 얇고 빛이 비친다: 랩 라이팅 + 역광 투과
	float ndl = dot( geometryNormal, directLight.direction );
	float dotNL = saturate( ( ndl + 0.32 ) / 1.32 );
	vec3 irradiance = dotNL * directLight.color;
	// 정반사는 wrap 이 아니라 실제 N·L 로만 (wrap 을 쓰면 N·L<=0 && N·V<=0 일 때 V_Smith 가 1/EPSILON 으로 폭주해 수관 가장자리에 흰 점이 생긴다)
	reflectedLight.directSpecular += saturate( ndl ) * directLight.color * BRDF_GGX( directLight.direction, geometryViewDir, geometryNormal, material );
	reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
	float vdl = dot( geometryViewDir, directLight.direction );
	float trans = pow( saturate( - vdl ), 2.2 ) * ( 0.55 + 0.45 * saturate( 1.0 - abs( ndl ) ) );
	reflectedLight.directDiffuse += directLight.color * trans * 0.17 * material.diffuseColor * vec3( 0.95, 1.08, 0.5 ) * RECIPROCAL_PI * 3.1416;
}

`;

function patchLeafShader(shader) {
  const nf = THREE.ShaderChunk.normal_fragment_begin;
  if (nf.includes('normal *= faceDirection;')) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', nf.replace('normal *= faceDirection;', '// 휘어진 법선 유지(양면 뒤집기 제거)'));
  }
  const chunk = THREE.ShaderChunk.lights_physical_pars_fragment;
  const s = chunk.indexOf('void RE_Direct_Physical(');
  const e = chunk.indexOf('void RE_IndirectDiffuse_Physical(');
  if (s >= 0 && e > s) {
    shader.fragmentShader = shader.fragmentShader.replace('#include <lights_physical_pars_fragment>', chunk.slice(0, s) + LEAF_RE_DIRECT + chunk.slice(e));
  }
}

function makeTrunkMaterial(spec) {
  const bt = barkTextures(spec.bark);
  return new THREE.MeshStandardMaterial({
    map: bt.map, normalMap: bt.normal, normalScale: new THREE.Vector2(1.0, 1.0),
    vertexColors: true, roughness: 0.94, metalness: 0,
  });
}

function makeLeafMaterial(spec) {
  const at = leafAtlas(spec.leaf);
  const m = new THREE.MeshStandardMaterial({
    map: at.map, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.78, metalness: 0,
  });
  m.onBeforeCompile = (shader) => patchLeafShader(shader);
  m.customProgramCacheKey = () => 'rg-leaf-v2';
  return m;
}

/* ───────────────────────── 변형 생성 ───────────────────────── */
const _matCache = new Map();   // 변형 키 -> { trunkMat, leafMat }  (같은 seed 의 LOD 들이 머티리얼 공유)
const _refCache = new Map();   // 변형 키 -> detail=1 기준 치수 (LOD 가 같은 외곽·키를 갖도록)

function buildVariant(name, seed, detail = 1) {
  const tv0 = nowMs();
  const spec = SPECIES[name];
  const key = name + ':' + seed;
  const rng = makeRng(seed);
  const P = {
    ...spec,
    H: rng.range(spec.H[0], spec.H[1]), T: rng.range(spec.T[0], spec.T[1]), R: rng.range(spec.R[0], spec.R[1]),
    limbTrop: [rng.range(0.08, 0.13), rng.range(-0.26, -0.18)],
  };
  P.yb = P.T + 0.05;
  P.Hc = P.H - 0.5;                           // 카드가 위로 더 올라오므로 영역은 조금 낮게
  const env = makeEnvelope(P, rng);
  const skel = growSkeleton(P, rng, env);
  const lod = lodSpec(detail);
  const trunkGeo = buildTrunkGeometry(P, rng, env, skel, lod);
  const trunkTris = trunkGeo.index.count / 3;
  let leafGeo, height, canopyRadius;
  if (!lod) {
    const budget = Math.min(spec.cardsMax, Math.floor((24400 - trunkTris) / 2));
    leafGeo = buildLeafGeometry(P, rng, env, skel, budget, null);
    height = Math.max(leafGeo.userData.maxY, P.H * 0.97);
    canopyRadius = leafGeo.userData.canopyR;
    _refCache.set(key, { box: leafGeo.boundingBox.clone(), height, canopyRadius, nRef: budget });
  } else {
    let ref = _refCache.get(key);
    if (!ref) {                                // detail=1 을 아직 안 만들었다면 같은 난수 상태에서 기준을 한 번 계산
      const nRef = Math.min(spec.cardsMax, Math.floor((24400 - fullTrunkTris(skel)) / 2));
      const g = buildLeafGeometry(P, rng.fork(), env, skel, nRef, null);
      ref = { box: g.boundingBox.clone(), height: Math.max(g.userData.maxY, P.H * 0.97), canopyRadius: g.userData.canopyR, nRef };
      g.dispose();
      _refCache.set(key, ref);
    }
    const nLod = Math.max(100, Math.min(Math.round(ref.nRef * lod.d), Math.floor((25000 * lod.d - trunkTris) / 2)));
    lod.ref = ref;
    lod.sizeScale = Math.sqrt(ref.nRef / nLod) * LOD_AREA_BOOST;      // 면적 보존: 카드 수 ↓ → 카드 크기 ↑
    leafGeo = buildLeafGeometry(P, rng, env, skel, nLod, lod);
    height = ref.height;
    canopyRadius = ref.canopyRadius;
  }
  const leafTris = leafGeo.index.count / 3;
  let mats = _matCache.get(key);
  if (!mats) { mats = { trunkMat: makeTrunkMaterial(spec), leafMat: makeLeafMaterial(spec) }; _matCache.set(key, mats); }
  treeTimings['variant:' + name] = Math.round((nowMs() - tv0) * 10) / 10;
  return {
    trunkGeo, leafGeo,
    trunkMat: mats.trunkMat, leafMat: mats.leafMat,
    height, canopyRadius,
    species: name,
    detail: lod ? lod.d : 1,
    tris: { trunk: trunkTris, leaf: leafTris, total: trunkTris + leafTris },
  };
}

const LOD_AREA_BOOST = 1.0;

export function buildTreeVariants({ count = 3, seed = 7, detail = 1 } = {}) {
  const d = Number.isFinite(detail) ? clamp(detail, 0.05, 1) : 1;      // (0,1], 범위 밖은 끝값으로, NaN 은 전체 디테일
  const out = [];
  for (let i = 0; i < count; i++) {
    const name = SPECIES_ORDER[i % SPECIES_ORDER.length];
    out.push(buildVariant(name, hashSeed(seed, i, name), d));
  }
  return out;
}

/* ───────────────────────── 바람 (선택) ───────────────────────── */
const WIND_VERT = /* glsl */`
{
	#ifdef USE_INSTANCING
		vec3 wInst = ( modelMatrix * vec4( instanceMatrix[ 3 ].xyz, 1.0 ) ).xyz;
		mat3 wIm = mat3( instanceMatrix );
		float wS2 = max( dot( wIm[ 0 ], wIm[ 0 ] ), 1e-4 );
	#else
		vec3 wInst = modelMatrix[ 3 ].xyz;
		mat3 wIm = mat3( 1.0 );
		float wS2 = 1.0;
	#endif
	float wh = max( position.y - 2.4, 0.0 );
	float wAmp = uWindStrength * wh * wh * 0.0008;
	float wPh = dot( wInst.xz, vec2( 0.071, 0.057 ) ) + fract( sin( dot( wInst.xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) * 6.2832;
	float wT = uWindTime;
	vec2 wd = vec2(
		sin( wT * 1.15 + wPh ) + 0.45 * sin( wT * 2.45 + wPh * 1.7 + position.y * 0.3 ),
		0.6 * cos( wT * 0.93 + wPh * 1.3 ) + 0.3 * sin( wT * 1.9 + wPh * 0.7 ) );
	vec3 wDisp = vec3( wd.x, 0.0, wd.y ) * wAmp;
	#ifdef WIND_FLUTTER
		float wf = sin( wT * 5.1 + dot( position, vec3( 9.1, 7.3, 8.3 ) ) );
		wDisp += vec3( wf, 0.4 * wf, - wf ) * 0.010 * uWindStrength * smoothstep( 3.0, 6.0, position.y );
	#endif
	transformed += ( wDisp * wIm ) / wS2;
}
`;

export function applyWind(material, opts = {}) {
  const { strength = 1, auto = true, flutter } = opts;
  if (material.userData.wind) {                 // 이미 적용됨(LOD 들이 머티리얼을 공유) — 세기만 갱신
    if ('strength' in opts) material.userData.wind.uniforms.uWindStrength.value = strength;
    return material.userData.wind;
  }
  const prevCompile = material.onBeforeCompile;
  const hasKey = material.customProgramCacheKey !== THREE.Material.prototype.customProgramCacheKey;
  const prevKey = hasKey ? material.customProgramCacheKey.bind(material) : () => '';
  const wind = {
    uniforms: { uWindTime: { value: 0 }, uWindStrength: { value: strength } },
    update(t) { this.uniforms.uWindTime.value = t; },
  };
  const useFlutter = flutter ?? (material.alphaTest > 0);
  material.onBeforeCompile = (shader, renderer) => {
    if (prevCompile) prevCompile.call(material, shader, renderer);
    shader.uniforms.uWindTime = wind.uniforms.uWindTime;
    shader.uniforms.uWindStrength = wind.uniforms.uWindStrength;
    let vs = shader.vertexShader;
    vs = vs.replace('#include <common>', '#include <common>\nuniform float uWindTime;\nuniform float uWindStrength;');
    vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + WIND_VERT);
    shader.vertexShader = (useFlutter ? '#define WIND_FLUTTER\n' : '') + vs;
  };
  material.customProgramCacheKey = () => prevKey() + '|wind' + (useFlutter ? 'F' : '');
  if (auto) {
    const prevBR = material.onBeforeRender;
    material.onBeforeRender = function (...args) {
      wind.uniforms.uWindTime.value = nowMs() * 0.001;
      if (prevBR) prevBR.apply(this, args);
    };
  }
  material.userData.wind = wind;
  material.needsUpdate = true;
  return wind;
}

/* ───────────────────────── 수목 보호덮개 (tree grate) ───────────────────────── */
function paintGrate() {
  const S = 512, SOIL = 32, H = S + SOIL;
  const cv = makeCanvas(S, H);
  const g = cv.getContext('2d');
  const rng = makeRng(2024);
  const m = (x) => x / 1.2 * S;                  // 미터 -> 픽셀 (판 한 변 1.2 m)
  const c = S / 2;
  // 판 전체 (불투명 주철)
  g.fillStyle = '#3c3e41'; g.fillRect(0, 0, S, S);
  // 얼룩
  for (let i = 0; i < 160; i++) {
    const x = rng() * S, y = rng() * S, r = 10 + rng() * 46;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const light = rng() < 0.5;
    gr.addColorStop(0, light ? 'rgba(98,98,94,0.20)' : 'rgba(18,18,18,0.22)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 2600; i++) {
    const v = 40 + rng() * 40;
    g.fillStyle = `rgba(${v},${v},${v + 2},${0.18 + rng() * 0.3})`;
    g.fillRect(rng() * S, rng() * S, 1 + rng() * 1.6, 1 + rng() * 1.6);
  }
  // 녹 기운
  for (let i = 0; i < 40; i++) {
    const x = rng() * S, y = rng() * S, r = 6 + rng() * 22;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(92,62,40,0.20)'); gr.addColorStop(1, 'rgba(92,62,40,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // 슬롯(구멍)은 destination-out 으로 뚫는다
  g.globalCompositeOperation = 'destination-out';
  g.fillStyle = '#000';
  // 가운데 줄기 구멍
  g.beginPath(); g.arc(c, c, m(0.30), 0, TAU); g.fill();
  // 정사각 동심 슬롯 (축/대각선 8곳은 다리)
  const slot = m(0.032), bridge = m(0.05);
  for (let k = 0; k < 3; k++) {
    const a = m(0.375 + k * 0.085);               // 바깥 반변
    const b = a - slot;
    const segs = [];
    // 변 4개 x 양쪽 2구간 (축 다리 + 대각 다리)
    for (let side = 0; side < 4; side++) {
      for (const h of [-1, 1]) {
        const t0 = h < 0 ? -a + bridge * 1.1 : bridge * 0.5;
        const t1 = h < 0 ? -bridge * 0.5 : a - bridge * 1.1;
        segs.push([side, t0, t1]);
      }
    }
    for (const [side, t0, t1] of segs) {
      g.save(); g.translate(c, c); g.rotate(side * Math.PI / 2);
      g.beginPath();
      const r = slot * 0.45;
      const x0 = t0, x1 = t1, y0 = -a, y1 = -b;
      g.moveTo(x0 + r, y0); g.lineTo(x1 - r, y0); g.quadraticCurveTo(x1, y0, x1, y0 + r);
      g.lineTo(x1, y1 - r); g.quadraticCurveTo(x1, y1, x1 - r, y1); g.lineTo(x0 + r, y1);
      g.quadraticCurveTo(x0, y1, x0, y1 - r); g.lineTo(x0, y0 + r); g.quadraticCurveTo(x0, y0, x0 + r, y0);
      g.fill(); g.restore();
    }
  }
  g.globalCompositeOperation = 'source-over';
  // 가장자리 틀 + 4조각 이음선 + 줄기구멍 링
  g.strokeStyle = 'rgba(14,14,15,0.9)'; g.lineWidth = 2.2;
  g.strokeRect(m(0.022), m(0.022), S - m(0.044), S - m(0.044));
  g.strokeStyle = 'rgba(122,124,126,0.38)'; g.lineWidth = 1.4;
  g.strokeRect(m(0.03), m(0.03), S - m(0.06), S - m(0.06));
  g.strokeStyle = 'rgba(14,14,15,0.8)'; g.lineWidth = 1.6;
  g.beginPath(); g.moveTo(c, 0); g.lineTo(c, m(0.3 + 0.0)); g.moveTo(c, c + m(0.30)); g.lineTo(c, S); g.moveTo(0, c); g.lineTo(c - m(0.30), c); g.moveTo(c + m(0.30), c); g.lineTo(S, c); g.stroke();
  g.strokeStyle = 'rgba(120,122,124,0.42)'; g.lineWidth = 2.2;
  g.beginPath(); g.arc(c, c, m(0.322), 0, TAU); g.stroke();
  // 흙 (불투명)
  g.fillStyle = '#2a2018'; g.fillRect(0, S, S, SOIL);
  for (let i = 0; i < 500; i++) {
    const v = 26 + rng() * 34;
    g.fillStyle = `rgb(${v + 12},${v + 4},${v - 4})`;
    g.fillRect(rng() * S, S + rng() * SOIL, 1 + rng() * 3, 1 + rng() * 2);
  }
  return cv;
}

export function buildTreeGrate() {
  const cv = paintGrate();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const mat = new THREE.MeshStandardMaterial({
    map: tex, alphaTest: 0.5, roughness: 0.62, metalness: 0.15, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const h = 0.6, yTop = 0.005, yPit = 0.0025;
  const vSplit = 32 / 544;                       // 판 영역 [vSplit, 1], 흙 영역 [0, vSplit]
  const pos = [
    -h, yTop, -h, h, yTop, -h, h, yTop, h, -h, yTop, h,
    -h, yPit, -h, h, yPit, -h, h, yPit, h, -h, yPit, h,
  ];
  const nor = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
  const uv = [
    0, 1, 1, 1, 1, vSplit, 0, vSplit,                // x -> u, 위쪽(-z) -> v=1
    0.1, 0.012, 0.9, 0.012, 0.9, 0.05, 0.1, 0.05,
  ];
  // 위에서 봤을 때 +y 를 향하는 감김: (-h,-h) -> (-h,h) -> (h,h)
  const idx = [0, 3, 2, 0, 2, 1, 4, 7, 6, 4, 6, 5];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  return { geo, mat };
}
