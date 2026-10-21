import * as THREE from 'three';
import { G, PAL, clamp, inRect } from './config.js';
import { makeVehicleMesh, disposeVehicleMesh, rollWheels } from './vehicles.js';

// 직접 운전 차량 (크림슨 세단) + 우회전 미션 판정
export class PlayerCar {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.mesh = makeVehicleMesh('sedan', PAL.crimson);
    // 지붕 표식
    const mark = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.05, 0.7), new THREE.MeshBasicMaterial({ color: PAL.ivory }));
    mark.position.set(0, (this.mesh.userData.height || 1.45) + 0.02, -0.3);
    this.mesh.add(mark);
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.len = 4.5;
    this.wid = 1.82;
    this.circles = [{ x: 0, z: 0, r: 0.96 }, { x: 0, z: 0, r: 0.96 }];
    this.keys = {};
    this.active = false;
    this.stats = { ok: 0, bad: 0 };
    this.events = [];
    this.rgStopAt = -99; // Right Guard가 ✕로 바뀐 시각 (운전자가 볼 시간이 있었는지 판정)
    this.lastRg = 'GO';
    this.reset();
  }

  reset() {
    this.x = G.LANE.NB_OUT;
    this.z = G.STOP.NB + 40; // 신설동 쪽 보문로에서 출발
    this.yaw = Math.PI; // 북쪽(−z)을 봄
    this.v = 6;
    this.steer = 0;
    this.trial = { crossedLine: false, minV: 99, judged: false, judgedAt: 0, lineRed: false, done: false, msgT: 0 };
    this.cooldown = 0;
    this.scenarioSpawned = false;
    this._place();
  }

  setActive(on) {
    this.active = on;
    this.mesh.visible = on;
    if (on) this.reset();
  }

  get fwd() {
    return { x: Math.sin(this.yaw), z: Math.cos(this.yaw) };
  }
  get front() {
    const f = this.fwd;
    return { x: this.x + f.x * 2.25, z: this.z + f.z * 2.25 };
  }

  _place() {
    const f = this.fwd;
    this.circles[0].x = this.x + f.x * 1.15;
    this.circles[0].z = this.z + f.z * 1.15;
    this.circles[1].x = this.x - f.x * 1.15;
    this.circles[1].z = this.z - f.z * 1.15;
    if (this._lx != null) {
      const d = Math.hypot(this.x - this._lx, this.z - this._lz);
      rollWheels(this.mesh, this.v >= 0 ? d : -d);
    }
    this._lx = this.x;
    this._lz = this.z;
    this.mesh.position.set(this.x, 0, this.z);
    this.mesh.rotation.y = this.yaw;
  }

  emit(kind, title, sub) {
    this.events.push({ kind, title, sub });
  }

  update(dt, ctx) {
    if (!this.active) return;
    const k = this.keys;
    const up = k.ArrowUp || k.KeyW, down = k.ArrowDown || k.KeyS;
    const left = k.ArrowLeft || k.KeyA, right = k.ArrowRight || k.KeyD;
    const hand = k.Space;
    const vmax = 14;
    if (up) this.v += (this.v < 0 ? 9 : 4.2 * (1 - Math.max(0, this.v) / vmax)) * dt;
    if (down) {
      if (this.v > 0.3) this.v -= 9 * dt;
      else this.v = Math.max(-4, this.v - 3 * dt);
    }
    if (!up && !down) {
      this.v *= 1 - 0.55 * dt;
      if (Math.abs(this.v) < 0.08) this.v = 0;
    }
    if (hand) this.v *= 1 - 5 * dt;
    const steerMax = 0.6 * (1 - Math.min(0.55, Math.abs(this.v) / 26));
    const target = (left ? 1 : 0) - (right ? 1 : 0);
    this.steer += (target * steerMax - this.steer) * Math.min(1, dt * 6);
    const px = this.x, pz = this.z, pyaw = this.yaw;
    this.yaw += (this.v / 2.7) * Math.tan(this.steer) * dt;
    const f = this.fwd;
    this.x += f.x * this.v * dt;
    this.z += f.z * this.v * dt;
    this.x = clamp(this.x, -140, 140);
    this.z = clamp(this.z, -140, 140);
    this._place();

    // 건물 충돌
    for (const b of this.world.occluders) {
      for (const c of this.circles) {
        const cx = clamp(c.x, b.x0, b.x1), cz = clamp(c.z, b.z0, b.z1);
        const dx = c.x - cx, dz = c.z - cz;
        if (dx * dx + dz * dz < c.r * c.r) {
          this.x = px; this.z = pz; this.yaw = pyaw;
          this.v *= -0.2;
          this._place();
          break;
        }
      }
    }
    // 다른 차량 충돌
    for (const o of ctx.vehicles) {
      for (const c of o.circles) {
        for (const m of this.circles) {
          const dx = m.x - c.x, dz = m.z - c.z;
          const rr = m.r + c.r;
          if (dx * dx + dz * dz < rr * rr) {
            this.x = px; this.z = pz; this.yaw = pyaw;
            this.v *= -0.15;
            this._place();
          }
        }
      }
    }
    // 보행자 — 자동 긴급 제동 (충돌 방지) + 위반 기록
    this.cooldown -= dt;
    const fr = this.front;
    for (const p of ctx.peds) {
      if (!p.active) continue;
      const dx = p.x - fr.x, dz = p.z - fr.z;
      const near = dx * dx + dz * dz < 1.35 * 1.35;
      const side = this.circles.some((c) => (p.x - c.x) ** 2 + (p.z - c.z) ** 2 < (c.r + 0.3) ** 2);
      if (near || side) {
        const moving = Math.abs(this.v) > 0.8;
        this.x = px; this.z = pz; this.yaw = pyaw;
        this.v = 0;
        this._place();
        if (moving && this.cooldown <= 0) {
          this.stats.bad++;
          this.emit('danger', '보행자 충돌 위험!', '자동 긴급제동이 작동했습니다');
          this.cooldown = 2.5;
        }
        break;
      }
    }

    this._judge(dt, ctx);
  }

  _judge(dt, ctx) {
    const tr = this.trial;
    if (ctx.rg.state === 'STOP' && this.lastRg !== 'STOP') this.rgStopAt = ctx.t;
    this.lastRg = ctx.rg.state;
    const fr = this.front;
    const f = this.fwd;
    // 적신호 우회전 일시정지 확인
    if (!tr.crossedLine && fr.x > 0 && fr.x < G.NS_HALF + 1) {
      if (fr.z > G.STOP.NB && fr.z < G.STOP.NB + 9) tr.minV = Math.min(tr.minV, Math.abs(this.v));
      if (fr.z <= G.STOP.NB && f.z < -0.5) {
        tr.crossedLine = true;
        if (ctx.signals.veh('NS') === 'R' && tr.minV > 0.45) {
          this.stats.bad++;
          this.emit('warn', '일시정지 위반', '차량 적신호에서 우회전할 땐 정지선 앞에서 먼저 멈춰야 해요');
        }
      }
    }
    // 고려대로 동쪽 횡단보도 진입 판정
    if (!tr.judged && inRect(fr.x, fr.z, G.CW.E, 0.1) && f.x > 0.25) {
      tr.judged = true;
      tr.judgedAt = ctx.t;
      // 위반: 차가 지나는 쪽(남쪽 절반) 횡단보도 위의 보행자, 또는 보행 녹색에 건너려고 연석에 선 보행자.
      // 보행 신호가 점멸·빨강일 때 인도에서 기다리는 사람은 위반으로 보지 않는다.
      const sig = ctx.signals.ped('E');
      const xIn = (p) => p.x >= G.CW.E.x0 - 0.6 && p.x <= G.CW.E.x1 + 0.6;
      const onRoad = (p) => xIn(p) && p.z >= G.MEDIAN - 0.6 && p.z <= G.EW_HALF + 0.1;
      const atCurb = (p) => sig === 'W' && xIn(p) && p.z > G.EW_HALF && p.z <= G.EW_HALF + 1.6;
      const pedOnCW = ctx.peds.some((p) => p.active && !p.isTwin && (onRoad(p) || atCurb(p)));
      const rgStop = ctx.rg.enabled && ctx.rg.state === 'STOP';
      const sawX = rgStop && ctx.t - this.rgStopAt >= 0.8; // ✕를 보고 멈출 시간이 있었는가
      if (sawX) {
        this.stats.bad++;
        this.emit('danger', '보행자 보호 위반', 'LED가 ✕(우회전 불가)일 때 횡단보도에 들어갔어요');
      } else if (pedOnCW) {
        this.stats.bad++;
        this.emit('danger', '보행자 보호 위반', sig === 'W' ? '건너는 중이거나 건너려는 보행자가 있었어요' : '차가 지나는 쪽 횡단보도에 보행자가 있었어요');
      } else if (rgStop) {
        this.stats.ok++;
        this.emit('warn', '우회전 완료 · 주의', '들어서는 순간 ✕로 바뀌었어요. 위반은 아니지만 주변을 한 번 더 살펴요');
      } else {
        this.stats.ok++;
        this.emit('ok', '안전 우회전 성공!', 'LED → 확인 후 우회전 · 보행자 보호 완료');
      }
    }
    // 직진·좌회전 등 미션 이탈
    if (!tr.done && !tr.judged && (this.z < -(G.EW_HALF + 9) || this.x < -(G.NS_HALF + 3))) {
      tr.done = true;
      tr.judgedAt = ctx.t;
      this.emit('info', '우회전 미션', '교차로에서 오른쪽(고려대 방향, 고려대로)으로 돌아 보세요');
    }
    if ((tr.judged || tr.done) && !tr.reset && (ctx.t - tr.judgedAt > 6 || this.x > 40)) {
      tr.reset = true;
      this.emit('restart', '', '');
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    disposeVehicleMesh(this.mesh);
  }
}
