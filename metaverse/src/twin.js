import { G, damp, angleWrap } from './config.js';
import { Pedestrian } from './pedestrians.js';

// 현실 레이더(LD2450)가 감지한 사람들을 메타버스에 홀로그램으로 표시 — 최대 3명 (LD2450 동시 추적 수)
//  · 센서 유닛이 RG:POS,x1,y1,x2,y2,x3,y3 (가까운 순) 으로 보내면 사람마다 한 명씩 그 자리에 나타남
//  · 좌표 없이 RG:REAL,1 만 오면 한 명이 기본 자리(횡단보도 남쪽 끝)에 나타남
//  · 프레임마다 '가장 가까운 기존 홀로그램'에 새 좌표를 이어 붙여, 누가 누구인지 유지함
const MAX = 3;
const POS_FRESH = 1.5; // 좌표 줄이 이만큼(초) 안 오면 좌표 없는 것으로
const LOST = 0.6; // 한 사람이 이만큼(초) 좌표에서 빠지면 사라짐
const MATCH_R = 2.5; // 같은 사람으로 이어 붙이는 최대 거리 (m)

export class Twin {
  constructor(scene, rg, traffic) {
    this.rg = rg;
    // 좌표(RG:POS)가 없을 때 서 있는 곳: 고려대로 동쪽 횡단보도 남쪽 끝 (레이더 부채꼴 안)
    this.home = { x: G.WALK_X + 0.4, z: G.EW_HALF + 0.85 };
    this.slots = [];
    for (let i = 0; i < MAX; i++) {
      const p = new Pedestrian(scene, { kind: 'twin', path: [this.home, this.home], height: 1.7 });
      p.active = false;
      p.root.visible = false;
      p.state = 'twin';
      traffic.peds.push(p);
      this.slots.push({ p, fade: 0, on: false, tx: this.home.x, tz: this.home.z, seen: -99, hasPos: false });
    }
    this.t = 0;
    this.visible = false; // 한 명이라도 보이는가
    this.hasPos = false;
    this.count = 0;
    this.list = []; // 지금 보이는 홀로그램들 (라벨용)
  }

  // 호환: 첫 홀로그램
  get p() { return (this.list[0] || this.slots[0]).p; }

  update(dt, link, show) {
    this.t += dt;
    const now = performance.now() / 1000;
    const want = show && link.realDetected;
    const fresh = want && link.realTargets && link.realTargets.length && now - link.realPosT < POS_FRESH;
    // 이번 프레임에 레이더가 본 사람들 (세상 좌표)
    let seen = [];
    if (fresh) {
      seen = link.realTargets.slice(0, MAX).map((q) => this.rg.fromSensor(q.x, q.y, link.mirror));
    } else if (want) {
      // 좌표 없이 감지만 보고될 때: 기본 자리에서 서성이는 한 명
      seen = [{ x: this.home.x + Math.sin(this.t * 0.7) * 0.25, z: this.home.z + Math.cos(this.t * 0.5) * 0.15 }];
    }
    // 1) 켜져 있는 홀로그램에 가장 가까운 좌표를 이어 붙임 (가까운 쌍부터)
    const free = new Set(seen.map((_, i) => i));
    const pairs = [];
    for (const s of this.slots) if (s.on) for (let i = 0; i < seen.length; i++) pairs.push({ s, i, d: Math.hypot(seen[i].x - s.p.x, seen[i].z - s.p.z) });
    pairs.sort((a, b) => a.d - b.d);
    const matched = new Set();
    for (const { s, i, d } of pairs) {
      if (matched.has(s) || !free.has(i) || d > MATCH_R) continue;
      matched.add(s); free.delete(i);
      s.tx = seen[i].x; s.tz = seen[i].z; s.seen = now;
    }
    // 2) 남은 좌표는 꺼져 있는 홀로그램에 — 처음 나타날 때는 바로 그 자리에
    for (const i of free) {
      const s = this.slots.find((o) => !o.on && !matched.has(o));
      if (!s) break;
      s.on = true; matched.add(s);
      s.p.x = s.tx = seen[i].x; s.p.z = s.tz = seen[i].z; s.seen = now;
    }
    // 3) 이번에 안 보인 홀로그램은 잠시 기다렸다 끔
    for (const s of this.slots) if (s.on && !matched.has(s) && (now - s.seen > LOST || !want)) s.on = false;

    this.list = [];
    for (const s of this.slots) {
      const p = s.p;
      s.hasPos = s.on && fresh;
      s.fade = damp(s.fade, s.on ? 1 : 0, 6, dt);
      const show3d = s.fade > 0.03;
      p.root.visible = show3d;
      p.active = s.on; // 차량·레이더가 인식
      const ud = p.root.userData;
      if (ud.holoMat) ud.holoMat.opacity = 0.78 * s.fade;
      if (ud.ring) ud.ring.material.opacity = 0.85 * s.fade;
      if (ud.beam) ud.beam.material.opacity = 0.2 * s.fade;
      if (!show3d) { p.vx = p.vz = 0; continue; }
      if (s.on) this.list.push(s);
      const ox = p.x, oz = p.z;
      p.x = damp(p.x, s.tx, 5, dt);
      p.z = damp(p.z, s.tz, 5, dt);
      const vx = (p.x - ox) / Math.max(dt, 1e-3), vz = (p.z - oz) / Math.max(dt, 1e-3);
      const spd = Math.hypot(vx, vz);
      p.vx = vx;
      p.vz = vz;
      if (spd > 0.15) p.heading += angleWrap(Math.atan2(vx, vz) - p.heading) * Math.min(1, dt * 8);
      else p.heading += angleWrap(Math.PI - p.heading) * Math.min(1, dt * 2);
      p._animate(dt, spd > 0.15 ? spd : 0);
      p._place(dt);
      p.root.scale.setScalar(p.baseScale * (0.9 + 0.1 * s.fade));
    }
    this.count = this.list.length;
    this.visible = this.count > 0;
    this.hasPos = this.list.some((s) => s.hasPos);
  }
}
