import { G } from './config.js';
import { seCrossingTrip } from './pedestrians.js';

// 자동 시연 — 처음 보는 사람이 1분 안에 "아, 이래서 만들었구나"를 느끼도록 구성
// 무대: 보문역 사거리 남동 모퉁이 (신설동 → 고려대 방향 우회전, 5번 출구 공사장 가림막 앞)
export const STEPS = 6;

function etaVehicle(v, sFrontTarget) {
  const R = v.route;
  let sc = v.s, sp = Math.max(v.v, 0.3), t = 0;
  const dt = 0.05;
  for (let k = 0; k < 600 && sc + v.len / 2 < sFrontTarget; k++) {
    const i0 = R.index(sc), i1 = R.index(sc + 32);
    let vT = v.vCruise;
    for (let j = i0; j <= i1; j += 2) {
      const vm = R.vmax[j] * v.turnBoost;
      if (vm >= 30) continue;
      vT = Math.min(vT, Math.sqrt(vm * vm + 2 * 2.4 * Math.max(0, R.S[j] - sc)));
    }
    sp = sp < vT ? Math.min(vT, sp + 2.4 * dt) : Math.max(vT, sp - 6.5 * dt);
    sc += sp * dt;
    t += dt;
  }
  return t;
}

export class Director {
  constructor(app) {
    this.app = app;
    this.active = false;
    this.gen = null;
    this.op = null;
  }
  start() {
    this.active = true;
    this.gen = this.script();
    this.op = null;
    this._next();
  }
  stop() {
    this.active = false;
    this.gen = null;
    this.op = null;
    const A = this.app;
    A.timeScale = 1;
    A.signals.frozen = false;
    A.rg.highlight = false;
    A.ui.showLink(false);
    A.ui.titleCard(false);
  }
  skip() {
    // 현재 대기 중인 동작을 즉시 끝냄
    if (this.op) this.op.left = 0;
  }
  _next() {
    if (!this.gen) return;
    const r = this.gen.next();
    if (r.done) { this.gen = this.script(); this.op = null; this._next(); return; }
    this.op = r.value;
  }
  update(dt) {
    if (!this.active || !this.op) return;
    let guard = 0;
    while (this.op && guard++ < 30) {
      this.op.left -= dt;
      dt = 0;
      if (this.op.type === 'wait' && this.op.left > 0) break;
      if (this.op.type === 'until' && this.op.left > 0 && !this.op.fn()) break;
      this._next();
    }
  }
  *wait(s) { yield { type: 'wait', left: s }; }
  *until(fn, timeout = 10) { yield { type: 'until', fn, left: timeout }; }

  *script() {
    const A = this.app;
    const R = A.routes.NB_R;
    for (;;) {
      // ── 0. 오프닝
      A.resetWorld('full');
      A.setRG(true);
      A.signals.frozen = false;
      A.rig.setShot('wide', { snap: !this._looped });
      this._looped = true;
      A.ui.titleCard(true);
      A.ui.caption(0, '보문역 사거리를 가상 세계로', '서울 성북구 보문역 사거리(보문로 × 고려대로)를 옮긴 메타버스예요. 실제 Right Guard 장치와 연결됩니다. 1분 동안 어떤 문제를 어떻게 해결하는지 보여 드릴게요.');
      yield* this.wait(7);
      A.ui.titleCard(false);

      // ── 1. 문제
      A.resetWorld('calm');
      A.setRG(false);
      A.signals.set('NS_G', 2);
      A.signals.frozen = true;
      A.ui.caption(1, '문제 · 가림막 앞으로 뛰어오는 아이', '신설동 쪽에서 올라와 고려대 방향으로 우회전하는 운전자는 왼쪽 차량을 살피느라, 공사장 가림막 앞 보행로로 뛰어오는 아이를 늦게 발견합니다.');
      const kidX = G.WALK_X + 0.2;
      const confS = R.firstS((x, z) => x >= kidX && z < G.EW_HALF);
      const car1 = A.traffic.spawnVehicle('NB_R', { s: R.stopFrontS - 44, v: 9, vCruise: 9.5, driver: 'late', turnBoost: 1.55, obeysRG: false, type: 'sedan', color: 0x27406b, tag: 'story' });
      const kid1 = A.traffic.spawnPed({ kind: 'kid', path: seCrossingTrip({ fromX: 19.5, ox: 0.2, oz: 0.3 }), speed: 3.1, hold: true, visibleWhileHolding: true, ignoreSignal: true, tag: 'story' });
      A.rig.setFollow(car1, 'chase', { snap: true });
      yield* this.until(() => etaVehicle(car1, confS) <= kid1.distTo(kidX, G.LANE.EB_OUT) / kid1.speed + 0.15, 14);
      kid1.go();
      yield* this.until(() => car1.nearMiss || car1.s > confS + 3, 10);
      if (car1.nearMiss) {
        A.ui.flash('danger', '아찔한 순간!', '운전자가 아이를 발견한 건 겨우 1초 전');
        A.slowmo(0.3, 2.4);
        A.rig.setShot('cornerLow', { k: 3 });
      }
      yield* this.wait(3.6);

      // ── 2. 설치
      A.resetWorld('calm');
      A.signals.set('NS_G', 2);
      A.signals.frozen = true;
      A.setRG(true);
      A.rg.highlight = true;
      A.rig.setShot('device', { k: 1.6 });
      A.ui.caption(2, 'Right Guard 설치', '모퉁이 기둥에 레이더 센서(LD2450)와 LED 표지판을 달았습니다. 레이더는 고려대로 횡단보도와 모퉁이 대기 공간을 계속 지켜봅니다.');
      yield* this.wait(7.5);
      A.rg.highlight = false;

      // ── 3. 감지 → 우회전 불가
      A.ui.caption(3, '감지하면 즉시 ✕', '아이가 횡단보도로 다가오면 레이더가 먼저 알아채고, LED가 곧바로 ✕(우회전 불가)로 바뀝니다. 같은 신호가 실제 장치로도 전송됩니다.');
      const car2 = A.traffic.spawnVehicle('NB_R', { s: R.stopFrontS - 46, v: 9, vCruise: 9.5, obeysRG: true, type: 'sedan', color: 0x27406b, tag: 'story' });
      const kid2 = A.traffic.spawnPed({ kind: 'kid', path: seCrossingTrip({ fromX: 19.5, ox: 0.2, oz: 0.3 }), speed: 2.4, hold: true, visibleWhileHolding: true, ignoreSignal: true, tag: 'story' });
      A.rig.setFollow(car2, 'chase', { snap: false });
      yield* this.until(() => etaVehicle(car2, car2.yieldS + car2.len / 2) <= 5.0, 14);
      kid2.go();
      A.rig.setFollow(car2, 'driver');
      A.ui.caption(3, '운전자에게 보이는 것', '모퉁이 너머의 아이는 아직 잘 보이지 않아도, 오른쪽 앞 LED가 먼저 ✕로 알려 줍니다. 운전자는 신호 하나만 보면 됩니다.');
      yield* this.until(() => A.rg.state === 'STOP', 8);
      A.ui.flash('stop', '우회전 불가!', '레이더가 아이를 먼저 감지 → LED ✕');
      yield* this.until(() => car2.v < 0.08 && car2.s > car2.yieldS - 4, 7);
      A.rig.setShot('crossing', { k: 2.6 });
      A.ui.caption(3, '아이가 지나갈 때까지 정지', '차는 횡단보도 앞에서 멈추고, 아이는 안전하게 건넙니다. 같은 ✕ 신호가 실제 장치로도 전송됩니다.');

      // ── 4. 해제 → 우회전 가능
      yield* this.until(() => !A.rg.virtualDetected, 10);
      A.ui.caption(4, '1초 더 기다린 뒤 →', '보행자가 감지 범위를 벗어나도 1초 동안 ✕를 유지합니다. 서두른 출발을 막는 안전 지연이에요.');
      yield* this.until(() => A.rg.state === 'GO', 3);
      A.ui.flash('go', '우회전 가능', '안전 지연 1초 후 → 표시');
      A.rig.setFollow(car2, 'chase');
      yield* this.wait(4.2);

      // ── 5. 현실과 연결
      A.resetWorld('full');
      A.signals.frozen = false;
      A.rig.setShot('link', { k: 1.2 });
      A.ui.showLink(true);
      A.ui.caption(5, '현실과 연결된 메타버스', '메타버스의 판단은 USB로 LED 장치(ESP32)에 그대로 전달되고, 현실의 레이더가 사람을 감지하면 메타버스에도 그 사람이 나타납니다.');
      yield* this.wait(10);
      A.ui.showLink(false);

      // ── 6. 직접 해 보기
      A.rig.setShot('wide', { k: 1.2 });
      A.ui.caption(6, '직접 해 보세요', '‘직접 운전’에서 우회전에 도전하거나, ‘관제 모드’의 조절 패널에서 센서 범위·보행자 속도·키를 바꿔 보며 LED가 어떻게 반응하는지 확인해 보세요.');
      yield* this.wait(7);
    }
  }
}
