import * as THREE from 'three';
import { G, PAL, rand, pick, damp, angleWrap } from './config.js';
import { groundY } from './world.js';
import { EXITS } from './layout.js';
import { buildPerson, poseWalk, poseIdle, disposePerson, gaitPhaseRate, PERSON_MODEL_H } from './real/people3d.js';

// 조절 패널이 바꾸는 보행자 값 (m, m/s)
export const PED = { adultSpeed: 1.3, kidSpeed: 3.0, adultH: 1.7, kidH: 1.2 };
const MODEL_H = PERSON_MODEL_H; // 메시 원래 키 (머리 끝)

export const HOLO = new THREE.MeshStandardMaterial({
  color: 0x8ff0ff, emissive: 0x22c8ff, emissiveIntensity: 1.6, transparent: true, opacity: 0.8, roughness: 0.4,
});

const SHIRTS = [0xe7dece, 0x2f4b7c, 0xb23a48, 0x3e7c59, 0xf2c14e, 0x6d597a, 0x355070, 0xe56b6f, 0xf4f1e8, 0x22223b, 0x8d99ae];
const PANTS = [0x2b2d42, 0x3d405b, 0x1d3557, 0x5c5552, 0x2f3e46, 0x7a6e66];
const SKIN = [0xf1c9a5, 0xe5b48f, 0xd29b74, 0xb07a55];
const HAIR = [0x1b1612, 0x2e2018, 0x4a3426, 0x6b6b6b];

const PACKS = [0xe23a2e, 0x2f6fb2, 0xf28c28];

// ── 비교 실험의 난수 순서 지키기
// 예전 사람 메시는 three.js 객체를 만들 때(uuid) 그리고 옷 색을 고를 때 Math.random 을 썼다. 새 실사 모델은 진짜 Math.random 으로
// 만들고, 바깥(시드 난수)에서는 예전 코드가 쓰던 순서·횟수를 그대로 재현한다 (색 재질 캐시가 처음 본 색이면 4번 더).
const NATIVE_RANDOM = Math.random;
const LEGACY_SEEN = new Set();
function legacyDraws(kind) {
  const holo = kind === 'twin';
  const U = () => { Math.random(); Math.random(); Math.random(); Math.random(); };
  const M = (hex) => { if (!LEGACY_SEEN.has(hex)) { LEGACY_SEEN.add(hex); U(); } };
  const m = (hex) => { if (!holo) M(hex); };
  U(); U(); // root, body
  const shirt = pick(SHIRTS), pants = pick(PANTS), skin = pick(SKIN);
  for (let i = 0; i < 2; i++) { U(); m(pants); U(); U(); m(shirt); U(); } // 엉덩이·다리, 어깨·팔
  m(shirt); U(); // 몸통
  m(skin); U(); // 머리
  const hair = pick(HAIR); m(hair); U(); // 머리카락
  if (kind === 'kid') { M(0xffd21f); U(); M(0xffd21f); U(); const pk = pick(PACKS); M(pk); U(); }
  if (holo) for (let i = 0; i < 6; i++) U(); // 홀로그램 고리·빛기둥
  return { shirt, pants, skin, hair };
}

let VIS = 0;
function buildMesh(kind) {
  const L = legacyDraws(kind);
  const holo = kind === 'twin';
  // 생김새 번호 (0~63, 모양 캐시 재사용) — 옛 옷 색 선택값 + 만든 순서
  const seed = (VIS++ * 37 + SHIRTS.indexOf(L.shirt) * 5 + HAIR.indexOf(L.hair) * 11) % 64;
  const outer = Math.random;
  Math.random = NATIVE_RANDOM;
  try {
    // 홀로그램은 사람마다 따로 흐려질 수 있게 재질을 복사해 씀 (현실 보행자 여러 명)
    const holoMat = holo ? HOLO.clone() : undefined;
    const rig = buildPerson(kind, { seed, material: holoMat });
    const root = rig.root;
    if (holo) {
      root.userData.holoMat = holoMat;
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.62, 32), new THREE.MeshBasicMaterial({ color: 0x3fd8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.04;
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 7, 20, 1, true), new THREE.MeshBasicMaterial({ color: 0x3fd8ff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      beam.position.y = 3.5;
      root.add(ring, beam);
      root.userData.ring = ring;
      root.userData.beam = beam;
    }
    return { root, body: rig.body, legs: rig.legs, arms: rig.arms, rig };
  } finally {
    Math.random = outer;
  }
}

let NEXT = 1;
export class Pedestrian {
  constructor(scene, opts = {}) {
    this.id = NEXT++;
    this.scene = scene;
    this.kind = opts.kind || 'adult';
    this.isTwin = this.kind === 'twin';
    this.path = opts.path || [];
    this.i = 1;
    this.fixedSpeed = opts.speed != null;
    this.speedJitter = this.kind === 'kid' ? 1 : rand(0.92, 1.08);
    this.speed = opts.speed ?? this._liveSpeed();
    this.ignoreSignal = !!opts.ignoreSignal;
    this.holding = !!opts.hold;
    this.tag = opts.tag || null;
    // 비교 실험용 성향: 건너기 전에 다가오는 우회전 차를 살피는가 · 점멸에도 출발하는가 · 차와의 최소 간격(초)
    this.vigilant = !!opts.vigilant;
    this.lateStarter = !!opts.lateStarter;
    this.gapNeed = opts.gapNeed ?? 3.2;
    this.carWait = 0; // 양보하지 않는 차 때문에 연석에서 기다린 시간
    this.waitedForCar = false;
    this.carBlocked = false;
    this.dwellLeft = 0;
    const m = buildMesh(this.kind);
    Object.assign(this, m);
    this.fixedHeight = opts.height != null;
    this.setHeight(opts.height ?? this._liveHeight());
    scene.add(this.root);
    const p0 = this.path[0] || { x: 0, z: 0 };
    this.x = p0.x;
    this.z = p0.z;
    this.vx = 0;
    this.vz = 0;
    this.heading = 0;
    if (this.path[1]) this.heading = Math.atan2(this.path[1].x - p0.x, this.path[1].z - p0.z);
    this.y = groundY(this.x, this.z);
    this.phase = Math.random() * 6;
    this.state = this.holding ? 'hold' : 'walk';
    this.active = !this.holding || !!opts.visibleWhileHolding;
    this.root.visible = this.active || !!opts.visibleWhileHolding;
    this.done = false;
    this.fade = 1;
    this.onCrosswalk = null;
    this.crossesE = this.path.some((w) => w.cross === 'E');
    this._place(0);
  }

  _liveSpeed() {
    return this.kind === 'kid' ? PED.kidSpeed : PED.adultSpeed * this.speedJitter;
  }
  _liveHeight() {
    return this.kind === 'kid' ? PED.kidH : PED.adultH;
  }
  setHeight(h) {
    this.height = h;
    this.baseScale = h / MODEL_H;
    this.root.scale.setScalar(this.baseScale);
  }
  // 조절 패널 값이 바뀌면 걷고 있는 사람에게도 바로 반영
  applyLive() {
    if (this.isTwin) return;
    if (!this.fixedSpeed) this.speed = this._liveSpeed();
    if (!this.fixedHeight) this.setHeight(this._liveHeight());
  }

  go() {
    this.holding = false;
    this.state = 'walk';
    this.active = true;
    this.root.visible = true;
  }

  // 남은 경로 길이 (특정 지점까지)
  distTo(px, pz) {
    let d = 0, x = this.x, z = this.z;
    for (let k = this.i; k < this.path.length; k++) {
      const w = this.path[k];
      const seg = Math.hypot(w.x - x, w.z - z);
      // 목표점이 이 구간 위에 있으면 멈춤
      const t = ((px - x) * (w.x - x) + (pz - z) * (w.z - z)) / Math.max(seg * seg, 1e-6);
      if (t >= 0 && t <= 1) {
        const qx = x + (w.x - x) * t, qz = z + (w.z - z) * t;
        if (Math.hypot(qx - px, qz - pz) < 0.6) return d + seg * t;
      }
      d += seg;
      x = w.x;
      z = w.z;
    }
    return d;
  }

  update(dt, ctx) {
    if (this.isTwin) return;
    this.vx = this.vz = 0;
    if (this.state === 'hold' || this.done) { this._animate(dt, 0); this._place(dt); return; }
    const tgt = this.path[this.i];
    if (!tgt) { this.done = true; return; }
    const prev = this.path[this.i - 1];
    // 잠시 머무는 사람 (모퉁이에서 누군가를 기다림)
    if (this.state === 'dwell') {
      this.dwellLeft -= dt;
      if (this.dwellLeft > 0) { this._animate(dt, 0); this._place(dt); return; }
      this.state = 'walk';
    }
    // 횡단 시작 지점에서 보행 신호 대기 — 남은 신호 안에 다 건널 수 있을 때만 출발
    if (this.state === 'wait') {
      if (this.ignoreSignal || this._clearToGo(prev.cross, prev, tgt, ctx, dt)) { this.state = 'walk'; this.onCrosswalk = prev.cross; this.carBlocked = false; }
      else { this._animate(dt, 0); this._place(dt); return; }
    }
    let spd = this.speed;
    if (this.onCrosswalk && !this.ignoreSignal && ctx.signals.ped(this.onCrosswalk) !== 'W') spd = this._hurrySpeed(ctx, tgt);
    const dx = tgt.x - this.x, dz = tgt.z - this.z;
    const dist = Math.hypot(dx, dz);
    const ux = dx / (dist || 1), uz = dz / (dist || 1);
    // 횡단보도 위 정차 차량과 겹치지 않기 — 단, 횡단보도 안에 서 버린 차는 잠시 뒤 돌아서 지나감 (서로 기다리는 교착 방지)
    if (this.onCrosswalk) {
      const nx = this.x + ux * 0.7, nz = this.z + uz * 0.7;
      let anyBlock = false;
      for (const v of ctx.vehicles) {
        let blocked = false;
        for (const c of v.circles) {
          if ((c.x - nx) ** 2 + (c.z - nz) ** 2 < (c.r + 0.35) ** 2) { blocked = true; break; }
        }
        if (!blocked) continue;
        anyBlock = true;
        if (v.v < 0.2) {
          this.blockT = (this.blockT || 0) + dt;
          if (this.blockT > 1.5 || this.passing === v) { this.passing = v; continue; }
        } else this.blockT = 0;
        this._animate(dt, 0); this._place(dt); return;
      }
      if (!anyBlock) { this.blockT = 0; this.passing = null; }
      if (ctx.player && ctx.player.active) {
        for (const c of ctx.player.circles) {
          if ((c.x - nx) ** 2 + (c.z - nz) ** 2 < (c.r + 0.35) ** 2) { this._animate(dt, 0); this._place(dt); return; }
        }
      }
    }
    const step = spd * dt;
    if (dist <= step) {
      this.x = tgt.x;
      this.z = tgt.z;
      this.i++;
      if (tgt.leave) this.onCrosswalk = null;
      if (tgt.cross) {
        const end = this.path[this.i];
        if (this.ignoreSignal || (end && this._clearToGo(tgt.cross, tgt, end, ctx, 0))) this.onCrosswalk = tgt.cross;
        else this.state = 'wait';
      }
      if (tgt.dwell) { this.state = 'dwell'; this.dwellLeft = tgt.dwell; }
      if (this.i >= this.path.length) this.done = true;
    } else {
      this.x += ux * step;
      this.z += uz * step;
      this.vx = ux * spd;
      this.vz = uz * spd;
      const want = Math.atan2(ux, uz);
      this.heading += angleWrap(want - this.heading) * Math.min(1, dt * 10);
    }
    this._animate(dt, spd);
    this._place(dt);
  }

  // 횡단을 시작해도 되는가: 보행 녹색(점멸 전)이고 남은 신호 시간 안에 다 건널 수 있을 때만.
  // 점멸·적색에는 출발하지 않는다. 신호 한 번에 못 건널 만큼 느린 사람은 녹색이 막 켜졌을 때 출발.
  _mayStart(cw, from, to, ctx) {
    const S = ctx.signals;
    const sig = S.ped(cw);
    const dist = Math.hypot(to.x - from.x, to.z - from.z);
    // 점멸에도 출발하는 사람: 서둘러 걸으면 남은 신호 안에 건널 수 있다고 보면 출발
    if (sig === 'F' && this.lateStarter) return S.pedRemaining(cw) >= dist / Math.min(2.2, this.speed * 1.6) + 0.4;
    if (sig !== 'W') return false;
    const need = dist / Math.max(0.3, this.speed) + 1.0;
    if (S.pedRemaining(cw) >= need) return true;
    return need > S.pedGreenLen(cw) && S.pedElapsed(cw) < 1.5;
  }
  // 신호 + (살피는 사람이면) 다가오는 우회전 차까지 확인
  _clearToGo(cw, from, to, ctx, dt) {
    if (!this._mayStart(cw, from, to, ctx)) { this.carBlocked = false; return false; }
    if (this.vigilant && this._carComing(cw, from, ctx)) {
      this.carBlocked = true;
      this.carWait += dt;
      if (this.carWait > 0.3) this.waitedForCar = true;
      return false;
    }
    this.carBlocked = false;
    return true;
  }
  // 고려대로 동쪽 횡단보도 남쪽 끝(공사장 쪽)에서: 멈출 기색 없이 다가오는 우회전 차가 있는가
  _carComing(cw, from, ctx) {
    if (cw !== 'E' || from.z < 0) return false;
    for (const v of ctx.vehicles) {
      if (!v.route || v.route.name !== 'NB_R' || v.yieldS == null || v.dead) continue;
      const d = v.yieldS - 0.3 - v.s; // > 0: 아직 횡단보도 앞
      if (d < -(v.len + 5)) continue; // 이미 지나감
      if (d <= 0) { if (v.v > 0.3) return true; continue; } // 횡단보도를 지나는 중
      if (v.yielding || v.v < 0.3) continue; // 멈추려는 차 · 서 있는 차
      if (d > 32) continue;
      if (d / Math.max(v.v, 1.0) < this.gapNeed) return true;
    }
    return false;
  }
  // 건너는 중 점멸·적색으로 바뀌면 남은 거리를 신호 안에 마치도록 서두름 (어른은 평소의 1.8배·최대 2.2 m/s)
  _hurrySpeed(ctx, tgt) {
    const left = Math.hypot(tgt.x - this.x, tgt.z - this.z);
    const tLeft = Math.max(1.2, ctx.signals.pedRemaining(this.onCrosswalk));
    const cap = this.kind === 'kid' ? Math.max(this.speed, 3.2) : Math.max(this.speed, Math.min(2.2, this.speed * 1.8));
    return Math.min(cap, Math.max(this.speed * 1.25, left / tLeft));
  }

  _animate(dt, spd) {
    const run = (this.kind === 'kid' && spd > 1.6) || spd > 2.2;
    if (spd > 0.05) {
      this.phase += dt * gaitPhaseRate(spd, run, this.root.scale.x, this.kind === 'kid');
      poseWalk(this.rig, this.phase, spd, run);
    } else {
      this.phase += dt;
      poseIdle(this.rig, this.phase);
    }
  }

  _place(dt) {
    const gy = groundY(this.x, this.z);
    this.y = dt > 0 ? damp(this.y, gy, 14, dt) : gy;
    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.y = this.heading;
  }

  dispose() {
    this.scene.remove(this.root);
    if (this.rig) disposePerson(this.rig);
  }
}

// ───────────────────────── 보행 동선 (격자형 인도 + 횡단보도)
const X = G.WALK_X, Z = G.WALK_Z, FAR = 72;
const CURB_E = G.EW_HALF + 0.35; // 고려대로 연석 (7.0)
const CURB_S = G.NS_HALF + 0.35; // 보문로 연석 (6.85)

// 모서리: sx, sz 부호
const CORNERS = { SE: [1, 1], NE: [1, -1], SW: [-1, 1], NW: [-1, -1] };
// 각 모서리에서 갈 수 있는 횡단: [횡단보도, 도착 모서리]
const LINKS = {
  SE: [['E', 'NE'], ['S', 'SW']],
  NE: [['E', 'SE'], ['N', 'NW']],
  SW: [['W', 'NW'], ['S', 'SE']],
  NW: [['W', 'SW'], ['N', 'NE']],
};

// 모퉁이별 지하철 출입구
const EXITS_AT = { SE: [], NE: [], SW: [], NW: [] };
for (const e of EXITS) EXITS_AT[e.corner].push(e);
// 출입구 앞 ↔ 보행 동선 연결점
function exitJoin(e, ox, oz) {
  const [sx, sz] = CORNERS[e.corner];
  return e.along === 'EW' ? { x: e.mx, z: sz * (Z + oz) } : { x: sx * (X + ox), z: e.mz };
}

function cornerPt(c, ox, oz) {
  const [sx, sz] = CORNERS[c];
  return { x: sx * (X + ox), z: sz * (Z + oz) };
}
// 모서리에서 바깥으로 나가는 두 방향 끝점
function endPts(c, ox, oz) {
  const [sx, sz] = CORNERS[c];
  return [
    { x: sx * (X + ox), z: sz * FAR }, // 보문로 따라
    { x: sx * FAR, z: sz * (Z + oz) }, // 고려대로 따라
  ];
}

export function crossingPts(cw, from, ox, oz) {
  const [sx, sz] = CORNERS[from];
  if (cw === 'E' || cw === 'W') {
    return [
      { x: sx * (X + ox), z: sz * CURB_E, cross: cw },
      { x: sx * (X + ox), z: -sz * CURB_E, leave: true },
    ];
  }
  return [
    { x: sx * CURB_S, z: sz * (Z + oz), cross: cw },
    { x: -sx * CURB_S, z: sz * (Z + oz), leave: true },
  ];
}

export function randomTrip(opts = {}) {
  const ox = rand(-0.9, 0.9), oz = rand(-0.2, 0.9);
  const starts = opts.startCorners || Object.keys(CORNERS);
  const c0 = pick(starts);
  // 출발: 멀리서 걸어오거나, 지하철 출입구에서 올라옴
  let e0, path, fromExit = null;
  if (!opts.noExit && EXITS_AT[c0].length && Math.random() < 0.38) {
    fromExit = pick(EXITS_AT[c0]);
    e0 = { x: fromExit.mx, z: fromExit.mz };
    path = [e0, exitJoin(fromExit, ox, oz), cornerPt(c0, ox, oz)];
  } else {
    e0 = pick(endPts(c0, ox, oz));
    path = [e0, cornerPt(c0, ox, oz)];
  }
  let c1 = c0;
  if (Math.random() < (opts.crossProb ?? 0.8)) {
    const links = opts.preferCW ? LINKS[c0].filter((l) => l[0] === opts.preferCW) : LINKS[c0];
    const [cw, to] = pick(links.length ? links : LINKS[c0]);
    path.push(...crossingPts(cw, c0, ox, oz));
    path.push(cornerPt(to, ox, oz));
    c1 = to;
  }
  // 도착: 멀리 걸어가거나, 출입구로 내려감
  const toExits = EXITS_AT[c1].filter((e) => e !== fromExit);
  if (!opts.noExit && toExits.length && Math.random() < 0.3) {
    const e = pick(toExits);
    path.push(exitJoin(e, ox, oz), { x: e.mx, z: e.mz });
    if (opts.startNear && !fromExit) {
      const a = path[0], b = path[1];
      const t = rand(0.55, 0.85);
      path[0] = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
    return path;
  }
  const exits = endPts(c1, ox, oz).filter((p) => c1 !== c0 || Math.hypot(p.x - e0.x, p.z - e0.z) > 1);
  path.push(pick(exits));
  // 시작점을 경로 중간으로 당겨 오기 (멀리서 걸어오는 시간 단축)
  if (opts.startNear && !fromExit) {
    const a = path[0], b = path[1];
    const t = rand(0.55, 0.85);
    path[0] = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
  }
  return path;
}

// 남동쪽(공사장 가림막 앞 보행로)에서 고려대로 동쪽 횡단보도로 다가오는 보행자 (Right Guard 감지 대상)
export function seCrossingTrip({ fromX = 19, ox = 0.25, oz = 0.25, northTo = -40 } = {}) {
  return [
    { x: fromX, z: Z + oz },
    { x: X + ox, z: Z + oz },
    { x: X + ox, z: CURB_E, cross: 'E' },
    { x: X + ox, z: -CURB_E, leave: true },
    { x: X + ox, z: -(Z + 0.2) },
    { x: X + ox, z: northTo },
  ];
}
// 북동 모퉁이(성북구청·고려대 쪽)에서 내려와 동쪽 횡단보도를 남쪽으로 건너는 보행자
// 레이더에서 먼 쪽에서 출발하므로 횡단보도 가운데를 지나서야 감지된다
export function northCrossingTrip({ ox = 0.3, oz = 0.3, east = false, fromZ = -26 } = {}) {
  const p = [
    { x: X + ox, z: fromZ },
    { x: X + ox, z: -CURB_E, cross: 'E' },
    { x: X + ox, z: CURB_E, leave: true },
    { x: X + ox, z: Z + oz },
  ];
  // 공사장 앞 보행로를 따라 동쪽으로, 또는 보문로를 따라 신설동 쪽으로
  p.push(east ? { x: 38, z: Z + oz } : { x: X + ox, z: 40 });
  return p;
}
// 횡단보도 앞 모퉁이에 잠시 서 있다가(누군가를 기다림) 건너지 않고 떠나는 사람 — 오감지 원인
export function loiterTrip({ dwell = 30 } = {}) {
  const ox = rand(-0.8, 0.8);
  const fromEast = Math.random() < 0.5;
  const p = [fromEast ? { x: rand(18, 34), z: Z + rand(0, 0.7) } : { x: X + ox, z: rand(22, 34) }];
  if (fromEast) p.push({ x: X + ox, z: Z + 0.3 });
  p.push({ x: X + rand(-0.9, 0.9), z: CURB_E + rand(1.3, 3.0), dwell });
  p.push({ x: X + ox, z: Z + 0.4 });
  p.push(Math.random() < 0.5 ? { x: 38, z: Z + rand(0, 0.7) } : { x: X + ox, z: 40 });
  return p;
}
// 보문로 남쪽 인도(신설동 쪽)에서 올라와 동쪽 횡단보도를 건너는 보행자
export function southApproachTrip({ fromZ = 26, ox = 0.4 } = {}) {
  return [
    { x: X + ox, z: fromZ },
    { x: X + ox, z: Z + 0.2 },
    { x: X + ox, z: CURB_E, cross: 'E' },
    { x: X + ox, z: -CURB_E, leave: true },
    { x: X + ox, z: -(Z + 0.2) },
    { x: X + ox, z: -45 },
  ];
}
