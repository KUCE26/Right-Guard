/**
 * people3d.js - procedural realistic pedestrians for the Right Guard Metaverse (three.js r170).
 *
 * Everything is code-built (lofted/lathe meshes, per-vertex colour, no textures, no assets).
 * One person = ONE SkinnedMesh (1 draw call, shared material, <= ~3.3k triangles) driven by a 13-bone skeleton.
 *
 * API
 *   PERSON_MODEL_H = 1.775                      top of the head at scale 1 (game scales `root` uniformly)
 *   buildPerson(kind='adult', opts={})  -> rig  kind: 'adult' | 'kid' | 'twin'
 *        opts: { seed, gender: 'm'|'f', material }   (material given => every mesh uses it, castShadow=false)
 *   poseWalk(rig, phase, speed, run=false)      full gait (one stride = 2*PI, run when run || speed >= 2.2)
 *   poseIdle(rig, t)                            relaxed standing, breathing / weight shift (t in seconds)
 *   disposePerson(rig)                          frees per-person GPU resources only (shared caches survive)
 *   gaitPhaseRate(speed, run=false, scale=1)    extra helper: rad/s of `phase` that keeps feet from sliding
 *
 * rig = { root, body, pelvis, torso, head, legs:[hipL,hipR], knees:[kneeL,kneeR], arms:[shoulderL,shoulderR],
 *         elbows:[elbowL,elbowR], ankles:[ankleL,ankleR], props, mesh, skeleton }
 *   root   Group, feet on y=0, person faces +Z. Person's LEFT side is +X, RIGHT side is -X.
 *   body   child of root (bob / lean pivot; poseWalk writes body.position.y).
 *   Joints are THREE.Bone (Object3D) pivots at the anatomical joints; the skinned mesh follows them.
 *
 * JOINT CONVENTION (rotation.x, radians) - "positive = flexion" for every joint:
 *   hips, shoulders : +x swings the limb FORWARD (toward +Z)
 *   knees           : +x bends the knee (shin goes BACKWARD)
 *   elbows          : +x bends the elbow (forearm goes FORWARD)
 *   ankles          : +x = toes down (plantar flexion)
 *   pelvis/torso/head: ordinary three.js axes (rotation.y + = turn toward the person's left (+X)),
 *                      torso.rotation.x + = lean forward, head.rotation.x + = nod down.
 *   Limb joints use rotation.order 'YXZ' and carry a rest rotation.y of PI (hips, knees, shoulders) so that the
 *   sign convention above holds. Only write rotation.x (flexion) / rotation.z (abduction); do not call
 *   rotation.set(...) or reset rotation.y on hips / knees / shoulders.
 *
 * props = { bag: 'backpack'|'crossbody'|'shoulder'|null, bagSide: 'L'|'R'|null, phone: 'L'|'R'|null (arm holding a phone),
 *           tote: 'L'|'R'|null, shopping: 'L'|'R'|null (hand carrying a bag), cap: bool, hood: bool,
 *           outfit: 'trench'|'jacket'|'puffer'|'vest'|'hoodie'|'shirt'|'kid...', bottom, hair, shoe, kind, gender }
 *   (descriptor only: the accessories are baked into the single skinned mesh, so props holds no scene objects).
 *
 * USAGE
 *   const rig = buildPerson('adult', { seed: 12, gender: 'f' }); rig.root.scale.setScalar(1.62 / PERSON_MODEL_H); scene.add(rig.root);
 *   walking : phase += dt * gaitPhaseRate(speed, run, rig.root.scale.x, kid); poseWalk(rig, phase, speed, run);
 *   standing: poseIdle(rig, timeSeconds)   (switching between the two blends over ~0.28 s automatically)
 *   Same seed + kind + gender => identical person (geometry cached and shared, 64 entries max); no seed => random.
 *   The caller may still move/rotate/scale rig.root; poseWalk/poseIdle own body.position.x/y and every joint rotation.
 */
import * as THREE from 'three';

export const PERSON_MODEL_H = 1.775;

// ----- bone indices ---------------------------------------------------------------------------------------------
const B = { PELVIS: 0, TORSO: 1, HEAD: 2, HIP_L: 3, KNEE_L: 4, ANK_L: 5, HIP_R: 6, KNEE_R: 7, ANK_R: 8, SH_L: 9, EL_L: 10, SH_R: 11, EL_R: 12 };
const NB = 13;

// ----- small utils ----------------------------------------------------------------------------------------------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
function rngFrom(seed) {
  let a = (seed >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pickR = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
const _c = new THREE.Color();
function lin(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; } // hex (sRGB) -> linear rgb for vertex colours
function shadeHex(hex, k) { _c.setHex(hex); _c.r = clamp(_c.r * k, 0, 1); _c.g = clamp(_c.g * k, 0, 1); _c.b = clamp(_c.b * k, 0, 1); return _c.getHex(); }

// ----- palettes (autumn Seoul street wear) ----------------------------------------------------------------------
const SKIN = [0xe6bf9f, 0xdeb08c, 0xd5a47f, 0xc99872, 0xbd8a66];
const HAIR = [0x15110e, 0x1c1612, 0x251a13, 0x33241a, 0x45342a, 0x0e0c0b, 0x1a1a1c, 0x58524b];
const TOP = [0x1b1c1f, 0x3a3d42, 0x1f2d47, 0xcdbd9f, 0xa87b4f, 0x8a8461, 0x5d6340, 0xe9e7e1, 0xb9bbbe, 0x4a6a93, 0x6d2434, 0xc89a2c, 0x8fb4d6, 0xb5d7b8, 0xe3d8c0, 0x2d2f33, 0x7a6a58];
const OUTER = [0x1b1c1f, 0x2e3035, 0x1f2d47, 0xc2ad88, 0x9c7048, 0x7d7757, 0x4f5535, 0xd9d6cf, 0xa9acb0, 0x6d2434, 0x3b4a5c, 0x8c8f93, 0xb9a98b];
const BOTTOM = [0x3b5b85, 0x4c6a92, 0x2c4163, 0x6f8cb0, 0x1c1c1e, 0x3a3c40, 0xc9b99c, 0x7e7656, 0xd9cfb9, 0x7b7d82, 0x23304a, 0x2f2f33];
const SHOE = [0xe9e9e6, 0x1a1a1a, 0x8a8c90, 0x4a3427, 0x22304a, 0xd9d3c4];
const BAG = [0x1b1c1f, 0x2e3035, 0x1f2d47, 0x7b5a3a, 0xb9a98b, 0x6d2434, 0x4f5535, 0xe9e7e1, 0x3b6fa0];
const KID_PACK = [0xe23a2e, 0x2f6fb2, 0xf28c28, 0x2fa36b, 0x7b4fb0, 0xe2559b];
const KID_TOP = [0x2f6fb2, 0xe23a2e, 0xf4f1e8, 0xf2c14e, 0x3e9c6a, 0x8fb4d6, 0xe56b6f, 0x6d597a];
const YELLOW = 0xffd21f;

// ----- shared material (one for everybody; per-vertex colour, alpha channel carries roughness) -------------------
let _sharedMat = null;
function sharedMaterial() {
  if (_sharedMat) return _sharedMat;
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0 });
  m.name = 'people3d-shared';
  m.onBeforeCompile = (sh) => {
    // vertex alpha (4-component colour attribute) = roughness; opacity stays 1 (material is opaque)
    sh.fragmentShader = sh.fragmentShader.replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = clamp(vColor.a, 0.12, 1.0);');
  };
  m.customProgramCacheKey = () => 'people3d-v1';
  _sharedMat = m;
  return m;
}

// ====================================================================================================================
// geometry builder: lofted rings (super-ellipse cross sections) -> smooth-shaded, skinned, vertex-coloured mesh
// ====================================================================================================================
class Acc {
  constructor() { this.p = []; this.n = []; this.c = []; this.si = []; this.sw = []; this.ix = []; this.count = 0; this.tris = 0; }
}
const sgp = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);
const _nm = new THREE.Matrix3(), _vv = new THREE.Vector3();

/** rings (ordered along +y): {y, rx, rz, cx, cz, col(hex), rough, k(shade), n(exponent), w:[[bone,weight]..]}
 *  o: {seg, n, col, rough, bone | w, m (Matrix4 applied after), rot} */
function loft(acc, rings, o = {}) {
  const seg = o.seg || 12, nr = rings.length, base = acc.count;
  const defW = o.w || [[o.bone || 0, 1]];
  const e0 = 2 / (o.n || 2);
  const cs = [];
  for (let j = 0; j < seg; j++) { const a = (j / seg) * Math.PI * 2 + (o.rot || 0); cs.push([Math.cos(a), Math.sin(a)]); }
  const P = new Float32Array(nr * seg * 3), N = new Float32Array(nr * seg * 3);
  for (let i = 0; i < nr; i++) {
    const r = rings[i], e = r.n ? 2 / r.n : e0;
    for (let j = 0; j < seg; j++) {
      const k = (i * seg + j) * 3, ca = cs[j][0], sa = cs[j][1];
      P[k] = (r.cx || 0) + r.rx * (e === 1 ? ca : sgp(ca, e));
      P[k + 1] = r.y;
      P[k + 2] = (r.cz || 0) + r.rz * (e === 1 ? sa : sgp(sa, e));
    }
  }
  const ix = [];
  for (let i = 0; i < nr - 1; i++) for (let j = 0; j < seg; j++) {
    const j2 = (j + 1) % seg, a = i * seg + j, b = i * seg + j2, c = (i + 1) * seg + j, d = (i + 1) * seg + j2;
    ix.push(a, c, b, b, c, d);
  }
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3, b = ix[t + 1] * 3, c = ix[t + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
  }
  if (o.m) _nm.getNormalMatrix(o.m);
  for (let i = 0; i < nr; i++) {
    const r = rings[i], rgb = lin(r.col != null ? r.col : o.col != null ? o.col : 0x888888), k = r.k != null ? r.k : 1;
    const rough = r.rough != null ? r.rough : o.rough != null ? o.rough : 0.88;
    for (let j = 0; j < seg; j++) {
      const q = (i * seg + j) * 3;
      const w = o.wf ? o.wf(P[q], P[q + 1], P[q + 2]) : r.w || defW; // wf: per-vertex weights (coat skirts follow the legs)
      let nx = N[q], ny = N[q + 1], nz = N[q + 2];
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      _vv.set(P[q], P[q + 1], P[q + 2]);
      if (o.m) { _vv.applyMatrix4(o.m); _vv.toArray(P, q); _vv.set(nx, ny, nz).applyMatrix3(_nm).normalize(); nx = _vv.x; ny = _vv.y; nz = _vv.z; }
      acc.p.push(P[q], P[q + 1], P[q + 2]); acc.n.push(nx, ny, nz);
      acc.c.push(rgb[0] * k, rgb[1] * k, rgb[2] * k, rough);
      for (let s = 0; s < 4; s++) { acc.si.push(w[s] ? w[s][0] : 0); acc.sw.push(w[s] ? w[s][1] : 0); }
    }
  }
  for (const v of ix) acc.ix.push(base + v);
  acc.count += nr * seg; acc.tris += ix.length / 3;
}
/** ellipsoid built from rings (poles are tiny rings) */
function ellipsoid(acc, cx, cy, cz, rx, ry, rz, o = {}) {
  const nR = o.rings || 7, rings = [];
  for (let i = 0; i <= nR; i++) {
    const ph = -Math.PI / 2 + (Math.PI * i) / nR, c = Math.max(Math.cos(ph), 0.001);
    rings.push({ y: cy + ry * Math.sin(ph), rx: rx * c, rz: rz * c, cx, cz, k: o.k0 != null ? lerp(o.k0, o.k1 != null ? o.k1 : 1, i / nR) : 1 });
  }
  loft(acc, rings, o);
}
/** rounded box / pillow (super-ellipse n) */
function pillow(acc, cx, cy, cz, w, h, d, o = {}) {
  const s = [0.02, 0.8, 1, 1, 0.8, 0.02], yy = [-0.5, -0.465, -0.3, 0.3, 0.465, 0.5];
  const rings = s.map((m, i) => ({ y: cy + yy[i] * h, rx: (w / 2) * m, rz: (d / 2) * m, cx, cz, k: o.k0 != null ? lerp(o.k0, o.k1 != null ? o.k1 : 1, yy[i] + 0.5) : 1 }));
  loft(acc, rings, Object.assign({ n: 3.4, seg: 12 }, o));
}
/** weights blending an upper bone into a lower one around joint height yj (half width hw) */
function wB(bUp, bLo, y, yj, hw) { const t = sstep(yj + hw, yj - hw, y); return [[bUp, 1 - t], [bLo, t]]; }
function finalize(acc) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.p, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.n, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(acc.c, 4));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(acc.si, 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(acc.sw, 4));
  g.setIndex(acc.count > 65000 ? new THREE.Uint32BufferAttribute(acc.ix, 1) : new THREE.Uint16BufferAttribute(acc.ix, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.45); // padded: limbs / bags swing outside the rest pose
  g.boundingBox = new THREE.Box3(new THREE.Vector3(-0.9, 0, -0.9), new THREE.Vector3(0.9, 1.85, 0.9));
  g.userData.tris = acc.tris;
  return g;
}

// ====================================================================================================================
// body dimension sets (model units; person is 1.775 tall at scale 1): m = adult male, f = adult female, k = child
// tor: [y, half-width, half-depth, z-centre] rings of the torso from pelvis bottom to neck base
// ====================================================================================================================
const DIMS = {
  m: {
    hipY: 0.92, hipX: 0.088, kneeY: 0.5, ankY: 0.075, waistY: 1.09, shY: 1.43, shX: 0.19, neckY: 1.5, elbowY: 1.1, wristY: 0.84,
    head: { cy: 1.657, rx: 0.077, ry: 0.118, rz: 0.098 }, thigh: 0.091, knee: 0.058, calf: 0.057, ank: 0.033, uarm: 0.049, farm: 0.037, wrist: 0.026, neck: 0.05, hand: 0.185, foot: 1,
    tor: [[0.8, 0.158, 0.1, 0], [0.88, 0.184, 0.112, 0], [0.96, 0.19, 0.114, 0], [1.04, 0.176, 0.106, 0], [1.1, 0.15, 0.098, 0], [1.18, 0.158, 0.104, 0.004], [1.28, 0.172, 0.114, 0.008], [1.36, 0.18, 0.112, 0.004], [1.42, 0.186, 0.1, 0], [1.47, 0.14, 0.085, 0], [1.505, 0.066, 0.064, 0]],
  },
  f: {
    hipY: 0.91, hipX: 0.088, kneeY: 0.5, ankY: 0.07, waistY: 1.08, shY: 1.41, shX: 0.168, neckY: 1.48, elbowY: 1.09, wristY: 0.84,
    head: { cy: 1.658, rx: 0.072, ry: 0.117, rz: 0.093 }, thigh: 0.092, knee: 0.054, calf: 0.052, ank: 0.03, uarm: 0.04, farm: 0.032, wrist: 0.023, neck: 0.04, hand: 0.17, foot: 0.92,
    tor: [[0.79, 0.158, 0.098, 0], [0.87, 0.186, 0.112, 0], [0.95, 0.194, 0.114, 0], [1.03, 0.172, 0.104, 0], [1.09, 0.134, 0.088, 0], [1.17, 0.138, 0.094, 0.004], [1.27, 0.152, 0.108, 0.012], [1.35, 0.16, 0.104, 0.006], [1.4, 0.164, 0.092, 0], [1.445, 0.12, 0.078, 0], [1.48, 0.054, 0.056, 0]],
  },
  k: {
    hipY: 0.8, hipX: 0.075, kneeY: 0.45, ankY: 0.07, waistY: 1.05, shY: 1.4, shX: 0.15, neckY: 1.465, elbowY: 1.14, wristY: 0.92,
    head: { cy: 1.62, rx: 0.118, ry: 0.155, rz: 0.132 }, thigh: 0.078, knee: 0.054, calf: 0.052, ank: 0.031, uarm: 0.041, farm: 0.034, wrist: 0.025, neck: 0.044, hand: 0.15, foot: 0.9,
    tor: [[0.72, 0.13, 0.086, 0], [0.8, 0.15, 0.098, 0], [0.9, 0.152, 0.104, 0.002], [1.02, 0.142, 0.11, 0.008], [1.14, 0.128, 0.102, 0.006], [1.26, 0.136, 0.098, 0.004], [1.35, 0.146, 0.092, 0], [1.4, 0.146, 0.082, 0], [1.44, 0.104, 0.068, 0], [1.468, 0.052, 0.054, 0]],
  },
};
// interpolate [y, ...] table rows at height y
function rowAt(tab, y) {
  if (y <= tab[0][0]) return tab[0].slice();
  for (let i = 1; i < tab.length; i++) if (y <= tab[i][0]) { const a = tab[i - 1], b = tab[i], t = (y - a[0]) / (b[0] - a[0] || 1); return a.map((v, k) => lerp(v, b[k], t)); }
  return tab[tab.length - 1].slice();
}
const HEAD_PROF = [[-1, 0.02, 0.03], [-0.93, 0.42, 0.5], [-0.78, 0.66, 0.76], [-0.55, 0.84, 0.9], [-0.2, 0.97, 0.98], [0.25, 1, 1], [0.62, 0.93, 0.95], [0.86, 0.72, 0.78], [0.97, 0.38, 0.45], [1, 0.02, 0.03]];
function headK(t) { const r = rowAt(HEAD_PROF, t); return [r[1], r[2]]; }

// ----- head, face bits, neck ------------------------------------------------------------------------------------
function buildHead(acc, D, S) {
  const h = D.head, skin = S.skin;
  const rings = HEAD_PROF.map(([t, kx, kz]) => ({ y: h.cy + t * h.ry, rx: h.rx * kx, rz: h.rz * kz, cz: t < -0.5 ? 0.008 : -0.004, rough: 0.55, k: t < -0.9 ? 0.82 : 1 }));
  loft(acc, rings, { seg: 16, col: skin, bone: B.HEAD });
  const [kx, kz] = headK(-0.2), zf = h.rz * kz - 0.004;
  ellipsoid(acc, 0, h.cy + h.ry * -0.25, zf + 0.006, 0.0095, 0.017, 0.015, { seg: 6, rings: 2, col: shadeHex(skin, 0.96), bone: B.HEAD, rough: 0.5 }); // nose
  for (const s of [-1, 1]) ellipsoid(acc, s * h.rx * 0.99, h.cy - h.ry * 0.05, -0.006, 0.0065, 0.022 * (h.ry / 0.118), 0.0145, { seg: 6, rings: 2, col: shadeHex(skin, 0.94), bone: B.HEAD, rough: 0.6 }); // ears
  const ez = h.rz * 0.995 * Math.cos(Math.PI / 8) - 0.004 - 0.001;
  for (const s of [-1, 1]) ellipsoid(acc, s * h.rx * Math.sin(Math.PI / 8) * 0.995, h.cy + h.ry * 0.07, ez, 0.0092 * (h.rx / 0.077), 0.0054, 0.004, { seg: 6, rings: 2, col: 0x1a1412, bone: B.HEAD, rough: 0.3 }); // eyes
  for (const s of [-1, 1]) ellipsoid(acc, s * h.rx * Math.sin(Math.PI / 8) * 0.995, h.cy + h.ry * 0.07 + 0.042 * (h.ry / 0.118), ez + 0.001, 0.0145 * (h.rx / 0.077), 0.0034, 0.0034, { seg: 6, rings: 2, col: shadeHex(S.hair.col, 1.1), bone: B.HEAD, rough: 0.6 }); // brows
  // neck (skin) from the shoulders up into the head
  const nk = D.neck, y0 = D.neckY - 0.03, y1 = h.cy - h.ry * 0.7;
  const nr = [0, 0.4, 0.75, 1].map((t) => ({ y: lerp(y0, y1, t), rx: nk * (1 + 0.1 * (1 - t)), rz: nk * (1.05 + 0.1 * (1 - t)), cz: lerp(0, 0.008, t), w: [[B.TORSO, 1 - t], [B.HEAD, t]] }));
  loft(acc, nr, { seg: 8, col: skin, rough: 0.6 });
}

// ----- legs + shoes ---------------------------------------------------------------------------------------------
/** leg ring list (ascending y) for side sx; S.leg = {col(y)->hex, ease, flare, rough, hem}  */
function legRings(D, S, sx) {
  const L = S.leg, cx = sx * D.hipX, hip = sx > 0 ? B.HIP_L : B.HIP_R, kn = sx > 0 ? B.KNEE_L : B.KNEE_R, an = sx > 0 ? B.ANK_L : B.ANK_R;
  const kY = D.kneeY, aY = D.ankY, hY = D.hipY, span = kY - aY;
  const T = [ // y, rx, rz, cz
    [aY - 0.004, D.ank, D.ank * 1.1, 0], [aY + 0.04, D.ank * 1.1, D.ank * 1.2, -0.002], [aY + span * 0.3, lerp(D.calf, D.ank, 0.5), lerp(D.calf, D.ank, 0.5) * 1.1, -0.006],
    [kY - span * 0.62, D.calf, D.calf * 1.1, -0.01], [kY - 0.07, lerp(D.knee, D.calf, 0.6), lerp(D.knee, D.calf, 0.6) * 1.06, -0.004], [kY, D.knee, D.knee * 1.05, 0.002],
    [kY + 0.07, D.knee * 1.07, D.knee * 1.1, 0.004], [lerp(kY, hY, 0.5), D.thigh * 0.88, D.thigh * 0.94, 0.004], [hY - 0.1, D.thigh * 0.98, D.thigh, 0.002], [hY + 0.03, D.thigh * 1.02, D.thigh * 1.02, 0],
  ];
  const rings = [];
  for (const [y, rx, rz, cz] of T) {
    const fl = L.flare ? L.flare * clamp(1 - (y - aY) / span, 0, 1) : 0, e = L.ease + fl;
    const w = y < aY + 0.06 ? [[kn, 0.5], [an, 0.5]] : y < aY + 0.09 ? [[kn, 0.8], [an, 0.2]] : wB(hip, kn, y, kY, 0.075);
    rings.push({ y, rx: rx + e, rz: rz + e, cx, cz, col: L.col(y), rough: L.rough, w, k: y < aY + 0.12 ? 0.9 : 1 });
  }
  rings.push({ y: hY + 0.056, rx: 0.014, rz: 0.014, cx, cz: 0, col: L.col(hY), rough: L.rough, w: wB(hip, kn, hY, kY, 0.075) }); // close the top
  if (L.hem != null) { // crisp trouser hem / skirt-leg colour change at height L.hem
    const i = rings.findIndex((r) => r.y > L.hem);
    if (i > 0) {
      const a = rings[i - 1], b = rings[i], t = (L.hem - a.y) / (b.y - a.y), m = (k) => lerp(a[k], b[k], t);
      const base = { rx: m('rx'), rz: m('rz'), cx, cz: m('cz'), w: wB(hip, kn, L.hem, kY, 0.075) };
      rings.splice(i, 0, Object.assign({ y: L.hem - 0.0005, col: L.col(L.hem - 0.01), rough: L.rough }, base), Object.assign({ y: L.hem, col: L.col(L.hem + 0.01), rough: L.rough }, base, { rx: base.rx + 0.004, rz: base.rz + 0.004 }));
    }
  }
  return rings;
}
const SHOE_PROF = [[-0.085, 0.006, 0.006, 0.04], [-0.075, 0.03, 0.034, 0.04], [-0.04, 0.036, 0.042, 0.046], [0.02, 0.04, 0.036, 0.04], [0.09, 0.046, 0.027, 0.029], [0.15, 0.047, 0.022, 0.024], [0.19, 0.037, 0.018, 0.02], [0.212, 0.022, 0.012, 0.014], [0.222, 0.006, 0.006, 0.015]];
function buildLegs(acc, D, S) {
  for (const sx of [1, -1]) {
    loft(acc, legRings(D, S, sx), { seg: 10 });
    const an = sx > 0 ? B.ANK_L : B.ANK_R, sh = S.shoe, f = D.foot, aY = D.ankY;
    const m = new THREE.Matrix4().makeTranslation(sx * D.hipX, aY, 0).multiply(new THREE.Matrix4().makeRotationY(sx * 0.1)).multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2));
    loft(acc, SHOE_PROF.map(([l, a, b, c]) => ({ y: l * f, rx: a * f, rz: b * f * sh.h, cz: aY - c * f, col: l > 0.1 ? sh.toe : sh.col, rough: sh.rough })), { seg: 8, bone: an, m });
    const sole = [[-0.084, 0.004, 0.004, 0.011], [-0.072, 0.031, 0.011, 0.011], [0, 0.043, 0.012, 0.012], [0.12, 0.05, 0.012, 0.012], [0.19, 0.04, 0.011, 0.011], [0.222, 0.012, 0.006, 0.01]];
    loft(acc, sole.map(([l, a, b, c]) => ({ y: l * f, rx: a * f, rz: b * f, cz: aY - c * f, col: sh.sole, rough: 0.7 })), { seg: 8, bone: an, m, n: 2.6 });
  }
}

// ----- generic crease: duplicate ring at height y, colour switches (colFn) and a small radial step (hem / cuff) ---
function crease(rings, y, colFn, step = 0.004) {
  const i = rings.findIndex((r) => r.y > y);
  if (i <= 0) return;
  const a = rings[i - 1], b = rings[i], t = (y - a.y) / (b.y - a.y), m = (k) => lerp(a[k] || 0, b[k] || 0, t);
  const base = { rx: m('rx'), rz: m('rz'), cx: m('cx'), cz: m('cz'), w: a.w, k: a.k, rough: a.rough };
  rings.splice(i, 0, Object.assign({}, base, { y: y - 0.0005, col: colFn(y - 0.01) }), Object.assign({}, base, { y, col: colFn(y + 0.01), rx: base.rx + step, rz: base.rz + step }));
}
const torsoW = (D, y) => wB(B.PELVIS, B.TORSO, y, D.waistY, 0.07);

// ----- torso (top garment + lower body colour below the hem) ------------------------------------------------------
function buildTorso(acc, D, S) {
  const T = S.top, sh = S.outer ? 0.014 : 0, rings = D.tor.map(([y, rx, rz, cz]) => ({ y, rx: rx + T.ease - sh, rz: rz + T.ease - sh, cz, w: torsoW(D, y), rough: T.rough, k: y < D.hipY - 0.1 ? 0.92 : 1 }));
  const colFn = (y) => (y < T.hem ? S.pelvisCol : T.col);
  rings.forEach((r) => { r.col = colFn(r.y); if (r.y < T.hem) { r.rx -= T.ease * 0.6; r.rz -= T.ease * 0.6; r.rough = S.pelvisRough; } });
  crease(rings, T.hem, colFn, T.ease * 0.7 + 0.003);
  loft(acc, rings, { seg: 12, n: 2.3 });
}

// ----- arms (sleeve colour above S.sleeve.end, skin below) + mitten hands -----------------------------------------------
function buildArms(acc, D, S) {
  const SL = S.sleeve, hs = D.hand / 0.185, sk = S.skin;
  for (const sx of [1, -1]) {
    const sh = sx > 0 ? B.SH_L : B.SH_R, el = sx > 0 ? B.EL_L : B.EL_R, cx = sx * D.shX, eY = D.elbowY, wY = D.wristY, sY = D.shY;
    const Rr = D.uarm * 1.1 + SL.ease, phone = !!S.acc && S.acc.phone === (sx > 0 ? 'L' : 'R');
    const top = [[sY + 0.032 * Math.sin(1.22), Rr * Math.cos(1.22)], [sY + 0.032 * Math.sin(0.79), Rr * Math.cos(0.79)], [sY + 0.032 * Math.sin(0.35), Rr * Math.cos(0.35)], [sY + 0.036, 0.004]];
    const L = [ // y, rx, rz (arm radii before sleeve ease), hand rings use their own radii
      [sY - 0.03, D.uarm * 1.1, D.uarm * 1.1], [sY - 0.12, D.uarm * 1.03, D.uarm * 1.06], [lerp(sY, eY, 0.62), D.uarm * 0.96, D.uarm * 0.98], [eY + 0.045, D.uarm * 0.88, D.uarm * 0.9], [eY, D.farm * 1.08, D.farm * 1.1],
      [eY - 0.05, D.farm * 1.1, D.farm * 1.12], [lerp(eY, wY, 0.38), D.farm * 1.06, D.farm * 1.1], [wY + 0.055, lerp(D.farm, D.wrist, 0.7), lerp(D.farm, D.wrist, 0.7) * 1.05], [wY, D.wrist * 0.95, D.wrist],
    ];
    const rings = top.map(([y, r]) => ({ y, rx: r, rz: r, cx, w: [[sh, 1]], col: SL.col, rough: SL.rough }));
    for (const [y, rx, rz] of L) {
      const sleeve = y >= SL.end, e = sleeve ? SL.ease : 0;
      rings.push({ y, rx: rx + e, rz: rz + e, cx, cz: y < eY + 0.2 ? 0.004 : 0, w: wB(sh, el, y, eY, 0.06), col: sleeve ? SL.col : sk, rough: sleeve ? SL.rough : 0.6, k: y < eY + 0.06 && y > eY - 0.06 ? 0.93 : 1 });
    }
    const hand = [[-0.025, 0.016, 0.034], [-0.075, 0.0195, 0.042], [-0.135, 0.0165, 0.038], [-0.172, 0.011, 0.028], [-0.19, 0.004, 0.008]];
    for (const [d, rx, rz] of hand) { const dd = d * hs; rings.push(phone ? { y: wY + dd, rx: rz * hs, rz: rx * hs, cx, cz: 0.004, w: [[el, 1]], col: sk, rough: 0.6 } : { y: wY + dd, rx: rx * hs, rz: rz * hs, cx, cz: 0.004, w: [[el, 1]], col: sk, rough: 0.6 }); }
    rings.sort((a, b) => a.y - b.y); // ascending y
    const colFn = (y) => (y >= SL.end ? SL.col : sk);
    if (SL.end > wY + 0.001 && SL.end < sY - 0.05) crease(rings, SL.end, colFn, SL.cuff);
    loft(acc, rings, { seg: 8 });
    if (phone) pillow(acc, cx, wY - 0.08 * hs, 0.033, 0.07, 0.148, 0.009, { seg: 8, col: 0x0c0d11, rough: 0.16, bone: el }); // phone lies on the (supinated) palm
    else ellipsoid(acc, cx - sx * 0.006, wY - 0.07 * hs, 0.034 * hs, 0.0095 * hs, 0.032 * hs, 0.012 * hs, { seg: 6, rings: 2, col: sk, bone: el, rough: 0.6 }); // thumb
  }
}

// ----- outer layer (jacket / coat / puffer / vest) and skirt: tubes that follow the legs below the hips -------------
function legFollow(D, hem, lamMax) {
  return (x, y) => {
    if (y >= D.hipY - 0.02) return torsoW(D, y);
    const t = clamp((D.hipY - 0.02 - y) / (D.hipY - 0.02 - hem), 0, 1), lam = lamMax * (1 - Math.pow(1 - t, 1.7)), s = sstep(-0.1, 0.1, x);
    return [[B.PELVIS, 1 - lam], [B.HIP_L, lam * s], [B.HIP_R, lam * (1 - s)]];
  };
}
function buildOuter(acc, D, S) {
  const O = S.outer;
  if (!O) return;
  const rings = [], e = O.ease, hem = O.hem, y0 = D.tor[0][0];
  const push = (y, rx, rz, cz, k = 1) => rings.push({ y, rx, rz, cz, col: O.col, rough: O.rough, k });
  if (hem < y0) { // long coat: widening skirt wrapping the thighs, hem flares
    const n = Math.max(2, Math.ceil((y0 - hem) / 0.12));
    for (let i = 0; i <= n; i++) { const t = i / n; push(lerp(hem, y0, t), lerp(0.19 + O.flare, 0.205, t), lerp(0.2 + O.flare * 0.8, 0.178, t), -0.004, 0.88 + 0.12 * t); }
  } else { const r = rowAt(D.tor, hem); push(hem, r[1] + e, r[2] + e, r[3], 0.88); }
  const yMin = hem < y0 ? y0 : hem;
  const lng = hem < y0;
  for (const [y, rx, rz, cz] of D.tor) if (y > yMin + 0.001) push(y, lng ? Math.max(rx + e, lerp(0.205, rx + e, sstep(0.8, 1.02, y))) : rx + e, lng ? Math.max(rz + e, lerp(0.178, rz + e, sstep(0.8, 1.08, y))) : rz + e, cz, y < D.waistY + 0.05 && O.type !== 'vest' ? 0.96 : 1);
  push(D.neckY + 0.012, D.neck + 0.03 + O.collar, D.neck + 0.034 + O.collar, 0.004);
  push(D.neckY + 0.045, D.neck + 0.027 + O.collar, D.neck + 0.03 + O.collar, 0.004);
  loft(acc, rings, { seg: 12, n: 2.3, wf: legFollow(D, hem, O.lam) });
}
function buildSkirt(acc, D, S) {
  const K = S.skirt;
  if (!K) return;
  // the skirt starts under the top's hem (hidden) and flares out below it, so it never cuts through the shirt
  const th = S.top.hem, hem = K.hem, rT = rowAt(D.tor, th + 0.03), rH = rowAt(D.tor, th), hR = [0.19 + K.flare, 0.18 + K.flare * 0.8];
  const rows = [
    [hem, hR[0], hR[1]],
    [lerp(hem, th, 0.5), lerp(hR[0], rH[1] + 0.02, 0.55), lerp(hR[1], rH[2] + 0.02, 0.55)],
    [th, rH[1] + 0.016, rH[2] + 0.016],
    [th + 0.03, rT[1] + 0.002, rT[2] + 0.002],
  ];
  loft(acc, rows.map(([y, rx, rz], i) => ({ y, rx, rz, cz: i > 1 ? rowAt(D.tor, y)[3] : -0.002, col: K.col, rough: K.rough, k: i === 0 ? 0.88 : 1 })), { seg: 12, n: 2.3, wf: legFollow(D, hem, 0.8) });
}
function buildHoodBunch(acc, D, S) { // hoodie hood resting behind the neck
  ellipsoid(acc, 0, D.neckY + 0.005, -0.062, 0.078, 0.052, 0.056, { seg: 10, rings: 5, col: S.hoodCol, rough: S.top.rough, bone: B.TORSO });
}

// ====================================================================================================================
// hair, caps, accessories
// ====================================================================================================================
const HAIR_STYLES = {
  crop: { th: 0.085, tLow: -0.42, tS: 0.15, tF: 0.58, bTh: 0.09 },
  side: { th: 0.1, tLow: -0.42, tS: 0.05, tF: 0.45, bTh: 0.1 },
  long: { th: 0.09, tLow: -0.8, tS: -0.7, tF: 0.5, bTh: 0.11, curtain: true },
  bob: { th: 0.115, tLow: -0.78, tS: -0.72, tF: 0.4, bTh: 0.14 },
  pony: { th: 0.085, tLow: -0.4, tS: 0.0, tF: 0.52, bTh: 0.09, tail: true },
  kid: { th: 0.09, tLow: -0.45, tS: 0.0, tF: 0.5, bTh: 0.1 },
};
function buildHair(acc, D, S) {
  const H = S.hair, st = HAIR_STYLES[H.style], h = D.head;
  if (!st) return;
  const rings = [], ts = [st.tLow].concat(HEAD_PROF.map((q) => q[0]).filter((t) => t > st.tLow + 0.06)); // same heights as the head rings => hair parallels the skull
  for (const t of ts) {
    const [kx, kz] = headK(t), side = sstep(st.tS - 0.12, st.tS + 0.1, t), fr = sstep(st.tF - 0.12, st.tF + 0.1, t);
    const rx = h.rx * kx * (1 + st.th * side - 0.1 * (1 - side)), zf = h.rz * kz * (0.9 + (0.1 + st.th) * fr), zb = h.rz * kz * (1 + st.bTh);
    rings.push({ y: h.cy + t * h.ry * (1 + st.th * sstep(0.2, 0.9, t)), rx, rz: (zf + zb) / 2, cz: -0.004 + (zf - zb) / 2, k: 0.8 + 0.2 * Math.min(1, (t - st.tLow) * 2), rough: 0.5 });
  }
  loft(acc, rings, { seg: 16, col: H.col, bone: B.HEAD });
  if (st.curtain) { // long straight hair falling down the back
    const yB = D.shY - 0.12, c = [[yB, 0.074, 0.044, -0.082], [yB + 0.09, 0.086, 0.05, -0.084], [D.neckY + 0.0, 0.09, 0.056, -0.068], [h.cy - 0.04, 0.088, 0.076, -0.05], [h.cy + 0.05, 0.074, 0.08, -0.03]];
    loft(acc, c.map(([y, rx, rz, cz], i) => ({ y, rx, rz, cz, w: wB(B.HEAD, B.TORSO, y, D.neckY - 0.02, 0.05), k: i === 0 ? 0.8 : 1, rough: 0.5 })), { seg: 10, col: H.col });
  }
  if (st.tail) { // ponytail
    const cy = h.cy, p = [[cy - 0.27, 0.004, 0.004, -0.138], [cy - 0.2, 0.017, 0.017, -0.135], [cy - 0.12, 0.029, 0.029, -0.132], [cy - 0.04, 0.034, 0.034, -0.122], [cy + 0.03, 0.028, 0.028, -0.1]];
    loft(acc, p.map(([y, rx, rz, cz]) => ({ y, rx, rz, cz, rough: 0.5, k: y < cy - 0.2 ? 0.85 : 1 })), { seg: 8, col: H.col, bone: B.HEAD });
  }
}
function buildCap(acc, D, S) {
  const C = S.cap, h = D.head;
  if (!C) return;
  const ts = [0.12, 0.3, 0.55, 0.78, 0.92, 1], rings = ts.map((t) => { const [kx, kz] = headK(t); return { y: h.cy + t * h.ry * (t >= 1 ? 1.1 : 1), rx: h.rx * kx * 1.16 + 0.002, rz: h.rz * kz * 1.16 + 0.002, cz: -0.004, k: t < 0.2 ? 0.85 : 1 }; });
  loft(acc, rings, { seg: 16, col: C.col, rough: 0.8, bone: B.HEAD });
  const m = new THREE.Matrix4().makeTranslation(0, h.cy + h.ry * 0.16, h.rz * 1.0 + 0.045).multiply(new THREE.Matrix4().makeRotationX(0.2));
  ellipsoid(acc, 0, 0, 0, h.rx * 0.9, 0.006, h.rz * 0.62, { seg: 10, rings: 3, col: C.brim || C.col, rough: 0.7, bone: B.HEAD, m });
}
function tubeBetween(acc, a, b, r, o = {}) { // thin round strap segment
  const dir = new THREE.Vector3().subVectors(b, a), len = dir.length();
  if (len < 1e-4) return;
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.divideScalar(len));
  const m = new THREE.Matrix4().compose(a, q, new THREE.Vector3(1, 1, 1));
  loft(acc, [{ y: 0, rx: r, rz: r }, { y: len, rx: r, rz: r }], Object.assign({ seg: 5, m }, o));
}
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;
/** point on the torso surface (+off outwards) at height y and angle ang (0 = left/+x, 90deg = front, 180 = right, 270 = back) */
function tp(D, y, ang, off = 0.01) {
  const r = rowAt(D.tor, y), c = Math.cos(ang), sn = Math.sin(ang);
  return V(r[1] * sgp(c, 0.87) + off * c, y, r[3] + r[2] * sgp(sn, 0.87) + off * sn);
}
function shoulderTopY(D, x) { // height of the torso top surface (trapezius slope) at lateral position |x|
  const t = D.tor, ax = Math.abs(x);
  for (let i = t.length - 2; i >= 0; i--) if (t[i][1] >= ax) { const a = t[i], b = t[i + 1], u = clamp((a[1] - ax) / (a[1] - b[1] || 1), 0, 1); return lerp(a[0], b[0], u); }
  return t[0][0];
}
function buildAccessories(acc, D, S) {
  const A = S.acc, kid = S.kind === 'kid';
  if (!A) return;
  const strapCol = shadeHex(A.col, 0.65), e = (S.outer ? S.outer.ease : S.top.ease) + 0.012, sk = { col: strapCol, bone: B.TORSO, rough: 0.8 };
  if (A.bag === 'backpack') {
    const w = kid ? 0.34 : 0.3, hgt = kid ? 0.44 : 0.4, d = kid ? 0.17 : 0.15, y = kid ? 1.17 : 1.23, r = rowAt(D.tor, y), z = r[3] - r[2] - d / 2 - e + 0.02;
    pillow(acc, 0, y, z, w, hgt, d, { seg: 10, col: A.col, rough: 0.75, bone: B.TORSO, k0: 0.8 });
    pillow(acc, 0, y - hgt * 0.12, z - d * 0.5 + 0.01, w * 0.62, hgt * 0.5, 0.05, { seg: 8, col: shadeHex(A.col, 1.25), rough: 0.7, bone: B.TORSO }); // front pocket
    for (const sx of [-1, 1]) { // shoulder straps: over the shoulder, down the chest, round under the arm
      const x = sx * 0.095, ty = shoulderTopY(D, x) + 0.007, a = (Math.PI / 2) - sx * 38 * DEG;
      tubeBetween(acc, V(x, D.shY - 0.04, z + d * 0.5 - 0.02), V(x, ty, -0.012), 0.012, sk);
      tubeBetween(acc, V(x, ty, -0.012), V(x, ty, 0.05), 0.012, sk);
      tubeBetween(acc, V(x, ty, 0.05), tp(D, D.shY - 0.1, a, e), 0.012, sk);
      tubeBetween(acc, tp(D, D.shY - 0.1, a, e), tp(D, D.shY - 0.2, (Math.PI / 2) - sx * 78 * DEG, e), 0.012, sk);
    }
  } else if (A.bag === 'crossbody' || A.bag === 'shoulder') {
    const s = A.side === 'L' ? 1 : -1;
    if (A.bag === 'crossbody') { // strap from the s-side shoulder diagonally to a small bag on the opposite hip
      const hx = -s * (rowAt(D.tor, D.hipY)[1] + e + 0.03), x0 = s * 0.1, ty = shoulderTopY(D, x0) + 0.012;
      const front = [V(x0, ty, 0.0), tp(D, D.shY - 0.15, (Math.PI / 2) - s * 25 * DEG, e), tp(D, D.waistY, (Math.PI / 2) + s * 40 * DEG, e), V(hx, D.hipY + 0.08, 0.05)];
      const back = [V(x0, ty, 0.0), tp(D, D.shY - 0.15, 1.5 * Math.PI + s * 25 * DEG, e), tp(D, D.waistY, 1.5 * Math.PI - s * 40 * DEG, e), V(hx, D.hipY + 0.08, -0.05)];
      for (const P of [front, back]) for (let i = 0; i < 3; i++) tubeBetween(acc, P[i], P[i + 1], 0.0105, sk);
      pillow(acc, hx - s * 0.03, D.hipY - 0.03, 0.01, 0.1, 0.19, 0.24, { seg: 8, col: A.col, rough: 0.7, bone: B.PELVIS });
    } else { // shoulder bag: strap over the shoulder, hobo bag under the arm
      const x0 = s * 0.12, ty = shoulderTopY(D, x0) + 0.012, bx = s * (rowAt(D.tor, D.hipY)[1] + e + 0.05), xo = s * (D.shX + 0.062);
      tubeBetween(acc, V(x0, ty, 0), V(xo, D.shY + 0.012, 0), 0.0115, sk);
      tubeBetween(acc, V(xo, D.shY + 0.012, 0), V(bx + s * 0.03, D.hipY + 0.1, 0.07), 0.0115, sk);
      tubeBetween(acc, V(xo, D.shY + 0.012, 0), V(bx + s * 0.03, D.hipY + 0.1, -0.07), 0.0115, sk);
      pillow(acc, bx + s * 0.02, D.hipY - 0.03, 0, 0.1, 0.22, 0.3, { seg: 8, col: A.col, rough: 0.65, bone: B.PELVIS });
    }
  }
  if (A.hand) { // tote / shopping bag hanging from the hand (bound to the forearm)
    const s = A.hand === 'L' ? 1 : -1, el = s > 0 ? B.EL_L : B.EL_R, cx = s * (D.shX + 0.052), wY = D.wristY, shop = A.kindHand === 'shop';
    const bw = shop ? 0.09 : 0.13, bh = shop ? 0.3 : 0.3, bd = shop ? 0.24 : 0.34, by = wY - 0.07 - bh / 2 - 0.08;
    pillow(acc, cx, by, 0.0, bw, bh, bd, { seg: 8, col: A.handCol, rough: shop ? 0.5 : 0.8, bone: el, k0: 0.85 });
    for (const z of [-1, 1]) tubeBetween(acc, V(cx - s * 0.04, wY - 0.1, z * 0.012), V(cx, by + bh / 2 - 0.005, z * bd * 0.3), 0.0075, { col: shadeHex(A.handCol, 0.7), bone: el, rough: 0.7 });
  }
}

// ====================================================================================================================
// outfit generation (deterministic from seed)
// ====================================================================================================================
const LIGHT_OUT = [0xc2ad88, 0x9c7048, 0x7d7757, 0xd9d6cf, 0xb9a98b, 0xa9acb0];
function makeOutfit(kind, gender, r) {
  const kid = kind === 'kid', D0 = DIMS[kid ? 'k' : gender], bd = (r() - 0.5) * (kid ? 0.1 : 0.15); // slimmer .. stockier build
  const D = Object.assign({}, D0, { tor: D0.tor.map(([y, rx, rz, cz]) => [y, rx * (1 + bd), rz * (1 + bd * 0.7), cz]), thigh: D0.thigh * (1 + bd * 1.3), knee: D0.knee * (1 + bd * 0.8), calf: D0.calf * (1 + bd * 0.8), uarm: D0.uarm * (1 + bd * 1.2), farm: D0.farm * (1 + bd * 0.8), neck: D0.neck * (1 + bd * 0.6) });
  const S = { kind, gender, skin: pickR(r, SKIN), acc: null, outer: null, skirt: null, cap: null };
  const hc = pickR(r, HAIR);
  const jeans = () => pickR(r, [0x3b5b85, 0x4c6a92, 0x2c4163, 0x6f8cb0, 0x3f4f6b]);
  const roll = r();
  let arch;
  if (kid) arch = pickR(r, ['kidHoodie', 'kidJacket', 'kidTee', 'kidJacket']);
  else if (gender === 'm') arch = roll < 0.12 ? 'trench' : roll < 0.4 ? 'jacket' : roll < 0.5 ? 'puffer' : roll < 0.58 ? 'vest' : roll < 0.76 ? 'hoodie' : 'shirt';
  else arch = roll < 0.18 ? 'trench' : roll < 0.4 ? 'jacket' : roll < 0.52 ? 'puffer' : roll < 0.58 ? 'vest' : roll < 0.7 ? 'hoodie' : 'shirt';
  S.name = arch;
  // --- hair / cap
  const hairStyle = kid ? (gender === 'f' ? pickR(r, ['bob', 'pony', 'kid']) : 'kid') : gender === 'm' ? pickR(r, ['crop', 'crop', 'side', 'side', 'side']) : pickR(r, ['long', 'long', 'pony', 'pony', 'bob', 'bob', 'crop', 'side']);
  S.hair = { style: hairStyle, col: hc };
  if (kid ? r() < 0.55 : r() < (gender === 'm' ? 0.12 : 0.07)) { S.cap = { col: kid ? YELLOW : pickR(r, [0x1b1c1f, 0x1f2d47, 0xcdbd9f, 0x7d7757, 0xb9bbbe]) }; if (S.hair.style === 'long' || S.hair.style === 'bob') S.hair.style = 'pony'; }
  // --- bottoms
  let bottom = kid ? pickR(r, ['jeans', 'slacks', 'slacks']) : pickR(r, gender === 'f' ? ['jeans', 'slacks', 'wide', 'skirt', 'skirt', 'wide'] : ['jeans', 'jeans', 'slacks', 'wide', 'jeans', 'slacks']);
  if (arch === 'trench' || arch === 'puffer' || arch === 'kidJacket') { if (bottom === 'skirt') bottom = 'slacks'; }
  if (arch === 'trench' && gender === 'f' && !kid && r() < 0.3) bottom = 'skirt';
  const pc = bottom === 'jeans' ? jeans() : bottom === 'wide' ? pickR(r, [0xd9cfb9, 0x1c1c1e, 0x7b7d82, 0xc9b99c, 0x3b5b85, 0x2f2f33]) : bottom === 'skirt' ? pickR(r, [0x1c1c1e, 0x3a3c40, 0xc9b99c, 0x23304a, 0x6d2434, 0x7e7656, 0xd9cfb9, 0x4c6a92]) : pickR(r, [0x1c1c1e, 0x3a3c40, 0xc9b99c, 0x7e7656, 0x23304a, 0x7b7d82]);
  S.bottomName = bottom;
  S.pelvisCol = kid ? pickR(r, [0x2c4163, 0x3b5b85, 0x23304a, 0x3a3c40, 0x7e7656]) : pc;
  S.pelvisRough = bottom === 'jeans' ? 0.88 : 0.8;
  // --- shoes
  const loafer = !kid && bottom !== 'wide' && r() < 0.2, sc = loafer ? pickR(r, [0x1a1a1a, 0x4a3427, 0x2a2018]) : kid ? pickR(r, [0xe9e9e6, 0x1a1a1a, 0x2f6fb2, 0xe23a2e, 0x8a8c90]) : pickR(r, SHOE);
  const dark = sc === 0x1a1a1a || sc === 0x4a3427 || sc === 0x22304a || sc === 0x2a2018;
  S.shoe = { col: sc, toe: !loafer && r() < 0.25 ? 0xf2f0ea : sc, sole: loafer ? 0x201a16 : dark && r() < 0.5 ? 0x2a2a2c : 0xe8e4da, h: loafer ? 0.8 : 1, rough: loafer ? 0.38 : 0.7 };
  const sockCol = pickR(r, [0xf0f0f0, 0x1a1a1a, 0xf0f0f0, shadeHex(S.skin, 0.95)]);
  // --- legs
  const kneeHem = D.ankY + 0.03;
  if (bottom === 'skirt') {
    const tights = r() < 0.6, tc = pickR(r, [0x151517, 0x151517, 0x2a2a30, 0x3a2e2a]), kh = pickR(r, [0.78, 0.64, 0.64, 0.5]);
    S.skirt = { col: pc, hem: kh, flare: 0.03 + (0.78 - kh) * 0.1, rough: 0.88 };
    S.leg = { col: (y) => (y > kh ? pc : tights ? tc : S.skin), ease: tights ? 0.002 : 0, flare: 0, rough: tights ? 0.5 : 0.6, hem: kh };
  } else {
    S.leg = { col: (y) => (y > kneeHem ? pc : sockCol), ease: bottom === 'jeans' ? 0.006 : bottom === 'wide' ? 0.012 : 0.009, flare: bottom === 'wide' ? 0.032 : bottom === 'slacks' ? 0.004 : 0, rough: bottom === 'jeans' ? 0.86 : 0.8, hem: bottom === 'wide' ? null : kneeHem };
    if (kid) S.leg.col = (y) => (y > kneeHem ? S.pelvisCol : sockCol);
  }
  // --- tops / outer layers
  const topCol = kid ? pickR(r, KID_TOP) : pickR(r, TOP), outCol = pickR(r, r() < 0.5 ? LIGHT_OUT : OUTER);
  const longEnd = D.wristY + 0.012;
  S.top = { col: topCol, ease: 0.009, hem: D.hipY + 0.025, rough: 0.92, hood: false }; // hems sit above the hip joint: a lower hem would be pierced by the swinging thighs
  S.sleeve = { col: topCol, ease: 0.011, end: longEnd, cuff: 0.004, rough: 0.92 };
  if (arch === 'hoodie' || arch === 'kidHoodie') { S.top.ease = kid ? 0.02 : 0.021; S.top.hem = D.hipY + 0.02; S.top.hood = true; S.top.rough = 0.96; S.sleeve.ease = kid ? 0.016 : 0.017; S.sleeve.cuff = 0.007; S.hoodCol = topCol; }
  else if (arch === 'shirt') { S.top.ease = 0.011; S.top.hem = r() < 0.5 ? D.hipY + 0.025 : D.waistY - 0.02; S.top.rough = 0.9; if (r() < 0.08) S.sleeve.end = D.elbowY + 0.13; }
  else if (arch === 'kidTee') { S.top.ease = 0.014; S.top.hem = D.hipY + 0.02; S.sleeve.end = D.elbowY + 0.1; S.sleeve.ease = 0.014; S.sleeve.cuff = 0.005; }
  else if (arch === 'kidJacket') { S.top.col = S.sleeve.col = outCol; S.top.ease = 0.024; S.top.hem = D.hipY + 0.02; S.top.rough = 0.5; S.sleeve.ease = 0.022; S.sleeve.cuff = 0.009; S.sleeve.rough = 0.5; }
  else { // adult outer layers
    const hemY = D.hipY + 0.025;
    if (arch === 'jacket') S.outer = { type: 'jacket', col: outCol, hem: hemY, ease: 0.016, flare: 0, lam: 0, collar: 0.004, rough: 0.62 };
    else if (arch === 'puffer') S.outer = { type: 'puffer', col: pickR(r, OUTER), hem: hemY - 0.02, ease: 0.034, flare: 0, lam: 0, collar: 0.012, rough: 0.42 };
    else if (arch === 'vest') S.outer = { type: 'vest', col: pickR(r, OUTER), hem: hemY, ease: 0.026, flare: 0, lam: 0, collar: 0.006, rough: 0.45 };
    else if (arch === 'trench') S.outer = { type: 'trench', col: pickR(r, [0xc2ad88, 0xa87b4f, 0x9c7048, 0x1b1c1f, 0x1f2d47, 0x7d7757, 0xb9a98b]), hem: 0.56, ease: 0.014, flare: 0.05, lam: 0.85, collar: 0.008, rough: 0.72 };
    if (S.outer && arch !== 'vest') { S.sleeve.col = S.outer.col; S.sleeve.ease = S.outer.ease + 0.003; S.sleeve.cuff = arch === 'puffer' ? 0.01 : 0.006; S.sleeve.rough = S.outer.rough; }
    if (S.outer && S.top.col === S.outer.col) S.top.col = 0xe9e7e1;
    if (S.outer && S.outer.type !== 'trench') S.top.hem = Math.max(S.top.hem, S.outer.hem + 0.012); // inner layer ends just above the shell's hem
    if (arch === 'vest') S.sleeve.ease = 0.012;
  }
  // --- accessories
  const sideRnd = () => (r() < 0.5 ? 'L' : 'R');
  if (kid) S.acc = { bag: 'backpack', col: pickR(r, KID_PACK), side: null, hand: null, phone: null };
  else {
    const a = { bag: null, col: pickR(r, BAG), side: sideRnd(), hand: null, handCol: pickR(r, [0xe9e7e1, 0x1b1c1f, 0xb9a98b, 0x6d2434, 0x3b6fa0, 0xc8b79a]), kindHand: null, phone: null };
    const b = r(), f = gender === 'f';
    a.bag = b < 0.28 ? 'backpack' : b < (f ? 0.42 : 0.4) ? 'crossbody' : b < (f ? 0.6 : 0.5) ? 'shoulder' : null;
    if (a.bag === 'backpack' && arch === 'trench') a.bag = 'crossbody';
    const h = r();
    if (h < 0.11) { a.hand = sideRnd(); a.kindHand = 'tote'; } else if (h < 0.19) { a.hand = sideRnd(); a.kindHand = 'shop'; }
    if (a.hand && a.bag === 'shoulder') a.hand = a.side === 'L' ? 'R' : 'L';
    if (a.hand && a.bag === 'crossbody' && a.hand === a.side) a.side = a.side === 'L' ? 'R' : 'L';
    if (r() < 0.17) { const p = sideRnd(); if (!a.hand || a.hand !== p) a.phone = p; else if (a.hand) a.phone = p === 'L' ? 'R' : 'L'; }
    if (a.phone && a.bag === 'shoulder' && a.phone === a.side) a.phone = a.phone === 'L' ? 'R' : 'L';
    S.acc = a;
  }
  return { D, S };
}

// ====================================================================================================================
// assembly + rig
// ====================================================================================================================
const GEO_CACHE = new Map(), CACHE_MAX = 64;
function assemble(kind, gender, seed) {
  const r = rngFrom(seed), { D, S } = makeOutfit(kind, gender, r), acc = new Acc();
  buildTorso(acc, D, S);
  if (S.top.hood) buildHoodBunch(acc, D, S);
  buildOuter(acc, D, S);
  buildSkirt(acc, D, S);
  buildArms(acc, D, S);
  buildLegs(acc, D, S);
  buildHead(acc, D, S);
  buildHair(acc, D, S);
  buildCap(acc, D, S);
  buildAccessories(acc, D, S);
  return { geo: finalize(acc), D, S };
}
function makeBones(D) {
  const bones = new Array(NB);
  const mk = (i, name, x, y, z, flip) => { const b = new THREE.Bone(); b.name = name; b.position.set(x, y, z); if (flip != null) { b.rotation.order = 'YXZ'; b.rotation.y = flip; } bones[i] = b; return b; };
  const pelvis = mk(B.PELVIS, 'pelvis', 0, D.hipY, 0), torso = mk(B.TORSO, 'torso', 0, D.waistY - D.hipY, 0), head = mk(B.HEAD, 'head', 0, D.neckY - D.waistY, 0);
  pelvis.add(torso); torso.add(head);
  for (const [sx, n, hi, ki, ai, si, ei] of [[1, 'L', B.HIP_L, B.KNEE_L, B.ANK_L, B.SH_L, B.EL_L], [-1, 'R', B.HIP_R, B.KNEE_R, B.ANK_R, B.SH_R, B.EL_R]]) {
    const hip = mk(hi, 'hip' + n, sx * D.hipX, 0, 0, Math.PI), knee = mk(ki, 'knee' + n, 0, -(D.hipY - D.kneeY), 0, Math.PI), ank = mk(ai, 'ankle' + n, 0, -(D.kneeY - D.ankY), 0);
    pelvis.add(hip); hip.add(knee); knee.add(ank);
    const sh = mk(si, 'shoulder' + n, sx * D.shX, D.shY - D.waistY, 0, Math.PI), el = mk(ei, 'elbow' + n, 0, -(D.shY - D.elbowY), 0, 0);
    torso.add(sh); sh.add(el);
  }
  return bones;
}

export function buildPerson(kind = 'adult', opts = {}) {
  const k = kind === 'kid' ? 'kid' : 'adult';
  const hasSeed = opts.seed != null, seed = hasSeed ? opts.seed >>> 0 : Math.floor(Math.random() * 4294967296) >>> 0;
  const rr = rngFrom(seed ^ 0x9e3779b9);
  const gender = opts.gender === 'f' || opts.gender === 'm' ? opts.gender : rr() < 0.5 ? 'm' : 'f';
  const key = hasSeed ? k + '|' + gender + '|' + seed : null;
  let built = key ? GEO_CACHE.get(key) : null;
  if (!built) { built = assemble(k, gender, seed); if (key && GEO_CACHE.size < CACHE_MAX) { built.geo.userData.shared = true; GEO_CACHE.set(key, built); } }
  const { D, S, geo } = built, holo = !!opts.material;
  const root = new THREE.Group(), body = new THREE.Group();
  root.name = kind === 'twin' ? 'person-twin' : 'person-' + k; body.name = 'body';
  root.add(body);
  const bones = makeBones(D);
  body.add(bones[B.PELVIS]);
  const mesh = new THREE.SkinnedMesh(geo, opts.material || sharedMaterial());
  mesh.name = 'person-mesh'; mesh.castShadow = !holo; mesh.receiveShadow = !holo;
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.95, 0), 1.45);
  mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-0.9, 0, -0.9), new THREE.Vector3(0.9, 1.85, 0.9));
  body.add(mesh);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);
  mesh.bind(skeleton, mesh.matrixWorld);
  const A = S.acc || {};
  const props = { bag: A.bag || null, bagSide: A.bag === 'crossbody' || A.bag === 'shoulder' ? A.side : null, phone: A.phone || null, tote: A.kindHand === 'tote' ? A.hand : null, shopping: A.kindHand === 'shop' ? A.hand : null, cap: !!S.cap, hood: !!S.top.hood, outfit: S.name, bottom: S.bottomName, hair: S.hair.style, shoe: S.shoe.h < 0.9 ? 'loafer' : 'sneaker', kind: k, gender };
  const rig = { root, body, pelvis: bones[B.PELVIS], torso: bones[B.TORSO], head: bones[B.HEAD], legs: [bones[B.HIP_L], bones[B.HIP_R]], knees: [bones[B.KNEE_L], bones[B.KNEE_R]], arms: [bones[B.SH_L], bones[B.SH_R]], elbows: [bones[B.EL_L], bones[B.EL_R]], ankles: [bones[B.ANK_L], bones[B.ANK_R]], props, mesh, skeleton, kind, _d: D, _ph: rr() * 6.2832, _pose: null, _mode: '', _mixT: 0, _from: null, _fresh: false };
  poseIdle(rig, 0);
  rig._fresh = true; // first real pose call applies directly (no blend from the construction pose)
  return rig;
}

/** optional teardown: frees the shared material and every cached geometry (only call when no person is alive) */
export function disposePersonCaches() {
  for (const b of GEO_CACHE.values()) b.geo.dispose();
  GEO_CACHE.clear();
  if (_sharedMat) { _sharedMat.dispose(); _sharedMat = null; }
}
export function disposePerson(rig) {
  if (!rig) return;
  if (rig.skeleton) rig.skeleton.dispose(); // per-person bone texture
  if (rig.mesh && rig.mesh.geometry && !rig.mesh.geometry.userData.shared) rig.mesh.geometry.dispose(); // cached geometry / shared material stay alive
  if (rig.root && rig.root.parent) rig.root.parent.remove(rig.root);
}



// ====================================================================================================================
// poses.  pose vector (25 floats): 0 body.y 1 body.x | 2-4 pelvis xyz | 5-7 torso xyz | 8-10 head xyz |
//   legs L 11-14, R 15-18: hip.x hip.z knee.x ankle.x | arms L 19-21, R 22-24: shoulder.x shoulder.z elbow.x
// ====================================================================================================================
const TAU = Math.PI * 2;
const NOW = () => (typeof performance !== 'undefined' ? performance.now() / 1000 : Date.now() / 1000);
const bump = (c, mu, w) => { let d = Math.abs(c - mu); d = Math.min(d, 1 - d); return Math.exp(-(d / w) * (d / w)); };
const smin = (a, b, k) => -k * Math.log(Math.exp(-a / k) + Math.exp(-b / k));
function writePose(rig, v) {
  rig.body.position.y = v[0]; rig.body.position.x = v[1];
  rig.pelvis.rotation.set(v[2], v[3], v[4]); rig.torso.rotation.set(v[5], v[6], v[7]); rig.head.rotation.set(v[8], v[9], v[10]);
  for (let s = 0; s < 2; s++) {
    const o = 11 + s * 4, a = 19 + s * 3;
    rig.legs[s].rotation.x = v[o]; rig.legs[s].rotation.z = v[o + 1]; rig.knees[s].rotation.x = v[o + 2]; rig.ankles[s].rotation.x = v[o + 3];
    rig.arms[s].rotation.x = v[a]; rig.arms[s].rotation.z = v[a + 1]; rig.elbows[s].rotation.x = v[a + 2];
  }
}
const SCR = new Float32Array(25), LG = [new Float64Array(3), new Float64Array(3)];
function applyBlend(rig, mode, target) { // short ease between walk <-> idle so stopping never pops
  const now = NOW();
  if (!rig._pose) { rig._pose = new Float32Array(25); rig._from = new Float32Array(25); rig._fresh = true; }
  if (rig._fresh) { rig._fresh = false; rig._mode = mode; rig._mixT = -1e9; } // first pose: apply directly
  else if (rig._mode !== mode) { rig._from.set(rig._pose); rig._mode = mode; rig._mixT = now; }
  const P = rig._pose;
  let w = clamp((now - rig._mixT) / 0.28, 0, 1);
  if (w < 1) { w = w * w * (3 - 2 * w); for (let i = 0; i < 25; i++) P[i] = lerp(rig._from[i], target[i], w); } else P.set(target);
  writePose(rig, P);
}
/** height of the lowest sole point above ground for a leg with the given sagittal angles (pelvis at rest height) */
function footBottom(D, hip, knee, ank) {
  const T = D.hipY - D.kneeY, Sg = D.kneeY - D.ankY, psi = hip - knee, beta = ank - psi, cb = Math.cos(beta), sb = Math.sin(beta);
  return D.hipY - T * Math.cos(hip) - Sg * Math.cos(psi) + Math.min(-D.ankY * cb + 0.065 * sb, -D.ankY * cb - 0.17 * sb);
}
function gaitParams(speed, run) {
  if (run) { const u = clamp((speed - 2.2) / 3, 0, 1); return { run: true, heel: 0.3, A: 0.56 + 0.12 * u, bias: 0.2, kneeBase: 0.12, kneeLd: 0.5, kneeSw: 1.75 + 0.35 * u, armA: 0.7 + 0.15 * u, elb0: 1.2, elb1: 0.35, lean: 0.14 + 0.05 * u, twP: 0.07, twT: 0.2, roll: 0.02, sway: 0.01, bounce: 0.04 + 0.015 * u, abd: 0.16 }; }
  const q = clamp(speed / 1.4, 0.2, 1.75);
  return { run: false, heel: 1, A: 0.18 + 0.22 * q, bias: 0.06 + 0.04 * q, kneeBase: 0.04 + 0.02 * q, kneeLd: 0.09 + 0.1 * q, kneeSw: 0.62 + 0.5 * q, armA: 0.08 + 0.26 * q, elb0: 0.1 + 0.14 * q, elb1: 0.12 + 0.22 * q, lean: 0.015 + 0.035 * q, twP: 0.02 + 0.045 * q, twT: 0.04 + 0.08 * q, roll: 0.012 + 0.025 * q, sway: 0.006 + 0.01 * q, bounce: 0, abd: 0.07 + 0.02 * q };
}
/** rad/s of `phase` that makes the feet roughly match the ground speed (scale = root scale actually applied) */
export function gaitPhaseRate(speed, run = false, scale = 1, kid = false) {
  const isRun = run || speed >= 2.2, P = gaitParams(speed, isRun);
  if (isRun) return TAU * clamp(1.3 + 0.1 * (speed - 2.5), 1.2, 1.75);
  const stride = 2 * (kid ? 0.78 : 0.9) * scale * (Math.sin(P.bias + P.A) + Math.sin(P.A - P.bias));
  return (TAU * Math.max(speed, 0.05)) / Math.max(stride, 0.2);
}
// arm role for props: 'phone' (raised, still) | 'carry' (bag in hand, small swing) | 'strap' (holding a shoulder strap) | null
function armRole(rig, s) {
  const p = rig.props, side = s === 0 ? 'L' : 'R';
  if (p.phone === side) return 'phone';
  if (p.tote === side || p.shopping === side) return 'carry';
  if (p.bag === 'shoulder' && p.bagSide === side) return 'strap';
  return null;
}
function walkTarget(rig, phase, speed, run) {
  const D = rig._d, Pm = gaitParams(speed, run), v = SCR;
  v.fill(0);
  const cL = (((phase / TAU) % 1) + 1) % 1, cR = (cL + 0.5) % 1;
  const leg = (c, out) => {
    const hip = Pm.bias + Pm.A * Math.cos(TAU * c);
    const knee = Pm.kneeBase + Pm.kneeLd * bump(c, 0.1, 0.07) + Pm.kneeSw * bump(c, 0.73, 0.14), psi = hip - knee;
    const bt = -0.2 * Pm.heel * (1 - sstep(0, 0.1, c)) - 0.2 * Pm.heel * sstep(0.88, 1, c) + 0.55 * sstep(0.38, 0.62, c) * (1 - sstep(0.62, 0.7, c));
    const wSt = Math.max(1 - sstep(0.6, 0.72, c), sstep(0.86, 1, c));
    out[0] = hip; out[1] = knee; out[2] = lerp(-0.05, bt + psi, wSt);
    return out;
  };
  const lg = [leg(cL, LG[0]), leg(cR, LG[1])], cs = Math.cos(TAU * cL), sn = Math.sin(TAU * cL), phone = rig.props.phone;
  for (let s = 0; s < 2; s++) { const o = 11 + s * 4; v[o] = lg[s][0]; v[o + 1] = 0.02; v[o + 2] = lg[s][1]; v[o + 3] = lg[s][2]; }
  v[0] = -smin(footBottom(D, lg[0][0], lg[0][1], lg[0][2]), footBottom(D, lg[1][0], lg[1][1], lg[1][2]), 0.012);
  if (Pm.run) v[0] += Pm.bounce * (0.5 - 0.5 * Math.cos(TAU * 2 * (cL - 0.12)));
  v[1] = Pm.sway * sn;
  v[2] = Pm.run ? 0.05 : 0; v[3] = -Pm.twP * cs; v[4] = Pm.roll * sn;
  v[5] = Pm.lean; v[6] = (Pm.twP + Pm.twT) * cs; v[7] = -0.6 * Pm.roll * sn;
  v[8] = -0.55 * Pm.lean + (phone ? 0.34 : 0); v[9] = -0.8 * Pm.twT * cs;
  for (let s = 0; s < 2; s++) {
    const a = 19 + s * 3, f = s === 0 ? -cs : cs, role = armRole(rig, s);
    let sh = 0.04 + Pm.armA * f, el = Pm.elb0 + Pm.elb1 * (0.5 + 0.5 * f), ab = Pm.abd;
    if (role === 'phone') { sh = 0.5 + 0.03 * sn; el = 1.72; ab = 0.03; }
    else if (role === 'carry') { sh = 0.05 + 0.3 * Pm.armA * f; el = 0.2 + 0.1 * Pm.elb1 * (0.5 + 0.5 * f); ab = Pm.abd + 0.02; }
    else if (role === 'strap') { sh = 0.05 + 0.45 * Pm.armA * f; el = 0.3 + 0.5 * Pm.elb0 + 0.2 * Pm.elb1 * (0.5 + 0.5 * f); }
    v[a] = sh; v[a + 1] = (s === 0 ? -1 : 1) * ab; v[a + 2] = el;
  }
  return v;
}
export function poseWalk(rig, phase, speed, run = false) {
  applyBlend(rig, 'walk', walkTarget(rig, phase, speed, run || speed >= 2.2));
}
export function poseIdle(rig, t) {
  const D = rig._d, ph = rig._ph, v = SCR, kid = rig.props.kind === 'kid';
  v.fill(0);
  const br = Math.sin(t * 1.6 + ph), sw = Math.sin(t * (kid ? 0.55 : 0.33) + ph * 1.7), look = Math.sin(t * 0.21 + ph * 2.3) * Math.sin(t * 0.13 + ph), phone = rig.props.phone;
  const uL = Math.max(0, -sw), uR = Math.max(0, sw); // unloaded amount of left / right leg
  const hipL = 0.025 + 0.07 * uL, kL = 0.03 + 0.12 * uL, hipR = 0.025 + 0.07 * uR, kR = 0.03 + 0.12 * uR;
  v[11] = hipL; v[12] = 0.015; v[13] = kL; v[14] = hipL - kL; v[15] = hipR; v[16] = 0.015; v[17] = kR; v[18] = hipR - kR;
  v[0] = -smin(footBottom(D, hipL, kL, v[14]), footBottom(D, hipR, kR, v[18]), 0.012);
  v[1] = 0.01 * sw; v[4] = 0.028 * sw;
  v[5] = 0.012 + 0.006 * br + (phone ? 0.03 : 0); v[6] = 0.18 * look; v[7] = -0.8 * v[4];
  v[8] = 0.02 + 0.015 * Math.sin(t * 0.4 + ph) + (phone ? 0.4 : 0); v[9] = phone ? 0.05 * look : 0.32 * look;
  for (let s = 0; s < 2; s++) {
    const a = 19 + s * 3, role = armRole(rig, s), asym = s === 0 ? 0.01 : -0.01;
    let sh = 0.045 + 0.012 * br + asym, el = 0.15 + 0.03 * br, ab = 0.08 + 0.01 * br;
    if (role === 'phone') { sh = 0.52; el = 1.78; ab = 0.03; }
    else if (role === 'carry') { sh = 0.05; el = 0.2; ab = 0.1; }
    else if (role === 'strap') { sh = 0.06; el = 0.55; ab = 0.06; }
    v[a] = sh; v[a + 1] = (s === 0 ? -1 : 1) * ab; v[a + 2] = el;
  }
  applyBlend(rig, 'idle', v);
}
