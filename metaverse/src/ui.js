import * as THREE from 'three';
import { G, RG, radarBand, radarSeesHeight } from './config.js';
import { PED } from './pedestrians.js';
import { drawMatrix } from './ledmatrix.js';
import { STEPS } from './story.js';
import { PHASES } from './signals.js';

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(app) {
    this.app = app;
    this.el = {
      verdict: $('verdict'), vText: $('vText'), vSub: $('vSub'), vLed: $('vLed'), holdBar: $('holdBar'), holdFill: $('holdFill'),
      caption: $('caption'), capSteps: $('capSteps'), capNum: $('capNum'), capTitle: $('capTitle'), capText: $('capText'),
      flash: $('flash'), flashT: $('flashT'), flashS: $('flashS'), vignette: $('vignette'),
      title: $('titlecard'), link: $('linkcard'), linkStatus: $('linkStatus'), linkStatusT: $('linkStatusT'),
      sidebar: $('sidebar'), driveHud: $('driveHud'), spd: $('spd'), scOk: $('scOk'), scBad: $('scBad'),
      devStatus: $('devStatus'), devStatusT: $('devStatusT'), mirror: $('mirror'), mirrorBox: $('mirrorBox'), mirrorTag: $('mirrorTag'),
      dTx: $('dTx'), dReal: $('dReal'), dMode: $('dMode'), devMsg: $('devMsg'), devConnect: $('devConnect'), devLog: $('devLog'),
      sigVeh: $('sigVeh'), sigVehT: $('sigVehT'), sigPed: $('sigPed'), minimap: $('minimap'), labels: $('labels'),
      stTurns: $('stTurns'), stStops: $('stStops'), stNear: $('stNear'),
    };
    for (let i = 0; i < STEPS; i++) this.el.capSteps.appendChild(document.createElement('i'));
    this.vctx = this.el.vLed.getContext('2d');
    this.mctx = this.el.mirror.getContext('2d');
    this.map = this.el.minimap.getContext('2d');
    this._v = {};
    this.flashTimer = null;
    this._labels = [];
    this.tmpV = new THREE.Vector3();
  }

  // ───────── 자막 / 연출
  caption(step, title, text) {
    const e = this.el;
    e.capNum.textContent = step === 0 ? '▶' : `${step}/${STEPS}`;
    e.capTitle.textContent = title;
    e.capText.textContent = text;
    [...e.capSteps.children].forEach((s, i) => {
      s.className = i + 1 < step ? 'on' : i + 1 === step ? 'now' : '';
    });
  }
  flash(kind, title, sub = '', dur = 2.4) {
    const e = this.el;
    e.flash.className = 'flash ' + kind;
    e.flashT.textContent = title;
    e.flashS.textContent = sub;
    void e.flash.offsetWidth;
    e.flash.classList.add('show');
    if (kind === 'danger') {
      e.vignette.classList.add('on');
      setTimeout(() => e.vignette.classList.remove('on'), 1400);
    }
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => e.flash.classList.remove('show'), dur * 1000);
  }
  titleCard(on) {
    this.el.title.dataset.on = on ? 'true' : 'false';
  }
  showLink(on) {
    this.el.link.hidden = !on;
  }

  setMode(mode) {
    for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-pressed', b.dataset.mode === mode ? 'true' : 'false');
    this.el.sidebar.hidden = mode !== 'sandbox';
    this.el.caption.hidden = mode !== 'story';
    this.el.driveHud.hidden = mode !== 'drive';
    document.getElementById('app').classList.toggle('drive-on', mode === 'drive');
    if (mode !== 'story') { this.titleCard(false); this.showLink(false); }
    this.el.title.hidden = mode !== 'story'; // 다른 모드에선 바로 숨김 (서서히 사라지는 효과를 기다리지 않음)
  }

  // ───────── 판단 배너
  updateVerdict(rg, link) {
    const e = this.el;
    let cls, text, sub, pattern;
    const near = rg.targets.find((t) => !t.p.isTwin && t.risk !== 'wait');
    if (rg.state === 'OFF') {
      cls = 'off'; text = 'Right Guard 꺼짐'; sub = '운전자가 직접 살펴야 합니다'; pattern = 'OFF';
    } else if (rg.state === 'GO') {
      cls = 'go'; text = '우회전 가능';
      sub = rg.waiting ? `보행자 대기 중 · 보행 신호 ${rg.pedSig === 'F' ? '점멸' : '빨강'}` : '보행자 없음 · 레이더 감시 중';
      pattern = 'ARROW';
    } else if (rg.virtualDetected || rg.realDetected) {
      cls = 'stop'; text = '우회전 불가!';
      const why = { road: '횡단 중', intent: '건너려는 보행자', dart: '차도로 뛰어듦' };
      if (rg.virtualDetected && near) sub = `보행자 감지 · ${near.dist.toFixed(1)} m · ${why[near.risk] || '진입 예상'}`;
      else sub = '현실 레이더가 사람을 감지 (LD2450)';
      pattern = 'X';
    } else {
      cls = 'stop hold'; text = '우회전 불가'; sub = `안전 지연 ${rg.holdLeft.toFixed(1)}초 후 해제`; pattern = 'X';
    }
    if (this._v.cls !== cls) { e.verdict.className = 'verdict ' + cls; this._v.cls = cls; }
    if (this._v.text !== text) { e.vText.textContent = text; this._v.text = text; }
    if (this._v.sub !== sub) { e.vSub.textContent = sub; this._v.sub = sub; }
    const hold = cls === 'stop hold';
    if (e.holdBar.hidden === hold) e.holdBar.hidden = !hold;
    if (hold) e.holdFill.style.width = `${RG.holdSec > 0 ? (1 - rg.holdLeft / RG.holdSec) * 100 : 100}%`;
    if (this._v.pattern !== pattern) {
      drawMatrix(this.vctx, 192, 96, pattern, { offDot: '#1f2126' });
      this._v.pattern = pattern;
    }
  }

  // ───────── 장치 패널
  updateDevice(link, rg) {
    const e = this.el;
    let st = 'off', stT = '연결 안 됨';
    if (!link.supported) { st = 'warn'; stT = '브라우저 미지원'; }
    else if (!link.policyOK) { st = 'warn'; stT = '미리보기에선 불가'; }
    else if (link.connected) {
      if (link.alive) { st = 'on'; stT = '연결됨 · ' + (link.roleText || '장치'); }
      else { st = 'warn'; stT = '응답 대기 중'; }
    }
    if (this._v.st !== st + stT) {
      e.devStatus.className = 'status ' + (st === 'on' ? 'on' : st === 'warn' ? 'warn' : '');
      e.devStatusT.textContent = stT;
      e.linkStatus.className = e.devStatus.className;
      e.linkStatusT.textContent = stT;
      e.devConnect.textContent = link.connected ? '연결 해제' : '장치 연결 (USB)';
      this._v.st = st + stT;
    }
    const realKnown = link.connected && link.realLed;
    const pat = realKnown ? link.realLed : link.metaState === 'STOP' ? 'X' : 'ARROW';
    const key = pat + (realKnown ? 'R' : 'P');
    if (this._v.mirror !== key) {
      drawMatrix(this.mctx, 384, 192, pat, { offDot: '#1d1f24' });
      e.mirrorBox.classList.toggle('preview', !realKnown);
      e.mirrorTag.textContent = realKnown ? '실제 LED · 장치 보고' : link.connected ? '장치 응답 대기' : '명령 미리보기';
      this._v.mirror = key;
    }
    const tx = link.metaState === 'STOP' ? 'RG:STOP' : 'RG:GO';
    if (this._v.tx !== tx) {
      e.dTx.innerHTML = `<i class="dot ${tx === 'RG:STOP' ? 'stop' : 'go'}"></i>${tx}`;
      e.mirrorBox.classList.add('flashing');
      setTimeout(() => e.mirrorBox.classList.remove('flashing'), 300);
      this._v.tx = tx;
    }
    let real;
    if (!link.connected) real = '<i class="dot"></i>—';
    else if (link.realDetected) real = `<i class="dot stop"></i>사람 감지${link.realInferred ? ' (추정)' : ''}`;
    else real = '<i class="dot go"></i>없음';
    if (this._v.real !== real) { e.dReal.innerHTML = real; this._v.real = real; }
  }
  deviceMessage(msg) {
    this.el.devMsg.hidden = !msg;
    this.el.devMsg.textContent = msg || '';
  }
  renderLog(link) {
    const box = this.el.devLog;
    if (box.hidden) return;
    const rows = link.log.slice(-40).map((l) => `<div class="${l.dir}">${l.dir === 'tx' ? '→' : l.dir === 'rx' ? '←' : '·'} ${escapeHtml(l.text)}</div>`);
    box.innerHTML = rows.join('') || '<div class="sys">· 아직 주고받은 메시지가 없습니다</div>';
    box.scrollTop = box.scrollHeight;
  }

  // ───────── 신호 표시
  updateSignals(signals, t) {
    const e = this.el;
    const v = signals.veh('NS');
    const cls = v === 'G' ? 'g' : v === 'Y' ? 'y' : 'r';
    if (this._v.sv !== cls) { e.sigVeh.className = cls; this._v.sv = cls; }
    let secs = '';
    if (!signals.frozen) {
      if (v !== 'R') secs = Math.ceil(signals.remaining) + '';
      else {
        let s = signals.remaining;
        for (let k = (signals.idx + 1) % PHASES.length; PHASES[k].k !== 'NS_G'; k = (k + 1) % PHASES.length) s += PHASES[k].d;
        secs = Math.ceil(s) + '';
      }
    } else secs = '고정';
    if (this._v.ss !== secs) { e.sigVehT.textContent = secs; this._v.ss = secs; }
    const p = signals.ped('E');
    const blink = Math.floor(t * 2.5) % 2 === 0;
    const pc = p === 'W' || (p === 'F' && blink) ? 'g' : p === 'F' ? '' : 'r';
    if (this._v.sp !== pc) { e.sigPed.className = pc; this._v.sp = pc; }
  }

  // ───────── 미니맵 (보문역 사거리)
  drawMinimap(A) {
    const c = this.map, W = 376, H = 376;
    let cx0 = 5, cz0 = 4;
    if (A.mode === 'drive' && A.player.active) { cx0 = A.player.x; cz0 = A.player.z; }
    const s = 3.1;
    const X = (x) => W / 2 + (x - cx0) * s, Z = (z) => H / 2 + (z - cz0) * s;
    c.save();
    c.clearRect(0, 0, W, H);
    c.beginPath();
    c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2);
    c.clip();
    c.fillStyle = '#25282c';
    c.fillRect(0, 0, W, H);
    // 도로
    c.fillStyle = '#4a4e55';
    c.fillRect(X(-G.NS_HALF), 0, G.NS_HALF * 2 * s, H);
    c.fillRect(0, Z(-G.EW_HALF), W, G.EW_HALF * 2 * s);
    // 공원 · 공사장
    const P = A.world.park, S = A.world.site;
    c.fillStyle = 'rgba(111,154,82,.55)';
    c.fillRect(X(P.x0), Z(P.z0), (P.x1 - P.x0) * s, (P.z1 - P.z0) * s);
    c.save();
    c.beginPath();
    c.rect(X(S.x0), Z(S.z0), (S.x1 - S.x0) * s, (S.z1 - S.z0) * s);
    c.clip();
    c.fillStyle = 'rgba(139,115,84,.5)';
    c.fillRect(X(S.x0), Z(S.z0), (S.x1 - S.x0) * s, (S.z1 - S.z0) * s);
    c.strokeStyle = 'rgba(244,168,35,.55)';
    c.lineWidth = 3;
    for (let k = -200; k < 400; k += 14) { c.beginPath(); c.moveTo(X(S.x0) + k, Z(S.z0)); c.lineTo(X(S.x0) + k + 120, Z(S.z0) + 120); c.stroke(); }
    c.restore();
    c.strokeStyle = 'rgba(244,168,35,.9)';
    c.lineWidth = 2;
    c.strokeRect(X(S.x0), Z(S.z0), (S.x1 - S.x0) * s, (S.z1 - S.z0) * s);
    // 건물 · 지하철 출입구
    c.lineWidth = 1;
    for (const b of A.world.occluders) {
      if (b.kind === 'site') continue;
      const x = X(b.x0), z = Z(b.z0), w = (b.x1 - b.x0) * s, h = (b.z1 - b.z0) * s;
      if (x > W || z > H || x + w < 0 || z + h < 0) continue;
      if (b.kind === 'exit') {
        c.fillStyle = '#f6c21c';
        c.fillRect(x, z, w, h);
        continue;
      }
      c.fillStyle = '#34373c';
      c.strokeStyle = '#41454b';
      c.fillRect(x, z, w, h);
      c.strokeRect(x, z, w, h);
    }
    // 횡단보도
    c.fillStyle = 'rgba(240,236,228,.75)';
    for (const k of ['E', 'W', 'N', 'S']) {
      const r = G.CW[k];
      if (r.axis === 'x') for (let x = r.x0 + 0.3; x < r.x1; x += 0.9) c.fillRect(X(x), Z(r.z0), 0.45 * s, (r.z1 - r.z0) * s);
      else for (let z = r.z0 + 0.25; z < r.z1; z += 0.9) c.fillRect(X(r.x0), Z(z), (r.x1 - r.x0) * s, 0.45 * s);
    }
    // 중앙선
    c.strokeStyle = 'rgba(242,182,48,.7)';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(X(0), 0); c.lineTo(X(0), Z(G.STOP.SB)); c.moveTo(X(0), Z(G.STOP.NB)); c.lineTo(X(0), H);
    c.moveTo(0, Z(0)); c.lineTo(X(G.STOP.EB), Z(0)); c.moveTo(X(G.STOP.WB), Z(0)); c.lineTo(W, Z(0));
    c.stroke();
    // 레이더 부채꼴 (어른 기준 감지 구간)
    if (A.rg.enabled) {
      const det = A.rg.virtualDetected || A.rg.realDetected;
      const band = A.rg.bands && A.rg.bands.adult;
      if (band) {
        c.fillStyle = det ? 'rgba(226,58,46,.42)' : A.rg.state === 'STOP' ? 'rgba(244,168,35,.35)' : 'rgba(31,166,90,.35)';
        const px = X(RG.pole.x), pz = Z(RG.pole.z);
        c.beginPath();
        c.arc(px, pz, band.far * s, RG.aim - RG.halfFov, RG.aim + RG.halfFov);
        c.arc(px, pz, band.near * s, RG.aim + RG.halfFov, RG.aim - RG.halfFov, true);
        c.closePath();
        c.fill();
      }
    }
    // 차량
    for (const v of A.traffic.vehicles) {
      const p = v.pos;
      c.save();
      c.translate(X(p.x), Z(p.z));
      c.rotate(Math.atan2(p.hz, p.hx));
      c.fillStyle = v.tag === 'story' ? '#7fb0ff' : v.route.rg ? '#f2e6c9' : '#c9ccd1';
      c.fillRect((-v.len / 2) * s, (-v.wid / 2) * s, v.len * s, v.wid * s);
      c.restore();
    }
    if (A.player.active) {
      const f = A.player.fwd;
      c.save();
      c.translate(X(A.player.x), Z(A.player.z));
      c.rotate(Math.atan2(f.z, f.x));
      c.fillStyle = '#d4153f';
      c.strokeStyle = '#fff';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(3.2 * s, 0); c.lineTo(-2.3 * s, -1.4 * s); c.lineTo(-1.4 * s, 0); c.lineTo(-2.3 * s, 1.4 * s);
      c.closePath(); c.fill(); c.stroke();
      c.restore();
    }
    // 보행자
    for (const p of A.traffic.peds) {
      if (!p.active) continue;
      c.fillStyle = p.isTwin ? '#3fd8ff' : p.kind === 'kid' ? '#ffd21f' : '#f4a823';
      c.beginPath();
      c.arc(X(p.x), Z(p.z), p.isTwin ? 5 : 3.6, 0, Math.PI * 2);
      c.fill();
    }
    // 장치
    c.fillStyle = '#910023';
    c.strokeStyle = '#E7DECE';
    c.lineWidth = 2;
    c.beginPath(); c.arc(X(RG.pole.x), Z(RG.pole.z), 6, 0, Math.PI * 2); c.fill(); c.stroke();
    // 행선지 · 도로 이름
    c.font = 'bold 19px "Noto Sans KR", sans-serif';
    c.textBaseline = 'middle';
    const tag = (txt, x, y, align) => {
      c.textAlign = align;
      c.lineWidth = 5;
      c.strokeStyle = 'rgba(20,22,25,.85)';
      c.strokeText(txt, x, y);
      c.fillStyle = '#E7DECE';
      c.fillText(txt, x, y);
    };
    if (!(A.mode === 'drive' && A.player.active)) {
      tag(`↑ ${G.NAMES.N}`, W / 2, 34, 'center');
      tag(`↓ ${G.NAMES.S}`, W / 2, H - 30, 'center');
      tag(`← ${G.NAMES.W.replace('역', '')}`, 14, H / 2 + 34, 'left');
      tag('고려대 →', W - 14, H / 2 + 34, 'right');
      c.font = '15px "Noto Sans KR", sans-serif';
      tag(G.NAMES.NS, X(-G.NS_HALF) - 6, Z(-30), 'right');
      tag(G.NAMES.EW, X(-34), Z(-G.EW_HALF) - 12, 'center');
    }
    c.restore();
    // 테두리
    c.strokeStyle = 'rgba(231,222,206,.35)';
    c.lineWidth = 3;
    c.beginPath(); c.arc(W / 2, H / 2, W / 2 - 2, 0, Math.PI * 2); c.stroke();
  }

  // ───────── 조절 패널: 측면도 (설치 높이 · 기울기 · 상하 감지각 vs 사람 키)
  drawSideView(cv) {
    const g = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const left = 30, ground = H - 58, ppm = (W - left - 18) / 8.5; // 8.5 m 폭
    const X = (d) => left + d * ppm, Y = (h) => ground - h * ppm;
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#121416';
    g.fillRect(0, 0, W, H);
    // 거리 눈금
    g.strokeStyle = 'rgba(255,255,255,.07)';
    g.fillStyle = 'rgba(231,222,206,.5)';
    g.font = '15px "Noto Sans KR", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let d = 0; d <= 8; d++) {
      g.beginPath(); g.moveTo(X(d), 10); g.lineTo(X(d), ground); g.stroke();
      if (d % 2 === 0) g.fillText(`${d}m`, X(d), ground + 33);
    }
    // 빔 (상하 감지 범위)
    const hS = RG.radarHeight, R = RG.radarRange;
    const lo = RG.pitch - RG.vHalf, hi = RG.pitch + RG.vHalf;
    g.save();
    g.beginPath(); g.rect(X(0), 0, X(R) - X(0), ground); g.clip();
    g.fillStyle = 'rgba(31,166,90,.22)';
    g.beginPath();
    g.moveTo(X(0), Y(hS));
    g.lineTo(X(R), Y(hS + R * Math.tan(hi)));
    g.lineTo(X(R), Y(hS + R * Math.tan(lo)));
    g.closePath();
    g.fill();
    g.strokeStyle = 'rgba(141,255,192,.75)';
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(X(0), Y(hS)); g.lineTo(X(R), Y(hS + R * Math.tan(hi))); g.stroke();
    g.beginPath(); g.moveTo(X(0), Y(hS)); g.lineTo(X(R), Y(hS + R * Math.tan(lo))); g.stroke();
    g.restore();
    // 최대 거리
    g.setLineDash([6, 5]);
    g.strokeStyle = 'rgba(141,255,192,.6)';
    g.beginPath(); g.moveTo(X(R), 10); g.lineTo(X(R), ground); g.stroke();
    g.setLineDash([]);
    // 땅
    g.fillStyle = '#4a4e55';
    g.fillRect(0, ground, W, 3);
    // 기둥 · LED · 센서
    g.fillStyle = '#8c9196';
    g.fillRect(X(0) - 4, Y(3.7), 8, ground - Y(3.7));
    g.fillStyle = '#15161a';
    g.fillRect(X(0) - 3, Y(RG.ledHeight + 0.4), 16, 0.8 * ppm);
    g.fillStyle = '#e7dece';
    g.fillRect(X(0) + 3, Y(hS) - 5, 12, 10);
    // 사람 (아이 1.0 m, 어른 2.4 m 지점) — 빔 안이면 초록, 밖이면 빨강
    const person = (d, h, label) => {
      const ok = radarSeesHeight(d, h) && d <= R;
      const col = ok ? '#3be38a' : '#ff6a5c';
      const x = X(d), top = Y(h), hr = 0.11 * ppm;
      g.fillStyle = col;
      g.beginPath(); g.arc(x, top + hr, hr, 0, Math.PI * 2); g.fill();
      g.fillRect(x - 0.12 * ppm, top + hr * 2, 0.24 * ppm, (h - 0.22) * ppm * 0.55);
      g.fillRect(x - 0.08 * ppm, top + hr * 2 + (h - 0.22) * ppm * 0.55, 0.16 * ppm, ground - (top + hr * 2 + (h - 0.22) * ppm * 0.55));
      g.font = 'bold 14px "Noto Sans KR", sans-serif';
      g.textBaseline = 'bottom';
      g.fillText(`${label} ${ok ? '✓' : '✕'}`, x, top - 4);
    };
    person(1.0, PED.kidH, '아이');
    person(2.4, PED.adultH, '어른');
    // 감지 구간 막대 (땅 아래)
    const bar = (b, y, col, txt) => {
      g.fillStyle = 'rgba(255,255,255,.06)';
      g.fillRect(X(0), y, X(8) - X(0), 10);
      if (b) { g.fillStyle = col; g.fillRect(X(b.near), y, Math.max(2, X(b.far) - X(b.near)), 10); }
      g.fillStyle = col;
      g.font = '12px "Noto Sans KR", sans-serif';
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.fillText(txt, 4, y + 5);
      g.textAlign = 'center';
    };
    bar(radarBand(PED.adultH), ground + 7, '#3be38a', '어른');
    bar(radarBand(PED.kidH), ground + 20, '#f4a823', '아이');
  }

  // ───────── 3D 라벨
  label(id, cls) {
    let l = this._labels.find((x) => x.id === id);
    if (!l) {
      const el = document.createElement('div');
      el.className = 'lbl ' + (cls || '');
      this.el.labels.appendChild(el);
      l = { id, el, text: '', vis: false };
      this._labels.push(l);
    }
    return l;
  }
  placeLabel(l, cam, x, y, z, text, cls) {
    const v = this.tmpV.set(x, y, z).project(cam);
    const vis = v.z < 1 && v.z > -1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15;
    if (vis !== l.vis) { l.el.style.display = vis ? '' : 'none'; l.vis = vis; }
    if (!vis) return;
    const w = this.el.labels.clientWidth, h = this.el.labels.clientHeight;
    l.el.style.left = ((v.x + 1) / 2) * w + 'px';
    l.el.style.top = ((1 - v.y) / 2) * h + 'px';
    if (l.text !== text) { l.el.textContent = text; l.text = text; }
    if (cls !== undefined && l.cls !== cls) { l.el.className = 'lbl ' + cls; l.cls = cls; }
  }
  hideLabel(l) {
    if (l.vis) { l.el.style.display = 'none'; l.vis = false; }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
