// 보문역 사거리(서울 성북구) 거리 시설물 — 절차적 3D (three r170, 외부 에셋 없음)
// 전주·전선·차량/보행 신호등·신호등 지주·가로등·실외기·옥상 설비·돌출 간판·보행자 울타리·방범 CCTV.
// 단위 m, Y 위. 각 빌더의 원점은 지면(y=0) 기둥 밑동. 팔은 +X, 신호/간판 앞면은 +Z.
// 재질은 모듈 수준에서 한 번만 만들어 공유한다 (인스턴싱/병합용). 간판 면·신호 렌즈·카운트다운만 호출마다 새 재질.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const UP = new V3(0, 1, 0);

// ───────────────────────── 난수 ─────────────────────────
function rng(seed) {
  let a = ((seed | 0) + 0x9e3779b9) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ───────────────────────── 지오메트리 누적기 ─────────────────────────
// 재질 하나당 Acc 하나. 모든 조각은 position/normal/uv + index 로 통일해 mergeGeometries 로 합친다.
class Acc {
  constructor() {
    this.list = [];
  }
  add(g) {
    this.list.push(g);
    return g;
  }
  get empty() {
    return this.list.length === 0;
  }
  // 현재 조각들을 X 로 뒤집어 other 에 더한다 (쌍팔 가로등용)
  mirrorInto(other) {
    const mm = new THREE.Matrix4().makeScale(-1, 1, 1);
    for (const g of this.list) {
      const c = g.clone().applyMatrix4(mm);
      const ix = c.index;
      for (let i = 0; i < ix.count; i += 3) {
        const b = ix.getY(i), d = ix.getZ(i);
        ix.setY(i, d);
        ix.setZ(i, b);
      }
      other.add(c);
    }
  }
  build() {
    if (!this.list.length) return null;
    const gs = this.list.map(norm);
    const out = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
    out.computeBoundingSphere();
    out.computeBoundingBox();
    return out;
  }
}
function norm(g) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  const n = g.attributes.position.count;
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  if (!g.index) {
    const ix = new Uint32Array(n);
    for (let i = 0; i < n; i++) ix[i] = i;
    g.setIndex(new THREE.BufferAttribute(ix, 1));
  }
  g.clearGroups();
  return g;
}
export const triCount = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new V3(), _s = new V3(1, 1, 1), _a = new V3(), _b = new V3();
// 이동·회전(XYZ 오일러)·비율을 한 번에 적용
function put(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz, 'XYZ');
  _q.setFromEuler(_e);
  g.applyMatrix4(_m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz)));
  return g;
}
const pv = (p) => (Array.isArray(p) ? new V3(p[0], p[1], p[2]) : p);

const box = (A, sx, sy, sz, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => A.add(put(new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx, ry, rz));
// 세로 원기둥/원뿔대 y0→y1, 아래 반지름 rb, 위 반지름 rt
const vcyl = (A, rb, rt, y0, y1, seg, x = 0, z = 0, open = false) => A.add(put(new THREE.CylinderGeometry(rt, rb, y1 - y0, seg, 1, open), x, (y0 + y1) / 2, z));
// 임의 두 점 사이 막대(원뿔대)
function rod(A, p0, p1, r0, r1 = r0, seg = 6, caps = true) {
  const a = pv(p0), b = pv(p1);
  _a.subVectors(b, a);
  const L = _a.length();
  if (L < 1e-5) return null;
  const g = new THREE.CylinderGeometry(r1, r0, L, seg, 1, !caps);
  _q.setFromUnitVectors(UP, _a.multiplyScalar(1 / L));
  g.applyMatrix4(_m.compose(_b.addVectors(a, b).multiplyScalar(0.5), _q, _s.set(1, 1, 1)));
  return A.add(g);
}
const sph = (A, r, ws, hs, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ps = 0, pl = TAU, ts = 0, tl = Math.PI, rx = 0, ry = 0, rz = 0) =>
  A.add(put(new THREE.SphereGeometry(r, ws, hs, ps, pl, ts, tl), x, y, z, rx, ry, rz, sx, sy, sz));
const tor = (A, R, r, rs, ts, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, arc = TAU, sx = 1, sy = 1, sz = 1) =>
  A.add(put(new THREE.TorusGeometry(R, r, rs, ts, arc), x, y, z, rx, ry, rz, sx, sy, sz));
// 회전체: pts = [[반지름, y], …] (아래→위). 세로축 Y.
const lathe = (A, pts, seg, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, ps = 0, pl = TAU) =>
  A.add(put(new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg, ps, pl), x, y, z, rx, ry, rz));
const circ = (A, r, seg, x, y, z, rx = 0, ry = 0, rz = 0) => A.add(put(new THREE.CircleGeometry(r, seg), x, y, z, rx, ry, rz));
const ringG = (A, ri, ro, seg, x, y, z, rx = 0, ry = 0, rz = 0) => A.add(put(new THREE.RingGeometry(ri, ro, seg), x, y, z, rx, ry, rz));

// 둥근 사각 윤곽 [[x,z],…] (반시계), 모서리 반지름 r, 모서리당 seg 분할
function roundRect(w, d, r, seg = 3) {
  r = Math.min(r, w / 2 - 1e-4, d / 2 - 1e-4);
  const pts = [];
  const cs = [[w / 2 - r, d / 2 - r, 0], [-w / 2 + r, d / 2 - r, 90], [-w / 2 + r, -d / 2 + r, 180], [w / 2 - r, -d / 2 + r, 270]];
  for (const [cx, cz, a0] of cs) for (let i = 0; i <= seg; i++) {
    const a = (a0 + (90 * i) / seg) * DEG;
    pts.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
  return pts;
}

// 볼록 윤곽을 y0→y1 로 밀어내 옆면+위·아래 뚜껑을 만든다. 위쪽은 scaleTop 배 (윤곽 중심 기준 축소).
function loftGeo(outline, y0, y1, scaleTop = 1, caps = true) {
  const n = outline.length;
  let cx = 0, cz = 0;
  for (const [x, z] of outline) { cx += x; cz += z; }
  cx /= n; cz /= n;
  const en = [];
  for (let i = 0; i < n; i++) {
    const [x0, z0] = outline[i], [x1, z1] = outline[(i + 1) % n];
    let nx = z1 - z0, nz = -(x1 - x0);
    if (nx * ((x0 + x1) / 2 - cx) + nz * ((z0 + z1) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
    const l = Math.hypot(nx, nz) || 1;
    en.push([nx / l, nz / l]);
  }
  const pos = [], nor = [], uv = [], idx = [];
  const h = y1 - y0;
  let per = 0;
  for (let i = 0; i <= n; i++) {
    const k = i % n, kp = (i + n - 1) % n;
    let nx = en[k][0] + en[kp][0], nz = en[k][1] + en[kp][1];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    const [x, z] = outline[k];
    const dist = (x - cx) * nx + (z - cz) * nz;
    const ny = dist * (1 - scaleTop);
    const nl = Math.hypot(nx * h, ny, nz * h) || 1;
    if (i > 0) per += Math.hypot(x - outline[kp][0], z - outline[kp][1]);
    pos.push(x, y0, z, cx + (x - cx) * scaleTop, y1, cz + (z - cz) * scaleTop);
    nor.push((nx * h) / nl, ny / nl, (nz * h) / nl, (nx * h) / nl, ny / nl, (nz * h) / nl);
    uv.push(per, 0, per, h);
  }
  // 옆면 감김 방향 확인
  let flip = false;
  {
    const a = new V3(pos[0], pos[1], pos[2]), b = new V3(pos[6], pos[7], pos[8]), c = new V3(pos[3], pos[4], pos[5]);
    const nrm = b.sub(a).cross(c.sub(a));
    flip = nrm.x * en[0][0] + nrm.z * en[0][1] < 0;
  }
  for (let i = 0; i < n; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    if (flip) idx.push(a, b, c, b, d, c);
    else idx.push(a, c, b, b, c, d);
  }
  // 위·아래 뚜껑
  if (caps) {
    for (const top of [true, false]) {
      const base = pos.length / 3, y = top ? y1 : y0, sc = top ? scaleTop : 1;
      pos.push(cx, y, cz);
      nor.push(0, top ? 1 : -1, 0);
      uv.push(cx, cz);
      for (const [x, z] of outline) {
        pos.push(cx + (x - cx) * sc, y, cz + (z - cz) * sc);
        nor.push(0, top ? 1 : -1, 0);
        uv.push(cx + (x - cx) * sc, cz + (z - cz) * sc);
      }
      // 반시계(위에서 볼 때) 여부
      const [x0, z0] = outline[0], [x1, z1] = outline[1];
      const cr = (x0 - cx) * (z1 - cz) - (z0 - cz) * (x1 - cx); // y 성분 부호 (x→z)
      const up = cr < 0; // cross(p0,p1).y = z0*x1 - x0*z1 = -cr
      for (let i = 0; i < n; i++) {
        const p0 = base + 1 + i, p1 = base + 1 + ((i + 1) % n);
        if (top === up) idx.push(base, p0, p1);
        else idx.push(base, p1, p0);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
// 윤곽 하나짜리 평평한 판 (위/아래 방향)
function fanGeo(outline, y, up = true, scale = 1) {
  const n = outline.length;
  let cx = 0, cz = 0;
  for (const [x, z] of outline) { cx += x; cz += z; }
  cx /= n; cz /= n;
  const pos = [cx, y, cz], nor = [0, up ? 1 : -1, 0], uv = [0.5, 0.5], idx = [];
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const [x, z] of outline) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  for (const [x, z] of outline) {
    const px = cx + (x - cx) * scale, pz = cz + (z - cz) * scale;
    pos.push(px, y, pz);
    nor.push(0, up ? 1 : -1, 0);
    uv.push((px - minX) / (maxX - minX), (pz - minZ) / (maxZ - minZ));
  }
  const [x0, z0] = outline[0], [x1, z1] = outline[1];
  const ccwUp = (x0 - cx) * (z1 - cz) - (z0 - cz) * (x1 - cx) < 0;
  for (let i = 0; i < n; i++) {
    const a = 1 + i, b = 1 + ((i + 1) % n);
    if (up === ccwUp) idx.push(0, a, b);
    else idx.push(0, b, a);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// 경로를 따라 반지름이 변하는 관 (평행 이동 프레임). rad = 숫자 | 배열 | (t,i)=>r. uv: u=둘레 0..1, v=길이(m)*vScale
function sweepGeo(pts, rad, radial = 8, caps = true, vScale = 1) {
  const n = pts.length;
  const R = (i) => (typeof rad === 'function' ? rad(i / (n - 1), i) : Array.isArray(rad) ? rad[i] : rad);
  const T = [];
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    T.push(new V3().subVectors(b, a).normalize());
  }
  const nrm = new V3(0, 1, 0);
  if (Math.abs(T[0].y) > 0.9) nrm.set(1, 0, 0);
  const pos = [], nor = [], uv = [], idx = [];
  const ring = radial + 1;
  const N = [], Bn = [];
  let len = 0;
  for (let i = 0; i < n; i++) {
    const t = T[i];
    nrm.addScaledVector(t, -nrm.dot(t)).normalize();
    const bin = new V3().crossVectors(t, nrm).normalize();
    N.push(nrm.clone());
    Bn.push(bin);
    if (i > 0) len += pts[i].distanceTo(pts[i - 1]);
    const r = R(i);
    const ds = pts[Math.min(n - 1, i + 1)].distanceTo(pts[Math.max(0, i - 1)]) || 1;
    const slope = (R(Math.min(n - 1, i + 1)) - R(Math.max(0, i - 1))) / ds;
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * TAU, c = Math.cos(a), s = Math.sin(a);
      const dx = nrm.x * c + bin.x * s, dy = nrm.y * c + bin.y * s, dz = nrm.z * c + bin.z * s;
      pos.push(pts[i].x + dx * r, pts[i].y + dy * r, pts[i].z + dz * r);
      const nx = dx - t.x * slope, ny = dy - t.y * slope, nz = dz - t.z * slope;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nor.push(nx / nl, ny / nl, nz / nl);
      uv.push(j / radial, len * vScale);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < radial; j++) {
    const a = i * ring + j, b = a + 1, c = a + ring, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  if (caps) {
    for (const end of [0, 1]) {
      const i = end ? n - 1 : 0, t = T[i], sign = end ? 1 : -1;
      const base = pos.length / 3;
      pos.push(pts[i].x, pts[i].y, pts[i].z);
      nor.push(t.x * sign, t.y * sign, t.z * sign);
      uv.push(0.5, 0.5);
      const r = R(i);
      for (let j = 0; j < radial; j++) {
        const a = (j / radial) * TAU, c = Math.cos(a), s = Math.sin(a);
        pos.push(pts[i].x + (N[i].x * c + Bn[i].x * s) * r, pts[i].y + (N[i].y * c + Bn[i].y * s) * r, pts[i].z + (N[i].z * c + Bn[i].z * s) * r);
        nor.push(t.x * sign, t.y * sign, t.z * sign);
        uv.push(0.5 + 0.5 * c, 0.5 + 0.5 * s);
      }
      for (let j = 0; j < radial; j++) {
        const a = base + 1 + j, b = base + 1 + ((j + 1) % radial);
        if (end) idx.push(base, a, b);
        else idx.push(base, b, a);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ───────────────────────── 캔버스 텍스처 ─────────────────────────
const FONT = (px) => `bold ${px}px 'Noto Sans KR', 'Malgun Gothic', sans-serif`;
const PAINT = 0xd9d7cf; // 실외기·옥탑 도장색 (grille 텍스처 배경과 같아야 이음매가 안 보임)

function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}
function toTex(c, repeat = false) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// 한국형 콘크리트 전주: u=둘레(0=+Z,0.25=+X,0.5=−Z), v=밑동0→꼭대기1. 세로 결, 얼룩, 밑동 때, 번호판·주의 스티커.
function concreteTexture() {
  const W = 512, H = 1024;
  const [c, g] = mkCanvas(W, H);
  const r = rng(77);
  const img = g.createImageData(W, H), d = img.data;
  const GX = 16, GY = 48, lat = new Float32Array((GX + 1) * (GY + 1));
  for (let j = 0; j <= GY; j++) for (let i = 0; i <= GX; i++) lat[j * (GX + 1) + i] = i === GX ? lat[j * (GX + 1)] : r();
  const col = new Float32Array(W), col2 = new Float32Array(W);
  for (let x = 0; x < W; x++) col[x] = r();
  for (let x = 0; x < W; x++) col2[x] = (col[(x + W - 2) % W] + col[(x + W - 1) % W] + col[x] + col[(x + 1) % W] + col[(x + 2) % W]) / 5;
  for (let y = 0; y < H; y++) {
    const v = (y / H) * GY, j = v | 0, fy = v - j, ty = fy * fy * (3 - 2 * fy);
    const up = 1 - y / H;
    const grime = sstep(0, 0.14, up);
    for (let x = 0; x < W; x++) {
      const u = (x / W) * GX, i = u | 0, fx = u - i, tx = fx * fx * (3 - 2 * fx);
      const a = lat[j * (GX + 1) + i], b = lat[j * (GX + 1) + i + 1], c2 = lat[(j + 1) * (GX + 1) + i], e = lat[(j + 1) * (GX + 1) + i + 1];
      const blot = lerp(lerp(a, b, tx), lerp(c2, e, tx), ty);
      let s = 0.5 + (blot - 0.5) * 0.22 + (col2[x] - 0.5) * 0.3 + (r() - 0.5) * 0.12;
      s *= 0.7 + 0.3 * grime;
      s += 0.03 * up;
      const k = 0.78 + 0.5 * s, o = (y * W + x) * 4;
      d[o] = 184 * k;
      d[o + 1] = 182 * k;
      d[o + 2] = 176 * k;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // 원심 성형 이음 자국
  g.fillStyle = 'rgba(70,70,66,0.10)';
  for (let k = 1; k < 8; k++) g.fillRect(0, (H * k) / 8, W, 1);
  // 녹물 자국 (발판 볼트 아래 — 앞/뒤 면)
  for (let k = 0; k < 14; k++) {
    const x = (k % 2 ? 0 : W / 2) + (r() - 0.5) * 10, y = H * (0.14 + 0.62 * r()), len = 40 + 70 * r();
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, 'rgba(132,92,62,0.20)');
    gr.addColorStop(1, 'rgba(132,92,62,0)');
    g.fillStyle = gr;
    g.fillRect(x - 3, y, 6, len);
  }
  // 번호판 (−Z 면) · 주의 스티커 (+Z 면, 이음매 걸침)
  const plate = (cx, cy, w, h, bg, fg) => {
    g.fillStyle = bg;
    g.fillRect(cx - w / 2, cy - h / 2, w, h);
    g.fillStyle = fg;
    g.fillRect(cx - w / 2 + 3, cy - h / 2 + 3, w - 6, 1.2);
    g.fillRect(cx - w / 2 + 6, cy - 2, w - 12, 3);
    g.fillRect(cx - w / 2 + 6, cy + 4, (w - 12) * 0.6, 2);
    g.fillRect(cx - w / 2 + 3, cy + h / 2 - 4, w - 6, 1.2);
  };
  plate(W / 2, H * 0.785, 56, 22, '#ecebe6', '#2a2d31');
  for (const cx of [0, W]) plate(cx, H * 0.7, 70, 28, '#e4be1c', '#18191b');
  const t = toTex(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// LED 점 격자 (R/Y/G 렌즈 공용: 흰색 바탕 위 밝은 점, 가장자리 약간 어둡게)
function ledPattern(size, spacing, rad, dim, vign) {
  const [c, g] = mkCanvas(size, size);
  const v = (dim * 255) | 0;
  g.fillStyle = `rgb(${v},${v},${v})`;
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#fff';
  const dy = spacing * 0.866;
  for (let j = 0; j * dy < size + spacing; j++) {
    const off = (j % 2) * spacing * 0.5;
    for (let x = off - spacing; x < size + spacing; x += spacing) {
      g.beginPath();
      g.arc(x, j * dy, rad, 0, TAU);
      g.fill();
    }
  }
  const rg = g.createRadialGradient(size / 2, size / 2, size * 0.28, size / 2, size / 2, size * 0.5);
  rg.addColorStop(0, 'rgba(0,0,0,0)');
  rg.addColorStop(1, `rgba(0,0,0,${vign})`);
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  return c;
}
function arrowTexture() {
  const [c, g] = mkCanvas(256, 256);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#fff';
  g.beginPath(); // 왼쪽 화살표
  g.moveTo(34, 128);
  g.lineTo(132, 46);
  g.lineTo(132, 100);
  g.lineTo(222, 100);
  g.lineTo(222, 156);
  g.lineTo(132, 156);
  g.lineTo(132, 210);
  g.closePath();
  g.fill();
  g.globalCompositeOperation = 'multiply';
  g.drawImage(ledPattern(256, 9, 3.5, 0.74, 0.3), 0, 0);
  return toTex(c);
}
// 보행 신호 아이콘: 검은 바탕 + 흰 사람 (색은 재질 color 로 입힘)
function pedIconTexture(walking) {
  const [c, g] = mkCanvas(256, 256);
  g.fillStyle = '#000';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const line = (w, pts) => {
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
  };
  if (!walking) {
    g.beginPath();
    g.arc(128, 48, 22, 0, TAU);
    g.fill();
    line(40, [[128, 98], [128, 134]]); // 몸통
    line(14, [[96, 98], [86, 154]]);
    line(14, [[160, 98], [170, 154]]);
    line(20, [[116, 140], [116, 226]]);
    line(20, [[140, 140], [140, 226]]);
  } else {
    g.beginPath();
    g.arc(152, 46, 21, 0, TAU);
    g.fill();
    line(32, [[142, 90], [124, 140]]);
    line(14, [[140, 98], [104, 128], [94, 156]]);
    line(14, [[140, 98], [172, 122], [196, 144]]);
    line(19, [[124, 142], [158, 186], [162, 228]]);
    line(19, [[124, 142], [92, 192], [66, 222]]);
  }
  g.globalCompositeOperation = 'multiply';
  g.drawImage(ledPattern(256, 9, 3.5, 0.78, 0.25), 0, 0);
  return toTex(c);
}

// 실외기 앞면: 동그란 팬 그릴(동심원+방사 살) + 팬 날개 + 허브
function acGrilleTexture() {
  const W = 512, H = 384;
  const [c, g] = mkCanvas(W, H);
  const body = '#' + PAINT.toString(16).padStart(6, '0');
  g.fillStyle = body;
  g.fillRect(0, 0, W, H);
  const r = rng(5);
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = `rgba(${r() < 0.5 ? 255 : 90},${r() < 0.5 ? 255 : 90},${r() < 0.5 ? 250 : 86},0.025)`;
    g.fillRect(r() * W, r() * H, 2 + r() * 8, 1 + r() * 6);
  }
  // 앞 패널 가장자리 모따기 선
  g.strokeStyle = 'rgba(90,90,84,0.35)';
  g.lineWidth = 2;
  g.strokeRect(5, 5, W - 10, H - 10);
  g.strokeStyle = 'rgba(255,255,255,0.5)';
  g.strokeRect(8, 8, W - 16, H - 16);
  const cx = 272, cy = 192, R = 160;
  // 오목한 개구부 그림자
  const rg = g.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.12);
  rg.addColorStop(0, '#0d0e10');
  rg.addColorStop(0.82, '#17191c');
  rg.addColorStop(1, '#4a4c4e');
  g.fillStyle = rg;
  g.beginPath();
  g.arc(cx, cy, R * 1.04, 0, TAU);
  g.fill();
  // 팬 날개 (어두운 회색, 3장)
  g.save();
  g.translate(cx, cy);
  for (let k = 0; k < 3; k++) {
    g.rotate(TAU / 3);
    const bg = g.createLinearGradient(0, 0, R * 0.95, 0);
    bg.addColorStop(0, '#3a3d41');
    bg.addColorStop(1, '#25282b');
    g.fillStyle = bg;
    g.beginPath();
    g.moveTo(14, -8);
    g.bezierCurveTo(R * 0.4, -R * 0.55, R * 0.92, -R * 0.52, R * 0.93, -R * 0.1);
    g.bezierCurveTo(R * 0.8, R * 0.18, R * 0.4, R * 0.1, 14, 16);
    g.closePath();
    g.fill();
  }
  g.restore();
  // 허브
  const hub = g.createRadialGradient(cx - 6, cy - 6, 3, cx, cy, 36);
  hub.addColorStop(0, '#e9e8e2');
  hub.addColorStop(1, '#9d9c97');
  g.fillStyle = hub;
  g.beginPath();
  g.arc(cx, cy, 34, 0, TAU);
  g.fill();
  // 그릴: 동심원 + 방사 살
  g.strokeStyle = '#ecebe6';
  g.lineCap = 'round';
  for (const rr of [46, 84, 122, 156]) {
    g.lineWidth = 4;
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 3;
    g.beginPath();
    g.arc(cx, cy, rr, 0, TAU);
    g.stroke();
  }
  g.lineWidth = 3;
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * TAU;
    g.beginPath();
    g.moveTo(cx + Math.cos(a) * 36, cy + Math.sin(a) * 36);
    g.lineTo(cx + Math.cos(a) * 158, cy + Math.sin(a) * 158);
    g.stroke();
  }
  g.shadowBlur = 0;
  g.lineWidth = 9; // 바깥 테두리
  g.strokeStyle = '#d9d8d2';
  g.beginPath();
  g.arc(cx, cy, R + 3, 0, TAU);
  g.stroke();
  // 오른쪽 세로 통풍 슬릿 + 로고 판
  g.fillStyle = 'rgba(60,62,64,0.55)';
  for (let k = 0; k < 9; k++) g.fillRect(W - 62 + k * 5.6, 70, 2.4, 244);
  g.fillStyle = '#8f908c';
  g.fillRect(30, H - 44, 58, 14);
  return toTex(c);
}

// 방범 CCTV 기둥 노랑·검정 경고 띠 (한 번 감기는 텍스처: 둘레 256px = 주기 64px × 4)
function hazardTexture() {
  const [c, g] = mkCanvas(256, 256);
  g.fillStyle = '#e8bb08';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#17181a';
  for (let k = -5; k < 9; k++) {
    const x0 = k * 64;
    g.beginPath();
    g.moveTo(x0, 0);
    g.lineTo(x0 + 32, 0);
    g.lineTo(x0 + 32 - 256, 256);
    g.lineTo(x0 - 256, 256);
    g.closePath();
    g.fill();
  }
  const r = rng(9);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(255,255,255,${0.03 + r() * 0.05})`;
    g.fillRect(r() * 256, r() * 256, 1 + r() * 3, 1 + r() * 3);
  }
  const t = toTex(c);
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

// ───────────────────────── 공유 재질 (지연 생성, 한 번만) ─────────────────────────
export const wireMaterial = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.6, metalness: 0.15 });
let _MAT = null;
let _TEX = null;
function MAT() {
  if (_MAT) return _MAT;
  const std = (o) => new THREE.MeshStandardMaterial(o);
  _MAT = {
    concrete: std({ map: concreteTexture(), roughness: 0.94, metalness: 0 }), // 전주 몸통
    galv: std({ color: 0xb2b8bc, roughness: 0.34, metalness: 0.9 }), // 아연도금 강재
    lampGray: std({ color: 0x80878c, roughness: 0.42, metalness: 0.8 }), // 도장 회색 금속 기둥
    black: std({ color: 0x1d2024, roughness: 0.5, metalness: 0.15 }), // 신호 하우징·케이블·고무
    equip: std({ color: 0x8e9691, roughness: 0.48, metalness: 0.25 }), // 애자·변압기·접속함·등기구
    paint: std({ color: PAINT, roughness: 0.72, metalness: 0 }), // 도장 외장 (실외기·옥탑·CCTV)
    acGrille: std({ map: acGrilleTexture(), roughness: 0.62, metalness: 0.05 }),
    hazard: std({ map: hazardTexture(), roughness: 0.55, metalness: 0 }),
    blueLight: std({ color: 0x1b4fd1, emissive: 0x2e78ff, emissiveIntensity: 0.9, roughness: 0.25, metalness: 0 }),
    fence: std({ color: 0xdfe2e4, roughness: 0.42, metalness: 0.55 }),
    tankBlue: std({ color: 0x4f8db6, roughness: 0.55, metalness: 0.05 }),
    tankGreen: std({ color: 0x4f9a76, roughness: 0.55, metalness: 0.05 }),
    lampLens: std({ color: 0xe9e6dc, roughness: 0.3, metalness: 0, emissive: 0xfff1d6, emissiveIntensity: 0 }),
  };
  return _MAT;
}
function TEX() {
  if (_TEX) return _TEX;
  _TEX = {
    lens: toTex(ledPattern(128, 6, 2.4, 0.74, 0.32)),
    arrow: arrowTexture(),
    pedR: pedIconTexture(false),
    pedG: pedIconTexture(true),
  };
  return _TEX;
}
// 재질 이름 → Acc 맵을 {geometry, material}[] 로 (빈 것은 건너뜀)
function toParts(accs, extra = {}) {
  const m = MAT();
  const out = [];
  for (const k of Object.keys(accs)) {
    if (accs[k].empty) continue;
    out.push({ geometry: accs[k].build(), material: extra[k] || m[k] });
  }
  return out;
}
/** 공유 재질 묶음(낮/밤 조절용). 이름: concrete, galv, lampGray, black, equip, paint, acGrille, hazard, blueLight, fence, tankBlue, tankGreen, lampLens */
export function getStreetMaterials() {
  return MAT();
}

// ───────────────────────── 1. 전주 (콘크리트 전주 + 완금 + 애자 + 통신 설비) ─────────────────────────
// 전선은 로컬 Z 방향으로 간다. 완금은 X 방향.
const INS_PROFILE = [[0.035, 0], [0.082, 0], [0.082, 0.02], [0.062, 0.045], [0.07, 0.07], [0.045, 0.11], [0.05, 0.15], [0.03, 0.175]];
const INS_GROOVE = 0.165; // 애자 밑면에서 전선이 걸리는 높이
const HV_PROFILE = [[0.03, 0], [0.05, 0], [0.05, 0.02], [0.034, 0.05], [0.044, 0.075], [0.026, 0.11]];

/** 한국형 콘크리트 전주. 반환: { parts, attach: { power: Vector3[], comm: Vector3[] } } */
export function utilityPoleParts({ height = 11, transformer = false, seed = 1 } = {}) {
  const R = rng(seed * 131 + 17);
  const H = height;
  const rAt = (y) => 0.19 - 0.06 * (y / H);
  const C = new Acc(), S = new Acc(), K = new Acc(), E = new Acc();
  // 몸통: u 둘레 · v 높이 0..1 (콘크리트 텍스처가 그대로 입혀짐)
  C.add(put(new THREE.CylinderGeometry(0.13, 0.19, H, 14, 1, true), 0, H / 2, 0));
  lathe(K, [[0.138, 0], [0.13, 0.035], [0.07, 0.07], [0, 0.09]], 8, 0, H, 0); // 검정 플라스틱 캡

  // 완금(ㄷ형강 2열이 기둥을 앞뒤로 감쌈) + 볼트 머리
  const crossArm = (y, len) => {
    const zz = rAt(y) + 0.028;
    for (const sg of [-1, 1]) {
      box(S, len, 0.075, 0.04, 0, y, sg * zz);
      for (const sx of [-0.2, 0.2]) box(S, 0.03, 0.03, 0.026, sx, y, sg * (zz + 0.03));
    }
    return zz;
  };
  const y1 = H - 0.42, y2 = y1 - 1.3;
  const zz1 = crossArm(y1, 2.4);
  crossArm(y2, 1.5);
  // 완금 사재(암타이) 앞뒤 4개
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    rod(S, [sx * 0.2, y1 - 0.95, sz * (rAt(y1 - 0.95) + 0.07)], [sx * 0.84, y1 - 0.04, sz * (rAt(y1) + 0.07)], 0.011, 0.011, 4, true);
  }
  // 애자: 핀(아연도금) + 회색 자기 애자
  const power = [];
  const insulator = (x, yBase, z = 0) => {
    rod(S, [x, yBase - 0.01, z], [x, yBase + 0.12, z], 0.012, 0.012, 6, true);
    lathe(E, INS_PROFILE, 8, x, yBase, z);
    power.push(new V3(x, yBase + INS_GROOVE, z));
  };
  for (const x of [-0.95, 0.95]) {
    box(S, 0.14, 0.012, 2 * zz1 + 0.04, x, y1 + 0.0375 + 0.006, 0); // 두 완금을 잇는 받침판
    insulator(x, y1 + 0.0375 + 0.012);
  }
  rod(S, [0, H + 0.04, 0], [0, H + 0.2, 0], 0.012, 0.012, 6, true); // 두상 핀
  insulator(0, H + 0.09);
  box(S, 0.14, 0.012, 2 * (rAt(y2) + 0.028) + 0.04, -0.58, y2 + 0.0375 + 0.006, 0);
  insulator(-0.58, y2 + 0.0375 + 0.012);

  // 주상변압기 (완금 아래에 걸린 원통 2개)
  if (transformer) {
    const top = y2 - 0.16;
    for (const sx of [-1, 1]) {
      const x = sx * 0.56;
      vcyl(E, 0.225, 0.225, top - 0.8, top, 18, x, 0);
      lathe(E, [[0.225, 0], [0.205, 0.028], [0.12, 0.05], [0, 0.058]], 12, x, top, 0);
      lathe(E, HV_PROFILE, 6, x, top + 0.055, 0);
      for (const dx of [-0.1, 0.1]) rod(K, [x + dx, top + 0.045, 0.1], [x + dx, top + 0.12, 0.1], 0.015, 0.012, 4, true);
      for (const sz of [-1, 1]) box(S, 0.05, 0.13, 0.012, x, y2 - 0.1, sz * 0.12);
    }
  }

  // 케이블 접속함 + 보호관
  const yb = 5.3, rb = rAt(yb);
  box(E, 0.26, 0.5, 0.16, 0, yb, rb + 0.07);
  box(K, 0.236, 0.012, 0.166, 0, yb + 0.02, rb + 0.07);
  box(K, 0.04, 0.07, 0.024, 0.1, yb + 0.02, rb + 0.158);
  box(S, 0.34, 0.03, 0.03, 0, yb + 0.2, rb + 0.0);
  box(S, 0.34, 0.03, 0.03, 0, yb - 0.2, rb + 0.0);
  rod(K, [0.05, yb + 0.25, rAt(yb + 0.25) + 0.022], [0.05, 6.62, rAt(6.62) + 0.022], 0.022, 0.022, 6, true);

  // 통신선: 브래킷 + 클램프, 점은 y 6.3~7.4 부근에 모임
  const slots = [[-0.46, 6.38], [0.4, 6.46], [-0.3, 6.92], [-0.44, 7.22], [0, 7.3]];
  const nC = 3 + Math.floor(R() * 3);
  const pick = slots.map((s, i) => [R(), i]).sort((a, b) => a[0] - b[0]).slice(0, nC).map((o) => slots[o[1]]);
  const comm = [];
  for (const [x, y0] of pick) {
    const y = y0 + (R() - 0.5) * 0.12, r = rAt(y);
    if (Math.abs(x) < 0.05) {
      box(S, 0.05, 0.035, 0.17, 0, y - 0.05, r + 0.08);
      box(K, 0.06, 0.07, 0.05, 0, y, r + 0.16);
      comm.push(new V3(0, y, r + 0.16));
    } else {
      const sg = Math.sign(x), x0 = sg * (r - 0.02);
      box(S, Math.abs(x - x0), 0.035, 0.05, (x + x0) / 2, y - 0.05, 0);
      box(K, 0.05, 0.07, 0.05, x, y, 0);
      comm.push(new V3(x, y, 0));
    }
  }
  // 여장 코일 (케이블 고리 두 겹) + 걸이
  box(S, 0.46, 0.035, 0.05, 0.38, 7.12, 0);
  tor(K, 0.34, 0.048, 5, 14, 0.62, 6.72, 0, 0, Math.PI / 2, 0, TAU, 1.35, 1, 1);
  tor(K, 0.31, 0.044, 5, 14, 0.68, 6.74, 0, 0.1, Math.PI / 2, 0, TAU, 1.3, 1, 1);
  box(S, 0.08, 0.05, 0.1, 0.62, 7.1, 0);

  // 발판 볼트(앞뒤 번갈아) + 접지 보호관
  let k = 0;
  for (let y = 2.6; y < y1 - 0.7; y += 0.46, k++) {
    const sg = k % 2 ? -1 : 1;
    if (sg > 0 && y > 5.0 && y < 6.8) continue;
    box(S, 0.022, 0.022, 0.15, 0, y, sg * (rAt(y) + 0.06));
  }
  rod(K, [rAt(0) + 0.02, 0, 0], [rAt(2.7) + 0.02, 2.7, 0], 0.022, 0.022, 6, true);

  return { parts: toParts({ concrete: C, galv: S, black: K, equip: E }), attach: { power, comm } };
}

// ───────────────────────── 2. 전선 ─────────────────────────
/** 월드 좌표 [A,B] 쌍들을 포물선으로 처진 관 하나로 합친다. sagJitter/seed 는 선택(가닥마다 처짐을 조금씩 다르게). */
export function wireGeometry(spans, { sagPerMeter = 0.02, radius = 0.013, segments = 14, radial = 4, sagJitter = 0, seed = 1 } = {}) {
  const R = rng(seed * 977 + 3);
  const gs = [];
  for (const [A, B] of spans) {
    const a = pv(A), b = pv(B), L = a.distanceTo(b);
    if (L < 1e-4) continue;
    const sag = sagPerMeter * L * (1 + (R() - 0.5) * 2 * sagJitter);
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments, p = new V3().lerpVectors(a, b, t);
      p.y -= 4 * sag * t * (1 - t);
      pts.push(p);
    }
    gs.push(norm(sweepGeo(pts, radius, radial, false, 1)));
  }
  if (!gs.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute([], 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute([], 2));
    return g;
  }
  const out = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

// 속 빈 관(축 +Y, y 0→L): 바깥 ro · 안 ri, 각도 φ0~φ1 (x=r·sinφ, z=r·cosφ). 모서리가 또렷한 후드용.
function pipeGeo(ro, ri, L, seg, phi0 = 0, phi1 = TAU) {
  const pos = [], nor = [], uv = [], idx = [];
  const add = (x, y, z, nx, ny, nz, u, v) => {
    pos.push(x, y, z);
    nor.push(nx, ny, nz);
    uv.push(u, v);
    return pos.length / 3 - 1;
  };
  const rows = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, a = lerp(phi0, phi1, t), s = Math.sin(a), c = Math.cos(a);
    rows.push({
      o0: add(ro * s, 0, ro * c, s, 0, c, t, 0),
      o1: add(ro * s, L, ro * c, s, 0, c, t, 1),
      i0: add(ri * s, 0, ri * c, -s, 0, -c, t, 0),
      i1: add(ri * s, L, ri * c, -s, 0, -c, t, 1),
      ro: add(ro * s, L, ro * c, 0, 1, 0, t, 0),
      ri: add(ri * s, L, ri * c, 0, 1, 0, t, 1),
    });
  }
  for (let i = 0; i < seg; i++) {
    const a = rows[i], b = rows[i + 1];
    idx.push(a.o0, b.o0, a.o1, b.o0, b.o1, a.o1); // 바깥벽
    idx.push(a.i0, a.i1, b.i0, b.i0, a.i1, b.i1); // 안벽
    idx.push(a.ro, b.ro, a.ri, b.ro, b.ri, a.ri); // 앞 테두리
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// ───────────────────────── 3. 차량 신호등 (가로형) ─────────────────────────
// 그룹 원점 = 브래킷 윗면(팔 아랫면에 닿는 점). 하우징 중심은 (0, −0.4, 0). 앞면 +Z, 긴 축 X.
const LAMP_PITCH = 0.388;
const SIG_CY = -0.4;
const _sig = {};
function signalHeadGeometry(n) {
  if (_sig[n]) return _sig[n];
  const K = new Acc(), S = new Acc();
  const W = n * LAMP_PITCH, cy = SIG_CY;
  K.add(put(loftGeo(roundRect(W, 0.45, 0.075, 3), -0.16, 0, 1), 0, cy, 0, Math.PI / 2, 0, 0)); // 본체 (z −0.16..0)
  for (let i = 0; i < n; i++) {
    const x = (i - (n - 1) / 2) * LAMP_PITCH;
    K.add(put(pipeGeo(0.185, 0.168, 0.17, 14), x, cy, 0, Math.PI / 2, 0, 0)); // 깊은 후드
    K.add(put(pipeGeo(0.185, 0.168, 0.08, 8, Math.PI - 2.0, Math.PI + 2.0), x, cy, 0.17, Math.PI / 2, 0, 0)); // 윗 챙 연장
    ringG(K, 0.148, 0.172, 28, x, cy, 0.034); // 렌즈 테두리
  }
  // 브래킷: 양끝 걸이 + 팔을 감는 U볼트
  for (const sg of [-1, 1]) {
    const x = sg * (W / 2 - 0.17);
    rod(S, [x, 0, 0], [x, cy + 0.225 + 0.004, 0], 0.014, 0.014, 6, true);
    box(S, 0.17, 0.014, 0.1, x, -0.007, 0);
    box(S, 0.12, 0.01, 0.08, x, cy + 0.225 + 0.005, 0);
    tor(S, 0.086, 0.008, 5, 12, x, 0.079, 0, Math.PI, Math.PI / 2, 0, Math.PI);
  }
  const lens = new THREE.CircleGeometry(0.15, 28);
  return (_sig[n] = { housing: K.build(), bracket: S.build(), lens });
}

/** 가로형 차량 신호등. lamps 4 = R,Y,좌회전(←),G / 3 = R,Y,G. lamps.X 는 각자의 MeshBasicMaterial (색을 .color.setHex 로 켬). */
export function signalHead({ lamps = 4 } = {}) {
  const n = lamps === 3 ? 3 : 4;
  const geo = signalHeadGeometry(n), m = MAT(), T = TEX();
  const group = new THREE.Group();
  group.name = 'signalHead';
  const h = new THREE.Mesh(geo.housing, m.black);
  const b = new THREE.Mesh(geo.bracket, m.galv);
  h.castShadow = h.receiveShadow = true;
  b.castShadow = true;
  group.add(h, b);
  const keys = n === 4 ? ['R', 'Y', 'L', 'G'] : ['R', 'Y', 'G'];
  const out = { R: null, Y: null, L: null, G: null };
  keys.forEach((k, i) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0x222222, map: k === 'L' ? T.arrow : T.lens, toneMapped: false });
    const lens = new THREE.Mesh(geo.lens, mat);
    lens.position.set((i - (n - 1) / 2) * LAMP_PITCH, SIG_CY, 0.03);
    lens.name = 'lens' + k;
    group.add(lens);
    out[k] = mat;
  });
  group.userData.center = new V3(0, SIG_CY, 0);
  return { group, lamps: out };
}

// ───────────────────────── 4. 보행 신호등 (세로 2등 + 잔여시간 표시기) ─────────────────────────
// 그룹 원점 = 하우징 중심. 앞면 +Z, 뒷면 z=−0.11 (지주는 z≈−0.17 부근). 표시기는 +X 옆 위쪽.
let _ped = null;
function pedGeometry() {
  if (_ped) return _ped;
  const K = new Acc(), S = new Acc();
  K.add(put(loftGeo(roundRect(0.42, 0.86, 0.06, 3), -0.11, 0.11, 1), 0, 0, 0, Math.PI / 2, 0, 0));
  for (const yc of [0.205, -0.205]) {
    box(K, 0.4, 0.012, 0.12, 0, yc + 0.188, 0.17); // 윗 챙
    for (const sg of [-1, 1]) box(K, 0.012, 0.2, 0.1, sg * 0.2, yc + 0.095, 0.165); // 옆 챙
    box(K, 0.37, 0.018, 0.016, 0, yc + 0.178, 0.12);
    box(K, 0.37, 0.018, 0.016, 0, yc - 0.178, 0.12);
    for (const sg of [-1, 1]) box(K, 0.018, 0.34, 0.016, sg * 0.178, yc, 0.12);
  }
  box(K, 0.3, 0.2, 0.14, 0.385, 0.25, 0); // 잔여시간 표시기
  box(K, 0.31, 0.01, 0.07, 0.385, 0.358, 0.1);
  box(K, 0.06, 0.05, 0.05, 0.235, 0.25, 0);
  for (const sy of [-1, 1]) {
    box(S, 0.12, 0.05, 0.04, 0, sy * 0.28, -0.13);
    box(S, 0.2, 0.03, 0.02, 0, sy * 0.28, -0.16);
  }
  return (_ped = { housing: K.build(), brackets: S.build(), lens: new THREE.PlaneGeometry(0.34, 0.34), disp: new THREE.PlaneGeometry(0.26, 0.13) });
}
// 7세그 숫자 (잔여시간 표시기)
function drawCountdown(g, n) {
  g.fillStyle = '#070403';
  g.fillRect(0, 0, 128, 64);
  const SEG = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
  const hex = (x, y, w, t, vertical) => {
    g.beginPath();
    if (!vertical) {
      g.moveTo(x, y + t / 2); g.lineTo(x + t * 0.6, y); g.lineTo(x + w - t * 0.6, y); g.lineTo(x + w, y + t / 2); g.lineTo(x + w - t * 0.6, y + t); g.lineTo(x + t * 0.6, y + t);
    } else {
      g.moveTo(x + t / 2, y); g.lineTo(x + t, y + t * 0.6); g.lineTo(x + t, y + w - t * 0.6); g.lineTo(x + t / 2, y + w); g.lineTo(x, y + w - t * 0.6); g.lineTo(x, y + t * 0.6);
    }
    g.closePath();
    g.fill();
  };
  const digit = (x0, d) => {
    const y0 = 7, w = 40, h = 50, t = 7, on = d >= 0 ? SEG[d] : '';
    const defs = {
      a: [x0 + 3, y0, w - 6, 0], g: [x0 + 3, y0 + (h - t) / 2, w - 6, 0], d: [x0 + 3, y0 + h - t, w - 6, 0],
      f: [x0, y0 + 3, h / 2 - 5, 1], b: [x0 + w - t, y0 + 3, h / 2 - 5, 1], e: [x0, y0 + h / 2 + 2, h / 2 - 5, 1], c: [x0 + w - t, y0 + h / 2 + 2, h / 2 - 5, 1],
    };
    for (const k of 'abcdefg') {
      const [x, y, len, v] = defs[k], lit = on.includes(k);
      g.fillStyle = lit ? '#ff7a26' : '#1c0a05';
      g.shadowColor = lit ? 'rgba(255,110,30,0.95)' : 'transparent';
      g.shadowBlur = lit ? 7 : 0;
      hex(x, y, len, t, v === 1);
    }
    g.shadowBlur = 0;
  };
  const tens = n >= 10 ? Math.floor(n / 10) : -1, ones = n >= 0 ? n % 10 : -1;
  digit(14, tens);
  digit(72, ones);
}
/** 세로 보행 신호등. r(빨간 서 있는 사람)·g(녹색 걷는 사람) 렌즈 재질의 .color 로 점등. setCountdown(초) 로 잔여시간(정수가 바뀔 때만 다시 그림, null/음수 = 꺼짐). */
export function pedSignalHead() {
  const geo = pedGeometry(), m = MAT(), T = TEX();
  const group = new THREE.Group();
  group.name = 'pedSignalHead';
  const h = new THREE.Mesh(geo.housing, m.black), b = new THREE.Mesh(geo.brackets, m.galv);
  h.castShadow = h.receiveShadow = true;
  b.castShadow = true;
  group.add(h, b);
  const r = new THREE.MeshBasicMaterial({ map: T.pedR, color: 0x333333, toneMapped: false });
  const g = new THREE.MeshBasicMaterial({ map: T.pedG, color: 0x333333, toneMapped: false });
  const lr = new THREE.Mesh(geo.lens, r), lg = new THREE.Mesh(geo.lens, g);
  lr.position.set(0, 0.205, 0.113);
  lg.position.set(0, -0.205, 0.113);
  lr.name = 'lensR';
  lg.name = 'lensG';
  const [cv, cx] = mkCanvas(128, 64);
  const tex = toTex(cv);
  const disp = new THREE.Mesh(geo.disp, new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
  disp.position.set(0.385, 0.245, 0.0705);
  disp.name = 'countdown';
  group.add(lr, lg, disp);
  let last = NaN;
  const setCountdown = (sec) => {
    const n = sec == null || !(sec >= 0) ? -1 : Math.min(99, Math.floor(sec));
    if (n === last) return;
    last = n;
    drawCountdown(cx, n);
    tex.needsUpdate = true;
  };
  setCountdown(null);
  return { group, r, g, setCountdown };
}

// ───────────────────────── 5. 신호등 지주 (L자 가로 암) ─────────────────────────
/** 아연도금 테이퍼 지주 + 위로 살짝 올라가는 긴 팔(+X) + 사재/플랜지/끝 캡. mounts = 팔 아랫면 위의 신호등 걸이 2곳(55%·85%). armAngle(rad) 추가 반환. */
export function signalMastParts({ height = 6.4, armLength = 9, armY = 6.1 } = {}) {
  const S = new Acc(), K = new Acc();
  const rP = (y) => 0.17 - 0.05 * (y / height);
  S.add(put(new THREE.CylinderGeometry(0.12, 0.17, height, 16, 1, true), 0, height / 2, 0));
  // 바닥판 · 앵커볼트 · 보호 커버 · 점검구
  vcyl(S, 0.3, 0.3, 0, 0.025, 20);
  vcyl(S, 0.215, 0.172, 0.025, 0.5, 16, 0, 0, true);
  vcyl(S, 0.186, 0.186, 0.485, 0.515, 16);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU + 0.3, x = Math.cos(a) * 0.255, z = Math.sin(a) * 0.255;
    rod(S, [x, 0.025, z], [x, 0.085, z], 0.009, 0.009, 4, true);
    box(S, 0.032, 0.02, 0.032, x, 0.04, z, 0, a, 0);
  }
  box(S, 0.14, 0.34, 0.012, 0, 0.98, rP(0.98) + 0.004);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) box(S, 0.014, 0.014, 0.012, sx * 0.05, 0.98 + sy * 0.145, rP(0.98) + 0.012);
  vcyl(S, rP(3.0) + 0.014, rP(3.0) + 0.014, 2.96, 3.04, 16); // 슬립 조인트 띠
  lathe(S, [[0.125, 0], [0.126, 0.02], [0.1, 0.055], [0.05, 0.08], [0, 0.092]], 10, 0, height, 0); // 윗 캡

  // 팔
  const rise = 0.04 * armLength, ang = Math.atan2(rise, armLength), ca = Math.cos(ang), sa = Math.sin(ang);
  const L = armLength / ca;
  const Pt = (f) => new V3(f * L * ca, armY + f * L * sa, 0);
  const sect = [0, 0.34, 0.68, 1], rr = [[0.105, 0.088], [0.09, 0.072], [0.075, 0.052]];
  const armR = (f) => {
    const k = f < 0.34 ? 0 : f < 0.68 ? 1 : 2;
    return lerp(rr[k][0], rr[k][1], (f - sect[k]) / (sect[k + 1] - sect[k]));
  };
  for (let k = 0; k < 3; k++) rod(S, Pt(sect[k]), Pt(sect[k + 1]), rr[k][0], rr[k][1], 14, false);
  for (const f of [0.34, 0.68]) rod(S, Pt(f - 0.006), Pt(f + 0.006), armR(f) + 0.016, armR(f) + 0.016, 14, true); // 연결 칼라
  // 팔 뿌리 플랜지 + 볼트
  const fF = 0.017, pf = Pt(fF);
  rod(S, Pt(fF - 0.005), Pt(fF + 0.006), 0.19, 0.19, 18, true);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    box(S, 0.03, 0.028, 0.028, pf.x + 0.014, pf.y + Math.sin(a) * 0.15, Math.cos(a) * 0.15, 0, 0, ang);
  }
  // 사재(대각 보강대)
  const xb = 2.0, fb = xb / armLength;
  const pb0 = new V3(rP(armY - 1.3) - 0.01, armY - 1.3, 0), pb1 = new V3(xb, Pt(fb).y - armR(fb) + 0.01, 0);
  rod(S, pb0, pb1, 0.038, 0.034, 8, true);
  vcyl(S, rP(armY - 1.3) + 0.014, rP(armY - 1.3) + 0.014, armY - 1.36, armY - 1.24, 16);
  rod(S, Pt(fb - 0.006), Pt(fb + 0.006), armR(fb) + 0.016, armR(fb) + 0.016, 14, true);
  // 끝 캡
  lathe(S, [[0.052, 0], [0.05, 0.02], [0.035, 0.045], [0, 0.06]], 12, Pt(1).x, Pt(1).y, 0, 0, 0, ang - Math.PI / 2);
  const mounts = [0.55, 0.85].map((u) => new V3(u * armLength, Pt(u).y - armR(u) * ca, 0));
  return { parts: toParts({ galv: S, black: K }), mounts, armAngle: ang };
}

// 임시 Acc 의 조각들을 (x,y,z, yaw) 로 옮겨 dst 에 더한다
function moveAcc(src, dst, x, y, z, yaw = 0, tiltZ = 0) {
  _e.set(0, yaw, tiltZ, 'XYZ');
  _q.setFromEuler(_e);
  const M = new THREE.Matrix4().compose(new V3(x, y, z), _q, new V3(1, 1, 1));
  for (const g of src.list) dst.add(g.applyMatrix4(M));
}

// ───────────────────────── 6. 가로등 (LED 슬림 등기구) ─────────────────────────
/** 한국형 LED 가로등. 반환: { parts, headMaterial(공유 발광 렌즈), lightPoints }. double=true 면 −X 쪽에도 팔. */
export function streetLampParts({ height = 10, arm = 2.4, double = false } = {}) {
  const P = new Acc(), Hh = new Acc(), L = new Acc();
  const rP = (y) => 0.108 - 0.058 * (y / height);
  vcyl(P, 0.24, 0.24, 0, 0.03, 16); // 바닥 플랜지
  vcyl(P, 0.17, 0.135, 0.03, 0.62, 16, 0, 0, true); // 하부 커버
  vcyl(P, 0.146, 0.146, 0.6, 0.645, 16);
  box(P, 0.11, 0.3, 0.012, 0, 0.32, 0.159); // 점검구
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + 0.4;
    box(P, 0.034, 0.022, 0.034, Math.cos(a) * 0.205, 0.04, Math.sin(a) * 0.205, 0, a, 0);
  }
  const yTop = height - 0.3;
  P.add(put(new THREE.CylinderGeometry(rP(yTop), rP(0.62), yTop - 0.62, 14, 1, true), 0, (0.62 + yTop) / 2, 0));
  vcyl(P, rP(yTop) + 0.012, rP(yTop) + 0.012, yTop - 0.12, yTop + 0.06, 14); // 팔 이음 슬리브
  // 휘어 올라가는 팔: 시작 36° → 끝 7° (2차 베지어)
  const A0 = new V3(0, height - 0.42, 0), A2 = new V3(arm, A0.y + arm * 0.28, 0);
  const th0 = 36 * DEG, th2 = 7 * DEG;
  const dx = A2.x - A0.x, dy = A2.y - A0.y;
  const t0 = (dx * Math.sin(th2) - Math.cos(th2) * dy) / Math.sin(th2 - th0);
  const P1 = new V3(A0.x + t0 * Math.cos(th0), A0.y + t0 * Math.sin(th0), 0);
  const pts = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10, u = 1 - t;
    pts.push(new V3(u * u * A0.x + 2 * u * t * P1.x + t * t * A2.x, u * u * A0.y + 2 * u * t * P1.y + t * t * A2.y, 0));
  }
  P.add(sweepGeo(pts, (t) => lerp(0.047, 0.032, t), 8, true));
  // 슬림 평판 등기구 (0.75 × 0.32 × 0.1), 바깥쪽이 4° 위로
  const tilt = 4 * DEG, hc = new V3(A2.x + 0.2, A2.y - 0.045, 0);
  const outline = roundRect(0.75, 0.32, 0.12, 4);
  const HL = new Acc(), LL = new Acc();
  HL.add(loftGeo(outline, -0.05, 0.05, 0.9));
  for (const z of [-0.1, -0.034, 0.034, 0.1]) box(HL, 0.5, 0.014, 0.018, 0.03, 0.052, z);
  vcyl(HL, 0.048, 0.042, 0.04, 0.09, 12, -0.2, 0);
  LL.add(fanGeo(outline, -0.053, false, 0.86));
  moveAcc(HL, Hh, hc.x, hc.y, 0, 0, tilt);
  moveAcc(LL, L, hc.x, hc.y, 0, 0, tilt);
  const lp = new V3(0, -0.053, 0).applyAxisAngle(new V3(0, 0, 1), tilt).add(hc);
  const lightPoints = [lp];
  if (double) {
    P.mirrorInto(P);
    Hh.mirrorInto(Hh);
    L.mirrorInto(L);
    lightPoints.push(new V3(-lp.x, lp.y, lp.z));
  }
  return { parts: toParts({ lampGray: P, equip: Hh, lampLens: L }), headMaterial: MAT().lampLens, lightPoints };
}

// ───────────────────────── 7. 실외기 (벽걸이 응축기) ─────────────────────────
/** 0.8×0.6×0.3 실외기. 뒷면 z=0, 앞면 +Z, 바닥 y=0 (x 는 중앙). 앞 그릴은 캔버스 텍스처, 아래에 벽 브래킷과 냉매관. */
export function acUnitParts() {
  const B = new Acc(), G = new Acc(), S = new Acc(), K = new Acc();
  B.add(put(loftGeo(roundRect(0.8, 0.3, 0.035, 2), 0, 0.6, 1), 0, 0, 0.15));
  G.add(put(new THREE.PlaneGeometry(0.74, 0.555), 0, 0.3, 0.3012));
  box(K, 0.01, 0.26, 0.09, 0.403, 0.22, 0.12); // 측면 서비스 패널
  rod(K, [0.33, 0, 0.045], [0.33, -0.31, 0.045], 0.016, 0.016, 4, true); // 냉매관(단열재)
  rod(K, [0.365, 0, 0.045], [0.365, -0.31, 0.045], 0.011, 0.011, 4, true);
  for (const x of [-0.27, 0.27]) {
    box(S, 0.04, 0.03, 0.3, x, -0.015, 0.15);
    rod(S, [x, -0.3, 0.012], [x, -0.015, 0.27], 0.012, 0.012, 4, true);
    box(S, 0.07, 0.34, 0.012, x, -0.16, 0.006);
  }
  return { parts: toParts({ paint: B, acGrille: G, galv: S, black: K }) };
}

// ───────────────────────── 8. 옥상 설비 ─────────────────────────
/** w×d m 평지붕(원점=지붕 중심, y=0=지붕면)의 결정적(seed) 옥상 잡동사니. 모두 지붕 윤곽 안쪽에 둔다. */
export function rooftopParts({ w = 12, d = 10, seed = 1 } = {}) {
  const R = rng(seed * 7919 + 131);
  const Pn = new Acc(), S = new Acc(), K = new Acc(), T = new Acc();
  const tankKey = R() < 0.5 ? 'tankBlue' : 'tankGreen';
  const mg = 0.6, hw = w / 2 - mg, hd = d / 2 - mg;
  const placed = [];
  const fits = (x0, x1, z0, z1, pad) => x0 >= -hw && x1 <= hw && z0 >= -hd && z1 <= hd && !placed.some((p) => x0 < p[1] + pad && x1 > p[0] - pad && z0 < p[3] + pad && z1 > p[2] - pad);
  const claim = (x, z, sx, sz) => placed.push([x - sx / 2, x + sx / 2, z - sz / 2, z + sz / 2]);
  const place = (sx, sz, pad = 0.5) => {
    if (sx > 2 * hw || sz > 2 * hd) return null;
    for (let t = 0; t < 40; t++) {
      const x = lerp(-hw + sx / 2, hw - sx / 2, R()), z = lerp(-hd + sz / 2, hd - sz / 2, R());
      if (fits(x - sx / 2, x + sx / 2, z - sz / 2, z + sz / 2, pad)) {
        claim(x, z, sx, sz);
        return [x, z];
      }
    }
    return null;
  };
  const area = w * d;

  // 난간 (옥상 가장자리 0.1 m 안쪽, 높이 1.05 m)
  if (w >= 3 && d >= 3) {
    const x0 = -w / 2 + 0.1, x1 = w / 2 - 0.1, z0 = -d / 2 + 0.1, z1 = d / 2 - 0.1;
    const sp = Math.max(1.8, (2 * (w + d)) / 48);
    const side = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.round(len / sp));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        box(S, 0.045, 1.05, 0.045, lerp(ax, bx, t), 0.525, lerp(az, bz, t));
      }
      const horiz = Math.abs(bz - az) < 1e-6;
      for (const [y, th] of [[1.03, 0.05], [0.55, 0.032]]) {
        if (horiz) box(S, len + 0.045, th, th, (ax + bx) / 2, y, az);
        else box(S, th, th, len + 0.045, ax, y, (az + bz) / 2);
      }
    };
    side(x0, z0, x1, z0);
    side(x1, z0, x1, z1);
    side(x1, z1, x0, z1);
    side(x0, z1, x0, z0);
  }

  // 옥탑(계단실) + 철문 + 차양
  if (w >= 6 && d >= 6) {
    const sx = lerp(2.6, Math.min(4.2, w * 0.4), R()), sz = lerp(2.4, Math.min(3.4, d * 0.4), R()), hh = 2.45 + R() * 0.2;
    const sgx = R() < 0.5 ? -1 : 1, sgz = R() < 0.5 ? -1 : 1;
    let cx = sgx * (hw - sx / 2), cz = sgz * (hd - sz / 2);
    if (!fits(cx - sx / 2, cx + sx / 2, cz - sz / 2, cz + sz / 2, 0)) [cx, cz] = place(sx, sz, 0.3) || [null, null];
    else claim(cx, cz, sx, sz);
    if (cx !== null) {
      box(Pn, sx, hh, sz, cx, hh / 2, cz);
      box(Pn, sx + 0.3, 0.12, sz + 0.3, cx, hh + 0.06, cz);
      const alongX = Math.abs(cx) / hw >= Math.abs(cz) / hd; // 문은 지붕 중심 쪽 면
      if (alongX) {
        const dir = -Math.sign(cx || 1), fx = cx + dir * (sx / 2);
        box(K, 0.05, 2.05, 0.95, fx + dir * 0.02, 1.025, cz);
        box(Pn, 0.5, 0.07, 1.4, fx + dir * 0.25, 2.2, cz);
        box(Pn, 0.5, 0.14, 1.3, fx + dir * 0.25, 0.07, cz);
      } else {
        const dir = -Math.sign(cz || 1), fz = cz + dir * (sz / 2);
        box(K, 0.95, 2.05, 0.05, cx, 1.025, fz + dir * 0.02);
        box(Pn, 1.4, 0.07, 0.5, cx, 2.2, fz + dir * 0.25);
        box(Pn, 1.3, 0.14, 0.5, cx, 0.07, fz + dir * 0.25);
      }
      rod(S, [cx - sx * 0.25, hh + 0.12, cz], [cx - sx * 0.25, hh + 0.62, cz], 0.06, 0.06, 8, true); // 환기구
    }
  }

  // 물탱크: 스테인리스 원통(철제 다리) 또는 FRP 각형(파랑/초록)
  const nT = area < 40 ? 0 : R() < 0.3 ? 0 : R() < 0.75 ? 1 : 2;
  for (let i = 0; i < nT; i++) {
    if (R() < 0.5) {
      const rr = lerp(0.65, 0.9, R()), hh = lerp(1.4, 1.9, R()), s2 = 2 * rr + 0.3;
      const pos = place(s2 + 0.3, s2, 0.7);
      if (!pos) continue;
      const [x, z] = pos;
      lathe(S, [[0, 0.45], [rr - 0.08, 0.45], [rr, 0.53], [rr, 0.45 + hh - 0.08], [rr - 0.08, 0.45 + hh], [0, 0.45 + hh]], 14, x, 0, z);
      const lg = rr - 0.16;
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) rod(S, [x + sx * lg, 0, z + sz * lg], [x + sx * lg, 0.46, z + sz * lg], 0.03, 0.03, 6, true);
      for (const sg of [-1, 1]) {
        box(S, 2 * lg, 0.03, 0.03, x, 0.2, z + sg * lg);
        box(S, 0.03, 0.03, 2 * lg, x + sg * lg, 0.2, z);
      }
      vcyl(S, 0.22, 0.2, 0.45 + hh, 0.45 + hh + 0.06, 12, x, z);
      rod(S, [x + rr + 0.06, 0.6, z], [x + rr + 0.06, 0.45 + hh - 0.25, z], 0.035, 0.035, 6, true);
      rod(S, [x + rr + 0.06, 0.45 + hh - 0.25, z], [x + rr - 0.1, 0.45 + hh - 0.25, z], 0.035, 0.035, 6, true);
    } else {
      const sx = lerp(1.6, 2.2, R()), sz = lerp(1.4, 1.8, R()), hh = lerp(1.2, 1.5, R());
      const pos = place(sx + 0.3, sz + 0.3, 0.7);
      if (!pos) continue;
      const [x, z] = pos, y0 = 0.18;
      for (const sg of [-1, 1]) box(S, 0.12, 0.18, sz + 0.2, x + sg * (sx / 2 - 0.2), 0.09, z);
      box(T, sx, hh, sz, x, y0 + hh / 2, z);
      box(T, sx + 0.06, 0.05, sz + 0.06, x, y0 + hh + 0.025, z);
      for (const sg of [-1, 1]) {
        for (let k = 0; k < 3; k++) box(T, 0.06, hh, 0.04, x - sx / 2 + (sx * (k + 0.5)) / 3, y0 + hh / 2, z + sg * (sz / 2 + 0.02));
        for (let k = 0; k < 2; k++) box(T, 0.04, hh, 0.06, x + sg * (sx / 2 + 0.02), y0 + hh / 2, z - sz / 2 + (sz * (k + 0.5)) / 2);
      }
      vcyl(S, 0.23, 0.22, y0 + hh + 0.05, y0 + hh + 0.11, 12, x + sx * 0.15, z);
      rod(S, [x - sx * 0.3, y0 + hh + 0.05, z], [x - sx * 0.3, y0 + hh + 0.4, z], 0.03, 0.03, 6, true);
    }
  }

  // 실외기 1~4대 한 줄 (옥상용 단순형)
  const nAC = 1 + Math.floor(R() * 4), yaw = Math.floor(R() * 4) * (Math.PI / 2);
  {
    const rowW = nAC * 0.88, swap = Math.abs(Math.sin(yaw)) > 0.5;
    let pos = place(swap ? 0.7 : rowW, swap ? rowW : 0.7, 0.6), n = nAC;
    if (!pos) {
      pos = place(swap ? 0.7 : 0.9, swap ? 0.9 : 0.7, 0.6);
      n = 1;
    }
    if (pos) {
      const Bp = new Acc(), Kp = new Acc(), Sp = new Acc();
      for (let i = 0; i < n; i++) {
        const lx = (i - (n - 1) / 2) * 0.88;
        box(Bp, 0.8, 0.6, 0.3, lx, 0.1 + 0.3, 0);
        circ(Kp, 0.235, 16, lx - 0.02, 0.4, 0.1512);
        for (const sg of [-1, 1]) box(Sp, 0.06, 0.1, 0.5, lx + sg * 0.27, 0.05, 0);
      }
      moveAcc(Bp, Pn, pos[0], 0, pos[1], yaw);
      moveAcc(Kp, K, pos[0], 0, pos[1], yaw);
      moveAcc(Sp, S, pos[0], 0, pos[1], yaw);
    }
  }

  // 위성 안테나 / TV 안테나
  if (R() < 0.5) {
    const pos = place(0.9, 0.9, 0.4);
    if (pos) {
      const [x, z] = pos;
      box(S, 0.3, 0.02, 0.3, x, 0.01, z);
      rod(S, [x, 0.02, z], [x, 0.95, z], 0.025, 0.025, 6, true);
      const D = new Acc(), DS = new Acc(), DK = new Acc();
      const pr = (dy) => {
        const o = [];
        for (let k = 0; k <= 3; k++) {
          const rr = 0.42 * (1 - k / 3);
          o.push([rr, 0.12 * (rr / 0.42) ** 2 + dy]);
        }
        return o;
      };
      lathe(D, pr(0), 10);
      lathe(D, pr(-0.012).reverse(), 10);
      rod(DS, [0, 0.0, 0], [0, 0.5, 0], 0.01, 0.01, 4, true);
      box(DK, 0.05, 0.07, 0.05, 0, 0.52, 0);
      const Mx = new THREE.Matrix4().compose(new V3(x, 1.0, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.75, R() * TAU, 0, 'YXZ')), new V3(1, 1, 1));
      for (const g of D.list) Pn.add(g.applyMatrix4(Mx));
      for (const g of DS.list) S.add(g.applyMatrix4(Mx));
      for (const g of DK.list) K.add(g.applyMatrix4(Mx));
    }
  }
  if (R() < 0.55) {
    const pos = place(1.3, 1.1, 0.4);
    if (pos) {
      const [x, z] = pos;
      rod(S, [x, 0, z], [x, 2.7, z], 0.022, 0.018, 6, true);
      rod(S, [x - 0.62, 2.55, z], [x + 0.62, 2.55, z], 0.014, 0.014, 4, true);
      for (let i = 0; i < 6; i++) box(S, 0.012, 0.012, 0.9 - i * 0.07, x - 0.5 + i * 0.2, 2.55, z);
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * TAU + 0.5;
        rod(S, [x, 1.3, z], [x + Math.cos(a) * 0.5, 0, z + Math.sin(a) * 0.5], 0.012, 0.012, 4, true);
      }
    }
  }

  return { parts: toParts({ paint: Pn, galv: S, black: K, [tankKey]: T }) };
}

// ───────────────────────── 9. 돌출 간판 ─────────────────────────
function signCanvas(text, bg, fg, aspect) {
  const W = 256, H = Math.round(W * aspect);
  const [c, g] = mkCanvas(W, H);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  const gr = g.createLinearGradient(0, 0, W, 0); // 아크릴 면의 은은한 명암
  gr.addColorStop(0, 'rgba(0,0,0,0.20)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.10)');
  gr.addColorStop(1, 'rgba(0,0,0,0.20)');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  const dirt = g.createLinearGradient(0, H * 0.82, 0, H);
  dirt.addColorStop(0, 'rgba(0,0,0,0)');
  dirt.addColorStop(1, 'rgba(20,16,10,0.28)');
  g.fillStyle = dirt;
  g.fillRect(0, H * 0.82, W, H * 0.18);
  g.globalAlpha = 0.85; // 안쪽 테두리선
  g.strokeStyle = fg;
  g.lineWidth = 6;
  g.strokeRect(11, 11, W - 22, H - 22);
  g.globalAlpha = 1;
  const chars = [...String(text)].filter((ch) => ch !== ' ');
  const cols = chars.length > 7 ? 2 : 1, per = Math.ceil(chars.length / cols);
  const colW = (W - 44) / cols, cellH = (H - 56) / Math.max(1, per);
  const fs = Math.min(colW * 0.8, cellH * 0.9, 150);
  g.fillStyle = fg;
  g.font = FONT(fs);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 4;
  g.shadowOffsetY = 2;
  for (let k = 0; k < cols; k++) {
    const col = chars.slice(k * per, (k + 1) * per); // 세로쓰기: 첫 열이 오른쪽
    const x = W - 22 - colW * (k + 0.5);
    const y0 = H / 2 - (col.length * cellH) / 2;
    col.forEach((ch, i) => g.fillText(ch, x, y0 + (i + 0.5) * cellH + fs * 0.04));
  }
  return c;
}

/** 돌출 간판 (세로쓰기, 양면). 원점 = 벽 부착점(간판 세로 중앙), 간판은 +Z 로 돌출. faceMaterial 은 호출마다 새 재질. */
export function projectingSign({ text = '간판', bg = '#d42a2a', fg = '#ffffff', w = 0.62, h = 2.6 } = {}) {
  const S = new Acc(), F = new Acc();
  const t = 0.16, gap = 0.12, zc = gap + w / 2;
  box(S, t, h, w, 0, 0, zc);
  for (const sg of [-1, 1]) {
    const x = sg * (t / 2 + 0.008);
    box(S, 0.016, h, 0.025, x, 0, gap + 0.0125);
    box(S, 0.016, h, 0.025, x, 0, gap + w - 0.0125);
    box(S, 0.016, 0.025, w, x, h / 2 - 0.0125, zc);
    box(S, 0.016, 0.025, w, x, -h / 2 + 0.0125, zc);
    F.add(put(new THREE.PlaneGeometry(w - 0.05, h - 0.05), sg * (t / 2 + 0.003), 0, zc, 0, (sg * Math.PI) / 2, 0));
  }
  const ys = h > 2.2 ? [h / 2 - 0.3, 0, -h / 2 + 0.3] : [h / 2 - 0.25, -h / 2 + 0.25];
  for (const yb of ys) {
    box(S, 0.1, 0.16, 0.012, 0, yb, 0.006);
    box(S, 0.05, 0.05, gap + w * 0.5, 0, yb, (gap + w * 0.5) / 2);
  }
  rod(S, [0, ys[ys.length - 1] - 0.3, 0.012], [0, ys[ys.length - 1] - 0.02, gap + w * 0.35], 0.012, 0.012, 4, true);
  const map = toTex(signCanvas(text, bg, fg, (h - 0.05) / (w - 0.05)));
  const faceMaterial = new THREE.MeshStandardMaterial({ map, roughness: 0.42, metalness: 0, emissive: 0xffffff, emissiveMap: map, emissiveIntensity: 0.05 });
  const parts = toParts({ galv: S });
  parts.push({ geometry: F.build(), material: faceMaterial });
  return { parts, faceMaterial };
}

// ───────────────────────── 10. 보행자 방호울타리 ─────────────────────────
/** 서울형 보행자 방호울타리: x=0→length, 높이 ≈ 0.9 m, 약 2 m 간격 기둥, 상·하 레일, 세로살. */
export function pedFenceParts({ length = 10 } = {}) {
  const F = new Acc();
  const n = Math.max(1, Math.round(length / 2)), sp = length / n;
  for (let i = 0; i <= n; i++) {
    const x = i * sp;
    vcyl(F, 0.032, 0.03, 0, 0.88, 8, x, 0);
    sph(F, 0.04, 8, 3, x, 0.88, 0, 1, 0.8, 1, 0, TAU, 0, Math.PI / 2);
    box(F, 0.12, 0.012, 0.12, x, 0.006, 0);
  }
  rod(F, [0, 0.84, 0], [length, 0.84, 0], 0.024, 0.024, 8, true);
  rod(F, [0, 0.16, 0], [length, 0.16, 0], 0.018, 0.018, 6, true);
  const g = new THREE.CylinderGeometry(0.0085, 0.0085, 0.68, 4, 1, true);
  for (let x = 0.0575; x < length; x += 0.115) {
    const near = Math.abs(x - Math.round(x / sp) * sp) < 0.055;
    if (!near) F.add(put(g.clone(), x, 0.5, 0));
  }
  g.dispose();
  return { parts: toParts({ fence: F }) };
}

// ───────────────────────── 11. 방범 CCTV 기둥 ─────────────────────────
/** 약 6 m 방범 CCTV 기둥: 노랑·검정 경고 띠, 짧은 팔에 돔 + 불릿 카메라, 1.4 m 높이 비상벨함(파란 경광등). */
export function cctvPoleParts() {
  const Pn = new Acc(), Hz = new Acc(), K = new Acc(), Bl = new Acc();
  const H = 6, rP = (y) => 0.088 - 0.03 * (y / H);
  Pn.add(put(new THREE.CylinderGeometry(rP(H), rP(0.45), H - 0.45, 14, 1, true), 0, (0.45 + H) / 2, 0));
  vcyl(Pn, 0.13, 0.13, 0, 0.03, 14);
  vcyl(Pn, 0.125, 0.098, 0.03, 0.45, 14, 0, 0, true);
  vcyl(Pn, 0.105, 0.105, 0.43, 0.46, 14);
  box(Pn, 0.1, 0.26, 0.01, 0, 0.24, 0.116);
  lathe(Pn, [[0.092, 0], [0.09, 0.03], [0.05, 0.07], [0, 0.09]], 10, 0, H, 0);
  Hz.add(put(new THREE.CylinderGeometry(rP(2.5) + 0.003, rP(1.9) + 0.003, 0.6, 16, 1, true), 0, 2.2, 0));
  // 비상벨함
  const rb = rP(1.4);
  box(Pn, 0.2, 0.36, 0.14, 0, 1.4, rb + 0.06);
  box(K, 0.12, 0.1, 0.006, 0, 1.47, rb + 0.133);
  rod(K, [0, 1.3, rb + 0.13], [0, 1.3, rb + 0.142], 0.032, 0.032, 12, true);
  sph(Bl, 0.06, 12, 6, 0, 1.58, rb + 0.06, 1, 1, 1, 0, TAU, 0, Math.PI / 2);
  box(Bl, 0.16, 0.024, 0.008, 0, 1.53, rb + 0.134);
  // 짧은 팔 + 카메라 2대
  const ya = H - 0.18;
  vcyl(Pn, rP(ya) + 0.012, rP(ya) + 0.012, ya - 0.06, ya + 0.06, 14);
  rod(Pn, [0, ya, 0], [0.72, ya, 0], 0.028, 0.025, 8, true);
  rod(Pn, [0.62, ya, 0], [0.62, ya - 0.08, 0], 0.04, 0.04, 10, true);
  vcyl(Pn, 0.105, 0.105, ya - 0.16, ya - 0.08, 14, 0.62, 0);
  sph(K, 0.095, 14, 6, 0.62, ya - 0.16, 0, 1, 1, 1, 0, TAU, Math.PI / 2, Math.PI / 2);
  rod(Pn, [0.26, ya, 0], [0.26, ya - 0.07, 0], 0.016, 0.016, 6, true);
  const pitch = 14 * DEG, d = new V3(0, -Math.sin(pitch), Math.cos(pitch));
  const c0 = new V3(0.26, ya - 0.1, -0.12), c1 = c0.clone().addScaledVector(d, 0.31);
  rod(Pn, c0, c1, 0.05, 0.05, 12, true);
  rod(K, c1.clone().addScaledVector(d, -0.004), c1.clone().addScaledVector(d, 0.004), 0.04, 0.04, 12, true);
  box(Pn, 0.11, 0.012, 0.34, 0.26, ya - 0.1 + 0.062 - 0.03, 0.04, pitch);
  return { parts: toParts({ paint: Pn, hazard: Hz, black: K, blueLight: Bl }) };
}

// ───────────────────────── 병합 도우미 ─────────────────────────
function flipWinding(g) {
  const ix = g.index;
  for (let i = 0; i < ix.count; i += 3) {
    const b = ix.getY(i), c = ix.getZ(i);
    ix.setY(i, c);
    ix.setZ(i, b);
  }
}
/** list = [{ parts, matrix }] → 재질별로 합친 THREE.Mesh[] (그림자 켬). 같은 재질 객체는 메시 하나, 간판 면 재질처럼 고유한 것은 따로. */
export function mergePartsInstances(list) {
  const byMat = new Map();
  for (const { parts, matrix } of list) {
    const flip = matrix.determinant() < 0;
    for (const { geometry, material } of parts) {
      const g = geometry.clone().applyMatrix4(matrix);
      if (flip && g.index) flipWinding(g);
      let arr = byMat.get(material);
      if (!arr) byMat.set(material, (arr = []));
      arr.push(g);
    }
  }
  const meshes = [];
  for (const [mat, arr] of byMat) {
    const gs = arr.map(norm);
    const merged = gs.length === 1 ? gs[0] : mergeGeometries(gs, false);
    const make = (geo) => {
      geo.computeBoundingSphere();
      geo.computeBoundingBox();
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = m.receiveShadow = true;
      return m;
    };
    if (merged) meshes.push(make(merged));
    else for (const g of gs) meshes.push(make(g));
  }
  return meshes;
}
