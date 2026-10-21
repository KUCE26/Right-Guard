// 비교 실험용 난수 — 같은 seed면 언제나 같은 수열
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 문자열·숫자 여러 개 → 32비트 seed
export function hashSeed(...parts) {
  let h = 2166136261 >>> 0;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= 0x9e3779b9;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// fn 안에서 Math.random 을 rnd 로 바꿔 실행 (차·사람 생성이 두 세계에서 똑같이 나오게)
export function withRandom(rnd, fn) {
  const orig = Math.random;
  Math.random = rnd;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

// 표준정규 난수 (Box–Muller)
export function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
