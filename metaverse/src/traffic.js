import { rand, pick } from './config.js';
import { Vehicle, randomType } from './vehicles.js';
import { Pedestrian, randomTrip } from './pedestrians.js';

// 보문로(NS)·고려대로(EW) 모두 왕복 4차로. NB_R = 신설동 → 고려대 방향 우회전 (Right Guard 대상)
const WEIGHTS = {
  NB_IN: 0.85, NB_OUT: 0.5, NB_R: 0.6, SB_IN: 0.85, SB_OUT: 0.5, SB_R: 0.28,
  EB_IN: 0.8, EB_OUT: 0.45, EB_R: 0.25, WB_IN: 0.8, WB_OUT: 0.45, WB_R: 0.25,
};
const SPAWN_S = 52; // 교차로에서 약 100 m 떨어진 곳에서 등장

export class Traffic {
  constructor(scene, routes) {
    this.scene = scene;
    this.routes = routes;
    this.vehicles = [];
    this.peds = [];
    this.vehOn = true;
    this.pedOn = true;
    this.density = 1;
    this.pedDensity = 1;
    this.blockRoutes = new Set();
    this.maxVeh = 22;
    this.maxPed = 15;
    this.timers = {};
    for (const k in WEIGHTS) this.timers[k] = rand(0, 4);
    this.pedTimer = 1;
    this.lateWhenOff = true; // Right Guard OFF 비교: 북행 우회전 운전자 반응 지연
    this.rgEnabled = true;
    this.schedule = null; // 비교 실험용 도착 일정 (schedule.js)
    this.onRemove = null;
  }

  // 조절 패널 값 반영 (걷는 속도·키, 차량 속도)
  applyLive() {
    for (const v of this.vehicles) v.applyLive();
    for (const p of this.peds) p.applyLive();
  }

  routeClear(route, s0, s1, radius = 3.2) {
    const p = {};
    for (let s = s0; s <= s1; s += 2) {
      route.sample(s, p);
      for (const v of this.vehicles) {
        for (const c of v.circles) {
          if ((c.x - p.x) ** 2 + (c.z - p.z) ** 2 < radius * radius) return false;
        }
      }
    }
    return true;
  }

  spawnVehicle(name, opts = {}) {
    const route = this.routes[name];
    const type = opts.type || randomType(name);
    if (name.endsWith('_R') && type === 'bus') opts.type = 'sedan';
    const v = new Vehicle(this.scene, route, {
      type: opts.type || type,
      s: opts.s ?? SPAWN_S,
      v: opts.v ?? rand(7, 9.5),
      ...opts,
    });
    if (name === 'NB_R' && !this.rgEnabled && this.lateWhenOff && !opts.driver && !opts.human) {
      v.driver = 'late';
      v.turnBoost = 1.45;
    }
    this.vehicles.push(v);
    return v;
  }

  spawnPed(opts = {}) {
    const p = new Pedestrian(this.scene, { path: opts.path || randomTrip(opts), ...opts });
    this.peds.push(p);
    return p;
  }

  populate({ peds = true } = {}) {
    // 시작 시 장면이 비어 보이지 않게 배치
    for (const name of Object.keys(WEIGHTS)) {
      if (this.blockRoutes.has(name)) continue;
      const route = this.routes[name];
      const n = name.endsWith('_R') ? 1 : 2;
      for (let i = 0; i < n; i++) {
        const s = rand(SPAWN_S + 4, route.stopFrontS ? route.stopFrontS - 14 : 130);
        if (this.routeClear(route, s - 6, s + 6, 3.5)) this.spawnVehicle(name, { s, v: rand(6, 9) });
      }
      // 교차로를 지나 멀어지는 차
      const s2 = rand(route.length * 0.62, route.length * 0.85);
      if (Math.random() < 0.6 && this.routeClear(route, s2 - 6, s2 + 6, 3.5)) this.spawnVehicle(name, { s: s2, v: 9 });
    }
    if (peds) for (let i = 0; i < 9; i++) this.spawnPed({ startNear: true });
  }

  clear({ vehicles = true, peds = true, keep = null } = {}) {
    if (vehicles) {
      this.vehicles = this.vehicles.filter((v) => {
        if (keep && keep(v)) return true;
        v.dispose();
        return false;
      });
    }
    if (peds) {
      this.peds = this.peds.filter((p) => {
        if (p.isTwin || (keep && keep(p))) return true;
        p.dispose();
        return false;
      });
    }
  }

  update(dt, ctx) {
    // 비교 실험: 정해진 일정대로 생성 (두 세계가 같은 사람·차를 받음)
    if (this.schedule) {
      this.schedule.update(ctx.t, this);
    } else this._spawnRandom(dt);
    ctx.vehicles = this.vehicles;
    ctx.peds = this.peds;
    for (const v of this.vehicles) v.update(dt, ctx);
    for (const p of this.peds) p.update(dt, ctx);
    // 정리
    this.vehicles = this.vehicles.filter((v) => {
      if (v.dead) { if (this.onRemove) this.onRemove(v); v.dispose(); return false; }
      return true;
    });
    this.peds = this.peds.filter((p) => {
      if (p.done && !p.isTwin) { if (this.onRemove) this.onRemove(p); p.dispose(); return false; }
      return true;
    });
  }

  _spawnRandom(dt) {
    // 차량 생성
    if (this.vehOn) {
      for (const name in WEIGHTS) {
        if (this.blockRoutes.has(name)) continue;
        this.timers[name] -= dt * WEIGHTS[name] * this.density;
        if (this.timers[name] <= 0) {
          this.timers[name] = rand(3, 7);
          if (this.vehicles.length < this.maxVeh && this.routeClear(this.routes[name], SPAWN_S - 8, SPAWN_S + 14)) {
            this.spawnVehicle(name);
          }
        }
      }
    }
    // 보행자 생성
    if (this.pedOn) {
      this.pedTimer -= dt * this.pedDensity;
      if (this.pedTimer <= 0) {
        this.pedTimer = rand(1.6, 3.6);
        const live = this.peds.filter((p) => !p.isTwin).length;
        if (live < this.maxPed) this.spawnPed({ startNear: Math.random() < 0.35 });
      }
    }
  }
}
