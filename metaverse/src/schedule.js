// 비교 실험(장치 없음 vs 있음)용 도착 일정
// 같은 seed·시나리오면 두 세계가 똑같은 사람과 차를 같은 순서로 받는다.
// 도착 시각은 경로별 난수 흐름으로 정하고, 각 사람·차의 생김새와 성향은 저마다의 seed로 만든다
// → 한쪽 세계에서 차가 막혀 늦게 들어와도 다른 사람·차의 성향은 바뀌지 않는다.
import { G } from './config.js';
import { mulberry32, hashSeed, withRandom, gauss } from './rng.js';
import { seCrossingTrip, southApproachTrip, northCrossingTrip, loiterTrip, randomTrip } from './pedestrians.js';

// 시나리오: 교통량·보행자 구성
export const SCENARIOS = {
  normal: {
    name: '평상시 낮', veh: 0.65, nbR: 0.6,
    eRate: 1 / 14, bgRate: 1 / 7, loiterRate: 1 / 110,
    kidShare: 0.1, dartShare: 0.4, mix: { se: 0.4, south: 0.25, north: 0.35 },
  },
  rush: {
    name: '출퇴근 (보행자 많음)', veh: 0.65, nbR: 0.5,
    eRate: 1 / 8, bgRate: 1 / 4.5, loiterRate: 1 / 60,
    kidShare: 0.04, dartShare: 0.3, mix: { se: 0.45, south: 0.25, north: 0.3 },
  },
  school: {
    name: '하교 시간 (아이 많음)', veh: 0.6, nbR: 0.6,
    eRate: 1 / 12, bgRate: 1 / 7, loiterRate: 1 / 110,
    kidShare: 0.45, dartShare: 0.45, mix: { se: 0.5, south: 0.2, north: 0.3 },
  },
};

// 운전자 행동 가정 (비교 페이지에서 바꿀 수 있음)
//   pSelf : 장치 없이도 건너려는 보행자를 보고 스스로 멈추는 운전자 비율
//           (국내 시범운영 관찰: 우회전 일시정지 준수율 10.3% — 경북, 2023)
//   pObey : LED ✕를 보면 멈추는 운전자 비율
//           (FHWA 보행자 경고등 RRFB 연구: 설치 후 양보율 약 80%)
//   prt   : 보행자를 '알아채기'까지 걸리는 시간의 중앙값(초). 보이기 시작한 뒤 이만큼 지나야 반응
export const ASSUME = { pSelf: 0.1, pObey: 0.8, prt: 1.3 };

// 차량 경로별 기본 빈도 (traffic.js 와 같음)
const WEIGHTS = {
  NB_IN: 0.85, NB_OUT: 0.5, NB_R: 0.6, SB_IN: 0.85, SB_OUT: 0.5, SB_R: 0.28,
  EB_IN: 0.8, EB_OUT: 0.45, EB_R: 0.25, WB_IN: 0.8, WB_OUT: 0.45, WB_R: 0.25,
};

const expo = (rnd, rate) => -Math.log(1 - rnd()) / rate;

export class Schedule {
  constructor(seed = 1, scenario = 'normal', assume = {}) {
    this.seed = seed >>> 0;
    this.scn = SCENARIOS[scenario] || SCENARIOS.normal;
    this.scnKey = SCENARIOS[scenario] ? scenario : 'normal';
    this.A = { ...ASSUME, ...assume };
    this.sid = 0;
    this.streams = {};
    for (const k in WEIGHTS) {
      const rnd = mulberry32(hashSeed(this.seed, 'veh', k));
      const mult = k === 'NB_R' ? this.scn.nbR : this.scn.veh;
      const st = { rnd, rate: WEIGHTS[k] * mult, t: 0, pending: [] };
      st.t = rnd() * 4 / st.rate * 0.2;
      this.streams[k] = st;
    }
    this.ped = {
      e: { rnd: mulberry32(hashSeed(this.seed, 'pedE')), t: 0 },
      bg: { rnd: mulberry32(hashSeed(this.seed, 'pedBG')), t: 0 },
      loiter: { rnd: mulberry32(hashSeed(this.seed, 'loiter')), t: 0 },
    };
    this.ped.e.t = expo(this.ped.e.rnd, this.scn.eRate) * 0.5;
    this.ped.bg.t = expo(this.ped.bg.rnd, this.scn.bgRate) * 0.5;
    this.ped.loiter.t = expo(this.ped.loiter.rnd, this.scn.loiterRate);
  }

  _nextSid() {
    return ++this.sid;
  }

  // 차량 도착 → 경로별 대기열, 진입로가 비면 차례대로 등장
  update(t, traffic) {
    for (const k in this.streams) {
      if (traffic.blockRoutes.has(k)) continue;
      const st = this.streams[k];
      while (st.t <= t) {
        const u = st.rnd();
        const seed = (st.rnd() * 4294967296) >>> 0;
        st.pending.push({ sid: this._nextSid(), seed, route: k });
        st.t += (3 + u * 4) / st.rate;
      }
      if (st.pending.length && traffic.routeClear(traffic.routes[k], 44, 66)) {
        const e = st.pending.shift();
        this._spawnVehicle(e, traffic);
      }
    }
    this._pedStream('e', t, traffic, (rnd) => this._eCrosser(rnd));
    this._pedStream('bg', t, traffic, () => ({ role: 'bg' }));
    this._pedStream('loiter', t, traffic, () => ({ role: 'loiter' }));
  }

  _pedStream(key, t, traffic, make) {
    const s = this.ped[key];
    const rate = key === 'e' ? this.scn.eRate : key === 'bg' ? this.scn.bgRate : this.scn.loiterRate;
    while (s.t <= t) {
      const spec = make(s.rnd);
      spec.sid = this._nextSid();
      spec.seed = (s.rnd() * 4294967296) >>> 0;
      this._spawnPed(spec, traffic);
      s.t += expo(s.rnd, rate);
    }
  }

  // 고려대로 동쪽 횡단보도를 건너는 사람 (측정 대상)
  _eCrosser(rnd) {
    const m = this.scn.mix;
    const u = rnd();
    const role = u < m.se ? 'se' : u < m.se + m.south ? 'south' : 'north';
    const kid = role !== 'north' && rnd() < this.scn.kidShare;
    const dart = kid && rnd() < this.scn.dartShare;
    return { role, kind: kid ? 'kid' : 'adult', dart };
  }

  _spawnVehicle(e, traffic) {
    const rnd = mulberry32(e.seed);
    const A = this.A;
    let human = null;
    if (e.route === 'NB_R') {
      // 같은 운전자는 두 세계에서 똑같이 행동한다 (같은 난수로 성향을 정함)
      const uSelf = rnd(), uObey = rnd();
      human = {
        prt: Math.min(3.2, Math.max(0.6, A.prt * Math.exp(0.35 * gauss(rnd)))),
        selfYield: uSelf < A.pSelf,
        obeyRG: uObey < A.pObey,
        patience: 2.5 + rnd() * 2.5,
        rgPatience: 9 + rnd() * 7,
        turnBoost: 1.0 + rnd() * 0.32,
        gapLeft: 3.2 + rnd() * 1.6,
        react: 0.6 + rnd() * 0.8, // 이미 본 사람이 차로로 들어오기 시작할 때 브레이크까지 (0.6–1.4초)
      };
    }
    withRandom(rnd, () => {
      const v = traffic.spawnVehicle(e.route, { s: 52, v: 7 + Math.random() * 2.5, human, turnBoost: human ? human.turnBoost : undefined });
      v.sid = e.sid;
    });
  }

  _spawnPed(spec, traffic) {
    const rnd = mulberry32(spec.seed);
    withRandom(rnd, () => {
      const ox = -0.6 + Math.random() * 1.4, oz = -0.2 + Math.random() * 0.9;
      let path, opts = {};
      const adultVig = Math.random() < 0.7;
      const late = Math.random() < 0.06;
      const gapNeed = 2.6 + Math.random() * 1.8;
      switch (spec.role) {
        case 'se': {
          const fromX = 15 + Math.random() * 22;
          path = seCrossingTrip({ fromX, ox, oz, northTo: Math.random() < 0.5 ? -40 : -24 });
          break;
        }
        case 'south':
          path = southApproachTrip({ fromZ: G.WALK_Z + 6 + Math.random() * 22, ox });
          break;
        case 'north':
          path = northCrossingTrip({ ox, oz, east: Math.random() < 0.45, fromZ: -(G.WALK_Z + 8 + Math.random() * 18) });
          break;
        case 'loiter':
          path = loiterTrip({ dwell: 18 + Math.random() * 50 });
          break;
        default:
          path = randomTrip({ startNear: Math.random() < 0.6 });
          break;
      }
      if (spec.kind === 'kid') {
        opts = spec.dart
          ? { kind: 'kid', speed: undefined, vigilant: false }
          : { kind: 'kid', speed: 1.35 + Math.random() * 0.35, vigilant: Math.random() < 0.5 };
      } else {
        opts = { kind: 'adult', vigilant: adultVig, lateStarter: late };
      }
      const p = traffic.spawnPed({ path, ...opts, gapNeed });
      p.sid = spec.sid;
      p.role = spec.role;
      p.dart = !!spec.dart;
    });
  }
}
