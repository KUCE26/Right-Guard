// ============================================================================
// vehicles3d.js — procedural "photo-real" vehicles for the Right Guard Metaverse
// (three.js r170, everything code-built: lofted bodies + canvas-painted textures)
// Conventions: 1 unit = 1 m, +Z forward, origin at ground centre, wheels touch y=0,
// the vehicle's RIGHT side is -X (bus doors on -X, driver on +X).
//
// buildVehicle(type, opts) -> THREE.Group      type: sedan | suv | taxi | truck | bus | minibus | moto
//   opts.color      hex number / css colour (body paint; default = seeded pick from the Korean-street palette)
//   opts.seed       integer, makes colour / sunroof picks deterministic (seeded PRNG only - no unseeded randomness anywhere)
//   opts.livery     'trunk' | 'branch'  (bus/minibus default body colour: blue #1c5fbf / lime #6cc04a)
//   opts.routeText  LED destination board of bus/minibus (default '273' / '성북구청'; 16 distinct texts can coexist)
//   opts.variant    sedan: 'sunroof' | 'fastback' (undefined = notchback, 30 % sunroof by seed); truck: 'tarp'
// group.userData: tailMat (unique MeshStandardMaterial - drive emissiveIntensity), blinkMat (unique MeshBasicMaterial,
//   toneMapped:false - the RIGHT/-X signals, front + rear), headMat (shared), wheels[] (pivots - advance rotation.x; the
//   first pivot of an axle owns the merged tyre mesh of that axle), wheelRadius, lights {head:[Vector3], tail:[Vector3]},
//   len, wid, height (measured top incl. taxi sign / rider), triangles, drawCalls.
// disposeVehicle(group) only frees the two per-vehicle lamp materials; geometry / paint / glass / detail are shared caches.
// Budget: <= 8 draw calls per vehicle (paint, glass, detail, head, tail, blink + 1 mesh per axle).
// ============================================================================
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

export const VEHICLE_DIMS = {
  sedan: { len: 4.95, wid: 1.87, height: 1.45, headY: 0.66 },
  suv: { len: 4.70, wid: 1.90, height: 1.70, headY: 0.73 },
  taxi: { len: 4.90, wid: 1.86, height: 1.47, headY: 0.66 }, // body height; the roof sign adds ~0.13 (userData.height is the real top)
  truck: { len: 5.10, wid: 1.74, height: 2.0, headY: 0.80 },
  bus: { len: 11.0, wid: 2.49, height: 3.25, headY: 0.74 },
  minibus: { len: 9.0, wid: 2.40, height: 3.05, headY: 0.72 },
  moto: { len: 2.0, wid: 0.75, height: 1.65, headY: 1.0 }, // with a seated rider (helmet top); scooter alone is ~1.3
};

// ───────────────────────── small helpers
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const PI = Math.PI;
function rng32(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// monotone cubic (PCHIP) through [x,y] keyframes -> f(x); no overshoot, C1 smooth
function curve(pts0) {
  const pts = pts0.map((p) => p.slice()).sort((a, b) => a[0] - b[0]);
  const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / (h[i] || 1e-9); }
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else { const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1]; m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]); }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0; while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// ───────────────────────── paint (clear-coated, cached by colour)
const PALETTE = [
  [0xeeeeea, 0.04, 0.42], [0x111316, 0.08, 0.36], [0xb9bdc1, 0.55, 0.34],
  [0x4b5056, 0.55, 0.34], [0x1d2a44, 0.55, 0.34], [0x561d24, 0.45, 0.34], [0xb3a385, 0.5, 0.38],
];
export const CAR_COLORS = PALETTE.map((p) => p[0]);
const _paint = new Map();
function paintMat(hex, vertexColors = false) {
  const key = hex + (vertexColors ? 'v' : '');
  let m = _paint.get(key);
  if (m) return m;
  const pre = PALETTE.find((p) => p[0] === hex);
  const c = new THREE.Color(hex);
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const metal = pre ? pre[1] : (lum > 0.6 || lum < 0.012 ? 0.08 : 0.5);
  const rough = pre ? pre[2] : (metal < 0.2 ? 0.4 : 0.34);
  m = new THREE.MeshPhysicalMaterial({ color: vertexColors ? 0xffffff : hex, metalness: metal, roughness: rough, clearcoat: 1, clearcoatRoughness: 0.07, envMapIntensity: 1.0, vertexColors });
  _paint.set(key, m);
  return m;
}
let _glass = null;
function glassMat() {
  return _glass || (_glass = new THREE.MeshPhysicalMaterial({ color: 0x0f1317, metalness: 0.0, roughness: 0.05, clearcoat: 0, envMapIntensity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
}
let _head = null;
function headMat() {
  return _head || (_head = new THREE.MeshStandardMaterial({ color: 0xdfe6ee, emissive: 0xfff4de, emissiveIntensity: 0.4, roughness: 0.25, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
}

// ───────────────────────── shared "detail" material: one atlas holds albedo / ORM / emissive
// swatch cells (constant UV per primitive => exact texel, no mip bleeding) + plates, sign, LED strips.
const ATL = 1024, SWC = 64;
const SW = { RUBBER: 0, PLASTIC: 1, GLOSS: 2, CHROME: 3, ALU: 4, CLOTH: 5, SATIN: 6, LENS: 7, EMIT: 8, MIRROR: 9, BRAKE: 10 };
const SW_DEF = [ // albedo, roughness, metalness, emissive
  [1.0, 0.9, 0, 0], [1.0, 0.58, 0, 0], [1.0, 0.24, 0, 0], [0.95, 0.16, 1, 0], [0.92, 0.36, 0.95, 0],
  [1.0, 0.95, 0, 0], [1.0, 0.48, 0.2, 0], [1.0, 0.07, 0, 0], [1.0, 0.6, 0, 1], [1.0, 0.04, 1, 0], [0.7, 0.45, 0.9, 0],
];
const RECT = { plate: { x: 8, y: 8, w: 256, h: 54 }, plateS: { x: 8, y: 72, w: 128, h: 64 }, sign: { x: 8, y: 150, w: 256, h: 72 } };
const LED_N = 16; // 8 strips in the left half + 8 in the right half of the lower atlas band
let _atlas = null, _detail = null;
const _ledRows = new Map(); let _ledNext = 0;
const swUV = (i) => [(512 + (i % 8) * SWC + SWC / 2) / ATL, 1 - (Math.floor(i / 8) * SWC + SWC / 2) / ATL];
function rectUV(r, u, v) { return [(r.x + u * r.w) / ATL, 1 - (r.y + (1 - v) * r.h) / ATL]; }
function mkCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function atlas() {
  if (_atlas) return _atlas;
  const A = mkCanvas(ATL, ATL), O = mkCanvas(ATL, ATL), E = mkCanvas(ATL, ATL);
  const a = A.getContext('2d'), o = O.getContext('2d'), e = E.getContext('2d');
  a.fillStyle = '#fff'; a.fillRect(0, 0, ATL, ATL);
  o.fillStyle = 'rgb(255,200,0)'; o.fillRect(0, 0, ATL, ATL);
  e.fillStyle = '#000'; e.fillRect(0, 0, ATL, ATL);
  SW_DEF.forEach((s, i) => {
    const x = 512 + (i % 8) * SWC, y = Math.floor(i / 8) * SWC, g = Math.round(s[0] * 255);
    a.fillStyle = `rgb(${g},${g},${g})`; a.fillRect(x, y, SWC, SWC);
    o.fillStyle = `rgb(255,${Math.round(s[1] * 255)},${Math.round(s[2] * 255)})`; o.fillRect(x, y, SWC, SWC);
    e.fillStyle = s[3] ? '#fff' : '#000'; e.fillRect(x, y, SWC, SWC);
  });
  const plate = (r, small) => {
    a.fillStyle = '#16181c'; a.fillRect(r.x, r.y, r.w, r.h);
    a.fillStyle = '#f2f2ee'; a.fillRect(r.x + 3, r.y + 3, r.w - 6, r.h - 6);
    o.fillStyle = 'rgb(255,110,0)'; o.fillRect(r.x, r.y, r.w, r.h);
    a.fillStyle = '#15181c'; a.textAlign = 'center'; a.textBaseline = 'middle';
    a.font = `bold ${small ? 26 : 34}px "Malgun Gothic","Noto Sans KR",sans-serif`;
    a.fillText(small ? '12가 3456' : '12가 3456', r.x + r.w / 2 + (small ? 0 : 6), r.y + r.h / 2 + 2);
    if (!small) { a.fillStyle = '#1f4fa0'; a.fillRect(r.x + 6, r.y + 8, 14, r.h - 16); }
  };
  plate(RECT.plate, false); plate(RECT.plateS, true);
  { // lit TAXI sign
    const r = RECT.sign;
    a.fillStyle = '#ffe9a6'; a.fillRect(r.x, r.y, r.w, r.h); e.fillStyle = '#d9b35a'; e.fillRect(r.x, r.y, r.w, r.h);
    for (const c of [a, e]) { c.fillStyle = '#171410'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = 'bold 58px Arial,Helvetica,sans-serif'; c.fillText('TAXI', r.x + r.w / 2, r.y + r.h / 2 + 3); }
    o.fillStyle = 'rgb(255,150,0)'; o.fillRect(r.x, r.y, r.w, r.h);
  }
  for (let k = 0; k < LED_N; k++) { const lx = k >= 8 ? 512 : 0, ly = 512 + (k % 8) * 64; a.fillStyle = '#050505'; a.fillRect(lx, ly, 512, 64); o.fillStyle = 'rgb(255,90,0)'; o.fillRect(lx, ly, 512, 64); }
  const tex = (cv, srgb) => { const t = new THREE.CanvasTexture(cv); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t; };
  _atlas = { A, O, E, a, o, e, tA: tex(A, true), tO: tex(O, false), tE: tex(E, true) };
  return _atlas;
}
function detailMat() {
  if (_detail) return _detail;
  const t = atlas();
  _detail = new THREE.MeshStandardMaterial({ map: t.tA, roughnessMap: t.tO, metalnessMap: t.tO, emissiveMap: t.tE, emissive: 0xffffff, emissiveIntensity: 1, roughness: 1, metalness: 1, vertexColors: true, envMapIntensity: 1.1, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  return _detail;
}
// allocate / reuse a LED strip row for a destination text; returns its UV rect
function ledStrip(text) {
  let row = _ledRows.get(text);
  if (row === undefined) {
    row = _ledNext++ % LED_N;
    for (const [k, v] of _ledRows) if (v === row) _ledRows.delete(k);
    _ledRows.set(text, row);
    const t = atlas(), x0 = row >= 8 ? 512 : 0, y0 = 512 + (row % 8) * 64;
    const m = mkCanvas(128, 16), mc = m.getContext('2d');
    mc.fillStyle = '#000'; mc.fillRect(0, 0, 128, 16); mc.fillStyle = '#fff'; mc.textBaseline = 'middle'; mc.textAlign = 'center';
    let size = 14; mc.font = `bold ${size}px "Malgun Gothic","Noto Sans KR",sans-serif`;
    while (size > 8 && mc.measureText(text).width > 124) { size--; mc.font = `bold ${size}px "Malgun Gothic","Noto Sans KR",sans-serif`; }
    mc.fillText(text, 64, 9);
    const px = mc.getImageData(0, 0, 128, 16).data;
    t.e.fillStyle = '#000'; t.e.fillRect(x0, y0, 512, 64);
    for (let yy = 0; yy < 16; yy++) for (let xx = 0; xx < 128; xx++) {
      const on = px[(yy * 128 + xx) * 4] > 110;
      t.e.fillStyle = on ? '#ffb020' : '#1a0f02'; t.e.beginPath(); t.e.arc(x0 + xx * 4 + 2, y0 + yy * 4 + 2, on ? 1.65 : 1.2, 0, PI * 2); t.e.fill();
    }
    t.tE.needsUpdate = true;
  }
  return { x: row >= 8 ? 512 : 0, y: 512 + (row % 8) * 64, w: 512, h: 64 };
}

// ───────────────────────── geometry helpers
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
function keepAttrs(g, keep) { for (const k of Object.keys(g.attributes)) if (!keep.includes(k)) g.deleteAttribute(k); return g; }
function xf(g, p = [0, 0, 0], r = [0, 0, 0], s = [1, 1, 1]) {
  _q.setFromEuler(_e.set(r[0], r[1], r[2], 'YXZ'));
  g.applyMatrix4(_m4.compose(new THREE.Vector3(p[0], p[1], p[2]), _q, new THREE.Vector3(s[0], s[1], s[2])));
  return g;
}
// paint geometry: position + normal (+ colour for livery-painted buses)
function indexed(g) { return g.index ? g : mergeVertices(g); }
function pnt(g, hex) {
  if (!g) return null;
  keepAttrs(g, ['position', 'normal']); g = indexed(g);
  if (hex !== undefined) vcol(g, hex);
  return g;
}
function vcol(g, hex) {
  const n = g.attributes.position.count, c = new THREE.Color(hex), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
// detail-material geometry: constant swatch UV + vertex colour tint
function det(g, sw, hex = 0xffffff) {
  if (!g) return null;
  keepAttrs(g, ['position', 'normal']); g = indexed(g);
  const n = g.attributes.position.count, [u, v] = swUV(sw), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) { uv[i * 2] = u; uv[i * 2 + 1] = v; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  vcol(g, hex);
  return g;
}
// detail geometry with explicit uv (plates / sign / LED)
function detUV(g, uvs, hex = 0xffffff) {
  if (!g) return null;
  keepAttrs(g, ['position', 'normal']);
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  vcol(g, hex);
  return g;
}
function mergeList(list) {
  const l = list.filter(Boolean);
  if (!l.length) return null;
  return l.length === 1 ? l[0] : mergeGeometries(l, false);
}
function triCount(g) { return g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0; }
// flat quad (4 points, ccw seen from the normal side) with optional uvs
function quadGeo(p0, p1, p2, p3, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([...p0, ...p1, ...p2, ...p3]), 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  return g;
}
// plate (flat, faces +z when dir>0, -z when dir<0), centred at (x,y,z); text reads left-to-right from outside
function plateGeo(x, y, z, w, h, dir, rect) {
  const hw = w / 2, hh = h / 2, u = [rectUV(rect, 0, 0), rectUV(rect, 1, 0), rectUV(rect, 1, 1), rectUV(rect, 0, 1)].flat();
  const P = dir > 0
    ? [[x - hw, y - hh, z], [x + hw, y - hh, z], [x + hw, y + hh, z], [x - hw, y + hh, z]]
    : [[x + hw, y - hh, z], [x - hw, y - hh, z], [x - hw, y + hh, z], [x + hw, y + hh, z]];
  return detUV(quadGeo(P[0], P[1], P[2], P[3]), u, 0xffffff);
}

// ───────────────────────── ray-projection surface (drapes patches over a lofted body)
const PROJ = [[1, 2], [0, 2], [0, 1]];
class Surface {
  constructor(geos) {
    const P = [], N = [];
    for (const g of geos) {
      const pos = g.attributes.position, nor = g.attributes.normal, idx = g.index, cnt = idx ? idx.count : pos.count;
      for (let t = 0; t < cnt; t++) { const i = idx ? idx.getX(t) : t; P.push(pos.getX(i), pos.getY(i), pos.getZ(i)); N.push(nor.getX(i), nor.getY(i), nor.getZ(i)); }
    }
    this.P = new Float32Array(P); this.N = new Float32Array(N); this.n = P.length / 9;
  }
  // ray along `axis` (0=x,1=y,2=z) from the `sign` side; (a,b) = the other two coords in ascending axis order
  hit(axis, sign, a, b, eps = 1e-5) {
    a += 0.0013; b += 0.0007; // keep rays off the exact mirror seam (x = 0), where sliver triangles can leave a pin-hole
    const [iu, iv] = PROJ[axis], P = this.P; let best = null, bestW = -Infinity;
    for (let t = 0; t < this.n; t++) {
      const o = t * 9;
      const u0 = P[o + iu], v0 = P[o + iv], u1 = P[o + 3 + iu], v1 = P[o + 3 + iv], u2 = P[o + 6 + iu], v2 = P[o + 6 + iv];
      if ((a < u0 - eps && a < u1 - eps && a < u2 - eps) || (a > u0 + eps && a > u1 + eps && a > u2 + eps)) continue;
      if ((b < v0 - eps && b < v1 - eps && b < v2 - eps) || (b > v0 + eps && b > v1 + eps && b > v2 + eps)) continue;
      const d = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
      if (Math.abs(d) < 1e-12) continue;
      const l0 = ((v1 - v2) * (a - u2) + (u2 - u1) * (b - v2)) / d, l1 = ((v2 - v0) * (a - u2) + (u0 - u2) * (b - v2)) / d, l2 = 1 - l0 - l1;
      if (l0 < -1e-4 || l1 < -1e-4 || l2 < -1e-4) continue;
      const w = (l0 * P[o + axis] + l1 * P[o + 3 + axis] + l2 * P[o + 6 + axis]) * sign;
      if (w > bestW) { bestW = w; best = { t, l0, l1, l2 }; }
    }
    if (!best) return null;
    const { t, l0, l1, l2 } = best, o = t * 9, N = this.N;
    const p = [0, 0, 0], n = [0, 0, 0];
    for (let k = 0; k < 3; k++) { p[k] = l0 * P[o + k] + l1 * P[o + 3 + k] + l2 * P[o + 6 + k]; n[k] = l0 * N[o + k] + l1 * N[o + 3 + k] + l2 * N[o + 6 + k]; }
    const m = Math.hypot(n[0], n[1], n[2]) || 1; n[0] /= m; n[1] /= m; n[2] /= m;
    return { p, n };
  }
}
function pushOut(h, off) { return [h.p[0] + h.n[0] * off, h.p[1] + h.n[1] * off, h.p[2] + h.n[2] * off]; }
function orient(pos, idx, axis, sign) { // flip triangles so they face +/-axis
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx][axis];
    if (n * sign < 0) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  }
}
function buildPatchGeo(pos, nor, idx, axis, sign) {
  if (!idx.length) return null;
  orient(pos, idx, axis, sign);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setIndex(idx);
  return g;
}
const resampleClosed = (poly, seg) => {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / seg));
    for (let k = 0; k < n; k++) out.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]);
  }
  return out;
};
// closed 2-D outline (a,b) draped over the surface: concentric rings -> centre fan (low-curvature panels: glass)
function patch(S, axis, sign, outline0, { rings = 1, off = 0.004, seg = 0.14 } = {}) {
  const outline = resampleClosed(outline0, seg), M = outline.length; let ca = 0, cb = 0;
  for (const p of outline) { ca += p[0]; cb += p[1]; }
  ca /= M; cb /= M;
  let dmin = Infinity; for (const p of outline) dmin = Math.min(dmin, Math.hypot(p[0] - ca, p[1] - cb));
  const R = clamp(Math.max(rings, Math.ceil(dmin / seg)), 1, 7);
  const pos = [], nor = [], ok = [], idx = [];
  const add = (a, b) => { const h = S.hit(axis, sign, a, b); if (h) { pos.push(...pushOut(h, off)); nor.push(...h.n); ok.push(1); } else { pos.push(0, 0, 0); nor.push(0, 1, 0); ok.push(0); } return ok.length - 1; };
  for (let r = 0; r < R; r++) { const s = 1 - r / (R + 0.35); for (let i = 0; i < M; i++) add(ca + (outline[i][0] - ca) * s, cb + (outline[i][1] - cb) * s); }
  const c = add(ca, cb);
  for (let r = 0; r < R; r++) for (let i = 0; i < M; i++) {
    const a = r * M + i, b = r * M + (i + 1) % M, d = r < R - 1 ? (r + 1) * M + i : c, e = r < R - 1 ? (r + 1) * M + (i + 1) % M : c;
    if (r < R - 1) { if (ok[a] && ok[b] && ok[e]) idx.push(a, b, e); if (ok[a] && ok[e] && ok[d]) idx.push(a, e, d); }
    else if (ok[a] && ok[b] && ok[c]) idx.push(a, b, c);
  }
  return buildPatchGeo(pos, nor, idx, axis, sign);
}
// quad ([c00,c10,c11,c01] in the projected plane) on a grid with superellipse-rounded corners; grid lines are spaced by
// 3-D arc length along the two centre lines (dense where the surface turns away from the ray, sparse where it is flat)
function gridPatch(S, axis, sign, q, { off = 0.004, seg = 0.05, round = 4 } = {}) {
  const [p00, p10, p11, p01] = q, [su, sv] = Array.isArray(seg) ? seg : [seg, seg];
  const map = (a, b) => {
    if (round > 1) { const rho = Math.max(Math.abs(a), Math.abs(b)); if (rho > 0) { const k = rho / Math.pow(Math.pow(Math.abs(a), round) + Math.pow(Math.abs(b), round), 1 / round); a *= k; b *= k; } }
    const u = (a + 1) / 2, v = (b + 1) / 2, bl = (k) => (p00[k] * (1 - u) + p10[k] * u) * (1 - v) + (p01[k] * (1 - u) + p11[k] * u) * v;
    return [bl(0), bl(1)];
  };
  const at = (a, b) => { const m = map(a, b); return S.hit(axis, sign, m[0], m[1]); };
  const c0 = at(0, 0);
  const sample = (a, b) => { // a missed sample slides toward the patch centre until it lands on the surface
    const h = at(a, b); if (h || !c0) return h;
    let lo = 0, hi = 1, best = c0;
    for (let k = 0; k < 9; k++) { const mid = (lo + hi) / 2, hm = at(a * mid, b * mid); if (hm) { best = hm; lo = mid; } else hi = mid; }
    return best;
  };
  const lines = (s, line) => {
    const M = 40, cum = [0]; let prev = null, plane = 0;
    { const A = map(...line(-1)), B = map(...line(1)); plane = Math.hypot(A[0] - B[0], A[1] - B[1]); }
    for (let i = 0; i <= M; i++) {
      const h = at(...line(-1 + (2 * i) / M));
      if (i) cum.push(cum[i - 1] + Math.max(1e-9, Math.min((plane / M) * 3, h && prev ? Math.hypot(h.p[0] - prev.p[0], h.p[1] - prev.p[1], h.p[2] - prev.p[2]) : plane / M)));
      prev = h;
    }
    const tot = cum[cum.length - 1], n = clamp(Math.ceil(tot / s), 2, 64), out = [-1];
    for (let k = 1; k < n; k++) { const target = (tot * k) / n; let j = 1; while (j < cum.length - 1 && cum[j] < target) j++; const c0 = cum[j - 1], c1 = cum[j], f = c1 > c0 ? (target - c0) / (c1 - c0) : 0; out.push(-1 + (2 * (j - 1 + f)) / M); }
    out.push(1);
    return out;
  };
  const us = lines(su, (t) => [t, 0]), vs = lines(sv, (t) => [0, t]), nu = us.length - 1, nv = vs.length - 1;
  const pos = [], nor = [], ok = [], idx = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const h = sample(us[i], vs[j]);
    if (h) { pos.push(...pushOut(h, off)); nor.push(...h.n); ok.push(1); } else { pos.push(0, 0, 0); nor.push(0, 1, 0); ok.push(0); }
  }
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 2, e = a + nu + 1;
    if (ok[a] && ok[b] && ok[c] && ok[e]) idx.push(a, b, c, a, c, e);
  }
  return buildPatchGeo(pos, nor, idx, axis, sign);
}
// closed polyline following the superellipse-rounded boundary of a quad (same mapping as gridPatch)
function quadOutline(q, n = 24, round = 4) {
  const [p00, p10, p11, p01] = q, out = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * PI * 2, ca = Math.cos(t), sb = Math.sin(t);
    const a = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / round), b = Math.sign(sb) * Math.pow(Math.abs(sb), 2 / round), u = (a + 1) / 2, v = (b + 1) / 2;
    const bl = (k) => (p00[k] * (1 - u) + p10[k] * u) * (1 - v) + (p01[k] * (1 - u) + p11[k] * u) * v;
    out.push([bl(0), bl(1)]);
  }
  return out;
}
// constant-width ribbon along a 2-D polyline, draped over the surface (polyline resampled, 3 samples across)
function strip(S, axis, sign, pts0, width, { off = 0.002, seg = 0.05 } = {}) {
  const pts = [];
  for (let i = 0; i < pts0.length - 1; i++) { const a = pts0[i], b = pts0[i + 1], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / seg)); for (let k = 0; k < n; k++) pts.push([lerp(a[0], b[0], k / n), lerp(a[1], b[1], k / n)]); }
  pts.push(pts0[pts0.length - 1]);
  const pos = [], nor = [], ok = [], idx = [], hw = width / 2, NS = width > 0.03 ? 3 : 2;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
    let ta = p1[0] - p0[0], tb = p1[1] - p0[1]; const m = Math.hypot(ta, tb) || 1; ta /= m; tb /= m;
    for (let s = 0; s < NS; s++) {
      const f = (s / (NS - 1)) * 2 - 1, h = S.hit(axis, sign, pts[i][0] - tb * hw * f, pts[i][1] + ta * hw * f);
      if (h) { pos.push(...pushOut(h, off)); nor.push(...h.n); ok.push(1); } else { pos.push(0, 0, 0); nor.push(0, 1, 0); ok.push(0); }
    }
  }
  for (let i = 0; i < pts.length - 1; i++) for (let s = 0; s < NS - 1; s++) { const a = i * NS + s, b = a + 1, c = a + NS + 1, d = a + NS; if (ok[a] && ok[b] && ok[c] && ok[d]) idx.push(a, b, c, a, c, d); }
  return buildPatchGeo(pos, nor, idx, axis, sign);
}
// rounded polygon outline (quadratic corner arcs)
function roundPoly(pts, r, segs = 3) {
  const out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i], a = pts[(i + n - 1) % n], b = pts[(i + 1) % n];
    if (p[2] === 0) { out.push([p[0], p[1]]); continue; }
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]), d = Math.min(r, la * 0.45, lb * 0.45);
    const s = [p[0] + (a[0] - p[0]) / la * d, p[1] + (a[1] - p[1]) / la * d], e = [p[0] + (b[0] - p[0]) / lb * d, p[1] + (b[1] - p[1]) / lb * d];
    for (let k = 0; k <= segs; k++) { const t = k / segs, u = 1 - t; out.push([u * u * s[0] + 2 * u * t * p[0] + t * t * e[0], u * u * s[1] + 2 * u * t * p[1] + t * t * e[1]]); }
  }
  return out;
}
const ellipsePoly = (ca, cb, ra, rb, n = 14) => Array.from({ length: n }, (_, i) => [ca + Math.cos((i / n) * PI * 2) * ra, cb + Math.sin((i / n) * PI * 2) * rb]);

// ───────────────────────── loft: rings of [x,y] at stations z (rear -> front, ring ccw seen from +z)
function buildLoft(zs, rings, cls) {
  const N = zs.length, K = rings[0].length, pos = new Float32Array(N * K * 3);
  for (let j = 0; j < N; j++) for (let i = 0; i < K; i++) { const o = (j * K + i) * 3; pos[o] = rings[j][i][0]; pos[o + 1] = rings[j][i][1]; pos[o + 2] = zs[j]; }
  const A = [], B = [];
  const area2 = (a, b, c) => { const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2], vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2]; return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); };
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < K; i++) {
    const a = j * K + i, b = j * K + (i + 1) % K, c = (j + 1) * K + (i + 1) % K, d = (j + 1) * K + i, T = cls && cls(j, i) ? B : A;
    if (area2(a, b, c) > 1e-9) T.push(a, b, c);
    if (area2(a, c, d) > 1e-9) T.push(a, c, d);
  }
  const all = new THREE.BufferGeometry();
  all.setAttribute('position', new THREE.BufferAttribute(pos, 3)); all.setIndex(A.concat(B)); all.computeVertexNormals();
  const mk = (idx) => { if (!idx.length) return null; const g = new THREE.BufferGeometry(); g.setAttribute('position', all.attributes.position); g.setAttribute('normal', all.attributes.normal); g.setIndex(idx); return g; };
  return { main: mk(A), alt: mk(B), all };
}
// superellipse plan-view factor: 1 in the body, -> 0 at the very end (u in 0..1 over the nose zone)
const planK = (u, p) => (u <= 0 ? 1 : u >= 1 ? 0 : Math.pow(Math.max(0, 1 - Math.pow(u, p)), 1 / p));
// cosine-clustered stations over [z0,z1], dense toward `denseEnd` (+1: z1, -1: z0)
function clustered(z0, z1, n, denseEnd) {
  const out = [];
  for (let i = 0; i <= n; i++) { const s = Math.sin((i / n) * PI / 2); out.push(denseEnd > 0 ? z0 + (z1 - z0) * s : z1 - (z1 - z0) * s); }
  return denseEnd > 0 ? out : out.reverse();
}

// ───────────────────────── wheels: one merged geometry per axle (both sides, dual rears for buses)
function lathe(prof, seg, phi0 = 0, phiLen = PI * 2) { // prof = [[r, a], ...] revolved around +X; normals follow (da, -dr)
  const g = new THREE.LatheGeometry(prof.map((p) => new THREE.Vector2(p[0], p[1])), seg, phi0, phiLen);
  g.rotateZ(-PI / 2);
  return g;
}
function spokeGeo(a0, r0, r1, w0, w1, t, phi) {
  const g = new THREE.BoxGeometry(1, 1, 1), P = g.attributes.position, N = g.attributes.normal;
  const c = Math.cos(phi), s = Math.sin(phi);
  for (let i = 0; i < P.count; i++) {
    const yu = P.getY(i) + 0.5, rad = lerp(r0, r1, yu), tan = P.getX(i) * lerp(w0, w1, yu), ax = a0 + P.getZ(i) * t;
    P.setXYZ(i, ax, rad * c - tan * s, rad * s + tan * c);
    const nx = N.getX(i), ny = N.getY(i), nz = N.getZ(i);
    N.setXYZ(i, nz, ny * c - nx * s, ny * s + nx * c);
  }
  return g;
}
// one wheel, axle = X, outer face toward +X. o: {spokes, steel, seg, simple, twoSided, rimHex}
function wheelGeo(R, W, rimR, o = {}) {
  const seg = o.seg || 18, hw = W / 2, sw = R - rimR, parts = [];
  parts.push(det(lathe([
    [rimR, -hw * 0.8], [rimR + sw * 0.45, -hw * 0.98], [R - sw * 0.12, -hw * 0.88], [R * 0.998, -hw * 0.6],
    [R * 0.998, hw * 0.6], [R - sw * 0.12, hw * 0.88], [rimR + sw * 0.45, hw * 0.98], [rimR, hw * 0.8],
  ], seg), SW.RUBBER, 0x151515));
  const rimHex = o.rimHex || (o.steel ? 0xb4b7ba : 0xc6c9cc);
  const side = () => {
    const L = [det(lathe([[rimR - 0.012, hw * 0.78], [rimR - 0.04, hw * 0.55], [0.0, hw * 0.55]], seg), SW.BRAKE, 0x1c1d1f)];
    if (o.simple) return L;
    L.push(det(lathe([[rimR + 0.004, hw * 0.8], [rimR - 0.007, hw * 0.865], [rimR - 0.026, hw * 0.855], [rimR - 0.042, hw * 0.74]], seg), o.steel ? SW.SATIN : SW.ALU, rimHex));
    if (o.steel) {
      L.push(det(lathe([[rimR - 0.042, hw * 0.74], [rimR * 0.5, hw * 0.66], [0.085, hw * 0.7], [0.07, hw * 0.78], [0, hw * 0.8]], seg), SW.SATIN, 0xb9bcbf));
      L.push(det(lathe([[0.06, hw * 0.8], [0.05, hw * 0.86], [0, hw * 0.87]], 10), SW.CHROME, 0x9a9ea2));
    } else {
      const n = o.spokes || 5;
      for (let i = 0; i < n; i++) L.push(det(spokeGeo(hw * 0.73, 0.04, rimR - 0.035, 0.04, 0.062, 0.016, (i / n) * PI * 2 + 0.3), SW.ALU, rimHex));
      L.push(det(lathe([[0.07, hw * 0.7], [0.06, hw * 0.78], [0.03, hw * 0.82], [0, hw * 0.82]], 12), SW.ALU, rimHex));
    }
    return L;
  };
  parts.push(...side());
  if (o.twoSided) parts.push(...side().map((g) => g.rotateY(PI)));
  return mergeList(parts);
}
// all wheels of one axle merged; xs = [{x, simple?}] (x<0 => rotated 180deg about Y); positions relative to pivot at xs[0].x
function axleGeo(R, W, rimR, xs, o = {}) {
  const px = xs[0].x, parts = [];
  for (const w of xs) {
    const g = wheelGeo(R, W, rimR, { ...o, simple: w.simple });
    if (w.x < 0) g.rotateY(PI);
    g.translate(w.x - px, 0, 0);
    parts.push(g);
  }
  return mergeList(parts);
}
// build the wheel layout common to every type: axles = [{z, xs:[{x,simple?}]}], returns {geos[], pivots:[{x,y,z,mesh:bool}]}
function wheelLayout(R, W, rimR, axles, o = {}) {
  const geos = [], pivots = [];
  for (const ax of axles) {
    geos.push({ geo: axleGeo(R, W, rimR, ax.xs, o), x: ax.xs[0].x, y: R, z: ax.z });
    ax.xs.forEach((w, i) => pivots.push({ x: w.x, y: R, z: ax.z, owner: i === 0 ? geos.length - 1 : -1 }));
  }
  return { geos, pivots };
}

// ───────────────────────── passenger cars (sedan / suv / taxi): lofted shell + arches + greenhouse
function makeLower(S) {
  const hwF = curve(S.halfW), yT = curve(S.yTop), yBf = curve(S.yBot), crF = curve(S.crown);
  const RA = S.wheelR + S.archClear, wh = S.arches || [S.axleR, S.axleF];
  const archY = (z) => { let y = -1; for (const zc of wh) { const dz = z - zc; if (Math.abs(dz) <= RA + 1e-9) y = Math.max(y, S.wheelR + Math.sqrt(Math.max(0, RA * RA - dz * dz))); } return y; };
  const zNs = S.zF - S.nose.L, zTs = S.zR + S.tail.L, inArch = (z, m) => wh.some((zc) => Math.abs(z - zc) < RA + m);
  const st = []; let ord = 0; const push = (z, arch) => st.push({ z, arch, ord: ord++ });
  clustered(S.zR, zTs, 8, -1).forEach((z) => { if (!inArch(z, 0)) push(z, false); });
  for (let z = zTs + 0.17; z < zNs - 0.05; z += S.step ?? 0.19) if (!inArch(z, 0.04)) push(z, false);
  clustered(zNs, S.zF, 9, 1).forEach((z) => { if (!inArch(z, 0)) push(z, false); });
  for (const zc of wh) {
    push(zc - RA, false);
    for (let i = 0; i <= 10; i++) push(zc - RA * Math.cos((PI * i) / 10), true);
    push(zc + RA, false);
  }
  st.sort((a, b) => a.z - b.z || a.ord - b.ord);
  const gz0 = S.gh ? S.gh.zb : 0, gz1 = S.gh ? S.gh.zf : 0;
  const ring = (z, arch) => {
    let kk = 1;
    if (z > zNs) kk = planK((z - zNs) / S.nose.L, S.nose.p); else if (z < zTs) kk = planK((zTs - z) / S.tail.L, S.tail.p);
    const w = hwF(z), yB = yBf(z), yTp = yT(z), cr = crF(z);
    const rcx = (z > gz0 && z < gz1 ? (S.rcxBelt ?? 0.075) : (S.rcx ?? 0.12)) * Math.max(kk, 1e-4);
    const tcl = (y) => clamp((y - yB) / (yTp - yB), 0, 1);
    const xs = (y) => w * kk * (1 - (S.bulge ?? 0.022) * (1 - Math.sin(PI * tcl(y))));
    const yA = arch ? archY(z) : yB, rs = arch ? (S.rsArch ?? 0.03) : (S.rsSill ?? 0.07), yLow = yA + rs;
    let rcy = S.rcy ?? 0.085, y8 = yTp - cr - rcy;
    if (y8 < yLow + 0.03) { y8 = yLow + 0.03; rcy = Math.max(0.01, yTp - cr - y8); }
    const xin = Math.min(S.tubIn, 0.8 * w) * kk, y6 = yLow + (y8 - yLow) * 0.33, y7 = yLow + (y8 - yLow) * 0.68, x8 = xs(y8), xt = x8 - rcx;
    const h = [
      [0, yB], [xin, yB], [xin, yA], [Math.max(xin, xs(yA + 0.01) - 0.1 * kk), yA], [xs(yA + 0.35 * rs) - 0.03 * kk, yA + 0.35 * rs],
      [xs(yLow), yLow], [xs(y6), y6], [xs(y7), y7], [x8, y8], [xt + rcx * 0.866, y8 + rcy * 0.5], [xt + rcx * 0.5, y8 + rcy * 0.866],
      [xt, y8 + rcy], [xt * 0.5, yTp - cr * 0.25], [0, yTp],
    ];
    const full = h.slice();
    for (let m = 12; m >= 1; m--) full.push([-h[m][0], h[m][1]]);
    return full;
  };
  const zs = st.map((s) => s.z), rings = st.map((s) => ring(s.z, s.arch));
  const tub = new Set([1, 2, 3, 22, 23, 24]);
  const L = buildLoft(zs, rings, (j, i) => (st[j].arch || st[j + 1].arch) && tub.has(i));
  return { L, hwF, yT, yBf, crF };
}

function makeGreenhouse(S, lo) {
  const g = S.gh, yb = (z) => lo.yT(z) - 0.03, wbf = (z) => lo.hwF(z) - g.baseInset;
  const pts = g.yr.map((p) => p.slice()).sort((p, q) => p[0] - q[0]); pts[0][1] = yb(pts[0][0]); pts[pts.length - 1][1] = yb(pts[pts.length - 1][0]);
  const yrF = curve(pts), zs = [];
  const n = Math.round((g.zf - g.zb) / 0.085);
  for (let i = 0; i <= n; i++) zs.push(g.zb + ((g.zf - g.zb) * i) / n);
  (g.extraZ || []).forEach((z) => zs.push(z));
  zs.sort((a, b) => a - b);
  const ring = (z) => {
    const base = yb(z), wb = wbf(z), yr = Math.max(base, yrF(z)), h = yr - base;
    const tum = g.tumble * clamp(h / g.hRef, 0, 1), cr = g.crown * clamp(h / 0.25, 0, 1), wr = wb - tum;
    const hh = [[wb, base], [wb - 0.15 * tum, base + 0.28 * h], [wb - 0.55 * tum, base + 0.62 * h], [wb - 0.9 * tum, base + 0.88 * h - cr * 0.1], [wr, yr - cr * 0.6], [wr * 0.5, yr - cr * 0.2], [0, yr]];
    const full = hh.slice();
    for (let m = 5; m >= 0; m--) full.push([-hh[m][0], hh[m][1]]);
    return full;
  };
  const L = buildLoft(zs, zs.map(ring));
  return { L, yb, wbf, yrF, base: (z) => yb(z), wr: (z) => { const base = yb(z), h = Math.max(0, yrF(z) - base); return wbf(z) - g.tumble * clamp(h / g.hRef, 0, 1); } };
}

const mirX = (poly) => poly.map(([x, y]) => [-x, y]);
const yz = (pts) => pts.map((p) => [p[1], p[0], p[2]]); // side-view (z,y) -> ray coords (y,z)
const rect = (z0, z1, y0, y1) => [[z0, y0], [z1, y0], [z1, y1], [z0, y1]];

function mirrorParts(x, y, z, sx) {
  const paint = [], dark = [];
  const h = new THREE.SphereGeometry(0.5, 9, 6); xf(h, [x, y, z], [0, 0, 0], [0.2, 0.125, 0.15]); paint.push(pnt(h));
  const st = new THREE.BoxGeometry(0.11, 0.035, 0.07); xf(st, [x - sx * 0.07, y - 0.045, z + 0.0]); paint.push(pnt(st));
  const gl = new THREE.CircleGeometry(0.5, 10); xf(gl, [x + sx * 0.002, y, z - 0.0765], [0, PI, 0], [0.165, 0.092, 1]); dark.push(det(gl, SW.MIRROR, 0x232a30));
  return { paint, dark };
}

function carParts(S, o) {
  const lo = makeLower(S), gh = makeGreenhouse(S, lo), g = S.gh;
  const SL = new Surface([lo.L.all]), SG = new Surface([gh.L.all]), SB = new Surface([lo.L.all, gh.L.all]);
  const P = { paint: [pnt(lo.L.main), pnt(gh.L.main)], detail: [], glass: [], head: [], tail: [], blink: [] };
  if (lo.L.alt) P.detail.push(det(lo.L.alt, SW.PLASTIC, 0x0a0a0b));
  const add = (list, geo) => { if (geo) list.push(geo); };
  // ── glass: windshield / rear window / side panes / (sunroof)
  const topPatch = (poly, off = 0.004) => patch(SG, 1, 1, roundPoly(poly, 0.07, 3), { rings: 3, off });
  add(P.glass, topPatch(S.glass.ws));
  add(P.glass, S.glass.rwBack ? patch(SG, 2, -1, roundPoly(S.glass.rw, 0.08, 3), { rings: 3, off: 0.004 }) : topPatch(S.glass.rw));
  const topY = (z) => gh.base(z) + S.win.topK * Math.max(0, gh.yrF(z) - gh.base(z));
  for (const pn of S.win.panes) {
    const pts = [[pn.zfb, S.win.sill], [pn.zrb, S.win.sill], [pn.zrt, topY(pn.zrt)]];
    for (let i = 1; i < 6; i++) { const z = lerp(pn.zrt, pn.zft, i / 6); pts.push([z, topY(z), 0]); }
    pts.push([pn.zft, topY(pn.zft)]);
    for (const sg of [1, -1]) add(P.glass, patch(SG, 0, sg, roundPoly(yz(pts), 0.05, 3), { rings: 2, off: 0.004 }));
  }
  if (o.sunroof) add(P.glass, patch(SG, 1, 1, roundPoly(S.glass.roof, 0.06, 2), { rings: 2, off: 0.004 }));
  // ── nose
  const FP = (q, off = 0.004, _r, _rr, seg = 0.08) => gridPatch(SL, 2, 1, q, { off, seg, round: 4 });
  const RP = (q, off = 0.004, _r, _rr, seg = 0.09) => gridPatch(SL, 2, -1, q, { off, seg, round: 4 });
  const F = S.front, Rr = S.rear;
  for (const m of [false, true]) {
    const mp = (p) => (m ? mirX(p) : p);
    add(P.detail, det(FP(mp(F.headL), 0.005, 0, 0, [0.05, 0.03]), SW.LENS, 0x12161a));
    add(P.head, FP(mp(F.ledL), 0.0085, 0, 0, 0.07));
    add(P.head, FP(mp(F.drlL), 0.0085, 0, 0, 0.07));
    if (F.fogL) add(P.detail, det(FP(mp(F.fogL), 0.004, 1, 0.02), SW.GLOSS, 0x0d0e10));
    if (!m) add(P.detail, det(FP(F.blinkL, 0.0095, 1, 0.01), SW.GLOSS, 0x7a4d0e)); // left (+X) signal: static amber lens
    else add(P.blink, FP(F.blinkL.map(([x, y]) => [-x, y]), 0.0095, 1, 0.01));       // right (-X) signal: animated
    add(P.detail, det(RP(mp(Rr.tailL), 0.005, 0, 0, [0.06, 0.04]), SW.GLOSS, 0x15090a));
    add(P.tail, RP(mp(Rr.tailLensL), 0.0085, 0, 0, [0.08, 0.05]));
    if (!m) add(P.detail, det(RP(Rr.blinkL, 0.0105, 1, 0.008), SW.GLOSS, 0x7a4d0e));
    else add(P.blink, RP(Rr.blinkL.map(([x, y]) => [-x, y]), 0.0105, 1, 0.008));
  }
  add(P.tail, RP(Rr.bar, 0.0075, 1, 0.008));
  add(P.detail, det(FP(F.grille, 0.006, 0, 0, [0.07, 0.04]), SW.PLASTIC, 0x0b0c0d));
  for (const s of F.slats || []) add(P.detail, det(strip(SL, 2, 1, s, 0.012, { off: 0.0095, seg: 0.1 }), SW.CHROME, 0x5d6166));
  add(P.detail, det(strip(SL, 2, 1, quadOutline(F.grille, 20, 4), 0.011, { off: 0.0085, seg: 0.09 }), SW.CHROME, 0xa5aab0));
  add(P.detail, det(FP(F.intake, 0.006, 0, 0, [0.08, 0.035]), SW.PLASTIC, 0x0b0c0d));
  add(P.detail, det(RP(Rr.diffuser, 0.006, 0, 0, [0.09, 0.035]), SW.PLASTIC, 0x0c0d0e));
  // plates (flat, set just proud of the surface)
  const plate = (SS, axis, sg, y, w, h, rectKey, dir) => {
    let zz = -Infinity * sg;
    for (const [dx, dy] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2], [0, 0]]) { const hh = SS.hit(2, sg, dx, y + dy); if (hh) zz = sg > 0 ? Math.max(zz, hh.p[2]) : Math.min(zz, hh.p[2]); }
    return plateGeo(0, y, zz + sg * 0.012, w, h, dir, RECT[rectKey]);
  };
  add(P.detail, plate(SL, 2, 1, F.plateY, 0.52, 0.11, 'plate', 1));
  add(P.detail, plate(SL, 2, -1, Rr.plateY, 0.52, 0.11, 'plate', -1));
  // ── side details on both flanks
  for (const sg of [1, -1]) {
    const SP = (poly, off, _r, _rr, seg = 0.08) => gridPatch(SB, 0, sg, yz(poly), { off, seg, round: 3 });
    for (const ln of S.doorLines) add(P.detail, det(strip(SB, 0, sg, yz(ln), 0.0052, { off: 0.0018, seg: 0.1 }), SW.PLASTIC, 0x0c0c0d));
    for (const hz of S.handles) add(P.detail, det(SP(rect(hz - 0.08, hz + 0.08, S.handleY - 0.012, S.handleY + 0.012), 0.009, 0, 0, 0.1), SW.CHROME, 0x8d9398));
    add(P.detail, det(strip(SB, 0, sg, yz(S.beltLine), 0.014, { off: 0.0035, seg: 0.12 }), SW.CHROME, 0xb3b8bd));
    add(P.detail, det(SP(S.rocker, 0.003, 0, 0, [0.3, 0.1]), SW.PLASTIC, 0x131416));
    if (S.cladding) for (const zc of [S.axleF, S.axleR]) {
      const pts = [], RA = S.wheelR + S.archClear + 0.032;
      for (let i = 0; i <= 12; i++) { const a = (PI * (0.04 + 0.92 * i / 12)); pts.push([zc + RA * Math.cos(a), S.wheelR + RA * Math.sin(a)]); }
      add(P.detail, det(strip(SB, 0, sg, yz(pts), 0.06, { off: 0.0035, seg: 0.1 }), SW.PLASTIC, 0x17181a));
    }
    const mm = mirrorParts(sg * (S.mirror.x), S.mirror.y, S.mirror.z, sg);
    mm.paint.forEach((q) => P.paint.push(q)); mm.dark.forEach((q) => P.detail.push(q));
    if (S.roofRails) add(P.detail, det(strip(SG, 1, 1, S.roofRails.map(([x, z]) => [sg * x, z]), 0.032, { off: 0.012, seg: 0.15 }), SW.ALU, 0x9a9ea4));
  }
  // roof furniture: shark-fin antenna
  const ah = SG.hit(1, 1, 0, S.finZ);
  if (ah) { const fin = xf(new THREE.SphereGeometry(0.5, 7, 5), [0, ah.p[1] + 0.02, S.finZ], [0.35, 0, 0], [0.065, 0.075, 0.2]); P.detail.push(det(fin, SW.GLOSS, 0x101113)); }
  // taxi roof sign + door stripe
  if (o.taxi) {
    const rz = S.signZ, hh = SG.hit(1, 1, 0, rz), ry = hh ? hh.p[1] : S.height - 0.03;
    const box = new THREE.BoxGeometry(0.62, 0.13, 0.22, 3, 1, 2); const pa = box.attributes.position;
    for (let i = 0; i < pa.count; i++) { const x = pa.getX(i); pa.setX(i, x); pa.setZ(i, pa.getZ(i) * (1 - 0.18 * Math.pow(Math.abs(x) / 0.31, 3))); }
    xf(box, [0, ry + 0.0975, rz]); box.computeVertexNormals();
    const bn = box.attributes.normal, bp = box.attributes.position, uv = [];
    for (let i = 0; i < bp.count; i++) {
      if (Math.abs(bn.getZ(i)) > 0.6) { const u = rectUV(RECT.sign, bn.getZ(i) > 0 ? (bp.getX(i) + 0.31) / 0.62 : 1 - (bp.getX(i) + 0.31) / 0.62, (bp.getY(i) - ry - 0.0325) / 0.13); uv.push(u[0], u[1]); }
      else { const u = swUV(SW.EMIT); uv.push(u[0], u[1]); }
    }
    P.detail.push(detUV(box, uv, 0xffffff));
    const base = new THREE.BoxGeometry(0.34, 0.03, 0.14); xf(base, [0, ry + 0.012, rz]); P.detail.push(det(base, SW.PLASTIC, 0x16171a));
    for (const sg of [1, -1]) add(P.detail, det(strip(SB, 0, sg, yz([[0.78, 0.62], [0.3, 0.62], [-0.2, 0.62], [-0.6, 0.62], [-0.95, 0.62]]), 0.06, { off: 0.0028 }), SW.SATIN, o.stripe));
  }
  // ── wheels & lights
  const xs = (x) => [{ x }, { x: -x }];
  const layout = wheelLayout(S.wheelR, S.tireW, S.rimR, [{ z: S.axleF, xs: xs(S.tx) }, { z: S.axleR, xs: xs(S.tx) }], { spokes: S.spokes || 5, steel: false, seg: 18 });
  const hy = S.headY, hz = S.zF - 0.08;
  return { P, layout, lights: { head: [[0.66, hy, hz], [-0.66, hy, hz]], tail: [[0.7, hy + 0.06, S.zR + 0.08], [-0.7, hy + 0.06, S.zR + 0.08]] } };
}

// ───────────────────────── car specs (all numbers in metres; rear -> front along z)
const SPEC_SEDAN = {
  height: 1.45, headY: 0.66, zF: 2.475, zR: -2.475, wheelR: 0.335, tireW: 0.225, rimR: 0.222, tx: 0.765, axleF: 1.53, axleR: -1.36, archClear: 0.04, tubIn: 0.62, spokes: 5,
  halfW: [[-2.475, 0.9], [-2.0, 0.915], [-1.2, 0.935], [0, 0.935], [1.2, 0.935], [2.0, 0.925], [2.475, 0.9]],
  yTop: [[-2.475, 0.8], [-2.43, 0.895], [-2.3, 0.955], [-1.9, 0.985], [-1.3, 0.99], [-0.2, 0.965], [0.8, 0.945], [1.5, 0.905], [2.05, 0.84], [2.35, 0.785], [2.475, 0.67]],
  yBot: [[-2.475, 0.45], [-2.4, 0.32], [-2.25, 0.25], [-2.0, 0.21], [-1.5, 0.175], [1.5, 0.175], [2.0, 0.2], [2.25, 0.235], [2.4, 0.29], [2.475, 0.4]],
  crown: [[-2.475, 0], [-2.2, 0.02], [-1.6, 0.02], [-1.0, 0.005], [0.8, 0.01], [1.2, 0.03], [2.0, 0.035], [2.475, 0]],
  nose: { L: 0.55, p: 2.6 }, tail: { L: 0.5, p: 3.0 },
  gh: { zf: 1.0, zb: -1.52, tumble: 0.19, hRef: 0.45, baseInset: 0.11, crown: 0.04,
    yr: [[1.0, 0], [0.82, 1.035], [0.62, 1.16], [0.4, 1.29], [0.2, 1.385], [-0.05, 1.44], [-0.35, 1.45], [-0.7, 1.425], [-1.0, 1.345], [-1.25, 1.16], [-1.52, 0]] },
  win: { sill: 1.0, topK: 0.84, panes: [{ zfb: 0.7, zft: 0.4, zrb: -0.2, zrt: -0.2 }, { zfb: -0.32, zft: -0.32, zrb: -1.2, zrt: -0.92 }] },
  glass: { ws: [[-0.72, 0.9], [0.72, 0.9], [0.55, 0.33], [-0.55, 0.33]], rw: [[-0.68, -1.42], [0.68, -1.42], [0.53, -0.93], [-0.53, -0.93]], roof: [[-0.4, -0.55], [0.4, -0.55], [0.4, 0.15], [-0.4, 0.15]] },
  front: {
    headL: [[0.36, 0.585], [0.83, 0.63], [0.81, 0.735], [0.42, 0.745]],
    ledL: [[0.44, 0.655], [0.8, 0.668], [0.8, 0.7], [0.5, 0.715]], drlL: [[0.4, 0.6], [0.62, 0.607], [0.62, 0.628], [0.42, 0.62]],
    grille: [[-0.42, 0.48], [0.42, 0.48], [0.46, 0.62], [-0.46, 0.62]],
    slats: [[[-0.41, 0.585], [0.41, 0.585]], [[-0.43, 0.55], [0.43, 0.55]], [[-0.4, 0.515], [0.4, 0.515]]],
    intake: [[-0.56, 0.375], [0.56, 0.375], [0.66, 0.465], [-0.66, 0.465]],
    blinkL: [[0.64, 0.627], [0.79, 0.633], [0.79, 0.653], [0.64, 0.648]], plateY: 0.43,
  },
  rear: {
    tailL: [[0.36, 0.735], [0.85, 0.718], [0.85, 0.86], [0.36, 0.835]],
    tailLensL: [[0.42, 0.745], [0.83, 0.73], [0.83, 0.845], [0.42, 0.826]],
    bar: [[-0.34, 0.775], [0.34, 0.775], [0.34, 0.795], [-0.34, 0.795]], blinkL: [[0.7, 0.742], [0.8, 0.738], [0.8, 0.768], [0.71, 0.77]],
    plateY: 0.6, diffuser: [[-0.6, 0.46], [0.6, 0.46], [0.68, 0.53], [-0.68, 0.53]],
  },
  doorLines: [[[1.02, 0.31], [1.04, 0.55], [1.0, 0.8], [0.94, 0.935]], [[-0.22, 0.3], [-0.22, 0.62], [-0.23, 0.935]], [[-1.1, 0.78], [-1.14, 0.86], [-1.2, 0.935]]],
  handles: [0.3, -0.62], handleY: 0.905, beltLine: [[0.5, 0.992], [0.2, 0.992], [-0.4, 0.992], [-1.0, 0.992], [-1.3, 0.992]],
  rocker: rect(-0.93, 0.95, 0.205, 0.262), mirror: { x: 0.99, y: 1.0, z: 0.82 }, finZ: -0.85, signZ: -0.35,
};
const SPEC_SUV = {
  height: 1.7, headY: 0.73, zF: 2.35, zR: -2.35, wheelR: 0.365, tireW: 0.235, rimR: 0.25, tx: 0.79, axleF: 1.46, axleR: -1.39, archClear: 0.045, tubIn: 0.64, spokes: 6, cladding: true,
  halfW: [[-2.35, 0.91], [-1.9, 0.94], [-1.0, 0.95], [1.0, 0.95], [1.8, 0.94], [2.35, 0.9]],
  yTop: [[-2.35, 1.0], [-2.28, 1.08], [-2.1, 1.12], [-1.3, 1.12], [-0.2, 1.1], [0.9, 1.065], [1.5, 1.01], [2.0, 0.93], [2.25, 0.87], [2.35, 0.78]],
  yBot: [[-2.35, 0.5], [-2.28, 0.4], [-2.1, 0.34], [-1.8, 0.29], [-1.4, 0.255], [1.4, 0.255], [1.9, 0.29], [2.15, 0.33], [2.28, 0.36], [2.35, 0.42]],
  crown: [[-2.35, 0], [-2.1, 0.02], [-1.3, 0.01], [0.9, 0.01], [1.3, 0.03], [2.0, 0.03], [2.35, 0]],
  nose: { L: 0.42, p: 2.8 }, tail: { L: 0.4, p: 3.4 },
  gh: { zf: 0.98, zb: -2.25, tumble: 0.12, hRef: 0.62, baseInset: 0.095, crown: 0.035, extraZ: [-2.02, -2.08, -2.12, -2.16, -2.2],
    yr: [[0.98, 0], [0.8, 1.16], [0.58, 1.33], [0.32, 1.48], [0.05, 1.58], [-0.3, 1.645], [-0.8, 1.66], [-1.5, 1.655], [-1.95, 1.625], [-2.12, 1.58], [-2.25, 0]] },
  win: { sill: 1.14, topK: 0.86, panes: [{ zfb: 0.6, zft: 0.3, zrb: -0.42, zrt: -0.42 }, { zfb: -0.54, zft: -0.54, zrb: -1.4, zrt: -1.4 }, { zfb: -1.52, zft: -1.52, zrb: -2.0, zrt: -1.96 }] },
  glass: { ws: [[-0.74, 0.88], [0.74, 0.88], [0.65, 0.14], [-0.65, 0.14]], rw: [[-0.7, 1.52], [0.7, 1.52], [0.74, 1.17], [-0.74, 1.17]], rwBack: true, roof: [[-0.42, -0.7], [0.42, -0.7], [0.42, -0.05], [-0.42, -0.05]] },
  front: {
    headL: [[0.37, 0.62], [0.83, 0.665], [0.81, 0.79], [0.43, 0.8]],
    ledL: [[0.45, 0.7], [0.8, 0.714], [0.8, 0.75], [0.5, 0.765]], drlL: [[0.41, 0.64], [0.62, 0.647], [0.62, 0.665], [0.43, 0.66]],
    grille: [[-0.42, 0.53], [0.42, 0.53], [0.48, 0.71], [-0.48, 0.71]],
    slats: [[[-0.45, 0.67], [0.45, 0.67]], [[-0.47, 0.62], [0.47, 0.62]], [[-0.43, 0.575], [0.43, 0.575]]],
    intake: [[-0.56, 0.405], [0.56, 0.405], [0.67, 0.5], [-0.67, 0.5]],
    blinkL: [[0.64, 0.667], [0.79, 0.672], [0.79, 0.69], [0.64, 0.686]], plateY: 0.46,
  },
  rear: {
    tailL: [[0.54, 0.8], [0.85, 0.785], [0.85, 1.02], [0.54, 1.0]], tailLensL: [[0.59, 0.82], [0.83, 0.805], [0.83, 0.99], [0.59, 0.975]],
    bar: [[-0.56, 0.93], [0.56, 0.93], [0.56, 0.95], [-0.56, 0.95]], blinkL: [[0.7, 0.82], [0.79, 0.812], [0.79, 0.842], [0.71, 0.85]],
    plateY: 0.74, diffuser: [[-0.6, 0.53], [0.6, 0.53], [0.7, 0.59], [-0.7, 0.59]],
  },
  doorLines: [[[0.86, 0.38], [0.88, 0.7], [0.84, 0.92], [0.74, 1.05]], [[-0.48, 0.38], [-0.48, 0.7], [-0.49, 1.05]], [[-1.45, 0.84], [-1.46, 0.94], [-1.48, 1.05]]],
  handles: [0.1, -0.9], handleY: 1.0, beltLine: [[0.55, 1.135], [-0.3, 1.135], [-1.0, 1.135], [-1.5, 1.135], [-2.0, 1.135]],
  rocker: rect(-0.85, 0.85, 0.255, 0.345), mirror: { x: 1.03, y: 1.12, z: 0.72 }, finZ: -1.6, signZ: -0.4,
  roofRails: [[0.68, 0.0], [0.7, -0.6], [0.7, -1.3], [0.69, -1.9]],
};

// fastback sedan: same lower body, long sloping roofline down to the lid
const SPEC_FASTBACK = Object.assign({}, SPEC_SEDAN, {
  gh: Object.assign({}, SPEC_SEDAN.gh, { zb: -2.2, yr: [[1.0, 0], [0.82, 1.035], [0.62, 1.16], [0.4, 1.29], [0.2, 1.385], [-0.05, 1.44], [-0.4, 1.445], [-0.8, 1.405], [-1.2, 1.3], [-1.6, 1.14], [-1.95, 1.02], [-2.2, 0]] }),
  win: { sill: 1.0, topK: 0.84, panes: [{ zfb: 0.7, zft: 0.4, zrb: -0.2, zrt: -0.2 }, { zfb: -0.32, zft: -0.32, zrb: -1.62, zrt: -1.3 }] },
  glass: { ws: [[-0.72, 0.9], [0.72, 0.9], [0.55, 0.33], [-0.55, 0.33]], rw: [[-0.64, -1.92], [0.64, -1.92], [0.52, -1.04], [-0.52, -1.04]], roof: [[-0.4, -0.55], [0.4, -0.55], [0.4, 0.15], [-0.4, 0.15]] },
  finZ: -0.7,
});

// ───────────────────────── finalize (merge per material) + assemble (meshes, pivots, userData)
function finalize(P, layout, lights, extra = {}) {
  const m = (list, keep) => {
    const l = list.filter(Boolean); l.forEach((g) => keepAttrs(g, keep));
    const g = mergeList(l); if (g) { g.computeBoundingSphere(); g.computeBoundingBox(); }
    return g;
  };
  const geos = {
    paint: m(P.paint, P.paintVC ? ['position', 'normal', 'color'] : ['position', 'normal']),
    detail: m(P.detail, ['position', 'normal', 'uv', 'color']),
    glass: m(P.glass, ['position', 'normal']), head: m(P.head, ['position', 'normal']),
    tail: m(P.tail, ['position', 'normal']), blink: m(P.blink, ['position', 'normal']),
  };
  let tri = 0; for (const k in geos) tri += triCount(geos[k]);
  layout.geos.forEach((w) => { tri += triCount(w.geo); w.geo.computeBoundingSphere(); });
  let top = 0; for (const k in geos) if (geos[k]) top = Math.max(top, geos[k].boundingBox.max.y);
  return { geos, layout, lights, tri, wheelR: extra.wheelR, paintVC: !!P.paintVC, height: top };
}
function scaleFin(f, sx, sy, sz) {
  for (const k in f.geos) if (f.geos[k]) { f.geos[k].scale(sx, sy, sz); f.geos[k].computeBoundingSphere(); f.geos[k].computeBoundingBox(); }
  f.layout.pivots.forEach((p) => { p.z *= sz; });
  f.layout.geos.forEach((w) => { w.z *= sz; });
  const sc = (v) => [v[0] * sx, v[1], v[2] * sz];
  f.lights = { head: f.lights.head.map(sc), tail: f.lights.tail.map(sc) };
}
function makeTailMat() { return new THREE.MeshStandardMaterial({ color: 0x5a0d0a, emissive: 0xff2414, emissiveIntensity: 0.35, roughness: 0.3, metalness: 0, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }); }
function makeBlinkMat() { return new THREE.MeshBasicMaterial({ color: 0x3a2a0a, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5 }); }

function assemble(type, fin, paintHex) {
  const D = VEHICLE_DIMS[type], grp = new THREE.Group(); grp.name = 'vehicle-' + type;
  const tailMat = makeTailMat(), blinkMat = makeBlinkMat(), hm = headMat();
  const mk = (geo, mat, cast, name, parent = grp) => {
    if (!geo) return null;
    const m = new THREE.Mesh(geo, mat); m.castShadow = cast; m.receiveShadow = true; m.name = name; parent.add(m); return m;
  };
  mk(fin.geos.paint, paintMat(paintHex, fin.paintVC), true, 'paint');
  mk(fin.geos.glass, glassMat(), false, 'glass');
  mk(fin.geos.detail, detailMat(), true, 'detail');
  mk(fin.geos.head, hm, false, 'head');
  mk(fin.geos.tail, tailMat, false, 'tail');
  mk(fin.geos.blink, blinkMat, false, 'blink');
  const wheels = [];
  for (const p of fin.layout.pivots) {
    const o3 = new THREE.Object3D(); o3.name = 'wheel-pivot'; o3.position.set(p.x, p.y, p.z); grp.add(o3); wheels.push(o3);
    if (p.owner >= 0) mk(fin.layout.geos[p.owner].geo, detailMat(), true, 'wheel', o3);
  }
  let draws = 0; grp.traverse((o) => { if (o.isMesh) draws++; });
  grp.userData = {
    type, tailMat, blinkMat, headMat: hm, wheels, wheelRadius: fin.wheelR,
    lights: { head: fin.lights.head.map((v) => new THREE.Vector3(v[0], v[1], v[2])), tail: fin.lights.tail.map((v) => new THREE.Vector3(v[0], v[1], v[2])) },
    len: D.len, wid: D.wid, height: fin.height || D.height, triangles: fin.tri, drawCalls: draws,
  };
  return grp;
}

// ───────────────────────── colours / variants
function toHex(c) { return typeof c === 'number' ? c : new THREE.Color(c).getHex(); }
function pickCarColor(type, rnd) {
  const r = rnd();
  if (type === 'taxi') return r < 0.5 ? 0xeeeeea : r < 0.8 ? 0xb9bdc1 : 0xd9822b;
  const w = [0.38, 0.2, 0.15, 0.12, 0.07, 0.04, 0.04]; let a = 0;
  for (let i = 0; i < w.length; i++) { a += w[i]; if (r < a) return PALETTE[i][0]; }
  return PALETTE[0][0];
}
const _cache = new Map();
function cached(key, fn) { let v = _cache.get(key); if (!v) { v = fn(); _cache.set(key, v); } return v; }

function buildCarVehicle(type, opts) {
  const rnd = rng32((opts.seed ?? 1) * 2654435761 + type.length * 97);
  const hex = opts.color !== undefined && opts.color !== null ? toHex(opts.color) : pickCarColor(type, rnd);
  const taxi = type === 'taxi', fb = type === 'sedan' && opts.variant === 'fastback', S = type === 'suv' ? SPEC_SUV : fb ? SPEC_FASTBACK : SPEC_SEDAN;
  const sun = !taxi && !fb && (opts.variant === 'sunroof' || (opts.variant === undefined && rnd() < 0.3));
  const stripe = hex === 0xd9822b ? 0xf1f1ec : 0x2f6db3;
  const fin = cached(`${type}|${sun ? 1 : 0}|${fb ? 1 : 0}|${taxi ? stripe : 0}`, () => {
    const { P, layout, lights } = carParts(S, { sunroof: sun, taxi, stripe });
    const f = finalize(P, layout, lights, { wheelR: S.wheelR });
    if (taxi) scaleFin(f, 0.9947, 1, 0.9899);
    return f;
  });
  return assemble(type, fin, hex);
}

// ───────────────────────── boxy helpers shared by truck / bus / moto
const boxD = (w, h, d, x, y, z, sw, hex, rot = [0, 0, 0]) => det(xf(new THREE.BoxGeometry(w, h, d), [x, y, z], rot), sw, hex);
const rboxD = (w, h, d, r, x, y, z, sw, hex, rot = [0, 0, 0]) => det(xf(new RoundedBoxGeometry(w, h, d, 2, r), [x, y, z], rot), sw, hex);
const rboxP = (w, h, d, r, x, y, z, rot = [0, 0, 0]) => pnt(xf(new RoundedBoxGeometry(w, h, d, 2, r), [x, y, z], rot));
// full ring (ccw from +z, starts bottom-centre) of a rounded rectangle: half-width w, y in [yb,yt], corner radii rb/rt, centre crown
function boxRing(w, yb, yt, rb, rt, nq = 2, crown = 0) {
  rb = Math.min(rb, w * 0.95); rt = Math.min(rt, w * 0.95);
  const h = [[0, yb], [w - rb, yb]];
  for (let i = 1; i <= nq; i++) { const a = (i / (nq + 1)) * PI / 2; h.push([w - rb + rb * Math.sin(a), yb + rb - rb * Math.cos(a)]); }
  h.push([w, yb + rb]); h.push([w, yt - rt]);
  for (let i = 1; i <= nq; i++) { const a = (i / (nq + 1)) * PI / 2; h.push([w - rt + rt * Math.cos(a), yt - rt + rt * Math.sin(a)]); }
  h.push([w - rt, yt]); h.push([0, yt + crown]);
  const full = h.slice(); for (let m = h.length - 2; m >= 1; m--) full.push([-h[m][0], h[m][1]]);
  return full;
}
const hexOf = (c) => (typeof c === 'number' ? c : new THREE.Color(c).getHex());

// ───────────────────────── 1-ton cab-over light truck
const SPEC_TRUCK = {
  height: 2.0, headY: 0.8, zF: 2.55, zR: 0.65, wheelR: 0.33, tireW: 0.205, rimR: 0.19, tx: 0.765, axleF: 1.8, axleR: -0.95, archClear: 0.04, tubIn: 0.58, arches: [1.8],
  halfW: [[0.65, 0.84], [1.0, 0.87], [2.2, 0.87], [2.55, 0.84]],
  yTop: [[0.65, 1.93], [0.72, 1.985], [1.0, 2.0], [2.0, 1.99], [2.22, 1.975], [2.34, 1.9], [2.44, 1.62], [2.5, 1.32], [2.55, 1.1]],
  yBot: [[0.65, 0.52], [1.0, 0.5], [2.2, 0.5], [2.5, 0.45], [2.55, 0.38]],
  crown: [[0.65, 0], [1.0, 0.03], [2.2, 0.03], [2.55, 0]],
  nose: { L: 0.35, p: 3.0 }, tail: { L: 0.14, p: 3.0 }, rcx: 0.17, rcy: 0.17, rsSill: 0.06, bulge: 0.012,
};
function truckParts(o) {
  const S = SPEC_TRUCK, lo = makeLower(S), SL = new Surface([lo.L.all]);
  const P = { paint: [pnt(lo.L.main)], detail: [], glass: [], head: [], tail: [], blink: [] };
  const add = (l, g) => { if (g) l.push(g); };
  if (lo.L.alt) P.detail.push(det(lo.L.alt, SW.PLASTIC, 0x0a0a0b));
  const FP = (q, off = 0.004, _r, _rr, seg = 0.1) => gridPatch(SL, 2, 1, q, { off, seg, round: 4 });
  // glass
  add(P.glass, FP([[-0.74, 1.15], [0.74, 1.15], [0.72, 1.83], [-0.72, 1.83]], 0.007, 0, 0, 0.1));
  add(P.glass, gridPatch(SL, 2, -1, [[-0.56, 1.4], [0.56, 1.4], [0.56, 1.8], [-0.56, 1.8]], { off: 0.004, seg: 0.08, round: 4 }));
  for (const sg of [1, -1]) {
    const side = (poly, off, _r, _rr, seg = 0.14) => gridPatch(SL, 0, sg, yz(poly), { off, seg, round: 4 });
    add(P.glass, side([[2.15, 1.12], [0.93, 1.12], [0.93, 1.8], [1.98, 1.8]], 0.004));
    add(P.detail, det(side([[2.18, 1.095], [0.905, 1.095], [0.905, 1.83], [1.96, 1.83]], 0.0025), SW.PLASTIC, 0x0c0c0d));
    for (const ln of [[[2.2, 0.62], [2.22, 1.0], [2.12, 1.55]], [[0.93, 0.6], [0.93, 1.1]], [[0.93, 1.8], [0.93, 1.95]]]) add(P.detail, det(strip(SL, 0, sg, yz(ln), 0.006, { off: 0.0018 }), SW.PLASTIC, 0x0c0c0d));
    add(P.detail, det(side(rect(1.08, 1.26, 1.1, 1.13), 0.008, 1, 0.01), SW.CHROME, 0x8d9398));
    // mirror: arm + housing
    P.detail.push(boxD(0.13, 0.03, 0.03, sg * 0.935, 1.52, 2.1, SW.PLASTIC, 0x1a1b1d), rboxD(0.075, 0.27, 0.14, 0.03, sg * 1.0, 1.55, 2.1, SW.GLOSS, 0x15171a));
    add(P.detail, det(xf(new THREE.PlaneGeometry(0.06, 0.24), [sg * 1.0, 1.55, 2.1 - 0.0705], [0, PI, 0]), SW.MIRROR, 0x252c33));
  }
  // nose: lamps, grille, bumper, plate
  for (const m of [false, true]) {
    const mp = (p) => (m ? mirX(p) : p);
    add(P.detail, det(FP(mp([[0.46, 0.7], [0.82, 0.7], [0.84, 0.9], [0.46, 0.9]]), 0.003, 2, 0.04), SW.LENS, 0x12161a));
    add(P.head, FP(mp([[0.5, 0.74], [0.8, 0.74], [0.81, 0.86], [0.5, 0.86]]), 0.0065, 2, 0.03));
    if (!m) add(P.detail, det(FP([[0.5, 0.57], [0.74, 0.57], [0.74, 0.63], [0.5, 0.63]], 0.005, 1, 0.012), SW.GLOSS, 0x7a4d0e));
    else add(P.blink, FP([[-0.74, 0.57], [-0.5, 0.57], [-0.5, 0.63], [-0.74, 0.63]], 0.005, 1, 0.012));
  }
  add(P.detail, det(FP([[-0.41, 0.72], [0.41, 0.72], [0.41, 1.04], [-0.41, 1.04]], 0.004, 2, 0.04), SW.PLASTIC, 0x0d0e10));
  for (const y of [0.8, 0.88, 0.96]) add(P.detail, det(strip(SL, 2, 1, [[-0.4, y], [0.4, y]], 0.014, { off: 0.0075 }), SW.CHROME, 0x4d5156));
  P.detail.push(rboxD(1.72, 0.27, 0.2, 0.05, 0, 0.46, 2.44, SW.SATIN, 0x4c5157));
  P.detail.push(plateGeo(0, 0.5, 2.558, 0.52, 0.11, 1, RECT.plate));
  // chassis, bed, gates
  const rail = (x) => boxD(0.09, 0.16, 4.3, x, 0.67, -0.35, SW.PLASTIC, 0x1b1c1e);
  P.detail.push(rail(0.5), rail(-0.5), boxD(1.7, 0.06, 3.12, 0, 0.81, -1.0, SW.SATIN, 0x62676c), boxD(1.0, 0.1, 0.1, 0, 0.64, -1.3, SW.PLASTIC, 0x1b1c1e), boxD(1.0, 0.1, 0.1, 0, 0.64, -2.2, SW.PLASTIC, 0x1b1c1e));
  P.detail.push(rboxD(1.74, 0.13, 0.1, 0.03, 0, 0.58, -2.46, SW.SATIN, 0x4c5157), plateGeo(0, 0.62, -2.52, 0.52, 0.11, -1, RECT.plate));
  const AL = 0xc6cacd, zc = -1.0, L = 3.1;
  for (const sg of [1, -1]) {
    P.detail.push(boxD(0.04, 0.36, L, sg * 0.855, 1.02, zc, SW.ALU, AL), boxD(0.05, 0.034, L - 0.1, sg * 0.867, 0.93, zc, SW.ALU, AL), boxD(0.05, 0.034, L - 0.1, sg * 0.867, 1.1, zc, SW.ALU, AL),
      boxD(0.07, 0.4, 0.06, sg * 0.86, 1.02, 0.53, SW.PLASTIC, 0x2a2c2f), boxD(0.07, 0.4, 0.06, sg * 0.86, 1.02, -2.49, SW.PLASTIC, 0x2a2c2f), boxD(0.07, 0.4, 0.06, sg * 0.86, 1.02, -1.0, SW.PLASTIC, 0x2a2c2f),
      boxD(0.28, 0.3, 0.012, sg * 0.77, 0.48, -1.42, SW.RUBBER, 0x101112));
    // tail lamps (+ right-side signal) and front/rear marker
    P.tail.push(xf(new THREE.BoxGeometry(0.2, 0.13, 0.05), [sg * 0.77, 0.8, -2.52]));
    if (sg > 0) P.detail.push(boxD(0.13, 0.055, 0.045, 0.77, 0.69, -2.52, SW.GLOSS, 0x7a4d0e));
    else P.blink.push(xf(new THREE.BoxGeometry(0.13, 0.055, 0.045), [-0.77, 0.69, -2.52]));
  }
  P.detail.push(boxD(1.7, 0.36, 0.04, 0, 1.02, -2.5, SW.ALU, AL), boxD(1.62, 0.034, 0.05, 0, 0.93, -2.52, SW.ALU, AL), boxD(1.62, 0.034, 0.05, 0, 1.1, -2.52, SW.ALU, AL), boxD(1.7, 0.3, 0.04, 0, 0.99, 0.545, SW.ALU, AL));
  for (const g of P.tail) keepAttrs(g, ['position', 'normal']);
  for (const g of P.blink) keepAttrs(g, ['position', 'normal']);
  // tarp-covered load (variant)
  if (o.tarp) {
    const zs = [], rings = [], N = 15;
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1), z = -2.42 + 2.86 * t, ue = t < 0.5 ? 1 - t / 0.12 : (t - 0.88) / 0.12;
      const kk = ue > 0 ? planK(clamp(ue, 0, 1), 3) : 1;
      const top = 1.78 - 0.2 * Math.pow((t - 0.45) / 0.55, 2) + 0.045 * Math.sin(t * 17) + (t < 0.2 ? -0.1 * (0.2 - t) : 0);
      zs.push(z); rings.push(boxRing(0.84 * Math.max(kk, 1e-3), 1.12, top, 0.08, 0.3 * Math.max(kk, 0.05), 2, 0.05).map(([x, y]) => [x * 1, y]));
    }
    const TL = buildLoft(zs, rings), ST = new Surface([TL.all]);
    P.detail.push(det(TL.main, SW.CLOTH, 0x2b5ea8));
    for (const zr of [-2.0, -1.25, -0.5, 0.1]) {
      add(P.detail, det(strip(ST, 1, 1, [[-0.8, zr], [0, zr], [0.8, zr]], 0.03, { off: 0.008 }), SW.CLOTH, 0xd7b24a));
      for (const sg of [1, -1]) add(P.detail, det(strip(ST, 0, sg, yz([[zr, 1.2], [zr, 1.5], [zr, 1.72]]), 0.03, { off: 0.008 }), SW.CLOTH, 0xd7b24a));
    }
  }
  const xs = (x) => [{ x }, { x: -x }];
  const layout = wheelLayout(S.wheelR, S.tireW, S.rimR, [{ z: S.axleF, xs: xs(S.tx) }, { z: S.axleR, xs: xs(S.tx) }], { steel: true, seg: 18 });
  return { P, layout, lights: { head: [[0.66, 0.8, 2.5], [-0.66, 0.8, 2.5]], tail: [[0.77, 0.8, -2.5], [-0.77, 0.8, -2.5]] } };
}
function buildTruckVehicle(opts) {
  const rnd = rng32((opts.seed ?? 1) * 40503 + 7);
  const tarp = opts.variant === 'tarp';
  const hex = opts.color !== undefined && opts.color !== null ? toHex(opts.color) : (rnd() < 0.8 ? 0xeeeeea : rnd() < 0.5 ? 0xb9bdc1 : 0x1d2a44);
  const fin = cached('truck|' + (tarp ? 1 : 0), () => {
    const { P, layout, lights } = truckParts({ tarp });
    const f = finalize(P, layout, lights, { wheelR: SPEC_TRUCK.wheelR });
    return f;
  });
  return assemble('truck', fin, hex);
}

// ───────────────────────── city buses: 'bus' (blue trunk line, 11 m) and 'minibus' (green branch line, 9 m)
const SPEC_BUS = {
  height: 3.25, headY: 0.74, zF: 5.5, zR: -5.5, wheelR: 0.5, tireW: 0.275, rimR: 0.29, tx: 1.07, axleF: 3.0, axleR: -2.7, archClear: 0.1, tubIn: 0.55, step: 0.55,
  halfW: [[-5.5, 1.16], [-5.0, 1.235], [-4.2, 1.245], [4.2, 1.245], [5.0, 1.235], [5.5, 1.16]],
  yTop: [[-5.5, 2.55], [-5.35, 2.78], [-5.1, 2.86], [-4.5, 2.88], [4.5, 2.88], [5.15, 2.86], [5.4, 2.78], [5.5, 2.6]],
  yBot: [[-5.5, 0.46], [-5.4, 0.36], [-5.2, 0.32], [-4.5, 0.3], [4.5, 0.3], [5.2, 0.34], [5.4, 0.38], [5.5, 0.46]],
  crown: [[-5.5, 0], [-5, 0.07], [5, 0.07], [5.5, 0]],
  nose: { L: 0.55, p: 3.6 }, tail: { L: 0.45, p: 3.6 }, rcx: 0.3, rcy: 0.32, rsSill: 0.06, rsArch: 0.04, bulge: 0.02,
  winY: [1.2, 2.44], dualRear: true,
};
const SPEC_MINI = {
  height: 3.05, headY: 0.72, zF: 4.5, zR: -4.5, wheelR: 0.45, tireW: 0.245, rimR: 0.26, tx: 0.98, axleF: 2.45, axleR: -2.2, archClear: 0.09, tubIn: 0.5, step: 0.5,
  halfW: [[-4.5, 1.12], [-4.1, 1.19], [-3.4, 1.2], [3.4, 1.2], [4.1, 1.19], [4.5, 1.12]],
  yTop: [[-4.5, 2.5], [-4.36, 2.7], [-4.1, 2.78], [-3.6, 2.8], [3.6, 2.8], [4.15, 2.78], [4.38, 2.7], [4.5, 2.52]],
  yBot: [[-4.5, 0.44], [-4.4, 0.35], [-4.2, 0.31], [-3.6, 0.29], [3.6, 0.29], [4.2, 0.33], [4.4, 0.37], [4.5, 0.44]],
  crown: [[-4.5, 0], [-4.0, 0.06], [4.0, 0.06], [4.5, 0]],
  nose: { L: 0.5, p: 3.4 }, tail: { L: 0.4, p: 3.4 }, rcx: 0.27, rcy: 0.3, rsSill: 0.06, rsArch: 0.04, bulge: 0.02,
  winY: [1.14, 2.4], dualRear: true,
};
const BUS_CFG = {
  bus: {
    S: SPEC_BUS, body: 0x1c5fbf, accent: 0xe4e8ec, accent2: 0x8f979f, defText: '273', font: 1,
    doorsR: [[5.1, 4.1], [0.02, -1.0]], winsR: [[3.95, 2.78], [2.62, 1.45], [1.32, 0.16], [-1.14, -2.25], [-2.4, -3.6], [-3.75, -4.95]],
    winsL: [[4.95, 3.85], [3.72, 2.55], [2.42, 1.25], [1.12, -0.05], [-0.18, -1.35], [-1.48, -2.65], [-2.78, -3.95], [-4.08, -5.0]],
    pod: { z0: -4.3, z1: 4.1, w: 0.98, yb: 2.8, yt: 3.2 }, rearWin: [[-0.78, 1.75], [0.78, 1.75], [0.78, 2.4], [-0.78, 2.4]],
    arches: [[2.4, 3.6], [-3.3, -2.1]], bands: [{ y0: 0.5, y1: 0.58, c: 0xe4e8ec }], roofCap: null,
  },
  minibus: {
    S: SPEC_MINI, body: 0x6cc04a, accent: 0xf2f4f1, accent2: 0x8f979f, defText: '성북구청', font: 1,
    doorsR: [[4.1, 3.1], [-0.3, -1.3]], winsR: [[2.95, 1.85], [1.72, 0.55], [-1.42, -2.6], [-2.72, -3.85]],
    winsL: [[4.05, 3.0], [2.88, 1.85], [1.72, 0.6], [0.48, -0.65], [-0.78, -1.9], [-2.02, -3.1], [-3.22, -4.1]],
    pod: { z0: -1.0, z1: 2.3, w: 0.8, yb: 2.74, yt: 3.0 }, rearWin: [[-0.7, 1.7], [0.7, 1.7], [0.7, 2.34], [-0.7, 2.34]],
    arches: [[1.9, 3.0], [-2.75, -1.65]], bands: [{ y0: 0.5, y1: 1.0, c: 0xf2f4f1, segs: [[1.82, 0.5], [-1.45, -1.62], [-2.7, -4.25]] }], roofCap: true,
  },
};
function busParts(type, o) {
  const C = BUS_CFG[type], S = C.S, lo = makeLower(S), SL = new Surface([lo.L.all]);
  const P = { paint: [pnt(lo.L.main)], detail: [], glass: [], head: [], tail: [], blink: [] }, add = (l, g) => { if (g) l.push(g); };
  if (lo.L.alt) P.detail.push(det(lo.L.alt, SW.PLASTIC, 0x0a0a0b));
  const SP = (sg, poly, off, rings = 1, rr = 0.05) => patch(SL, 0, sg, roundPoly(yz(poly), rr, 2), { rings, off, seg: 0.7 });
  const FP = (q, off = 0.004, _r, _rr, seg = 0.08) => gridPatch(SL, 2, 1, q, { off, seg, round: 4 });
  const RP = (q, off = 0.004, _r, _rr, seg = 0.08) => gridPatch(SL, 2, -1, q, { off, seg, round: 4 });
  const rz = (a, b, y0, y1, e = 0) => rect(Math.max(a, b) + e, Math.min(a, b) - e, y0 - e, y1 + e);
  const [wy0, wy1] = S.winY, DARK = 0x0d0e10, GL = 0x161c22;
  for (const sg of [-1, 1]) {
    const wins = sg < 0 ? C.winsR : C.winsL;
    for (const [a, b] of wins) { add(P.detail, det(SP(sg, rz(a, b, wy0, wy1, 0.028), 0.003, 1, 0.06), SW.PLASTIC, DARK)); add(P.glass, SP(sg, rz(a, b, wy0, wy1), 0.0065, 2, 0.05)); }
    if (sg < 0) for (const [a, b] of C.doorsR) { // doors (right side): frame + two glass leaves + centre seal
      const m = (a + b) / 2;
      add(P.detail, det(SP(sg, rz(a, b, 0.5, wy1 + 0.02, 0.025), 0.003, 1, 0.04), SW.PLASTIC, DARK));
      for (const [l0, l1] of [[a, m + 0.02], [m - 0.02, b]]) add(P.glass, SP(sg, rz(l0 - 0.015 * Math.sign(a - m), l1, 0.62, wy1), 0.0065, 2, 0.04));
      add(P.detail, det(strip(SL, 0, sg, yz([[m, 0.5], [m, wy1]]), 0.04, { off: 0.0085 }), SW.RUBBER, 0x111214));
      add(P.detail, det(SP(sg, rz(a, b, 0.5, 0.6, 0.0), 0.005, 1, 0.01), SW.PLASTIC, 0x2a2c2f));
    }
    // livery bands / panels (satin accents)
    for (const bd of C.bands) {
      let list = bd.segs;
      if (!list) { const ex = [...C.arches, ...(sg < 0 ? C.doorsR.map(([a, b]) => [Math.max(a, b), Math.min(a, b)]) : [])].map(([a, b]) => [Math.min(a, b) - 0.04, Math.max(a, b) + 0.04]).sort((p, q) => p[0] - q[0]); list = []; let cur = S.zR + 0.35; for (const [a, b] of ex) { if (a > cur + 0.2) list.push([a, cur]); cur = Math.max(cur, b); } if (S.zF - 0.35 > cur + 0.2) list.push([S.zF - 0.35, cur]); }
      for (const [a, b] of list) add(P.detail, det(SP(sg, rect(a, b, bd.y0, bd.y1), 0.0024, 1, 0.02), SW.SATIN, bd.c));
    }
    // mirror arm + housing, lower step lights etc.
    P.detail.push(boxD(0.34, 0.035, 0.04, sg * (S.halfW[3][1] + 0.12), 1.95, S.zF - 0.5, SW.PLASTIC, 0x17181a), rboxD(0.075, 0.42, 0.2, 0.025, sg * (S.halfW[3][1] + 0.3), 1.9, S.zF - 0.5, SW.GLOSS, 0x15171a));
    add(P.detail, det(xf(new THREE.PlaneGeometry(0.17, 0.38), [sg * (S.halfW[3][1] + 0.3), 1.9, S.zF - 0.5 - 0.101], [0, PI, 0]), SW.MIRROR, 0x252c33));
  }
  // ── front face
  const hw = S.halfW[3][1], f0 = S.zF;
  add(P.glass, FP([[0.035, 1.12], [hw - 0.13, 1.12], [hw - 0.12, 2.45], [0.035, 2.45]], 0.009, 0, 0, 0.2));
  add(P.glass, FP([[-0.035, 1.12], [-hw + 0.13, 1.12], [-hw + 0.12, 2.45], [-0.035, 2.45]], 0.009, 0, 0, 0.2));
  add(P.detail, det(FP([[-1.12, 1.095], [1.12, 1.095], [1.12, 2.47], [-1.12, 2.47]], 0.005, 0, 0, 0.16), SW.PLASTIC, DARK));
  add(P.detail, det(strip(SL, 2, 1, [[0, 1.12], [0, 2.46]], 0.07, { off: 0.0085 }), SW.PLASTIC, 0x151618));
  for (const sx of [1, -1]) add(P.detail, det(strip(SL, 2, 1, [[sx * 0.1, 1.2], [sx * 0.75, 2.0]], 0.012, { off: 0.0105 }), SW.PLASTIC, 0x0a0a0b));
  { // LED destination board
    const bw = hw * 0.62, y0 = 2.5, y1 = 2.74, led = ledStrip(o.routeText || C.defText);
    add(P.detail, det(FP(rect(-bw - 0.03, bw + 0.03, y0 - 0.03, y1 + 0.03), 0.003, 0, 0, 0.2), SW.PLASTIC, DARK));
    const g = FP(rect(-bw, bw, y0, y1), 0.0055, 0, 0, 0.1);
    if (g) { const p = g.attributes.position, uv = []; for (let i = 0; i < p.count; i++) { const u = rectUV(led, clamp((p.getX(i) + bw) / (2 * bw), 0, 1), clamp((p.getY(i) - y0) / (y1 - y0), 0, 1)); uv.push(u[0], u[1]); } P.detail.push(detUV(g, uv, 0xffffff)); }
  }
  for (const m of [false, true]) {
    const mp = (p) => (m ? mirX(p) : p);
    add(P.detail, det(FP(mp([[0.6, 0.6], [hw - 0.06, 0.6], [hw - 0.03, 0.84], [0.6, 0.84]]), 0.003, 2, 0.05), SW.LENS, 0x12161a));
    add(P.head, FP(mp([[0.68, 0.65], [hw - 0.12, 0.65], [hw - 0.1, 0.79], [0.68, 0.79]]), 0.0065, 2, 0.04));
    if (!m) add(P.detail, det(FP([[hw - 0.32, 0.9], [hw - 0.1, 0.9], [hw - 0.1, 0.98], [hw - 0.32, 0.98]], 0.005, 1, 0.015), SW.GLOSS, 0x7a4d0e));
    else add(P.blink, FP([[-hw + 0.1, 0.9], [-hw + 0.32, 0.9], [-hw + 0.32, 0.98], [-hw + 0.1, 0.98]], 0.005, 1, 0.015));
    add(P.detail, det(RP(mp([[hw - 0.32, 0.9], [hw - 0.06, 0.9], [hw - 0.06, 2.0], [hw - 0.32, 2.0]]), 0.003, 2, 0.04), SW.GLOSS, 0x15090a));
    add(P.tail, RP(mp([[hw - 0.29, 0.93], [hw - 0.09, 0.93], [hw - 0.09, 1.78], [hw - 0.29, 1.78]]), 0.0065, 2, 0.03));
    if (!m) add(P.detail, det(RP([[hw - 0.29, 1.82], [hw - 0.09, 1.82], [hw - 0.09, 1.95], [hw - 0.29, 1.95]], 0.0075, 1, 0.01), SW.GLOSS, 0x7a4d0e));
    else add(P.blink, RP([[-hw + 0.09, 1.82], [-hw + 0.29, 1.82], [-hw + 0.29, 1.95], [-hw + 0.09, 1.95]], 0.0075, 1, 0.01));
  }
  add(P.detail, det(FP(rect(-hw + 0.1, hw - 0.1, 0.36, 0.6), 0.004, 0, 0, 0.2), SW.SATIN, C.accent2));
  add(P.detail, det(FP(rect(-0.55, 0.55, 0.64, 1.0), 0.004, 0, 0, 0.14), SW.PLASTIC, 0x0d0e10));
  for (const y of [0.72, 0.8, 0.88, 0.96]) add(P.detail, det(strip(SL, 2, 1, [[-0.5, y], [0.5, y]], 0.012, { off: 0.0075 }), SW.PLASTIC, 0x2a2c2f));
  P.detail.push(plateGeo(0, 0.5, f0 + 0.015, 0.52, 0.11, 1, RECT.plate));
  // ── rear face
  add(P.glass, RP(C.rearWin, 0.0065, 0, 0, 0.2));
  add(P.detail, det(RP(rect(-0.8, 0.8, 0.64, 1.6), 0.004, 0, 0, 0.2), SW.PLASTIC, 0x101113));
  for (let y = 0.7; y < 1.55; y += 0.1) add(P.detail, det(strip(SL, 2, -1, [[-0.74, y], [0.74, y]], 0.018, { off: 0.0075 }), SW.PLASTIC, 0x2c2e31));
  P.detail.push(plateGeo(0, 0.5, S.zR - 0.015, 0.52, 0.11, -1, RECT.plate));
  add(P.detail, det(RP(rect(-hw + 0.1, hw - 0.1, 0.36, 0.56), 0.004, 0, 0, 0.2), SW.SATIN, C.accent2));
  // roof pod (fuel / AC housing) + furniture
  const pd = C.pod, zs = [], rings = [], N = 16;
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1), z = lerp(pd.z0, pd.z1, t), e = Math.min(t, 1 - t) / 0.12, kk = e < 1 ? planK(1 - e, 2.4) : 1;
    zs.push(z); rings.push(boxRing(Math.max(1e-3, pd.w * kk), pd.yb, pd.yt - 0.1 * (1 - Math.min(1, e)), 0.04, Math.min(0.26, pd.w * kk * 0.9), 2, 0.025));
  }
  const PL = buildLoft(zs, rings);
  P.paint.push(pnt(PL.main));
  const podTop = pd.yt + 0.025;
  P.detail.push(rboxD(0.55, 0.05, 0.4, 0.02, 0, podTop, pd.z0 + (pd.z1 - pd.z0) * 0.3, SW.SATIN, 0x30343a), rboxD(0.55, 0.05, 0.4, 0.02, 0, podTop, pd.z0 + (pd.z1 - pd.z0) * 0.62, SW.SATIN, 0x30343a));
  // livery accents drawn over the body: roof cap (minibus) / pod trim (bus)
  if (C.roofCap) add(P.detail, det(gridPatch(SL, 1, 1, [[-0.9, S.zR + 0.9], [0.9, S.zR + 0.9], [0.9, S.zF - 0.9], [-0.9, S.zF - 0.9]], { off: 0.004, seg: 0.2, round: 1 }), SW.SATIN, C.accent));
  // dark underbody (hides the see-through gap under the floor)
  P.detail.push(boxD(1.1, 0.22, S.zF * 2 - 0.9, 0, 0.2, 0, SW.PLASTIC, 0x131416));
  // wheels: single front, dual rear
  const x1 = S.tx, x2 = S.tx - 0.33;
  const rear = S.dualRear ? [{ x: x1 }, { x: x2, simple: true }, { x: -x2, simple: true }, { x: -x1 }] : [{ x: x1 }, { x: -x1 }];
  const layout = wheelLayout(S.wheelR, S.tireW, S.rimR, [{ z: S.axleF, xs: [{ x: x1 }, { x: -x1 }] }, { z: S.axleR, xs: rear }], { steel: true, seg: 20 });
  const hy = S.headY;
  return { P, layout, lights: { head: [[hw - 0.35, hy, f0 - 0.04], [-hw + 0.35, hy, f0 - 0.04]], tail: [[hw - 0.2, 1.35, S.zR + 0.04], [-hw + 0.2, 1.35, S.zR + 0.04]] } };
}
function buildBusVehicle(type, opts) {
  const C = BUS_CFG[type], rnd = rng32((opts.seed ?? 1) * 7919 + type.length);
  let livery = opts.livery || (type === 'bus' ? 'trunk' : 'branch');
  let hex = opts.color !== undefined && opts.color !== null ? toHex(opts.color) : (livery === 'branch' ? BUS_CFG.minibus.body : BUS_CFG.bus.body);
  const text = opts.routeText || C.defText;
  const led = ledStrip(text); // allocates / refreshes the strip row; the cache key follows the row so a recycled row rebuilds the UVs
  const fin = cached(`${type}|${text}|${led.x}|${led.y}`, () => {
    const { P, layout, lights } = busParts(type, { routeText: text });
    return finalize(P, layout, lights, { wheelR: C.S.wheelR });
  });
  return assemble(type, fin, hex);
}

// ───────────────────────── 125cc delivery scooter with rider
const _up = new THREE.Vector3(0, 1, 0);
function oriented(g, a, b) { // orient a +Y-axis geometry from point a to point b
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_up, d.clone().normalize()));
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const rodD = (a, b, r, sw, hex, seg = 6) => det(oriented(new THREE.CylinderGeometry(r, r, dist3(a, b), seg, 1), a, b), sw, hex);
function limb(a, b, r, sw, hex, sx = 1, sz = 1) { // capsule between two points (scaled across its width)
  const g = new THREE.CapsuleGeometry(r, Math.max(0.001, dist3(a, b) - 2 * r), 1, 6);
  g.scale(sx, 1, sz);
  return det(oriented(g, a, b), sw, hex);
}
const ellip = (cx, cy, cz, rx, ry, rz, sw, hex, seg = 9, rot = [0, 0, 0]) => det(xf(new THREE.SphereGeometry(0.5, seg, Math.max(3, seg - 4)), [cx, cy, cz], rot, [rx * 2, ry * 2, rz * 2]), sw, hex);

function motoParts(o) {
  const R = 0.26, ZF = 0.72, ZR = -0.63, hexBody = o.hex;
  const P = { paint: [], detail: [], glass: [], head: [], tail: [], blink: [] }, add = (l, g) => { if (g) l.push(g); };
  // body shell: tail, seat base, floor, leg shield (one smooth loft)
  const zs = [-0.98, -0.92, -0.82, -0.66, -0.5, -0.34, -0.18, -0.08, 0.04, 0.2, 0.38, 0.46, 0.53, 0.6, 0.66, 0.7];
  const fw = curve([[-0.98, 0.03], [-0.93, 0.12], [-0.85, 0.17], [-0.65, 0.2], [-0.35, 0.2], [-0.08, 0.24], [0.2, 0.28], [0.45, 0.24], [0.6, 0.2], [0.66, 0.14], [0.7, 0.05]]);
  const fb = curve([[-0.98, 0.52], [-0.75, 0.56], [-0.4, 0.54], [-0.14, 0.34], [0, 0.26], [0.45, 0.25], [0.58, 0.32], [0.7, 0.5]]);
  const ft = curve([[-0.98, 0.7], [-0.85, 0.76], [-0.55, 0.76], [-0.25, 0.7], [-0.08, 0.42], [0.06, 0.36], [0.42, 0.36], [0.5, 0.6], [0.6, 0.9], [0.7, 0.97]]);
  const rings = zs.map((z) => { const yb = fb(z), yt = Math.max(ft(z), yb + 0.08), h = yt - yb; return boxRing(Math.max(1e-3, fw(z)), yb, yt, Math.min(0.06, 0.4 * h), Math.min(0.09, 0.45 * h), 1, 0.012); });
  const body = buildLoft(zs, rings); P.paint.push(pnt(body.main));
  // front fender (arc over the wheel), cowl, headlamp
  P.paint.push(pnt(xf(lathe([[R + 0.022, -0.055], [R + 0.03, 0], [R + 0.022, 0.055]], 14, -2.5, 2.95), [0, R, ZF])));
  P.paint.push(rboxP(0.34, 0.2, 0.28, 0.07, 0, 1.0, 0.56));
  P.detail.push(det(xf(new THREE.CircleGeometry(0.5, 12), [0, 1.0, 0.704], [0, 0, 0], [0.25, 0.14, 1]), SW.LENS, 0x12161a));
  P.head.push(keepAttrs(xf(new THREE.CircleGeometry(0.5, 12), [0, 1.0, 0.708], [0, 0, 0], [0.18, 0.075, 1]), ['position', 'normal']));
  // seat, floor mat, rack, delivery box, tail details
  P.detail.push(rboxD(0.3, 0.07, 0.56, 0.03, 0, 0.78, -0.37, SW.CLOTH, 0x131313), boxD(0.34, 0.012, 0.45, 0, 0.371, 0.2, SW.RUBBER, 0x141414), boxD(0.4, 0.03, 0.42, 0, 0.79, -0.78, SW.PLASTIC, 0x1a1b1d));
  P.detail.push(rboxD(0.4, 0.38, 0.4, 0.05, 0, 1.0, -0.8, SW.GLOSS, 0xe4e6e8), boxD(0.404, 0.012, 0.404, 0, 1.07, -0.8, SW.PLASTIC, 0x2a2c2f), boxD(0.16, 0.03, 0.01, 0, 1.12, -1.004, SW.SATIN, 0x9a1010));
  P.detail.push(plateGeo(0, 0.93, -1.006, 0.22, 0.11, -1, RECT.plateS));
  P.tail.push(keepAttrs(xf(new THREE.PlaneGeometry(0.15, 0.045), [0, 0.67, -0.985], [0, PI, 0]), ['position', 'normal']));
  P.detail.push(det(xf(new THREE.PlaneGeometry(0.19, 0.075), [0, 0.67, -0.9845], [0, PI, 0]), SW.GLOSS, 0x15090a));
  // signals (right = -X blinks)
  P.detail.push(boxD(0.055, 0.035, 0.03, 0.14, 0.67, -0.975, SW.GLOSS, 0x7a4d0e), boxD(0.05, 0.035, 0.045, 0.17, 0.96, 0.58, SW.GLOSS, 0x7a4d0e));
  P.blink.push(keepAttrs(xf(new THREE.BoxGeometry(0.055, 0.035, 0.03), [-0.14, 0.67, -0.975]), ['position', 'normal']), keepAttrs(xf(new THREE.BoxGeometry(0.05, 0.035, 0.045), [-0.17, 0.96, 0.58]), ['position', 'normal']));
  // fork, handlebar, mirrors, engine cover, exhaust, shocks
  for (const sx of [1, -1]) {
    P.detail.push(rodD([sx * 0.07, R, ZF], [sx * 0.07, 0.93, 0.58], 0.016, SW.CHROME, 0x3a3d41), rodD([sx * 0.31, 1.06, 0.5], [sx * 0.39, 1.06, 0.5], 0.02, SW.RUBBER, 0x101112, 7),
      rodD([sx * 0.3, 1.07, 0.5], [sx * 0.32, 1.26, 0.44], 0.006, SW.CHROME, 0x2a2c2f, 4), ellip(sx * 0.325, 1.285, 0.425, 0.045, 0.03, 0.012, SW.GLOSS, 0x14161a, 8),
      rodD([sx * 0.13, 0.28, ZR], [sx * 0.15, 0.62, -0.5], 0.011, SW.CHROME, 0x2a2c2f, 5));
  }
  P.detail.push(rodD([-0.3, 1.06, 0.5], [0.3, 1.06, 0.5], 0.013, SW.CHROME, 0x1c1d20), rboxD(0.12, 0.2, 0.5, 0.05, 0.13, 0.34, -0.42, SW.SATIN, 0x23262a), rodD([-0.13, 0.27, -0.22], [-0.13, 0.31, -0.95], 0.045, SW.CHROME, 0x4a4d52, 8));
  // rider
  const jacket = o.jacket, pants = 0x3b4048, glove = 0x131415, helm = o.helmet;
  P.detail.push(limb([0, 0.92, -0.33], [0, 1.25, -0.15], 0.15, SW.CLOTH, jacket, 1.15, 0.8), ellip(0, 1.27, -0.12, 0.2, 0.09, 0.14, SW.CLOTH, jacket, 8));
  for (const sx of [1, -1]) {
    P.detail.push(limb([sx * 0.2, 1.24, -0.12], [sx * 0.27, 1.08, 0.1], 0.05, SW.CLOTH, jacket), limb([sx * 0.27, 1.08, 0.1], [sx * 0.31, 1.065, 0.43], 0.043, SW.CLOTH, jacket), ellip(sx * 0.315, 1.06, 0.46, 0.045, 0.04, 0.05, SW.CLOTH, glove, 6),
      limb([sx * 0.12, 0.88, -0.34], [sx * 0.17, 0.8, 0.17], 0.078, SW.CLOTH, pants), limb([sx * 0.17, 0.8, 0.17], [sx * 0.16, 0.45, 0.27], 0.06, SW.CLOTH, pants), rboxD(0.095, 0.07, 0.27, 0.025, sx * 0.16, 0.405, 0.33, SW.GLOSS, o.shoe));
  }
  P.detail.push(limb([0, 1.3, -0.1], [0, 1.38, -0.06], 0.06, SW.CLOTH, jacket), ellip(0, 1.49, -0.03, 0.15, 0.16, 0.19, SW.GLOSS, helm, 10), ellip(0, 1.485, 0.075, 0.125, 0.06, 0.1, SW.LENS, 0x101418, 8));
  const layout = wheelLayout(R, 0.1, 0.165, [{ z: ZF, xs: [{ x: 0 }] }, { z: ZR, xs: [{ x: 0 }] }], { spokes: 5, seg: 12, twoSided: true, rimHex: 0x30343a });
  return { P, layout, lights: { head: [[0, 1.0, 0.7]], tail: [[0, 0.67, -0.98]] } };
}
function buildMotoVehicle(opts) {
  const rnd = rng32((opts.seed ?? 1) * 6007 + 3);
  const hex = opts.color !== undefined && opts.color !== null ? toHex(opts.color) : (rnd() < 0.7 ? 0x15171a : rnd() < 0.6 ? 0x33383e : 0x1d2a44);
  const jackets = [0x1b1f27, 0x23292f, 0x2a2420, 0x182030], helmets = [0xeceff1, 0xeceff1, 0x16171a, 0xc9ced3], shoes = [0xe6e6e6, 0x1a1a1c, 0xd8d8d4];
  const pickA = (a) => a[Math.floor(rnd() * a.length) % a.length];
  const jacket = pickA(jackets), helmet = pickA(helmets), shoe = pickA(shoes);
  const fin = cached(`moto|${jacket}|${helmet}|${shoe}`, () => {
    const { P, layout, lights } = motoParts({ hex, jacket, helmet, shoe });
    return finalize(P, layout, lights, { wheelR: 0.26 });
  });
  return assemble('moto', fin, hex);
}

// ───────────────────────── public API
export function buildVehicle(type, opts = {}) {
  if (!VEHICLE_DIMS[type]) throw new Error('vehicles3d: unknown vehicle type "' + type + '"');
  switch (type) {
    case 'sedan': case 'suv': case 'taxi': return buildCarVehicle(type, opts);
    case 'bus': case 'minibus': return buildBusVehicle(type, opts);
    case 'moto': return buildMotoVehicle(opts);
    case 'truck': return buildTruckVehicle(opts);
    default: throw new Error('vehicles3d: not implemented yet: ' + type);
  }
}
// disposes only the per-vehicle resources (unique lamp materials); geometry / paint / glass / detail are shared caches
export function disposeVehicle(group) {
  const ud = group && group.userData;
  if (!ud) return;
  if (ud.tailMat) ud.tailMat.dispose();
  if (ud.blinkMat) ud.blinkMat.dispose();
}
