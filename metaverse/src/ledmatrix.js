// 32×16 P10 LED 패널 패턴 — 실제 장치 영상의 모양을 그대로 옮김
// ARROW: 초록 → (우회전 가능), X: 빨강 ✕ (우회전 불가)
export const LED_W = 32;
export const LED_H = 16;

function makeArrow() {
  const m = new Uint8Array(LED_W * LED_H);
  for (let r = 0; r < LED_H; r++) {
    for (let c = 0; c < LED_W; c++) {
      const dy = Math.abs(r - 7.5);
      let on = false;
      if (c >= 3 && c <= 15 && dy <= 2) on = true; // 몸통 (4줄 두께)
      if (c >= 15 && c <= 27) {
        const t = (c - 15) / 12;
        const half = 7 * (1 - t) + 0.5;
        if (dy <= half) on = true; // 화살촉
      }
      m[r * LED_W + c] = on ? 1 : 0;
    }
  }
  return m;
}

function makeX() {
  const m = new Uint8Array(LED_W * LED_H);
  for (let i = 0; i < 16; i++) {
    const a = 8 + i, b = 23 - i;
    for (const c of [a, a + 1, b, b - 1]) {
      if (c >= 8 && c <= 23) m[i * LED_W + c] = 1;
    }
  }
  return m;
}

export const PATTERNS = {
  ARROW: { bits: makeArrow(), color: [40, 235, 110] },
  X: { bits: makeX(), color: [255, 52, 40] },
  OFF: { bits: new Uint8Array(LED_W * LED_H), color: [0, 0, 0] },
};

// 캔버스에 도트 매트릭스로 그리기
export function drawMatrix(ctx, w, h, patternKey, opts = {}) {
  const p = PATTERNS[patternKey] || PATTERNS.OFF;
  const { bg = '#0b0c0e', offDot = '#1c1e22', glow = true, dim = 1 } = opts;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const cw = w / LED_W, ch = h / LED_H;
  const rad = Math.min(cw, ch) * 0.36;
  const [R, Gc, B] = p.color;
  for (let r = 0; r < LED_H; r++) {
    for (let c = 0; c < LED_W; c++) {
      const x = (c + 0.5) * cw, y = (r + 0.5) * ch;
      const on = p.bits[r * LED_W + c];
      if (on) {
        if (glow) {
          const gr = ctx.createRadialGradient(x, y, 0, x, y, rad * 2.2);
          gr.addColorStop(0, `rgba(${R},${Gc},${B},${0.55 * dim})`);
          gr.addColorStop(1, `rgba(${R},${Gc},${B},0)`);
          ctx.fillStyle = gr;
          ctx.fillRect(x - rad * 2.2, y - rad * 2.2, rad * 4.4, rad * 4.4);
        }
        ctx.fillStyle = `rgba(${Math.min(255, R + 70)},${Math.min(255, Gc + 70)},${Math.min(255, B + 70)},${dim})`;
      } else {
        ctx.fillStyle = offDot;
      }
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
