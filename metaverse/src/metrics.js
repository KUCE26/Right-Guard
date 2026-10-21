// 비교 실험 지표 — 장치 없는 세계와 있는 세계를 똑같은 기준으로 센다
//
// 북행 우회전 차 (신설동 → 고려대 방향, 고려대로 동쪽 횡단보도를 지남)
//   일시정지가 필요했던 차 : 차가 아직 편안히(4.5 m/s² 이하로) 멈출 수 있는 거리에 있을 때
//                           ① 횡단보도 위 보행자가 차가 지나갈 자리(CZ)에 있거나 6초 안에 들어오거나
//                           ② 보행 신호 녹색에 공사장 쪽 연석에서 건너려는 사람이 있었던 경우
//   일시정지 이행         : 그 뒤 횡단보도 앞에서 완전히 멈춤(0.3 m/s 미만)
//   아찔한 순간           : 알아챈 보행자 때문에 4.2 m/s² 넘게 급정거
//   충돌 직전             : 사람과 겹치기 직전 시뮬레이션이 강제로 세움 (실제라면 부딪혔을 상황)
// 보행자 (고려대로 동쪽 횡단보도를 건너 차가 지나가는 자리에 들어선 사람)
//   감지 성공 (장치)      : 그 자리에 들어서기 전에 레이더가 '건너는/건너려는 사람'으로 잡음
//   경고 선행 시간        : 처음 잡힌 때부터 그 자리에 들어설 때까지
//   차를 먼저 보냄        : 멈추지 않고 오는 차 때문에 연석에서 기다림
// ✕ 구간 (장치)
//   오감지                : ✕가 켜졌다 꺼질 때까지(+4초) 실제로 그 자리에 들어선 사람이 없음
import { CZ, inCZ, onCrosswalkE, etaCZ, intendsE_SE } from './vehicles.js';

const MAX_EVENTS = 40;
// 고려대로 동쪽 횡단보도와 양쪽 연석 둘레
const EZ = { x0: CZ.x0 - 1.6, x1: CZ.x1 + 1.6, z0: -(6.65 + 3.5), z1: 6.65 + 3.5 };
const inEZone = (p) => p.x >= EZ.x0 && p.x <= EZ.x1 && p.z >= EZ.z0 && p.z <= EZ.z1;

export class Metrics {
  constructor() {
    this.reset(0);
  }

  // sidCut: 비교 실험에서 이 번호까지 도착한 사람·차는 세지 않음 (두 세계가 정확히 같은 대상을 셈)
  reset(t, vehicles = [], peds = [], sidCut = null) {
    this.t0 = t;
    this.t = t;
    this.sidCut = sidCut;
    this.c = {
      turns: 0, required: 0, complied: 0, reqIntent: 0, compIntent: 0, close: 0, near: 0, crash: 0,
      pedWaitSum: 0, warnOk: 0,
      turnTime: 0, turnTimeN: 0, rgStops: 0, falseStops: 0,
      pedCross: 0, pedYieldFail: 0, pedConflict: 0,
      det: 0, detOk: 0, leadSum: 0, leadN: 0, lead1: 0,
      ep: 0, epFalse: 0, epTime: 0, epFalseTime: 0,
    };
    this.events = [];
    this.seq = 0;
    this.ep = null;
    this.pendingEp = [];
    // 이미 측정 구간에 들어선 차·횡단보도 위 사람은 빼고 센다
    for (const v of vehicles) {
      if (!v.route || !v.route.rg) continue;
      v._mt = v.s + v.len / 2 >= v.route.stopFrontS - 40 ? { skip: true } : undefined;
    }
    for (const p of peds) {
      p._mp = { conflict: !!(p.hitBy || p.nearBy), enterT: onCrosswalkE(p) ? -1 : null, detT: null };
    }
  }

  _event(type, obj, extra = {}) {
    this.events.push({ n: ++this.seq, type, t: +(this.t - this.t0).toFixed(1), sid: obj && obj.sid, ...extra });
    if (this.events.length > MAX_EVENTS) this.events.shift();
  }
  eventsSince(n) {
    return this.events.filter((e) => e.n > n);
  }

  // 일시정지가 필요한가 — 'cross' 건너는 사람이 차가 지나갈 자리로 옴 · 'intent' 연석에서 건너려 함 · '' 필요 없음
  _required(ctx) {
    const walk = ctx.signals.ped('E') === 'W';
    let kind = '';
    for (const p of ctx.peds) {
      if (!p.active || p.isTwin) continue;
      if (onCrosswalkE(p) && etaCZ(p) <= 6.0) return 'cross';
      if (walk && intendsE_SE(p)) kind = 'intent';
    }
    return kind;
  }

  update(dt, t, ctx) {
    this.t = t;
    const c = this.c;
    const rg = ctx.rg;
    // ── 우회전 차
    let req = null; // 이번 단계의 '일시정지 필요' 여부 (필요할 때만 계산)
    for (const v of ctx.vehicles) {
      if (!v.route || !v.route.rg || v.yieldS == null) continue;
      if (this.sidCut != null && (v.sid == null || v.sid <= this.sidCut)) continue; // 측정 시작 전에 도착한 차
      let m = v._mt;
      if (!m) m = v._mt = { started: false };
      if (m.skip || m.done) continue;
      const sY = v.yieldS - 0.3;
      if (!m.started) {
        if (v.s + v.len / 2 < v.route.stopFrontS - 40) continue;
        m.started = true;
        m.t0 = t;
      }
      // 맨 앞 차일 때만 판단 (앞차 때문에 줄 서 있는 차는 아직 횡단보도와 마주하지 않음).
      // 바깥 차로는 직진 차(NB_OUT)와 같이 쓰므로, 경로가 달라도 앞에 차가 있으면 맨 앞이 아님
      const ahead = v.blockedBy;
      const lead = !ahead || (ahead.route === v.route && ahead.yieldS != null && ahead.s > ahead.yieldS - 0.3);
      if (!m.req && lead && v.s <= sY + 0.25) {
        const dist = sY - v.s;
        const canStop = v.v < 0.3 || dist >= (v.v * v.v) / (2 * 4.5);
        if (canStop && dist < 30) {
          if (req === null) req = this._required(ctx);
          if (req) { m.req = true; m.reqT = t; m.reqKind = req; }
        }
      }
      // 일시정지 = 횡단보도 바로 앞(2.5 m 안)에서 맨 앞 차로 완전히 멈춤 (신호 대기·줄 서기는 제외)
      if (m.req && !m.stopped && lead && v.v < 0.3 && v.s <= sY + 0.6 && sY - v.s < 2.5 && v.reason !== 'car') m.stopped = true;
      if (!m.rgStop && v.reason === 'rg' && v.v < 0.3) m.rgStop = true;
      // 가까이 스침: 차가 시속 7 km 넘게 움직이는데 앞쪽 2 m 안에 횡단보도 위(차도) 보행자
      if (!m.close && v.v > 2.0) {
        const f = v.front, hx = v.pos.hx, hz = v.pos.hz;
        for (const p of ctx.peds) {
          if (!p.active || p.isTwin || !onCrosswalkE(p)) continue;
          const dx = p.x - f.x, dz = p.z - f.z;
          if (dx * dx + dz * dz < 4.0 && dx * hx + dz * hz > -0.3) { m.close = true; this._event('close', v); break; }
        }
      }
      // 아찔한 순간·충돌 직전은 우회전 뒤 횡단보도(고려대로 동쪽) 둘레의 보행자만 셈 — 장치가 지키는 곳
      if (v.nearList && (m.nearIdx || 0) < v.nearList.length) {
        for (let i = m.nearIdx || 0; i < v.nearList.length; i++) {
          const e = v.nearList[i];
          if (!m.near && e && inEZone(e)) { m.near = true; this._event('near', v); }
        }
        m.nearIdx = v.nearList.length;
      }
      if (v.crashed && !m.crashChecked) {
        m.crashChecked = true;
        if (v.crashAt && inEZone(v.crashAt)) { m.crash = true; this._event('crash', v, { kmh: Math.round(v.crashV * 3.6) }); }
      }
      if (v.s > v.yieldS + 7) {
        m.done = true;
        c.turns++;
        c.turnTime += t - m.t0;
        c.turnTimeN++;
        if (m.req) {
          c.required++;
          if (m.reqKind === 'intent') c.reqIntent++;
          if (m.stopped) {
            c.complied++;
            if (m.reqKind === 'intent') c.compIntent++;
            this._event('yield', v);
          } else this._event('noyield', v, { kind: m.reqKind });
        }
        if (m.close) c.close++;
        if (m.near) c.near++;
        if (m.crash) c.crash++;
        if (m.rgStop) {
          c.rgStops++;
          if (!m.req) { c.falseStops++; }
        }
      }
    }

    // ── 보행자
    const devOn = rg && rg.enabled;
    if (devOn) {
      // 레이더가 '건너는/건너려는 사람'으로 계속 잡고 있는 구간의 시작 시각
      for (const tg of rg.targets) {
        if (tg.p.isTwin || tg.risk === 'wait') continue;
        const pm = tg.p._mp || (tg.p._mp = {});
        if (pm.trackLast == null || t - pm.trackLast > 0.1) pm.detT = t;
        pm.trackLast = t;
      }
    }
    for (const p of ctx.peds) {
      if (!p.active || p.isTwin) continue;
      if (this.sidCut != null && (p.sid == null || p.sid <= this.sidCut)) continue; // 측정 시작 전에 도착한 사람
      const pm = p._mp || (p._mp = {});
      if (pm.enterT == null && onCrosswalkE(p) && inCZ(p)) {
        pm.enterT = t;
        c.pedCross++;
        if (p.waitedForCar) { c.pedYieldFail++; c.pedWaitSum += p.carWait; this._event('pedwait', p, { wait: +p.carWait.toFixed(1) }); }
        if (devOn) {
          c.det++;
          if (rg.state === 'STOP') c.warnOk++;
          if (pm.trackLast != null && t - pm.trackLast <= 0.1) {
            c.detOk++;
            const lead = t - pm.detT;
            c.leadSum += lead;
            c.leadN++;
            if (lead >= 1.0) c.lead1++;
          } else this._event('miss', p);
        }
      }
      if (!pm.conflict && (p.hitBy || p.nearBy)) { pm.conflict = true; c.pedConflict++; }
    }

    // ── ✕ 구간 (장치가 있을 때)
    if (devOn) {
      const stop = rg.state === 'STOP';
      if (stop && !this.ep) this.ep = { t0: t, ids: new Set(), justified: false };
      if (this.ep) {
        for (const tg of rg.targets) if (!tg.p.isTwin && tg.risk !== 'wait') this.ep.ids.add(tg.p);
        if (!this.ep.justified) {
          for (const p of ctx.peds) {
            if (p.active && !p.isTwin && onCrosswalkE(p) && (inCZ(p) || etaCZ(p) <= 6.0)) { this.ep.justified = true; break; }
          }
        }
        if (!stop) {
          this.ep.t1 = t;
          this.pendingEp.push(this.ep);
          this.ep = null;
        }
      }
      for (let i = this.pendingEp.length - 1; i >= 0; i--) {
        const e = this.pendingEp[i];
        if (!e.justified) {
          for (const p of e.ids) {
            const et = p._mp && p._mp.enterT;
            if (et != null && et >= e.t0 - 0.5 && et <= e.t1 + 4) { e.justified = true; break; }
          }
        }
        if (e.justified || t - e.t1 >= 4) {
          this.pendingEp.splice(i, 1);
          c.ep++;
          c.epTime += e.t1 - e.t0;
          if (!e.justified) {
            c.epFalse++;
            c.epFalseTime += e.t1 - e.t0;
            this._event('false', null, { dur: +(e.t1 - e.t0).toFixed(1) });
          }
        }
      }
    }
  }

  summary() {
    const c = this.c;
    const r = (a, b) => (b > 0 ? a / b : null);
    return {
      min: (this.t - this.t0) / 60,
      turns: c.turns,
      required: c.required,
      complied: c.complied,
      compliance: r(c.complied, c.required),
      reqIntent: c.reqIntent,
      compIntent: c.compIntent,
      complianceIntent: r(c.compIntent, c.reqIntent),
      pedWait: r(c.pedWaitSum, c.pedYieldFail),
      warnOk: c.warnOk,
      warnRate: r(c.warnOk, c.det),
      close: c.close,
      near: c.near,
      crash: c.crash,
      turnTime: r(c.turnTime, c.turnTimeN),
      rgStops: c.rgStops,
      falseStops: c.falseStops,
      pedCross: c.pedCross,
      pedYieldFail: c.pedYieldFail,
      yieldFailRate: r(c.pedYieldFail, c.pedCross),
      pedConflict: c.pedConflict,
      det: c.det,
      detOk: c.detOk,
      detRate: r(c.detOk, c.det),
      lead: r(c.leadSum, c.leadN),
      lead1Rate: r(c.lead1, c.det),
      ep: c.ep,
      epFalse: c.epFalse,
      falseRate: r(c.epFalse, c.ep),
      falseTimeRate: r(c.epFalseTime, c.epTime),
    };
  }
}
export { CZ };
