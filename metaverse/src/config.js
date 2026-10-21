// Right Guard Metaverse — shared constants
// 서울 성북구 보문역 사거리(보문로 × 고려대로)를 바탕으로 만든 가상 교차로.
// 실제로는 고려대로가 비스듬히 지나가지만, 여기서는 두 도로를 직각으로 단순화했다.
// 좌표계: 1 unit = 1 m, 교차로 중심 = (0,0,0), Y = 위
//   −Z(북) = 보문로 → 성북구청      +Z(남) = 보문로 → 신설동역
//   +X(동) = 고려대로 → 안암·고려대  −X(서) = 고려대로 → 창신역
// 우측통행(대한민국). 두 도로 모두 왕복 4차로.

export const PAL = {
  crimson: 0x910023,
  deep: 0x6e0019,
  ivory: 0xe7dece,
  red: 0xe23a2e,
  amber: 0xf4a823,
  green: 0x1fa65a,
  cyan: 0x3fd8ff,
};

export const G = {
  NS_HALF: 6.5, // 보문로 반폭 (차로 3.25 m × 2)
  EW_HALF: 6.65, // 고려대로 반폭 (중앙 0.25 + 차로 3.2 m × 2)
  MEDIAN: 0.25,
  SIDEWALK: 6.5, // 출구·가로수가 있는 넓은 보도
  CURB_H: 0.15,
  CORNER_R: 2.5, // 모퉁이 연석 반경
  CW_GAP: 2.6, // 교차로 가장자리 ~ 횡단보도 (모퉁이 곡선이 끝나는 곳)
  CW_W: 4.0, // 횡단보도 폭
  STOP_GAP: 1.0, // 횡단보도 ~ 정지선
  EXT: 150, // 도로가 뻗는 거리
};

G.LANE = {
  NB_IN: 1.625,
  NB_OUT: 4.875,
  SB_IN: -1.625,
  SB_OUT: -4.875,
  EB_IN: G.MEDIAN + 1.6, // 1.85
  EB_OUT: G.MEDIAN + 4.8, // 5.05
  WB_IN: -(G.MEDIAN + 1.6),
  WB_OUT: -(G.MEDIAN + 4.8),
};
// 우회전 반경: 모퉁이 연석과 거의 같은 중심을 갖도록
G.TURN_R = G.CORNER_R + 1.6; // 4.1

// 횡단보도 사각형 (x0<x1, z0<z1)
const cwIn = G.NS_HALF + G.CW_GAP; // 9.1
const cwOut = cwIn + G.CW_W; // 13.1
const cwInZ = G.EW_HALF + G.CW_GAP; // 9.25
const cwOutZ = cwInZ + G.CW_W; // 13.25
G.CW = {
  E: { x0: cwIn, x1: cwOut, z0: -G.EW_HALF, z1: G.EW_HALF, axis: 'z' },
  W: { x0: -cwOut, x1: -cwIn, z0: -G.EW_HALF, z1: G.EW_HALF, axis: 'z' },
  S: { x0: -G.NS_HALF, x1: G.NS_HALF, z0: cwInZ, z1: cwOutZ, axis: 'x' },
  N: { x0: -G.NS_HALF, x1: G.NS_HALF, z0: -cwOutZ, z1: -cwInZ, axis: 'x' },
};
// 보행 동선(인도 위 걷는 선 = 횡단보도 중심선)
G.WALK_X = (cwIn + cwOut) / 2; // 11.1
G.WALK_Z = (cwInZ + cwOutZ) / 2; // 11.25

// 정지선 위치
G.STOP = {
  NB: cwOutZ + G.STOP_GAP, // z = 14.25 (북행 차량은 z가 줄어듦)
  SB: -(cwOutZ + G.STOP_GAP),
  EB: -(cwOut + G.STOP_GAP), // x = -14.1
  WB: cwOut + G.STOP_GAP,
};

// 건물 블록 시작 (인도 바깥)
G.BLOCK_X = G.NS_HALF + G.SIDEWALK; // 13.0
G.BLOCK_Z = G.EW_HALF + G.SIDEWALK; // 13.15

// 방향 이름 (표지판·미니맵·안내 문구)
G.NAMES = {
  N: '성북구청', S: '신설동역', W: '창신역', E: '안암·고려대',
  NS: '보문로', EW: '고려대로', place: '보문역 사거리',
};

// Right Guard 설치 위치: 남동 모퉁이(보문역 5번 출구 공사장 앞) 기둥 —
// 신설동 쪽에서 올라와 고려대 방향으로 우회전하는 차량이 고려대로 동쪽 횡단보도를 지나는 곳
export const RG = {
  pole: { x: G.NS_HALF + G.CW_GAP - 0.3, z: G.EW_HALF + 0.65 }, // (8.8, 7.3)
  radarAimDeg: -10, // x-z 평면 각도. 0 = 고려대로(동쪽) 방향, − = 횡단보도(북쪽) 쪽
  // (기본값: 차가 지나는 쪽 횡단보도 약 57% + 가림막 앞 보행로 접근을 약 7 m 일찍 감지하는 절충)
  radarRange: 6.0, // LD2450 최대 감지 거리 (m)
  radarHalfFov: 60, // 수평 ±60°
  radarHeight: 1.1, // 설치 높이 (m)
  radarTiltDeg: 0, // 아래로 기울인 각도 (+ = 아래)
  radarVHalfFov: 35, // 상하 ±35° (LD2450)
  ledHeight: 3.05,
  ledLowHeight: 2.3, // LED 위치 비교(L 키): 같은 기둥에서 낮춘 높이 (인도 기준 · 도로면에서 2.45 m)
  ledW: 1.6,
  ledH: 0.8,
  holdSec: 1.0, // 보행자 이탈 후 안전 지연 (펌웨어와 동일)
  maxTargets: 3, // LD2450 동시 추적 수
};
export function deriveRG() {
  RG.aim = (RG.radarAimDeg * Math.PI) / 180;
  RG.halfFov = (RG.radarHalfFov * Math.PI) / 180;
  RG.vHalf = (RG.radarVHalfFov * Math.PI) / 180;
  RG.pitch = (-RG.radarTiltDeg * Math.PI) / 180; // + = 위
}
deriveRG();
// LED 패널이 바라보는 방향: 북행(신설동 → 성북구청) 우회전 차량 운전자 쪽
RG.ledFace = Math.atan2(G.LANE.NB_OUT - RG.pole.x, G.STOP.NB + 14 - RG.pole.z); // rotation.y (패널 법선 = (sin, cos))
// LED 위치 비교(L 키)의 '건너편 끝': 같은 고려대로 동쪽 횡단보도의 북쪽 끝(북동 모퉁이) 기둥.
// 정지선에 선 우회전 차로를 바라봄 — 정지선에서 약 24 m라 경차 지붕선 아래로 들어옴
RG.farPole = { x: RG.pole.x, z: -RG.pole.z }; // (8.8, -7.3)
RG.farFace = Math.atan2(G.LANE.NB_OUT - RG.farPole.x, G.STOP.NB - RG.farPole.z);

// 레이더 상하 범위: 수평 거리 d에서 키 h인 사람의 몸이 빔 안에 들어오는가
export function radarSeesHeight(d, h) {
  const lo = RG.radarHeight + d * Math.tan(RG.pitch - RG.vHalf);
  const hi = RG.radarHeight + d * Math.tan(RG.pitch + RG.vHalf);
  return lo < h && hi > 0.05;
}
// 키 h인 사람을 감지할 수 있는 수평 거리 구간 [near, far] (없으면 null)
export function radarBand(h) {
  const n = 160;
  let near = null, far = null;
  for (let i = 0; i <= n; i++) {
    const d = 0.25 + ((RG.radarRange - 0.25) * i) / n;
    if (radarSeesHeight(d, h)) {
      if (near === null) near = d;
      far = d;
    }
  }
  return near === null ? null : { near, far };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, k, dt) => lerp(a, b, 1 - Math.exp(-k * dt));
export const rand = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[(Math.random() * arr.length) | 0];
export const angleWrap = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
export const inRect = (x, z, r, pad = 0) =>
  x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad;
