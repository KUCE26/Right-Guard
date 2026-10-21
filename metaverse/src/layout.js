// 보문역 사거리 배치 데이터 (월드·보행자·미니맵이 함께 씀)
// 실제 거리뷰(2026년 5월)를 참고해 모퉁이별 특징을 옮기되, 거리·크기는 단순화했다.
//   북동(성북구청·고려대 쪽 모퉁이) : 3·4번 출구, 한의원·떡집·부동산·카페·치과 상가
//   북서(성북구청·창신 쪽 모퉁이)   : 1·2번 출구, 주황 간판 치과의원 + 휴대폰 매장
//   남서(신설동·창신 쪽 모퉁이)     : 8번 출구, 갈색 타일 건물(베이커리·필라테스·약국)
//   남동(신설동·고려대 쪽 모퉁이)   : 5번 출구 신설 공사장 가림막, 6·7번 출구, 고층 아파트
import { G } from './config.js';

const NS = G.NS_HALF, EW = G.EW_HALF;

// 지하철 출입구: 상자(x0..x1, z0..z1) + 입구 방향(교차로 쪽)
export const EXITS = [
  { n: 1, x0: -24.5, x1: -19.0, z0: -(EW + 2.95), z1: -(EW + 0.55), mouth: 'E' },
  { n: 2, x0: -(NS + 2.95), x1: -(NS + 0.55), z0: -24.5, z1: -19.0, mouth: 'S' },
  { n: 3, x0: NS + 0.55, x1: NS + 2.95, z0: -26.0, z1: -20.5, mouth: 'S' },
  { n: 4, x0: 27.0, x1: 32.5, z0: -(EW + 2.95), z1: -(EW + 0.55), mouth: 'W' },
  { n: 6, x0: 56.0, x1: 61.5, z0: EW + 0.55, z1: EW + 2.95, mouth: 'W' },
  { n: 7, x0: 43.0, x1: 48.5, z0: EW + 0.55, z1: EW + 2.95, mouth: 'W' },
  { n: 8, x0: -22.5, x1: -17.0, z0: EW + 0.55, z1: EW + 2.95, mouth: 'E' },
];
// 입구 앞 보행 시작점 (상자 밖 0.6 m)
for (const e of EXITS) {
  const cx = (e.x0 + e.x1) / 2, cz = (e.z0 + e.z1) / 2;
  if (e.mouth === 'E') e.mx = e.x1 + 0.6, e.mz = cz;
  if (e.mouth === 'W') e.mx = e.x0 - 0.6, e.mz = cz;
  if (e.mouth === 'S') e.mx = cx, e.mz = e.z1 + 0.6;
  if (e.mouth === 'N') e.mx = cx, e.mz = e.z0 - 0.6;
  // 어느 모퉁이 인도에 있는가
  e.corner = (e.mz < 0 ? 'N' : 'S') + (e.mx < 0 ? 'W' : 'E');
  // 출구가 어느 도로를 따라 있는가 (보행 동선 연결용)
  e.along = e.mouth === 'E' || e.mouth === 'W' ? 'EW' : 'NS';
}

// 남동 모퉁이 공사장 (5번 출구 신설) — 가림막으로 둘러쌈
export const SITE = { x0: G.BLOCK_X, x1: 40, z0: G.BLOCK_Z, z1: 38 };
// 남동쪽 작은 공원
export const PARK = { x0: 42, x1: 64, z0: G.BLOCK_Z, z1: 36 };
// 가림막 앞 초록 임시 보행로 + 물통 방호벽
export const WALKWAY = { w: 2.4 };
export const BARRIER = { x0: 15.5, x1: 39.5, z: G.BLOCK_Z - WALKWAY.w - 0.3 };
