import { G } from './config.js';

const STEP = 0.5;

function lineP(out, ax, az, bx, bz) {
  const d = Math.hypot(bx - ax, bz - az);
  const n = Math.max(1, Math.ceil(d / STEP));
  for (let i = 0; i < n; i++) out.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
}
function arcP(out, cx, cz, r, a0, a1) {
  const n = Math.max(2, Math.ceil((Math.abs(a1 - a0) * r) / STEP));
  for (let i = 0; i < n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    out.push([cx + r * Math.cos(a), cz + r * Math.sin(a)]);
  }
}

export class Route {
  constructor(name, pts, meta) {
    this.name = name;
    Object.assign(this, meta);
    const n = pts.length;
    this.n = n;
    this.x = new Float32Array(n);
    this.z = new Float32Array(n);
    this.S = new Float32Array(n);
    this.vmax = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.x[i] = pts[i][0];
      this.z[i] = pts[i][1];
      if (i > 0) this.S[i] = this.S[i - 1] + Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
    }
    this.length = this.S[n - 1];
    // 곡률 기반 최대 속도 (횡가속 2.6 m/s²)
    const aLat = meta.aLat || 2.6;
    for (let i = 0; i < n; i++) {
      if (i === 0 || i === n - 1) { this.vmax[i] = 99; continue; }
      const ax = this.x[i] - this.x[i - 1], az = this.z[i] - this.z[i - 1];
      const bx = this.x[i + 1] - this.x[i], bz = this.z[i + 1] - this.z[i];
      const ang = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
      const len = (Math.hypot(ax, az) + Math.hypot(bx, bz)) / 2;
      const k = ang / Math.max(len, 1e-3);
      this.vmax[i] = k > 1e-4 ? Math.max(2.4, Math.sqrt(aLat / k)) : 99;
    }
    this.p = { x: 0, z: 0, hx: 0, hz: 1 };
  }
  index(s) {
    if (s <= 0) return 0;
    if (s >= this.length) return this.n - 2;
    let lo = 0, hi = this.n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.S[mid] <= s) lo = mid; else hi = mid;
    }
    return lo;
  }
  sample(s, out = this.p) {
    const i = this.index(s);
    const s0 = this.S[i], s1 = this.S[i + 1];
    const t = s1 > s0 ? Math.min(1, Math.max(0, (s - s0) / (s1 - s0))) : 0;
    const dx = this.x[i + 1] - this.x[i], dz = this.z[i + 1] - this.z[i];
    const dl = Math.hypot(dx, dz) || 1;
    out.x = this.x[i] + dx * t;
    out.z = this.z[i] + dz * t;
    out.hx = dx / dl;
    out.hz = dz / dl;
    // 앞쪽으로 extrapolate (경로 끝 바깥)
    if (s > this.length) {
      out.x += out.hx * (s - this.length);
      out.z += out.hz * (s - this.length);
    }
    return out;
  }
  // 조건이 처음 참이 되는 s
  firstS(fn) {
    for (let i = 0; i < this.n; i++) if (fn(this.x[i], this.z[i])) return this.S[i];
    return null;
  }
}

export function footprintEnters(route, rect, front = 2.2, half = 0.95, pad = 0.25) {
  const p = {};
  for (let s = 0; s < route.length; s += 0.1) {
    route.sample(s, p);
    const rx = -p.hz, rz = p.hx;
    const fx = p.x + p.hx * front, fz = p.z + p.hz * front;
    const pts = [
      [fx, fz],
      [fx + rx * half, fz + rz * half],
      [fx - rx * half, fz - rz * half],
    ];
    for (const [x, z] of pts) {
      if (x >= rect.x0 - pad && x <= rect.x1 + pad && z >= rect.z0 - pad && z <= rect.z1 + pad) return s;
    }
  }
  return null;
}

// 보문로(남북) 4차로 × 고려대로(동서) 4차로. 직진은 안쪽·바깥 차로, 우회전은 바깥 차로 → 바깥 차로.
export function buildRoutes() {
  const E = G.EXT, L = G.LANE, R = {};
  const r = G.TURN_R;
  const make = (name, pts, meta) => (R[name] = new Route(name, pts, meta));
  const straight = (name, ax, az, bx, bz, meta) => {
    const p = [];
    lineP(p, ax, az, bx, bz);
    p.push([bx, bz]);
    make(name, p, meta);
  };

  // ── 북행 (−z 방향, 신설동 → 성북구청)
  straight('NB_IN', L.NB_IN, E, L.NB_IN, -E, { group: 'NS', approach: 'NB', turn: 'S' });
  straight('NB_OUT', L.NB_OUT, E, L.NB_OUT, -E, { group: 'NS', approach: 'NB', turn: 'S' });
  // 북행 우회전 → 고려대로 동쪽(안암·고려대) — Right Guard 대상
  let p = [];
  const nbCx = L.NB_OUT + r, nbCz = L.EB_OUT + r;
  lineP(p, L.NB_OUT, E, L.NB_OUT, nbCz);
  arcP(p, nbCx, nbCz, r, Math.PI, Math.PI * 1.5);
  lineP(p, nbCx, L.EB_OUT, E, L.EB_OUT); p.push([E, L.EB_OUT]);
  make('NB_R', p, { group: 'NS', approach: 'NB', turn: 'R', conflict: 'E', rg: true });

  // ── 남행 (+z, 성북구청 → 신설동역)
  straight('SB_IN', L.SB_IN, -E, L.SB_IN, E, { group: 'NS', approach: 'SB', turn: 'S' });
  straight('SB_OUT', L.SB_OUT, -E, L.SB_OUT, E, { group: 'NS', approach: 'SB', turn: 'S' });
  p = [];
  const sbCx = L.SB_OUT - r, sbCz = L.WB_OUT - r;
  lineP(p, L.SB_OUT, -E, L.SB_OUT, sbCz);
  arcP(p, sbCx, sbCz, r, 0, Math.PI * 0.5);
  lineP(p, sbCx, L.WB_OUT, -E, L.WB_OUT); p.push([-E, L.WB_OUT]);
  make('SB_R', p, { group: 'NS', approach: 'SB', turn: 'R', conflict: 'W' });

  // ── 동행 (+x, 창신역 → 안암·고려대)
  straight('EB_IN', -E, L.EB_IN, E, L.EB_IN, { group: 'EW', approach: 'EB', turn: 'S' });
  straight('EB_OUT', -E, L.EB_OUT, E, L.EB_OUT, { group: 'EW', approach: 'EB', turn: 'S' });
  p = [];
  const ebCx = L.SB_OUT - r, ebCz = L.EB_OUT + r;
  lineP(p, -E, L.EB_OUT, ebCx, L.EB_OUT);
  arcP(p, ebCx, ebCz, r, Math.PI * 1.5, Math.PI * 2);
  lineP(p, L.SB_OUT, ebCz, L.SB_OUT, E); p.push([L.SB_OUT, E]);
  make('EB_R', p, { group: 'EW', approach: 'EB', turn: 'R', conflict: 'S' });

  // ── 서행 (−x, 안암·고려대 → 창신역)
  straight('WB_IN', E, L.WB_IN, -E, L.WB_IN, { group: 'EW', approach: 'WB', turn: 'S' });
  straight('WB_OUT', E, L.WB_OUT, -E, L.WB_OUT, { group: 'EW', approach: 'WB', turn: 'S' });
  p = [];
  const wbCx = L.NB_OUT + r, wbCz = L.WB_OUT - r;
  lineP(p, E, L.WB_OUT, wbCx, L.WB_OUT);
  arcP(p, wbCx, wbCz, r, Math.PI * 0.5, Math.PI);
  lineP(p, L.NB_OUT, wbCz, L.NB_OUT, -E); p.push([L.NB_OUT, -E]);
  make('WB_R', p, { group: 'EW', approach: 'WB', turn: 'R', conflict: 'N' });

  // 정지선 통과 지점 (차량 앞범퍼 기준)
  const stopFn = {
    NB: (x, z) => z <= G.STOP.NB,
    SB: (x, z) => z >= G.STOP.SB,
    EB: (x, z) => x >= G.STOP.EB,
    WB: (x, z) => x <= G.STOP.WB,
  };
  for (const k in R) {
    const rt = R[k];
    rt.stopFrontS = rt.firstS(stopFn[rt.approach]);
    if (rt.conflict) rt.yieldS = footprintEnters(rt, G.CW[rt.conflict]); // 차량 중심 s (기본 승용차)
  }
  // 적신호 우회전 판단용 — 정지선 바로 뒤 '앞 횡단보도' 구역과, 왼쪽에서 와 합류하는 직진 차로의 합류 구간
  const FRONT_CW = { NB: 'S', SB: 'N', EB: 'W', WB: 'E' };
  const MERGE_INTO = { NB_R: 'EB_OUT', SB_R: 'WB_OUT', EB_R: 'SB_OUT', WB_R: 'NB_OUT' };
  const OUT_LANE = { NB: L.NB_OUT, SB: L.SB_OUT, EB: L.EB_OUT, WB: L.WB_OUT };
  const q = {};
  for (const k in MERGE_INTO) {
    const rt = R[k], cw = G.CW[FRONT_CW[rt.approach]], lane = OUT_LANE[rt.approach];
    rt.frontBox = rt.approach === 'NB' || rt.approach === 'SB'
      ? { x0: lane - 2.4, x1: lane + 2.4, z0: cw.z0 - 0.4, z1: cw.z1 + 0.4 }
      : { x0: cw.x0 - 0.4, x1: cw.x1 + 0.4, z0: lane - 2.4, z1: lane + 2.4 };
    const pts = [];
    for (let s = rt.stopFrontS; s < rt.stopFrontS + 26; s += 0.5) { rt.sample(s, q); pts.push([q.x, q.z]); }
    const st = R[MERGE_INTO[k]];
    let sA = null, sM = null;
    for (let s = 0; s < st.length; s += 0.5) {
      st.sample(s, q);
      let md = Infinity;
      for (const [x, z] of pts) md = Math.min(md, (x - q.x) ** 2 + (z - q.z) ** 2);
      if (sA === null && md < 2.4 * 2.4) sA = s; // 우회전 차와 가까워지기 시작
      if (sM === null && md < 0.3 * 0.3) sM = s; // 같은 차로로 들어오는 합류 지점
    }
    rt.merge = { route: st.name, sA, sM: sM ?? sA };
  }
  // 이야기 장면용: 북행 우회전 경로가 동쪽 횡단보도 보행 동선(x = WALK_X)과 만나는 지점
  R.NB_R.conflictS = R.NB_R.firstS((x, z) => x >= G.WALK_X && z < G.EW_HALF);
  return R;
}
