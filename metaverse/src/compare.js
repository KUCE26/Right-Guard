// 비교 모드 (#compare) — 비교 페이지(compare.html)의 한 칸이 되어, 부모 페이지가 보내는 명령으로만 움직인다.
// 두 칸(장치 없음 · 장치 있음)이 같은 seed로 같은 사람·차를 받고, 같은 간격으로 한 걸음씩 나아간다.
import { Schedule, SCENARIOS, ASSUME } from './schedule.js';
import { Metrics } from './metrics.js';
import { DEFAULTS } from './settings.js';

const H = 1 / 30; // 시뮬레이션 한 걸음 (초)

export function parseCompareHash(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (!h.startsWith('compare')) return null;
  const q = new URLSearchParams(h.slice('compare'.length).replace(/^[&?]/, ''));
  const num = (k, d) => (q.has(k) && Number.isFinite(+q.get(k)) ? +q.get(k) : d);
  return {
    id: q.get('id') || 'pane',
    device: num('rg', 1) ? 1 : 0,
    seed: num('seed', 7) >>> 0,
    scn: SCENARIOS[q.get('scn')] ? q.get('scn') : 'normal',
    assume: { pSelf: num('ps', ASSUME.pSelf), pObey: num('po', ASSUME.pObey), prt: num('prt', ASSUME.prt) },
    view: q.get('view') || 'corner',
    warm: num('warm', 40),
    gen: num('gen', 0),
  };
}

export function setupCompare(app, cfg, { step, draw, ctx }) {
  const { traffic, rg, signals, rig, routes, world, ui } = app;
  const root = document.getElementById('app');
  root.classList.add('compare');
  app.mode = 'compare';
  ui.setMode('compare');
  app.applySettings(DEFAULTS);
  traffic.lateWhenOff = false;
  app.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.35));

  // 운전자 시야를 가리는 것: 남동 모퉁이 주변의 건물·공사장 가림막·출입구
  ctx.occluders = world.occluders.filter((o) => o.h > 1.4 && o.x1 > -10 && o.x0 < 70 && o.z1 > -10 && o.z0 < 70);
  const metrics = new Metrics();
  app.metrics = metrics;
  let followSid = null;
  let sentEv = 0;
  let busy = false;
  let runToken = 0; // 새 장면을 시작하면 하던 '빠르게 돌리기'를 멈추기 위한 번호

  // 모든 답장에 세대 번호(gen)를 붙여, 부모가 지난 장면의 답장을 걸러낼 수 있게 함
  const post = (msg) => {
    try { window.parent.postMessage({ rgc: msg.type, id: cfg.id, gen: cfg.gen, ...msg }, '*'); } catch (e) { /* 단독으로 열림 */ }
  };

  const setDevice = (on) => {
    app.setRG(on);
    rg.group.visible = on; // 장치 없는 세계에는 기둥·LED 자체가 없음
    if (!on) for (const m of rg.markers) { m.ring.visible = false; m.ln.visible = false; }
  };

  const setView = (v) => {
    cfg.view = v;
    followSid = null;
    if (v === 'driver') { pickFollow(); return; }
    const shots = { corner: 'corner', low: 'cornerLow', crossing: 'crossing', top: 'top', wide: 'wide' };
    rig.setShot(shots[v] || 'corner', { snap: true });
  };
  // 운전자 시점: 두 칸이 같은 차를 따라가도록 '일정 번호(sid)가 가장 작은, 다가오는 우회전 차'
  const pickFollow = () => {
    let best = null;
    for (const v of traffic.vehicles) {
      if (v.route !== routes.NB_R || v.yieldS == null || v.s > v.yieldS - 8 || v.sid == null) continue;
      if (!best || v.sid < best.sid) best = v;
    }
    if (best) {
      followSid = best.sid;
      rig.setFollow(best, 'driver', { snap: true });
    } else rig.setShot('cornerLow', { snap: true });
  };
  const keepFollow = () => {
    if (cfg.view !== 'driver') return;
    const cur = traffic.vehicles.find((v) => v.sid === followSid);
    if (!cur || cur.s > cur.yieldS + 22) pickFollow();
  };

  const state = () => ({
    type: 'state',
    t: +(app.simT - metrics.t0).toFixed(2),
    led: rg.enabled ? rg.state : 'NONE',
    sigVeh: signals.veh('NS'),
    sigPed: signals.ped('E'),
    m: metrics.summary(),
    ev: (() => { const e = metrics.eventsSince(sentEv); if (e.length) sentEv = e[e.length - 1].n; return e; })(),
  });

  const init = (c) => {
    Object.assign(cfg, c);
    runToken++;
    busy = false;
    traffic.clear();
    traffic.blockRoutes = new Set();
    traffic.vehOn = true;
    traffic.pedOn = true;
    traffic.schedule = new Schedule(cfg.seed, cfg.scn, cfg.assume);
    setDevice(!!cfg.device);
    // 시계를 0으로 되돌리므로 장치의 '마지막 감지 시각'도 지움 (안 그러면 ✕가 남음)
    rg.lastVirt = rg.lastAll = -999;
    rg.state = rg.enabled ? 'GO' : 'OFF';
    rg.events = [];
    signals.frozen = false;
    signals.set('EW_G', 6);
    app.simT = 0;
    app.timeScale = 1;
    ctx.t = 0;
    // 준비 운동: 교차로에 차와 사람이 자연스럽게 찰 때까지 그리지 않고 돌림 (두 칸이 똑같이)
    const n = Math.round(cfg.warm / H);
    for (let i = 0; i < n; i++) step(H);
    // 준비 운동 동안 도착한 사람·차는 빼고 셈 — 두 세계에서 똑같은 대상을 세기 위해 '도착 번호'로 자름
    metrics.reset(app.simT, traffic.vehicles, traffic.peds, traffic.schedule.sid);
    sentEv = 0;
    setView(cfg.view);
    rig.update(1);
    draw();
    post({ type: 'ready', scn: cfg.scn, seed: cfg.seed, device: cfg.device, assume: cfg.assume });
    post(state());
  };

  const tick = (n) => {
    for (let i = 0; i < n; i++) step(H);
    keepFollow();
    draw();
    post(state());
  };

  // 빠르게 돌리기: 그리지 않고 sec초를 조각내어 돌리며 진행률을 알림
  const run = (sec) => {
    if (busy) return;
    busy = true;
    const tok = ++runToken;
    const total = Math.round(sec / H);
    let done = 0;
    const chunk = () => {
      if (tok !== runToken) return; // 그사이 새 장면이 시작됨
      const end = Math.min(total, done + 450);
      for (; done < end; done++) step(H);
      post({ type: 'progress', done, total });
      if (done < total) setTimeout(chunk, 0);
      else {
        busy = false;
        keepFollow();
        rig.update(1);
        draw();
        post(state());
        post({ type: 'ran', sec });
      }
    };
    chunk();
  };

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.rgc) return;
    switch (d.rgc) {
      case 'init': init(d.cfg || {}); break;
      case 'tick': if (!busy) tick(Math.max(0, Math.min(240, d.n | 0))); break;
      case 'run': run(Math.max(1, Math.min(7200, +d.sec || 60))); break;
      case 'view': setView(d.v); rig.update(1); draw(); break;
      case 'night': app.setNight(!!d.on); draw(); break;
      case 'state': post(state()); break;
      default: break;
    }
  });
  window.addEventListener('resize', () => draw());

  // 디버그·테스트용
  app.cmp = { init, tick, run, setView, state, metrics, H };
  init({});
}
