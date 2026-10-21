import * as THREE from 'three';

export const FONT_DISPLAY = '"Black Han Sans", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif';
export const FONT_BODY = '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function toTex(c, { repeat = false, srgb = true, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

// 간단한 결정적 난수 (텍스처마다 같은 결과)
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

export function asphaltTexture() {
  const [c, g] = canvas(512, 512);
  const r = rng(7);
  g.fillStyle = '#3b3c40';
  g.fillRect(0, 0, 512, 512);
  // 큰 얼룩
  for (let i = 0; i < 40; i++) {
    const x = r() * 512, y = r() * 512, rad = 30 + r() * 90;
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    const l = r() < 0.5 ? 'rgba(20,20,24,0.18)' : 'rgba(90,90,96,0.10)';
    gr.addColorStop(0, l);
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  // 골재 점
  for (let i = 0; i < 9000; i++) {
    const v = 40 + r() * 70;
    g.fillStyle = `rgba(${v},${v},${v + 4},${0.35 + r() * 0.4})`;
    g.fillRect(r() * 512, r() * 512, 1 + r() * 1.6, 1 + r() * 1.6);
  }
  return toTex(c, { repeat: true });
}

export function paverTexture() {
  const [c, g] = canvas(512, 512);
  const r = rng(11);
  g.fillStyle = '#8f8a84';
  g.fillRect(0, 0, 512, 512);
  const bw = 64, bh = 32;
  for (let row = 0; row < 512 / bh; row++) {
    const off = (row % 2) * (bw / 2);
    for (let col = -1; col < 512 / bw + 1; col++) {
      const x = col * bw + off, y = row * bh;
      const pinkish = r() < 0.12;
      const base = pinkish ? [176, 132, 124] : [178 + r() * 18, 172 + r() * 16, 162 + r() * 14];
      g.fillStyle = `rgb(${base[0] | 0},${base[1] | 0},${base[2] | 0})`;
      g.fillRect(x + 2, y + 2, bw - 4, bh - 4);
      for (let k = 0; k < 30; k++) {
        g.fillStyle = `rgba(0,0,0,${r() * 0.06})`;
        g.fillRect(x + 2 + r() * (bw - 6), y + 2 + r() * (bh - 6), 2, 2);
      }
    }
  }
  return toTex(c, { repeat: true });
}

export function concreteTexture(base = '#b9b2a6') {
  const [c, g] = canvas(256, 256);
  const r = rng(3);
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 3000; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.07})`;
    g.fillRect(r() * 256, r() * 256, 2, 2);
  }
  return toTex(c, { repeat: true });
}

// 건물 파사드: 4×4 칸(층×창) — map + emissive(야간 불 켜진 창)
const FACADES = [
  { wall: '#c9c0b0', frame: '#8c8478', glass: '#4d5f70', kind: 'window' }, // 베이지 상가
  { wall: '#7f97ad', frame: '#5e7286', glass: '#2c3e52', kind: 'curtain' }, // 유리 오피스
  { wall: '#9a5b45', frame: '#6d3d2d', glass: '#3b4652', kind: 'window' }, // 벽돌
  { wall: '#a9adb1', frame: '#7c8186', glass: '#38434e', kind: 'strip' }, // 회색 콘크리트
  { wall: '#e2dccf', frame: '#b3aa98', glass: '#46586a', kind: 'balcony' }, // 아파트
];
export const FACADE_COUNT = FACADES.length;

export function facadeTextures(variant, seed = 1) {
  const f = FACADES[variant % FACADES.length];
  const S = 512, N = 4, cell = S / N;
  const [c, g] = canvas(S, S);
  const [ce, ge] = canvas(S, S);
  const r = rng(97 + variant * 31 + seed * 7);
  g.fillStyle = f.wall;
  g.fillRect(0, 0, S, S);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, S, S);
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const x = ix * cell, y = iy * cell;
      let wx, wy, ww, wh;
      if (f.kind === 'curtain') {
        wx = x + 4; wy = y + 6; ww = cell - 8; wh = cell - 22;
      } else if (f.kind === 'strip') {
        wx = x; wy = y + 38; ww = cell; wh = cell - 76;
      } else if (f.kind === 'balcony') {
        wx = x + 14; wy = y + 22; ww = cell - 28; wh = cell - 60;
      } else {
        wx = x + 26; wy = y + 28; ww = cell - 52; wh = cell - 62;
      }
      g.fillStyle = f.frame;
      g.fillRect(wx - 4, wy - 4, ww + 8, wh + 8);
      const gr = g.createLinearGradient(wx, wy, wx + ww, wy + wh);
      gr.addColorStop(0, f.glass);
      gr.addColorStop(0.55, shade(f.glass, 28));
      gr.addColorStop(1, shade(f.glass, -10));
      g.fillStyle = gr;
      g.fillRect(wx, wy, ww, wh);
      // 반사 하이라이트
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.beginPath();
      g.moveTo(wx, wy + wh * 0.7);
      g.lineTo(wx + ww * 0.45, wy);
      g.lineTo(wx + ww * 0.62, wy);
      g.lineTo(wx, wy + wh);
      g.fill();
      // 창틀 가운데 줄
      g.fillStyle = f.frame;
      if (f.kind !== 'strip') g.fillRect(wx + ww / 2 - 2, wy, 4, wh);
      else for (let k = 1; k < 4; k++) g.fillRect(wx + (ww * k) / 4 - 2, wy, 4, wh);
      if (f.kind === 'balcony') {
        g.fillStyle = 'rgba(240,236,228,0.95)';
        g.fillRect(x + 8, y + cell - 40, cell - 16, 6);
        g.fillStyle = 'rgba(120,120,120,0.55)';
        for (let k = 0; k < 10; k++) g.fillRect(x + 10 + k * ((cell - 20) / 10), y + cell - 36, 2, 26);
      }
      // 야간 조명
      if (r() < 0.42) {
        const warm = r() < 0.7;
        ge.fillStyle = warm ? `rgba(255,${200 + r() * 30},${130 + r() * 40},1)` : 'rgba(190,220,255,1)';
        ge.fillRect(wx, wy, ww, wh);
        ge.fillStyle = 'rgba(0,0,0,0.35)';
        ge.fillRect(wx + ww * r() * 0.6, wy, ww * 0.25, wh);
      }
    }
  }
  const map = toTex(c, { repeat: true });
  const emissive = toTex(ce, { repeat: true });
  return { map, emissive, cellW: 3.2 * N, cellH: 3.4 * N };
}

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const gg = Math.max(0, Math.min(255, ((n >> 8) & 255) + amt));
  const b = Math.max(0, Math.min(255, (n & 255) + amt));
  return `rgb(${r},${gg},${b})`;
}

export function roofTexture() {
  const [c, g] = canvas(256, 256);
  const r = rng(5);
  g.fillStyle = '#8d8f8c';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(0,0,0,0.12)';
  for (let i = 0; i < 256; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
  }
  for (let i = 0; i < 1500; i++) {
    g.fillStyle = `rgba(0,0,0,${r() * 0.08})`;
    g.fillRect(r() * 256, r() * 256, 2, 2);
  }
  return toTex(c, { repeat: true });
}

// 상점 간판
export function signTexture(text, { bg = '#910023', fg = '#ffffff', sub = '', w = 512, h = 128, font = FONT_DISPLAY, fs = 1 } = {}) {
  const [c, g] = canvas(w, h);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(0, 0, w, h * 0.12);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const size = (sub ? h * 0.46 : h * 0.6) * fs;
  g.font = `${size}px ${font}`;
  g.fillText(text, w / 2, sub ? h * 0.4 : h * 0.54, w * 0.92);
  if (sub) {
    g.font = `${h * 0.2}px ${FONT_BODY}`;
    g.globalAlpha = 0.85;
    g.fillText(sub, w / 2, h * 0.8, w * 0.9);
  }
  return toTex(c);
}

// 보행자 신호 아이콘 (빨간 서 있는 사람 / 초록 걷는 사람)
export function pedIconTexture(walk) {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#0d0d0f';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = walk ? '#38e07a' : '#ff4a3a';
  g.translate(64, 64);
  g.beginPath();
  g.arc(0, -36, 11, 0, Math.PI * 2);
  g.fill();
  g.lineCap = 'round';
  g.strokeStyle = g.fillStyle;
  g.lineWidth = 14;
  if (walk) {
    line(g, 0, -20, -4, 12); // 몸통
    g.lineWidth = 10;
    line(g, -4, 12, -20, 42);
    line(g, -4, 12, 14, 40);
    line(g, -1, -14, 18, 2);
    line(g, -1, -14, -18, -2);
  } else {
    line(g, 0, -20, 0, 14);
    g.lineWidth = 10;
    line(g, -6, 14, -8, 44);
    line(g, 6, 14, 8, 44);
    line(g, -8, -16, -14, 12);
    line(g, 8, -16, 14, 12);
  }
  return toTex(c);
}
function line(g, x0, y0, x1, y1) {
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
}

// 부드러운 원형 그라디언트 (glow / 빛 웅덩이)
export function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128) {
  const [c, g] = canvas(size, size);
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, inner);
  gr.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.45)'));
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return toTex(c);
}

// 지면 문자 (예: "천천히")
export function roadTextTexture(text) {
  const [c, g] = canvas(256, 512);
  g.clearRect(0, 0, 256, 512);
  g.fillStyle = '#f4f1e8';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `200px ${FONT_DISPLAY}`;
  const chars = [...text];
  const step = 512 / chars.length;
  chars.forEach((ch, i) => {
    g.save();
    g.translate(128, step * (i + 0.5));
    g.scale(1, 1.25);
    g.fillText(ch, 0, 0);
    g.restore();
  });
  return toTex(c);
}

// 광고판 (Right Guard 현수막) — 왼쪽에 고려대학교 엠블럼 (크림슨 바탕 위 아이보리 방패 그대로)
export function billboardTexture(emblemImg) {
  const [c, g] = canvas(1024, 384);
  const gr = g.createLinearGradient(0, 0, 1024, 384);
  gr.addColorStop(0, '#910023');
  gr.addColorStop(1, '#5c0016');
  g.fillStyle = gr;
  g.fillRect(0, 0, 1024, 384);
  if (emblemImg && emblemImg.naturalWidth) {
    try {
      const ih = 300, iw = (ih * emblemImg.naturalWidth) / emblemImg.naturalHeight;
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.35)';
      g.shadowBlur = 14;
      g.shadowOffsetY = 4;
      g.drawImage(emblemImg, 36 + (272 - iw) / 2, (384 - ih) / 2, iw, ih);
      g.restore();
    } catch (e) { /* ignore */ }
  }
  g.fillStyle = '#E7DECE';
  g.textBaseline = 'middle';
  g.font = `92px ${FONT_DISPLAY}`;
  g.fillText('우회전, 보행자 먼저', 346, 140, 646);
  g.font = `44px ${FONT_BODY}`;
  g.globalAlpha = 0.9;
  g.fillText('RIGHT TURN, RIGHT TIME', 350, 238, 636);
  g.globalAlpha = 0.7;
  g.font = `34px ${FONT_BODY}`;
  g.fillText('Team Right Guard · 고려대학교 KU CreativeX', 350, 304, 636);
  return toTex(c);
}

// ───────────────────────── 보문역 사거리 전용

// 지하철 출입구 표지 (6호선 · 우이신설선 보문역 + 출구 번호)
export function exitSignTexture(num) {
  const [c, g] = canvas(512, 160);
  g.fillStyle = '#23272c';
  g.fillRect(0, 0, 512, 160);
  g.fillStyle = 'rgba(255,255,255,0.08)';
  g.fillRect(0, 0, 512, 14);
  // 노선 배지
  const badge = (x, col, txt, fg = '#fff') => {
    g.fillStyle = col;
    g.beginPath(); g.arc(x, 80, 30, 0, Math.PI * 2); g.fill();
    g.fillStyle = fg;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `bold ${txt.length > 1 ? 22 : 34}px ${FONT_BODY}`;
    g.fillText(txt, x, 82);
  };
  badge(48, '#cd7c2f', '6');
  badge(112, '#b7c452', '우이', '#1d2a10');
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.font = `52px ${FONT_DISPLAY}`;
  g.fillText('보문', 158, 66);
  g.font = `22px ${FONT_BODY}`;
  g.globalAlpha = 0.8;
  g.fillText('Bomun', 160, 116);
  g.globalAlpha = 1;
  // 출구 번호 (노란 사각)
  g.fillStyle = '#f6c21c';
  roundRect(g, 382, 18, 112, 124, 18);
  g.fill();
  g.fillStyle = '#1a1a1a';
  g.textAlign = 'center';
  g.font = `bold 88px ${FONT_BODY}`;
  g.fillText(String(num), 438, 84);
  return toTex(c);
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// 도로 방향 표지 (파란 바탕) — left/up/right: 행선지
export function directionSignTexture({ road, roadEn, left, up, right }) {
  const [c, g] = canvas(1024, 448);
  g.fillStyle = '#0d55a6';
  g.fillRect(0, 0, 1024, 448);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 8;
  g.strokeRect(14, 14, 996, 420);
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  // 윗줄: 행선지 3개
  g.font = `54px ${FONT_DISPLAY}`;
  g.textAlign = 'left';
  g.fillText(`← ${left}`, 44, 104, 270);
  g.textAlign = 'center';
  g.fillText(`↑ ${up}`, 512, 104, 250);
  g.textAlign = 'right';
  g.fillText(`${right} →`, 980, 104, 290);
  // 행선지 사이 구분선
  g.fillRect(352, 70, 4, 70);
  g.fillRect(668, 70, 4, 70);
  // 구분선
  g.fillRect(40, 168, 944, 5);
  // 아랫줄: 교차 도로 이름
  g.textAlign = 'center';
  g.font = `112px ${FONT_DISPLAY}`;
  g.fillText(road, 512, 268, 620);
  g.font = `40px ${FONT_BODY}`;
  g.globalAlpha = 0.9;
  g.fillText(roadEn, 512, 370, 600);
  g.globalAlpha = 1;
  // 양쪽 화살표 (도로가 좌우로 이어짐)
  g.font = `110px ${FONT_BODY}`;
  g.fillText('‹', 92, 300);
  g.fillText('›', 932, 300);
  return toTex(c);
}

// 작은 지명 표지 (초록 바탕)
export function placeSignTexture(text) {
  const [c, g] = canvas(512, 128);
  g.fillStyle = '#1f7a3e';
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.strokeRect(8, 8, 496, 112);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `70px ${FONT_DISPLAY}`;
  g.fillText(text, 256, 68, 470);
  return toTex(c);
}

// 공사 가림막 (흰 패널 + 파란 띠 + 안내 문구). 한 장 = 가로 8 m × 세로 3 m
// 공사장 가림막 한 칸 (HOARD_TILE_M × 3 m, 1 m = 128 px)
//  안전 배지 · '보문역 출입구 신설 공사' 문구 · 오른쪽에 고려대학교 차세대통신학과 판
export const HOARD_TILE_M = 10;
export const HOARD_PLATE = { x0: 872, x1: 1244, y0: 144, y1: 248 }; // 학과 판 위치 (px)
export function hoardingTexture(deptImg) {
  const W = HOARD_TILE_M * 128;
  const [c, g] = canvas(W, 384);
  g.fillStyle = '#eef0f0';
  g.fillRect(0, 0, W, 384);
  // 패널 이음새 (1 m 간격)
  g.fillStyle = 'rgba(0,0,0,0.10)';
  for (let x = 0; x <= W; x += 128) g.fillRect(x, 0, 3, 384);
  // 아래 남색 띠, 위 파란 띠
  g.fillStyle = '#1e3a6e';
  g.fillRect(0, 344, W, 40);
  g.fillStyle = '#2f73c9';
  g.fillRect(0, 34, W, 22);
  // 안전제일 배지
  g.fillStyle = '#1f9a4a';
  g.beginPath(); g.arc(84, 192, 46, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  g.fillRect(74, 158, 20, 68);
  g.fillRect(50, 182, 68, 20);
  // 문구
  g.fillStyle = '#1e3a6e';
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  g.font = `56px ${FONT_DISPLAY}`;
  g.fillText('보문역 출입구 신설 공사', 152, 160, 680);
  g.font = `32px ${FONT_BODY}`;
  g.fillStyle = '#3d4a5c';
  g.fillText('공사 기간 중 보행자 안전 통로를 이용해 주세요', 154, 234, 690);
  // 고려대학교 차세대통신학과 판
  if (deptImg && deptImg.naturalWidth) {
    const { x0, x1, y0, y1 } = HOARD_PLATE;
    const pw = x1 - x0, ph = y1 - y0;
    g.fillStyle = '#ffffff';
    roundRect(g, x0, y0, pw, ph, 12);
    g.fill();
    g.strokeStyle = 'rgba(30,58,110,0.22)';
    g.lineWidth = 3;
    g.stroke();
    try {
      const iw = pw - 30, ih = (iw * deptImg.naturalHeight) / deptImg.naturalWidth;
      g.drawImage(deptImg, x0 + 15, y0 + (ph - ih) / 2, iw, ih);
    } catch (e) { /* ignore */ }
  }
  return toTex(c, { repeat: true });
}

// 둥근 제한속도 표지
export function speedLimitTexture(n = 50) {
  const [c, g] = canvas(256, 256);
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(128, 128, 120, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#d7261e';
  g.lineWidth = 26;
  g.beginPath(); g.arc(128, 128, 104, 0, Math.PI * 2); g.stroke();
  g.fillStyle = '#111111';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `bold 118px ${FONT_BODY}`;
  g.fillText(String(n), 128, 134);
  return toTex(c);
}

// 노란 단속 안내판
export function enforcementSignTexture() {
  const [c, g] = canvas(512, 128);
  g.fillStyle = '#f6c21c';
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#1a1a1a';
  g.lineWidth = 6;
  g.strokeRect(8, 8, 496, 112);
  g.fillStyle = '#1a1a1a';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `60px ${FONT_DISPLAY}`;
  g.fillText('신호·과속 단속', 256, 68, 470);
  return toTex(c);
}

// 노면 숫자 (예: 50) — 진행 방향으로 길쭉하게
export function roadNumberTexture(text) {
  const [c, g] = canvas(256, 512);
  g.clearRect(0, 0, 256, 512);
  g.fillStyle = '#f4f1e8';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  g.translate(128, 256);
  g.scale(1, 2.4);
  g.font = `bold 170px ${FONT_BODY}`;
  g.fillText(text, 0, 6);
  g.restore();
  return toTex(c);
}

// 점자블록 (노란 바탕 + 점)
export function tactileTexture() {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#e9b81f';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(120,80,0,0.35)';
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    g.beginPath(); g.arc(16 + x * 32, 16 + y * 32, 8, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgba(0,0,0,0.25)';
  g.fillRect(0, 0, 128, 2);
  g.fillRect(0, 0, 2, 128);
  return toTex(c, { repeat: true });
}
