import * as THREE from 'three';
import { G, clamp, rand, pick } from './config.js';
import { buildVehicle, disposeVehicle } from './real/vehicles3d.js';
import { footprintEnters } from './routes.js';

// ───────────────────────── 공용 재질
export const VMAT = {
  head: new THREE.MeshStandardMaterial({ color: 0xfff6e0, emissive: 0xfff3d6, emissiveIntensity: 0.25 }),
};
let glowTex = null, poolTex = null;
export function setVehicleTextures(glow, pool) {
  glowTex = glow;
  poolTex = pool;
}
export const NIGHT = { on: false, registry: new Set() };
// 조절 패널이 바꾸는 차량 주행 속도 (km/h)
export const CAR = { kmh: 35 };

const COLORS = [0xf2f2ef, 0x1d1f22, 0xb9bdc1, 0xeceae4, 0x5d646b, 0x27406b, 0x2a2c30, 0xd9d6cf, 0x7a1d24];

// 시뮬레이션용 차 크기 (판정·간격 계산은 예전 값 그대로 — 결과가 바뀌지 않게)
export const VTYPES = {
  sedan: { len: 4.5, wid: 1.82, headY: 0.72 },
  suv: { len: 4.7, wid: 1.9, headY: 0.86 },
  taxi: { len: 4.55, wid: 1.82, headY: 0.72 },
  truck: { len: 5.1, wid: 1.85, headY: 0.85 },
  bus: { len: 11.0, wid: 2.5, headY: 0.95 },
};

// 밤 효과(빛무리·노면 불빛)는 모든 차가 같은 재질·도형을 나눠 씀
let FX = null;
function fxKit() {
  if (FX || !glowTex) return FX;
  const pool = new THREE.PlaneGeometry(4.2, 9);
  pool.rotateX(-Math.PI / 2);
  FX = {
    head: new THREE.SpriteMaterial({ map: glowTex, color: 0xfff1d0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 }),
    tail: new THREE.SpriteMaterial({ map: glowTex, color: 0xff2a1a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.7 }),
    poolGeo: pool,
    poolMat: poolTex ? new THREE.MeshBasicMaterial({ map: poolTex, color: 0xffe8c0, transparent: true, opacity: 0.38, blending: THREE.AdditiveBlending, depthWrite: false }) : null,
  };
  return FX;
}
export const HEADMATS = new Set();

// 비교 실험의 난수 순서 지키기: 예전 차 메시는 만들 때 three.js 객체 uuid 로 Math.random 을 정해진 횟수만큼 썼다.
// 새 모델은 진짜 Math.random 으로 만들고, 바깥(시드 난수)에서는 예전과 똑같은 횟수만 소모한다.
const NATIVE_RANDOM = Math.random;
const LEGACY_DRAWS = { sedan: 156, suv: 156, taxi: 160, truck: 164, bus: 152 };
export function makeVehicleMesh(type, color, opts = {}) {
  const outer = Math.random;
  Math.random = NATIVE_RANDOM;
  let grp;
  try {
    grp = buildVehicleMesh(type, color, opts);
  } finally {
    Math.random = outer;
  }
  for (let i = LEGACY_DRAWS[type] || 0; i > 0; i--) outer();
  return grp;
}

// 차량 메시 (+z가 앞) — 실사 모델(real/vehicles3d.js). 모양 고르기에는 Math.random 을 쓰지 않음
let VIS = 0;
function buildVehicleMesh(type, color, opts = {}) {
  const seed = opts.seed ?? ((++VIS * 2654435761) >>> 0);
  let vtype = type;
  const o = { color, seed };
  if (type === 'bus') {
    if (color === 0x4f9e3a) { vtype = 'minibus'; o.livery = 'branch'; } // 초록 지선 버스
    else { o.livery = 'trunk'; o.routeText = '273'; } // 파란 간선 273
    o.color = undefined;
  } else if (type === 'taxi') {
    o.color = seed % 3 === 0 ? 0xe58a2e : undefined; // 대부분 흰 택시, 일부 주황
  } else if (type === 'truck') {
    o.color = seed % 2 ? 0x2e5aa8 : 0xf0f0ec; // 파랑·흰 1톤 트럭
    if (seed % 3 === 0) o.variant = 'tarp';
  }
  const grp = buildVehicle(vtype, o);
  const ud = grp.userData;
  if (ud.headMat) {
    HEADMATS.add(ud.headMat);
    ud.headMat.emissiveIntensity = NIGHT.on ? 2.4 : 0.25;
  }
  // 바퀴 굴림 기준 (이전 위치)
  ud.lastS = null;
  // 야간 효과
  const fx = new THREE.Group();
  const K = fxKit();
  const half = (ud.len || VTYPES[type].len) / 2;
  if (K) {
    const heads = (ud.lights && ud.lights.head && ud.lights.head.length) ? ud.lights.head : [new THREE.Vector3(-0.62, 0.7, half), new THREE.Vector3(0.62, 0.7, half)];
    const tails = (ud.lights && ud.lights.tail && ud.lights.tail.length) ? ud.lights.tail : [new THREE.Vector3(-0.64, 0.72, -half), new THREE.Vector3(0.64, 0.72, -half)];
    for (const h of heads) {
      const sp = new THREE.Sprite(K.head);
      sp.position.set(h.x, h.y, h.z + 0.12);
      sp.scale.set(1.3, 1.3, 1);
      fx.add(sp);
    }
    for (const t of tails) {
      const sp = new THREE.Sprite(K.tail);
      sp.position.set(t.x, t.y, t.z - 0.12);
      sp.scale.set(0.9, 0.9, 1);
      fx.add(sp);
    }
    if (K.poolMat) {
      const pool = new THREE.Mesh(K.poolGeo, K.poolMat);
      pool.position.set(0, 0.03, half + 4.3);
      fx.add(pool);
    }
  }
  fx.visible = NIGHT.on;
  grp.add(fx);
  ud.fx = fx;
  NIGHT.registry.add(grp);
  return grp;
}
export function disposeVehicleMesh(grp) {
  NIGHT.registry.delete(grp);
  disposeVehicle(grp); // 차마다 따로인 등 재질만 정리 (도형·도장은 공유 캐시)
}
// 바퀴 굴리기 (진행 거리 ds m)
export function rollWheels(grp, ds) {
  const ud = grp.userData;
  if (!ud.wheels || !ds) return;
  const a = ds / (ud.wheelRadius || 0.33);
  for (const w of ud.wheels) w.rotation.x += a;
}

let NEXT_ID = 1;

// ───────────────────────── 운전자 시야 (비교 실험용)
// 2D 선분이 상자(건물·공사장 가림막)를 지나는가 — 지나면 가려서 안 보임
function segHitsBox(ax, az, bx, bz, b) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  return clip(-dx, ax - b.x0) && clip(dx, b.x1 - ax) && clip(-dz, az - b.z0) && clip(dz, b.z1 - az) && t0 <= t1;
}
export function losClear(ax, az, bx, bz, occ) {
  if (!occ) return true;
  for (const b of occ) if (segHitsBox(ax, az, bx, bz, b)) return false;
  return true;
}
// 고려대로 동쪽 횡단보도 중 북행 우회전 차가 지나가는 구간 (바깥 차로 + 여유)
export const CZ = { x0: G.CW.E.x0 - 0.4, x1: G.CW.E.x1 + 0.4, z0: 3.0, z1: G.EW_HALF };
export function inCZ(p) {
  return p.x >= CZ.x0 && p.x <= CZ.x1 && p.z >= CZ.z0 && p.z <= CZ.z1;
}
export function onCrosswalkE(p) {
  const c = G.CW.E;
  return p.x >= c.x0 - 0.5 && p.x <= c.x1 + 0.5 && p.z >= -G.EW_HALF && p.z <= G.EW_HALF;
}
// 보행자가 CZ에 들어오기까지 남은 시간 (이미 안이면 0, 멀어지는 중이면 Infinity)
export function etaCZ(p) {
  if (inCZ(p)) return 0;
  if (p.x < CZ.x0 - 1 || p.x > CZ.x1 + 1) return Infinity;
  if (p.z < CZ.z0 && p.vz > 0.05) return (CZ.z0 - p.z) / p.vz;
  if (p.z > CZ.z1 && p.vz < -0.05) return (p.z - CZ.z1) / -p.vz;
  return Infinity;
}
// 공사장 쪽(남동) 연석에서 동쪽 횡단보도를 건너려는 사람
export function intendsE_SE(p) {
  if (!p.crossesE || p.onCrosswalk) return false;
  const w = p.state === 'wait' ? p.path[p.i - 1] : p.path[p.i];
  if (!w || w.cross !== 'E' || w.z < 0) return false;
  return Math.hypot(w.x - p.x, w.z - p.z) < 2.6;
}

// ───────────────────────── NPC 차량
export class Vehicle {
  constructor(scene, route, opts = {}) {
    this.id = NEXT_ID++;
    this.kind = 'npc';
    this.route = route;
    this.type = opts.type || 'sedan';
    const T = VTYPES[this.type];
    this.len = T.len;
    this.wid = T.wid;
    this.color = opts.color ?? (this.type === 'taxi' ? 0xe59a3a : this.type === 'bus' ? pick([0x4f9e3a, 0x1f63c6]) : this.type === 'truck' ? 0x2e5aa8 : pick(COLORS));
    this.mesh = makeVehicleMesh(this.type, this.color);
    scene.add(this.mesh);
    this.scene = scene;
    this.s = opts.s ?? 0;
    this.v = opts.v ?? 7;
    this.fixedCruise = opts.vCruise != null;
    this.cruiseJitter = rand(0.88, 1.12) * (this.type === 'bus' ? 0.82 : 1);
    this.vCruise = opts.vCruise ?? this._liveCruise();
    this.turnBoost = opts.turnBoost ?? 1; // >1이면 곡선에서 더 빠름 (부주의 운전)
    this.obeysRG = opts.obeysRG ?? true;
    this.driver = opts.driver || 'attentive'; // 'attentive' | 'late'
    this.pos = { x: 0, z: 0, hx: 0, hz: 1 };
    this.circles = [];
    this.blockedBy = null;
    this.redWait = 0;
    this.redDone = false;
    this.reason = '';
    this.emergency = false;
    this.nearMiss = false;
    this.stoppedFor = 0;
    this.reactT = 0;
    this.tag = opts.tag || null;
    this.dead = false;
    // 비교 실험용 사람 운전자 (schedule.js) — 보이는 보행자만, 반응 시간이 지나야 알아챔
    this.human = opts.human || null;
    if (this.human) {
      this.obeysRG = this.human.obeyRG;
      this.known = new WeakSet();
      this.seen = new WeakMap();
      this.hazT = new WeakMap();
      if (this.human.react == null) this.human.react = 1.0;
      this.yielding = false;
      this.yieldWhy = '';
      this.yieldWait = 0;
      this.intentGaveUp = false;
      this.rgGaveUp = false;
    }
    if (route.conflict) {
      const rect = G.CW[route.conflict];
      this.yieldS = footprintEnters(route, rect, this.len / 2, this.wid / 2 + 0.05, 0.3);
    }
    this._place();
  }

  _liveCruise() {
    return (CAR.kmh / 3.6) * this.cruiseJitter;
  }
  applyLive() {
    if (!this.fixedCruise) this.vCruise = this._liveCruise();
  }

  _place() {
    this.route.sample(this.s, this.pos);
    if (this._ls != null) rollWheels(this.mesh, this.s - this._ls);
    this._ls = this.s;
    const p = this.pos;
    this.mesh.position.set(p.x, 0, p.z);
    this.mesh.rotation.y = Math.atan2(p.hx, p.hz);
    const n = Math.max(2, Math.round(this.len / 2.1));
    const r = this.wid / 2 + 0.05;
    while (this.circles.length < n) this.circles.push({ x: 0, z: 0, r });
    for (let i = 0; i < n; i++) {
      const off = -this.len / 2 + r + ((this.len - 2 * r) * i) / (n - 1);
      this.circles[i].x = p.x + p.hx * off;
      this.circles[i].z = p.z + p.hz * off;
      this.circles[i].r = r;
    }
  }

  // 적신호 우회전을 지금 하면 안 되는 이유 ('' = 진행 가능)
  //  rg: Right Guard ✕ · ped: 앞 횡단보도를 건너는(건너려는) 보행자 · gap: 왼쪽에서 오는 직진 차량이 가까움
  _rtorBlock(ctx) {
    const R = this.route;
    if (R.rg && ctx.rg.enabled && this.obeysRG && ctx.rg.state === 'STOP') return 'rg';
    const box = R.frontBox;
    if (box) {
      for (const p of ctx.peds) {
        if (!p.active || p.state === 'wait') continue;
        for (let tp = 0; tp <= 3; tp++) {
          const x = p.x + p.vx * tp, z = p.z + p.vz * tp;
          if (x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1) return 'ped';
        }
      }
    }
    const M = R.merge;
    if (M && M.sA != null) {
      for (const o of ctx.vehicles) {
        if (o === this || o.dead || o.route.name !== M.route) continue;
        if (o.s - o.len / 2 > M.sM + 2) continue; // 이미 합류 지점을 지나감
        const front = o.s + o.len / 2;
        if (front > M.sA - 0.5) return 'gap'; // 합류 구간 안
        if ((M.sA - front) / Math.max(o.v, 0.8) < 4.0) return 'gap'; // 4초 안에 도착
      }
    }
    return '';
  }

  get front() {
    return { x: this.pos.x + this.pos.hx * this.len / 2, z: this.pos.z + this.pos.hz * this.len / 2 };
  }

  // ── 사람 운전자 (비교 실험)
  _eye() {
    const p = this.pos, off = this.len / 2 - 1.9;
    return { x: p.x + p.hx * off + p.hz * 0.4, z: p.z + p.hz * off - p.hx * 0.4 }; // 운전석 = 왼쪽
  }
  _seesLED() {
    return !!this.route.rg && this.yieldS != null && this.s > (this.route.stopFrontS ?? 0) - 75 && this.s < this.yieldS + 0.5;
  }
  // 보행자를 '알아채기': 가림막에 가리지 않고 앞쪽 시야에 들어온 채로 반응 시간(prt)이 지나야 함.
  // LED ✕가 보이면 오른쪽을 더 살피게 되어 알아채는 시간이 짧아짐 (×0.6)
  _perceive(dt, ctx) {
    const H = this.human;
    if (this.yieldS == null || this.s > this.yieldS + 14 || this.s < this.yieldS - 70) return;
    const e = this._eye();
    const cue = ctx.rg && ctx.rg.enabled && ctx.rg.state === 'STOP' && this._seesLED();
    const prt = H.prt * (cue ? 0.6 : 1);
    const hx = this.pos.hx, hz = this.pos.hz;
    for (const p of ctx.peds) {
      if (!p.active || p.isTwin || this.known.has(p)) continue;
      const dx = p.x - e.x, dz = p.z - e.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 46 * 46) continue;
      const d = Math.sqrt(d2) || 1e-3;
      const vis = (dx * hx + dz * hz) / d > -0.2 && losClear(e.x, e.z, p.x, p.z, ctx.occluders);
      let t = this.seen.get(p) || 0;
      t = vis ? t + dt : Math.max(0, t - dt);
      if (t >= prt) this.known.add(p);
      else this.seen.set(p, t);
    }
  }
  // 알아챈 보행자가 차가 지나갈 자리로 들어오고 있다 → 누구든 멈춤 (자기 보호)
  _knownConflict(ctx) {
    // 내 차가 횡단보도를 다 빠져나가는 데 걸리는 시간 + 1초 안에 그 자리에 오는 사람이면 멈춘다
    const tClear = (Math.max(0, this.yieldS - 0.3 - this.s) + this.len + 4.5) / Math.max(this.v, 2.5) + 1.0;
    for (const p of ctx.peds) {
      if (!p.active || !this.known.has(p)) continue;
      if (onCrosswalkE(p) && etaCZ(p) <= tClear) return p;
      if (p.z > CZ.z1 && p.z < CZ.z1 + 3.0 && -p.vz > 2.0 && etaCZ(p) <= 2.0) return p; // 뛰어드는 아이
    }
    return null;
  }
  // 알아챈 보행자가 건너는 중이거나 건너려 함 → 법을 지키는 운전자는 멈춤
  _knownIntent(ctx) {
    const walk = ctx.signals.ped('E') === 'W';
    for (const p of ctx.peds) {
      if (!p.active || !this.known.has(p)) continue;
      if (onCrosswalkE(p) && etaCZ(p) <= 6.0) return true;
      if (walk && intendsE_SE(p)) return true;
    }
    return false;
  }
  // 일시정지 판단 — 'ped' 차로로 들어오는 사람 · 'rg' LED ✕ · 'intent' 건너려는 사람(스스로 양보하는 운전자)
  _humanYield(dt, ctx) {
    const H = this.human;
    if (this.yieldS == null) return null;
    const sY = this.yieldS - 0.3;
    const dist = sY - this.s;
    const clear = () => { this.yielding = false; this.yieldWhy = ''; this.yieldWait = 0; this.yieldPed = null; return null; };
    if (dist < -0.25 || dist > 40) return clear();
    // 반응 시간: 새로 생긴 위험(차로로 들어오는 보행자 · ✕ 켜짐)을 보고 실제로 브레이크를 밟기까지 H.react초
    const conflictPed = this._knownConflict(ctx);
    const conflict = !!conflictPed;
    this.tPed = conflict ? (this.tPed || 0) + dt : 0;
    const rgOn = !!(ctx.rg && ctx.rg.enabled && ctx.rg.state === 'STOP' && this._seesLED());
    this.tRg = rgOn ? (this.tRg || 0) + dt : 0;
    let why = '';
    if (conflict && (this.tPed >= H.react || this.v < 1.0 || this.yieldWhy === 'ped')) why = 'ped';
    else if (rgOn && H.obeyRG && !this.rgGaveUp && (this.tRg >= H.react || this.yieldWhy === 'rg')) why = 'rg';
    else if (H.selfYield && !this.intentGaveUp && this._knownIntent(ctx)) why = 'intent';
    if (!why) return clear();
    const need = (this.v * this.v) / (2 * Math.max(0.05, dist));
    if (!this.yielding && this.v > 0.5 && need > (why === 'ped' ? 8.0 : 4.5)) return null; // 편안히 멈추기엔 너무 가까움 → 진행
    this.yielding = true;
    this.yieldWhy = why;
    if (this.v < 0.15 && dist < 1.2) {
      this.yieldWait += dt;
      // 연석의 사람이 건너지 않으면 잠시 뒤 출발 · ✕가 오래 이어지는데 건너려는 사람이 안 보이면 결국 출발
      if (why === 'intent' && this.yieldWait > H.patience) this.intentGaveUp = true;
      if (why === 'rg' && this.yieldWait > H.rgPatience && !this._knownIntent(ctx)) this.rgGaveUp = true;
    }
    // 차로로 들어오는 사람 때문에 멈출 때는 'ped' — 세게 밟아야 하면 급정거(아찔한 순간)로 셈
    this.yieldPed = why === 'ped' ? conflictPed : null;
    return { s: sY, r: why === 'rg' ? 'rg' : why === 'ped' ? 'ped' : 'yield' };
  }

  update(dt, ctx) {
    const R = this.route;
    let stopAt = Infinity;
    let reason = '';
    let emergency = false;
    if (this.human) this._perceive(dt, ctx);

    // 1) 곡률 속도 제한 (앞을 내다보며 감속)
    let vT = this.vCruise;
    const i0 = R.index(this.s), i1 = R.index(this.s + 32);
    for (let i = i0; i <= i1; i += 2) {
      const vm = R.vmax[i] * this.turnBoost;
      if (vm >= 30) continue;
      const lim = Math.sqrt(vm * vm + 2 * 2.4 * Math.max(0, R.S[i] - this.s));
      if (lim < vT) vT = lim;
    }

    // 2) 신호 (정지선)
    if (R.stopFrontS != null) {
      const sStop = R.stopFrontS - this.len / 2 - 0.35;
      if (this.s < sStop + 0.25) {
        const sig = ctx.signals.veh(R.group);
        let must = false;
        if (sig === 'R') must = true;
        else if (sig === 'Y') {
          const d = sStop - this.s;
          if (d > (this.v * this.v) / (2 * 5) + 0.5) must = true;
        }
        let why = 'signal';
        if (must && R.turn === 'R' && sig === 'R') {
          // 적신호 우회전: 정지선에서 일시정지 → Right Guard·앞 횡단보도·왼쪽 차량 간격을 확인하고 진행
          // (들어간 뒤 교차로 안에서 멈춰 직진 차를 막지 않도록, 확인은 정지선에서 끝낸다)
          if (this.redDone) {
            const block = this._rtorBlock(ctx);
            must = !!block;
            if (block === 'rg') why = 'rg';
          } else if (this.v < 0.2 && sStop - this.s < 1.2) {
            this.redWait += dt;
            if (this.redWait > 1.6) this.redDone = true;
          }
        }
        if (must && sStop < stopAt) { stopAt = sStop; reason = why; }
      } else if (!this.passedLine) {
        this.passedLine = true;
      }
    }

    // 3) Right Guard (보문로 북행 → 고려대 방향 우회전)
    if (this.human) {
      const y = this._humanYield(dt, ctx);
      if (y && y.s < stopAt) { stopAt = y.s; reason = y.r; }
    } else if (R.rg && this.yieldS != null && ctx.rg.enabled && this.obeysRG) {
      const sY = this.yieldS - 0.3;
      if (this.s < sY + 0.2 && ctx.rg.state === 'STOP') {
        // 이미 너무 가까우면(급정거 필요) 멈추지 않고 통과 — 보행자 검사가 최종 안전장치
        const need = this.s >= sY ? 0 : (this.v * this.v) / (2 * Math.max(0.01, sY - this.s));
        if (need < 8.5 || this.v < 0.5) {
          if (sY < stopAt) { stopAt = sY; reason = 'rg'; }
        }
      }
    }

    const stopNoPed = { s: stopAt, r: reason };
    // 4) 앞차 / 보행자 (진행 경로 스캔)
    const look = this.driver === 'late' ? 4.2 : Math.min(42, Math.max(10, (this.v * this.v) / 6 + 9));
    const p = {};
    const halfW = this.wid / 2;
    this.blockedBy = null;
    let pedHit = null;
    // 진행 경로 근처의 차·사람만 미리 골라 둠 (전부 훑으면 차가 많을 때 느려짐)
    const fx0 = this.pos.x + this.pos.hx * this.len / 2, fz0 = this.pos.z + this.pos.hz * this.len / 2;
    const reach = look + 8;
    const nearV = [], nearP = [];
    for (const o of ctx.vehicles) {
      if (o === this || o.dead) continue;
      const dx = o.pos.x - fx0, dz = o.pos.z - fz0, rr = reach + o.len;
      if (dx * dx + dz * dz < rr * rr) nearV.push(o);
    }
    for (const ped of ctx.peds) {
      if (!ped.active) continue;
      if (this.human && !this.known.has(ped)) continue;
      const dx = ped.x - fx0, dz = ped.z - fz0, rr = reach + 3;
      if (dx * dx + dz * dz < rr * rr) nearP.push(ped);
    }
    for (let d = 0; d <= look; d += 0.75) {
      const sFront = this.s + this.len / 2 + d;
      R.sample(sFront, p);
      // 차량
      for (const o of nearV) {
        if (o.blockedBy === this && this.id < o.id) continue; // 교착 해소
        for (const c of o.circles) {
          const dx = c.x - p.x, dz = c.z - p.z;
          if (dx * dx + dz * dz < (c.r + halfW + 0.25) ** 2) {
            const sAt = this.s + d - 1.4;
            if (sAt < stopAt) { stopAt = sAt; reason = 'car'; this.blockedBy = o; }
            break;
          }
        }
      }
      if (reason === 'car' && stopAt < stopNoPed.s) { stopNoPed.s = stopAt; stopNoPed.r = 'car'; }
      // 보행자 (사람 운전자는 알아챈 사람만 피함)
      if (!pedHit) {
        for (const ped of nearP) {
          let px = ped.x, pz = ped.z;
          // 인도 위 사람은 보행 신호가 녹색이 아니면 연석에서 멈출 것으로 봄 (차도로 이어서 걸어 들어온다고 예측하지 않음)
          let tpMax = 1.3;
          if (!ped.onCrosswalk && !ped.ignoreSignal) {
            const w = ped.state === 'wait' ? null : ped.path[ped.i];
            if (ped.state === 'wait' || (w && w.cross && ctx.signals.ped(w.cross) !== 'W')) tpMax = 0;
          }
          if (this.driver !== 'late' && tpMax > 0) {
            const tp = Math.min(tpMax, d / Math.max(this.v, 2.5));
            px += ped.vx * tp;
            pz += ped.vz * tp;
          }
          const dx = px - p.x, dz = pz - p.z;
          const rr = halfW + 0.45;
          if (dx * dx + dz * dz < rr * rr) {
            // 사람 운전자: 이 사람이 경로로 들어오는 걸 처음 본 뒤 반응 시간이 지나야 밟음 (이미 거의 멈춰 있으면 바로)
            if (this.human && this.v > 1.0) {
              let t0 = this.hazT.get(ped);
              if (t0 == null) { t0 = ctx.t; this.hazT.set(ped, t0); }
              if (ctx.t - t0 < this.human.react) continue;
            }
            pedHit = ped;
            const sAt = this.s + d - 1.0;
            if (sAt < stopAt) { stopAt = sAt; reason = 'ped'; }
            break;
          }
        }
      }
      if (stopAt < this.s + d) break;
    }
    // 플레이어 차량
    if (ctx.player && ctx.player.active) {
      for (let d = 0; d <= look; d += 0.75) {
        R.sample(this.s + this.len / 2 + d, p);
        let hit = false;
        for (const c of ctx.player.circles) {
          const dx = c.x - p.x, dz = c.z - p.z;
          if (dx * dx + dz * dz < (c.r + halfW + 0.25) ** 2) { hit = true; break; }
        }
        if (hit) {
          const sAt = this.s + d - 1.4;
          if (sAt < stopAt) { stopAt = sAt; reason = 'car'; }
          if (sAt < stopNoPed.s) { stopNoPed.s = sAt; stopNoPed.r = 'car'; }
          break;
        }
      }
    }

    // 늦은 반응 운전자: 보행자 발견 시 짧은 반응 지연 후 급제동
    if (this.driver === 'late' && reason === 'ped') {
      this.reactT += dt;
      if (this.reactT < 0.22) { stopAt = stopNoPed.s; reason = stopNoPed.r || 'react'; }
      else emergency = true;
    } else if (reason !== 'ped') {
      this.reactT = 0;
    }
    // 사람 운전자: 알아챈 보행자 앞에서 4.2 m/s² 넘게 밟아야 하면 급정거 (= 아찔한 순간)
    if (this.human && reason === 'ped') {
      const need = (this.v * this.v) / (2 * Math.max(0.05, stopAt - this.s - 0.1));
      if (need > 4.2) emergency = true;
    }

    // 5) 속도 제어 (사람 운전자의 급제동은 7.5 m/s² — 마른 노면에서 세게 밟은 정도)
    const dist = stopAt - this.s;
    const eDec = this.human ? 7.5 : 9;
    if (dist < Infinity) {
      const dec = emergency ? eDec : 3.6;
      const vs = Math.sqrt(Math.max(0, 2 * dec * Math.max(0, dist - 0.1)));
      if (vs < vT) vT = vs;
    }
    const prevV = this.v;
    if (this.v < vT) this.v = Math.min(vT, this.v + 2.4 * dt);
    else this.v = Math.max(vT, this.v - (emergency ? (this.human ? 7.5 : 9.5) : 6.5) * dt);
    // 멈출 지점에 닿으면 정지 — 단, 사람 운전자가 보행자 앞에서 다 못 멈췄으면 그대로 미끄러져 나감
    if (dist <= 0.02 && !(this.human && reason === 'ped' && this.v >= 1.2)) this.v = 0;
    if (emergency && !this.emergency && prevV > 2) {
      this.nearMiss = true;
      const np = pedHit || this.yieldPed || null;
      (this.nearList || (this.nearList = [])).push(np ? { p: np, x: np.x, z: np.z } : null);
      if (np) np.nearBy = this;
      if (ctx.onNearMiss) ctx.onNearMiss(this, pedHit);
    }
    this.emergency = emergency;
    this.reason = reason;
    this.braking = this.v < prevV - 0.02 || this.v < 0.1;
    this.stoppedFor = this.v < 0.05 ? this.stoppedFor + dt : 0;

    // 6) 이동 + 최종 안전장치 (보행자와 겹치지 않게)
    const sPrev = this.s;
    this.s += this.v * dt;
    this._place();
    const f = this.front;
    for (const ped of ctx.peds) {
      if (!ped.active) continue;
      const dx = ped.x - f.x, dz = ped.z - f.z;
      if (dx * dx + dz * dz < (halfW * 0.85 + 0.35) ** 2) {
        // 시뮬레이션은 사람을 통과하지 못하게 여기서 강제로 세운다 — 실제라면 부딪혔을 상황
        const vHit = this.v;
        this.s = sPrev;
        this.v = 0;
        this._place();
        if (!this.hardStopped && ctx.onNearMiss) ctx.onNearMiss(this, ped);
        this.hardStopped = true;
        if (vHit > 1.0 && !this.crashed) {
          this.crashed = true;
          this.crashV = vHit;
          this.crashPed = ped;
          this.crashAt = { x: ped.x, z: ped.z };
          ped.hitBy = this;
        }
        break;
      }
    }

    // 7) 표시등
    const ud = this.mesh.userData;
    ud.tailMat.emissiveIntensity = this.braking ? 2.4 : NIGHT.on ? 0.9 : 0.35;
    const toTurn = R.turn === 'R' && R.yieldS != null && this.s > R.yieldS - 45 && this.s < R.yieldS + 10;
    ud.blinkMat.color.setHex(toTurn && Math.floor(ctx.t * 3) % 2 === 0 ? 0xffa21a : 0x3a2a0a);

    if (this.s >= R.length - 1) this.dead = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    disposeVehicleMesh(this.mesh);
  }
}

export function randomType(routeName) {
  const r = Math.random();
  if (routeName.endsWith('_IN') && r < 0.1) return 'bus';
  if (r < 0.5) return 'sedan';
  if (r < 0.68) return 'suv';
  if (r < 0.84) return 'taxi';
  return 'truck';
}
