// 조절 패널 값 — 센서 범위, 보행자 속도·키, 차량
// 자동 시연은 항상 DEFAULTS로 재생하고, 관제·운전 모드에서는 사용자가 바꾼 값을 쓴다.
export const DEFAULTS = {
  range: 6.0, // 감지 거리 (m) — LD2450 사양 최대 6 m
  hfov: 60, // 좌우 감지각 (±°) — 사양 ±60°
  aim: -10, // 조준 방향 (°) — 0 = 고려대로(동쪽), − = 횡단보도 쪽
  height: 1.1, // 설치 높이 (m)
  tilt: 0, // 아래로 기울기 (°)
  vfov: 35, // 상하 감지각 (±°) — 사양 ±35°
  hold: 1.0, // 안전 지연 (s)
  adultSpeed: 1.3, // 어른 걷는 속도 (m/s)
  kidSpeed: 3.0, // 아이 뛰는 속도 (m/s)
  adultH: 170, // 어른 키 (cm)
  kidH: 120, // 아이 키 (cm)
  pedRate: 1, // 보행자 생성 빈도 (×)
  carKmh: 35, // 차량 주행 속도 (km/h)
  traffic: 1, // 교통량 (×)
};

// 슬라이더 정의: [키, 라벨, min, max, step, 단위, 그룹, 힌트]
export const FIELDS = [
  ['range', '감지 거리', 1, 8, 0.1, 'm', 'sensor', 'LD2450 사양 최대 6 m'],
  ['hfov', '좌우 감지각', 15, 90, 1, '±°', 'sensor', '사양 ±60°'],
  ['aim', '조준 방향', -90, 90, 1, '°', 'sensor', '− 횡단보도 쪽 · + 인도 쪽'],
  ['height', '설치 높이', 0.3, 4, 0.05, 'm', 'sensor', ''],
  ['tilt', '아래로 기울기', 0, 45, 1, '°', 'sensor', ''],
  ['vfov', '상하 감지각', 10, 60, 1, '±°', 'sensor', '사양 ±35°'],
  ['hold', '안전 지연', 0, 3, 0.1, '초', 'sensor', '사라진 뒤 ✕ 유지'],
  ['adultSpeed', '어른 걷는 속도', 0.5, 2, 0.05, 'm/s', 'ped', ''],
  ['kidSpeed', '아이 뛰는 속도', 0.8, 4, 0.1, 'm/s', 'ped', ''],
  ['adultH', '어른 키', 140, 200, 1, 'cm', 'ped', ''],
  ['kidH', '아이 키', 90, 150, 1, 'cm', 'ped', ''],
  ['pedRate', '보행자 수', 0, 2, 0.1, '×', 'ped', '자동 생성 빈도'],
  ['carKmh', '차량 주행 속도', 20, 60, 1, 'km/h', 'car', ''],
  ['traffic', '교통량', 0.2, 2, 0.1, '×', 'car', ''],
];

const KEY = 'rg_meta_settings_v1';

export function loadSettings() {
  const s = { ...DEFAULTS };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && typeof raw === 'object') {
      for (const [k, , min, max] of FIELDS) {
        const v = +raw[k];
        if (Number.isFinite(v)) s[k] = Math.min(max, Math.max(min, v));
      }
    }
  } catch (e) { /* 저장소를 쓸 수 없으면 기본값 */ }
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
}

export function isDefault(s) {
  return FIELDS.every(([k]) => Math.abs(s[k] - DEFAULTS[k]) < 1e-9);
}

export function fmt(k, v) {
  const f = FIELDS.find((x) => x[0] === k);
  if (!f) return String(v);
  const step = f[4];
  const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  const num = Number(v).toFixed(dec);
  if (k === 'adultSpeed' || k === 'kidSpeed') return `${num} m/s · ${(v * 3.6).toFixed(1)} km/h`;
  if (f[5] === '±°') return `±${num}°`;
  if (k === 'aim') return `${v > 0 ? '+' : ''}${num}°`;
  return `${num} ${f[5]}`;
}
