// 교차로 신호 — 보문로(NS) / 고려대로(EW) 2현시
// 보행 신호: 동·서 횡단보도(고려대로를 건넘)는 보문로 녹색일 때 보행,
//           남·북 횡단보도(보문로를 건넘)는 고려대로 녹색일 때 보행.
export const PHASES = [
  { k: 'NS_G', d: 24 },
  { k: 'NS_Y', d: 3 },
  { k: 'AR1', d: 2 },
  { k: 'EW_G', d: 26 },
  { k: 'EW_Y', d: 3 },
  { k: 'AR2', d: 2 },
];
const WALK = { NS_G: 16, EW_G: 18 }; // 보행 녹색(점멸 전) 시간
// 횡단보도별 보행 현시: 동·서(고려대로를 건넘)는 보문로 녹색, 남·북(보문로를 건넘)은 고려대로 녹색
const PED_PHASE = { E: 'NS_G', W: 'NS_G', S: 'EW_G', N: 'EW_G' };

export class Signals {
  constructor() {
    this.idx = 0;
    this.t = 0;
    this.frozen = false;
  }
  get phase() {
    return PHASES[this.idx].k;
  }
  get remaining() {
    return PHASES[this.idx].d - this.t;
  }
  update(dt) {
    if (this.frozen) return;
    this.t += dt;
    while (this.t >= PHASES[this.idx].d) {
      this.t -= PHASES[this.idx].d;
      this.idx = (this.idx + 1) % PHASES.length;
    }
  }
  set(k, t = 0) {
    const i = PHASES.findIndex((p) => p.k === k);
    if (i >= 0) {
      this.idx = i;
      this.t = t;
    }
  }
  veh(group) {
    const ph = this.phase;
    if (group === 'NS') return ph === 'NS_G' ? 'G' : ph === 'NS_Y' ? 'Y' : 'R';
    return ph === 'EW_G' ? 'G' : ph === 'EW_Y' ? 'Y' : 'R';
  }
  // 'W' 보행, 'F' 점멸, 'D' 정지
  ped(cw) {
    const g = PED_PHASE[cw];
    if (this.phase !== g) return 'D';
    if (this.frozen) return 'W';
    return this.t < WALK[g] ? 'W' : 'F';
  }
  // 보행 신호(녹색+점멸)가 꺼질 때까지 남은 시간 — 보행 현시가 아니면 0, 신호 고정 중이면 무한
  pedRemaining(cw) {
    if (this.phase !== PED_PHASE[cw]) return 0;
    if (this.frozen) return Infinity;
    return PHASES[this.idx].d - this.t;
  }
  // 보행 녹색이 켜진 뒤 지난 시간 (보행 현시가 아니면 −1)
  pedElapsed(cw) {
    return this.phase === PED_PHASE[cw] ? this.t : -1;
  }
  // 보행 녹색(녹색+점멸) 전체 길이
  pedGreenLen(cw) {
    const g = PED_PHASE[cw];
    return PHASES.find((p) => p.k === g).d;
  }
}
