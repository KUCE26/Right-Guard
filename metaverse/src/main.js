import * as THREE from 'three';
import { G, RG, rand, deriveRG, radarBand } from './config.js';
import { DEFAULTS, FIELDS, loadSettings, saveSettings, fmt } from './settings.js';
import { buildWorld, updateSignalViews } from './world.js';
import { buildRoutes } from './routes.js';
import { Signals } from './signals.js';
import { RightGuard } from './rightguard.js';
import { Traffic } from './traffic.js';
import { PlayerCar } from './player.js';
import { DeviceLink } from './device.js';
import { CameraRig } from './cameras.js';
import { UI } from './ui.js';
import { Director } from './story.js';
import { Twin } from './twin.js';
import { VMAT, NIGHT, HEADMATS, setVehicleTextures, CAR } from './vehicles.js';
import { seCrossingTrip, southApproachTrip, PED } from './pedestrians.js';
import { radialTexture } from './textures.js';
import { parseCompareHash, setupCompare } from './compare.js';
import { createEnvironment, SUN_OFF } from './real/atmosphere.js';
import { createPost } from './real/post.js';
import { createCockpit } from './real/cockpit.js';

const $ = (id) => document.getElementById(id);
performance.mark('modulesLoaded');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 빛·노출 (낮: 5월 맑은 오후 / 밤)
const LOOK = {
  day: { exposure: 1.0, sun: 3.1, sunColor: 0xfff1dc, hemi: 0.18, env: 0.85, fog: 0.0027 },
  night: { exposure: 1.35, sun: 0.22, sunColor: 0x9fb4ff, hemi: 0.1, env: 1.0, fog: 0.0042 },
};
// 화질: ?q=0|1|2 (0 후처리 없음 · 1 가볍게 · 2 고화질). 비교 화면(두 칸)은 기본 1
const qParam = new URLSearchParams(location.search).get('q');

async function boot() {
  performance.mark('boot0');
  try { await Promise.race([document.fonts ? document.fonts.ready : null, sleep(1800)]); } catch (e) { /* ignore */ }
  const emblemEl = document.querySelector('.brand img');
  const deptEl = $('deptLogo');
  document.querySelector('.titlecard img').src = emblemEl.src; // 같은 엠블럼을 한 번만 싣기
  try { await Promise.all([emblemEl.decode(), deptEl.decode()]); } catch (e) { /* ignore */ }

  // ── 렌더러 / 장면
  const canvas = $('gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // 실사 톤: 색을 크게 바꾸지 않는 중립 톤 매핑 (LED ✕·→ 색이 그대로 보이도록)
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = LOOK.day.exposure;
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xc4d4e2, LOOK.day.fog);
  scene.environmentIntensity = LOOK.day.env;
  const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 1100);

  const hemi = new THREE.HemisphereLight(0xdfeaf5, 0x5a5650, LOOK.day.hemi);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, LOOK.day.sun);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -44, right: 44, top: 44, bottom: -44, near: 1, far: 260 });
  sun.shadow.bias = -0.0003;
  sun.shadow.normalBias = 0.025;
  scene.add(sun, sun.target);

  const glow = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
  setVehicleTextures(glow, radialTexture('rgba(255,240,210,0.9)', 'rgba(255,240,210,0)'));
  performance.mark('w0');
  const world = buildWorld(scene, { emblemImg: emblemEl, deptImg: deptEl });
  performance.measure('buildWorld', 'w0');
  // 환경광(반사): 정적인 세계만 한 번 찍어 둠 — 이후에 생기는 차·사람·장치는 빠짐
  const env = createEnvironment(renderer, scene, world.sky);
  env.markStatic(scene);
  sun.position.copy(SUN_OFF);
  sun.target.position.set(0, 0, 0);
  sun.updateMatrixWorld();
  sun.target.updateMatrixWorld();
  performance.mark('e0');
  env.capture();
  performance.measure('envCapture', 'e0');
  performance.mark('b1');
  const routes = buildRoutes();
  const signals = new Signals();
  const rg = new RightGuard(scene);
  const traffic = new Traffic(scene, routes);
  const player = new PlayerCar(scene, world);
  const link = new DeviceLink();
  const twin = new Twin(scene, rg, traffic);
  performance.measure('rg+traffic+player+twin', 'b1');
  const rig = new CameraRig(camera, canvas);
  const isCmp = !!parseCompareHash(location.hash);
  const startLevel = qParam != null && /^[012]$/.test(qParam) ? +qParam : isCmp ? 1 : 2;
  const post = createPost(renderer, scene, camera, { level: startLevel });
  // 운전석 시점의 실내 (핸들·계기판·필러·거울)
  const cockpit = createCockpit();
  rig.cockpit = cockpit;

  const app = {
    scene, camera, renderer, world, routes, signals, rg, traffic, player, link, rig, post, env, cockpit,
    mode: 'story', timeScale: 1, slowUntil: 0, night: false, simT: 0, realT: 0,
    stats: { turns: 0, rgStops: 0, near: 0 }, twinSuppressed: false, followNpc: null,
  };
  const ui = new UI(app);
  app.ui = ui;
  const director = new Director(app);
  app.director = director;

  // ── 조절 패널 (센서 범위 · 보행자 속도·키 · 차량) — 자동 시연은 기본값, 나머지 모드는 사용자 값
  app.settings = loadSettings();
  const tune = $('tune');
  const inputs = {}, outs = {};
  const coverageE = () => {
    // 고려대로 동쪽 횡단보도 중 레이더가 어른을 잡는 비율: 우회전 차가 지나는 남쪽 절반 / 전체
    const c = G.CW.E;
    let inH = 0, nH = 0, inA = 0, nA = 0;
    for (let x = c.x0 + 0.125; x < c.x1; x += 0.25) {
      for (let z = c.z0 + 0.125; z < c.z1; z += 0.25) {
        const ok = !!rg.measure(x, z, PED.adultH);
        nA++; if (ok) inA++;
        if (z > G.MEDIAN) { nH++; if (ok) inH++; }
      }
    }
    return { half: nH ? inH / nH : 0, all: nA ? inA / nA : 0 };
  };
  const renderTuneInfo = () => {
    if (tune.hidden) return;
    ui.drawSideView($('sideView'));
    const st = app.activeSettings || app.settings;
    const ad = radarBand(PED.adultH), kd = radarBand(PED.kidH);
    const band = (b) => (b ? `${b.near.toFixed(1)}–${b.far.toFixed(1)} m` : '감지 안 됨');
    const cov = coverageE();
    const warns = [];
    if (st.range > 6) warns.push('감지 거리가 LD2450 사양(6 m)보다 길어요.');
    if (st.hfov > 60) warns.push('좌우 감지각이 사양(±60°)보다 넓어요.');
    if (st.vfov > 35) warns.push('상하 감지각이 사양(±35°)보다 넓어요.');
    if (!ad) warns.push('이 높이·기울기로는 어른도 감지하지 못해요. 설치 높이를 낮추거나 기울기를 줄여 보세요.');
    else if (!kd || kd.near > ad.near + 0.3) warns.push(kd ? `설치가 높아 기둥 ${kd.near.toFixed(1)} m 안의 아이는 빔 아래로 빠져요. 아래로 기울여 보세요.` : '이 설치로는 아이를 감지하지 못해요.');
    if (st.hold === 0) warns.push('안전 지연이 0초면 보행자가 벗어나자마자 →로 바뀌어요.');
    if (app.mode === 'story') warns.push('지금은 자동 시연이라 기본값으로 재생 중이에요.');
    $('tuneInfo').innerHTML = `<b class="ad">어른 ${Math.round(PED.adultH * 100)} cm</b> ${band(ad)} · <b class="kd">아이 ${Math.round(PED.kidH * 100)} cm</b> ${band(kd)}<br>`
      + `고려대로 동쪽 횡단보도 감지: 차가 지나는 쪽 <b>${Math.round(cov.half * 100)}%</b> · 전체 <b>${Math.round(cov.all * 100)}%</b>`
      + warns.map((w) => `<span class="wn">${w}</span>`).join('');
  };
  const applySettings = (st) => {
    RG.radarRange = st.range;
    RG.radarHalfFov = st.hfov;
    RG.radarAimDeg = st.aim;
    RG.radarHeight = st.height;
    RG.radarTiltDeg = st.tilt;
    RG.radarVHalfFov = st.vfov;
    RG.holdSec = st.hold;
    deriveRG();
    PED.adultSpeed = st.adultSpeed;
    PED.kidSpeed = st.kidSpeed;
    PED.adultH = st.adultH / 100;
    PED.kidH = st.kidH / 100;
    CAR.kmh = st.carKmh;
    traffic.density = st.traffic;
    traffic.pedDensity = st.pedRate;
    rg.rebuildSensor();
    traffic.applyLive();
    app.activeSettings = st;
    renderTuneInfo();
  };
  app.applySettings = applySettings;
  const syncTune = () => {
    const st = app.settings;
    for (const [k] of FIELDS) {
      if (+inputs[k].value !== st[k]) inputs[k].value = st[k];
      outs[k].textContent = fmt(k, st[k]);
      outs[k].classList.toggle('warn', (k === 'range' && st.range > 6) || (k === 'hfov' && st.hfov > 60) || (k === 'vfov' && st.vfov > 35));
    }
    for (const o of document.querySelectorAll('#segTraffic button')) o.setAttribute('aria-pressed', Math.abs(+o.dataset.v - st.traffic) < 0.05 ? 'true' : 'false');
  };
  const changed = () => {
    saveSettings(app.settings);
    syncTune();
    if (app.mode !== 'story') applySettings(app.settings);
    else renderTuneInfo();
  };
  const tGroups = { sensor: $('tgSensor'), ped: $('tgPed'), car: $('tgCar') };
  for (const [k, label, min, max, step, , grp, hint] of FIELDS) {
    const row = document.createElement('label');
    row.className = 'trow';
    row.innerHTML = `<span>${label}</span><output id="o_${k}"></output><input type="range" id="s_${k}" min="${min}" max="${max}" step="${step}" aria-label="${label}">${hint ? `<small>${hint}</small>` : ''}`;
    tGroups[grp].appendChild(row);
    inputs[k] = row.querySelector('input');
    outs[k] = row.querySelector('output');
    inputs[k].value = app.settings[k];
    inputs[k].addEventListener('input', () => {
      app.settings[k] = +inputs[k].value;
      changed();
    });
  }
  syncTune();
  const setTune = (open) => {
    tune.hidden = !open;
    $('btnTune').setAttribute('aria-expanded', open ? 'true' : 'false');
    $('btnTune').setAttribute('aria-pressed', open ? 'true' : 'false');
    ui.el.sidebar.hidden = app.mode !== 'sandbox' || open;
    if (open) renderTuneInfo();
  };
  app.setTune = setTune;
  $('btnTune').onclick = () => setTune(tune.hidden);
  $('openTune').onclick = () => setTune(true);
  $('tuneClose').onclick = () => setTune(false);
  $('tuneReset').onclick = () => {
    app.settings = { ...DEFAULTS };
    changed();
  };

  app.resetWorld = (kind) => {
    traffic.clear();
    traffic.blockRoutes = new Set();
    if (kind === 'full') {
      traffic.vehOn = true;
      traffic.pedOn = $('tPeds').checked || app.mode !== 'sandbox';
      traffic.populate({ peds: traffic.pedOn });
      app.twinSuppressed = false;
    } else if (kind === 'calm') {
      traffic.vehOn = true;
      traffic.pedOn = false;
      // 장치·횡단보도 앞을 가리지 않도록 보문로 북행·고려대로 서행(동쪽 팔에서 대기하는 차) 비움
      traffic.blockRoutes = new Set(['NB_IN', 'NB_OUT', 'NB_R', 'WB_IN', 'WB_OUT', 'WB_R', 'SB_R']);
      traffic.populate({ peds: false });
      app.twinSuppressed = true;
    } else {
      traffic.vehOn = false;
      traffic.pedOn = false;
    }
  };
  app.setRG = (on) => {
    rg.setEnabled(on);
    traffic.rgEnabled = on;
    $('tRG').checked = on;
  };
  app.slowmo = (scale, dur) => {
    app.timeScale = scale;
    app.slowUntil = app.realT + dur;
  };
  app.setNight = (on) => {
    app.night = on;
    $('btnNight').setAttribute('aria-pressed', on ? 'true' : 'false');
    const L = on ? LOOK.night : LOOK.day;
    world.sky.setNight(on);
    scene.fog.color.copy(world.sky.fogColor);
    scene.fog.density = L.fog;
    hemi.intensity = L.hemi;
    hemi.color.setHex(on ? 0x7a8cc0 : 0xdfeaf5);
    sun.intensity = L.sun;
    sun.color.setHex(L.sunColor);
    renderer.toneMappingExposure = L.exposure;
    for (const m of world.night.windowMats) m.emissiveIntensity = on ? 0.8 : 0;
    for (const m of world.night.lampMats) m.emissiveIntensity = on ? 3 : 0;
    for (const m of world.night.emissiveSigns) m.emissiveIntensity = on ? 0.85 : 0.05;
    for (const s of world.night.glowSprites) s.visible = on;
    for (const l of world.night.pointLights) l.intensity = on ? 70 : 0;
    VMAT.head.emissiveIntensity = on ? 2.4 : 0.25;
    for (const m of HEADMATS) m.emissiveIntensity = on ? 2.4 : 0.25;
    NIGHT.on = on;
    for (const g of NIGHT.registry) g.userData.fx.visible = on;
    post.setNight(on);
    cockpit.setNight(on);
    // 반사·간접광도 밤 세계로 다시 찍음
    const look = rig.look;
    sun.position.copy(SUN_OFF); sun.target.position.set(0, 0, 0);
    sun.updateMatrixWorld(); sun.target.updateMatrixWorld();
    scene.environmentIntensity = L.env;
    env.capture();
    sun.position.copy(look).add(SUN_OFF); sun.target.position.copy(look);
  };

  // ── 모드 전환
  const setMode = (mode) => {
    if (app.mode === 'story' && mode !== 'story') {
      director.stop();
      app.setRG(true); // 자동 시연 중 꺼 둔 장치를 다시 켬
    }
    if (app.mode === 'drive' && mode !== 'drive') player.setActive(false);
    app.mode = mode;
    app.followNpc = null;
    ui.setMode(mode);
    for (const b of document.querySelectorAll('[data-view], [data-tune]')) b.hidden = mode === 'story';
    if (mode === 'story') setTune(false);
    else ui.el.sidebar.hidden = mode !== 'sandbox' || !tune.hidden;
    applySettings(mode === 'story' ? DEFAULTS : app.settings);
    app.timeScale = 1;
    if (mode === 'story') {
      director.start();
    } else if (mode === 'drive') {
      signals.frozen = false;
      app.resetWorld('full');
      player.setActive(true);
      clearAroundPlayer();
      rig.setFollow(player, 'chase', { snap: true });
    } else {
      signals.frozen = $('tHold').checked;
      if (signals.frozen) signals.set('NS_G', 2);
      app.resetWorld('full');
      rig.setShot('corner', { k: 2 });
    }
  };
  app.setMode = setMode;
  const clearAroundPlayer = () => {
    traffic.vehicles = traffic.vehicles.filter((v) => {
      const near = Math.hypot(v.pos.x - player.x, v.pos.z - player.z) < 16;
      if (near) v.dispose();
      return !near;
    });
  };

  // ── 관제 모드 동작
  const sendPed = (kind = 'adult', from = 'se') => {
    if (app.mode !== 'sandbox') setMode('sandbox');
    let path;
    if (from === 'north') {
      const ox = rand(-0.6, 0.8);
      path = [
        { x: G.WALK_X + ox, z: -(G.WALK_Z + 12) }, { x: G.WALK_X + ox, z: -(G.EW_HALF + 0.35), cross: 'E' },
        { x: G.WALK_X + ox, z: G.EW_HALF + 0.35, leave: true }, { x: G.WALK_X + ox, z: G.WALK_Z + 0.3 }, { x: G.WALK_X + ox, z: 40 },
      ];
    } else if (Math.random() < 0.5 || kind === 'kid') {
      path = seCrossingTrip({ fromX: rand(15, 19), ox: rand(-0.5, 0.8), oz: rand(-0.2, 0.7) });
    } else {
      path = southApproachTrip({ fromZ: rand(G.WALK_Z + 7, G.WALK_Z + 13), ox: rand(-0.5, 0.8) });
    }
    traffic.spawnPed({ kind, path });
  };
  $('sendPed').onclick = () => sendPed('adult');
  $('sendKid').onclick = () => sendPed('kid');
  $('sendNorth').onclick = () => sendPed('adult', 'north');
  $('tRG').onchange = (e) => app.setRG(e.target.checked);
  $('tHold').onchange = (e) => {
    signals.frozen = e.target.checked;
    if (e.target.checked) signals.set('NS_G', 2);
  };
  $('tPeds').onchange = (e) => { traffic.pedOn = e.target.checked; };
  for (const b of document.querySelectorAll('#segTraffic button')) {
    b.onclick = () => {
      app.settings.traffic = +b.dataset.v;
      app.settings.pedRate = +b.dataset.v;
      changed();
    };
  }
  for (const b of document.querySelectorAll('.modes button')) b.onclick = () => setMode(b.dataset.mode);
  $('capSkip').onclick = () => director.skip();

  // 시점 버튼
  for (const b of document.querySelectorAll('[data-view]')) {
    b.onclick = () => {
      const v = b.dataset.view;
      if (app.mode === 'drive') {
        rig.setFollow(player, v === 'driver' ? 'driver' : 'chase');
        if (v === 'top') rig.setShot(() => ({ pos: [player.x, 55, player.z + 20], look: [player.x, 0, player.z] }), { k: 3 });
        if (v === 'corner') rig.setShot('cornerLow', { k: 2 });
        return;
      }
      app.followNpc = null;
      if (v === 'drone') rig.setShot('wide', { k: 1.6 });
      else if (v === 'corner') rig.setShot('corner', { k: 2 });
      else if (v === 'top') rig.setShot('top', { k: 2 });
      else if (v === 'driver') {
        let car = traffic.vehicles.find((c) => c.route.name === 'NB_R' && c.s < c.yieldS - 12);
        if (!car) car = traffic.spawnVehicle('NB_R', { s: routes.NB_R.stopFrontS - 40, v: 8 });
        app.followNpc = car;
        rig.setFollow(car, 'driver');
      }
    };
  }
  // 관제 모드: 드래그하면 자유 시점
  canvas.addEventListener('pointerdown', () => {
    if (app.mode === 'sandbox' && rig.mode !== 'orbit') {
      app.followNpc = null;
      rig.setOrbit();
    }
  }, { capture: true });

  $('btnNight').onclick = () => app.setNight(!app.night);
  // 그래픽 품질: 고화질(그림자·AO·블룸) → 보통(AO 끔) → 가볍게(후처리 끔)
  const Q_LABEL = ['가볍게', '보통', '고화질'];
  app.setQuality = (l, manual = true) => {
    post.setLevel(l);
    $('btnQuality').textContent = Q_LABEL[l];
    if (manual) app.qualityManual = true;
  };
  $('btnQuality').textContent = Q_LABEL[post.level];
  $('btnQuality').onclick = () => app.setQuality((post.level + 2) % 3);
  $('btnHud').onclick = () => $('app').classList.toggle('hud-hidden');
  $('hudRestore').onclick = () => $('app').classList.remove('hud-hidden');
  const toggleFullscreen = () => {
    try {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    } catch (e) { /* 지원 안 함 */ }
  };

  // ── 장치 패널
  const devErr = {
    UNSUPPORTED: '이 브라우저는 USB 장치 연결(Web Serial)을 지원하지 않아요. Chrome 또는 Edge에서 이 파일을 열어 주세요.',
    BLOCKED: '미리보기 화면에서는 USB 연결이 막혀 있어요. 내려받은 HTML 파일을 Chrome에서 열면 연결됩니다.',
    BUSY: '포트를 열 수 없어요. Arduino IDE의 시리얼 모니터처럼 같은 포트를 쓰는 프로그램을 닫고 다시 시도하세요.',
  };
  $('devConnect').onclick = async () => {
    ui.deviceMessage('');
    if (link.connected) { await link.disconnect(); return; }
    try {
      await link.connect();
    } catch (e) {
      const m = devErr[e.message];
      if (m) ui.deviceMessage(m);
    }
  };
  if (!link.supported) ui.deviceMessage(devErr.UNSUPPORTED);
  else if (!link.policyOK) ui.deviceMessage(devErr.BLOCKED);
  $('dMode').onchange = (e) => link.setMode(e.target.value);
  $('tTwin').onchange = (e) => { link.twinOn = e.target.checked; };
  $('devHelp').onclick = () => { $('help').hidden = false; $('helpClose').focus(); };
  $('helpClose').onclick = () => { $('help').hidden = true; };
  $('help').onclick = (e) => { if (e.target.id === 'help') $('help').hidden = true; };
  $('devLogBtn').onclick = () => {
    const box = $('devLog');
    box.hidden = !box.hidden;
    $('devLogBtn').setAttribute('aria-expanded', box.hidden ? 'false' : 'true');
    ui.renderLog(link);
  };
  $('devMin').onclick = () => {
    const d = $('device');
    d.classList.toggle('min');
    $('devMin').textContent = d.classList.contains('min') ? '펼치기' : '접기';
  };
  if (window.matchMedia && matchMedia('(max-width: 860px)').matches) {
    $('device').classList.add('min');
    $('devMin').textContent = '펼치기';
  }
  link.on((type) => {
    if (type === 'log') ui.renderLog(link);
    if (type === 'status' && link.connected) ui.deviceMessage('');
  });

  // ── 키보드 / 터치
  const DRIVE_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space'];
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'SELECT' || e.target.tagName === 'INPUT')) return;
    if (app.mode === 'drive' && DRIVE_KEYS.includes(e.code)) {
      player.keys[e.code] = true;
      e.preventDefault();
      return;
    }
    // 운전석 시점에서 고개 돌리기 (누르고 있는 동안)
    if (e.code === 'KeyQ' || e.code === 'KeyE') { cockpit.look = e.code === 'KeyQ' ? -1 : 1; return; }
    if (e.repeat) return;
    switch (e.code) {
      case 'Digit1': setMode('story'); break;
      case 'Digit2': setMode('drive'); break;
      case 'Digit3': setMode('sandbox'); break;
      case 'KeyP': sendPed('adult'); break;
      case 'KeyK': sendPed('kid'); break;
      case 'KeyG': app.setRG(!rg.enabled); break;
      case 'KeyN': app.setNight(!app.night); break;
      case 'KeyH': $('app').classList.toggle('hud-hidden'); break;
      case 'KeyF': toggleFullscreen(); break;
      case 'KeyC': if (app.mode === 'drive') rig.setFollow(player, rig.followKind === 'driver' ? 'chase' : 'driver'); break;
      case 'KeyR': if (app.mode === 'drive') restartDrive(); break;
      case 'Escape': $('help').hidden = true; break;
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => {
    player.keys[e.code] = false;
    if ((e.code === 'KeyQ' && cockpit.look < 0) || (e.code === 'KeyE' && cockpit.look > 0)) cockpit.look = 0;
  });
  window.addEventListener('blur', () => { player.keys = {}; cockpit.look = 0; });
  const isTouch = 'ontouchstart' in window || (window.matchMedia && matchMedia('(pointer: coarse)').matches);
  if (isTouch) $('app').classList.add('is-touch');
  for (const b of document.querySelectorAll('#touch button')) {
    const k = b.dataset.k;
    const on = (e) => { e.preventDefault(); player.keys[k] = true; };
    const off = (e) => { e.preventDefault(); player.keys[k] = false; };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointerleave', off);
    b.addEventListener('pointercancel', off);
  }

  const restartDrive = () => {
    player.reset();
    clearAroundPlayer();
    rig.setFollow(player, rig.followKind === 'driver' ? 'driver' : 'chase', { snap: true });
  };

  // ── 크기
  const resize = () => {
    const w = canvas.clientWidth || window.innerWidth, h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    post.setSize(w, h);
  };
  window.addEventListener('resize', resize);
  resize();

  // ── 시작 모드 (#drive / #sandbox 로 바로 열기 · #compare 는 비교 페이지의 한 칸)
  const hash = (location.hash || '').replace('#', '');
  const cmpCfg = parseCompareHash(location.hash);
  performance.mark('m0');
  if (!cmpCfg) setMode(hash === 'drive' ? 'drive' : hash === 'sandbox' ? 'sandbox' : 'story');
  performance.measure('setMode', 'm0');

  // ── 메인 루프
  const ctx = { signals, rg, player, t: 0, vehicles: [], peds: [] };
  ctx.onNearMiss = (v) => {
    if (v.driver !== 'late') return;
    if (app.mode === 'sandbox') {
      app.stats.near++;
      ui.flash('danger', '아찔한 순간!', 'Right Guard가 꺼져 있어 운전자가 가림막 앞 보행자를 늦게 발견했어요');
    }
  };
  const ledLabel = ui.label('led', 'dev'), radarLabel = ui.label('radar', 'dev'), twinLabel = ui.label('twin', 'cyan');
  const tLabels = [ui.label('t0'), ui.label('t1'), ui.label('t2')];
  const ledPos = new THREE.Vector3();
  scene.updateMatrixWorld(true);
  rg.ledFace.getWorldPosition(ledPos);
  let last = performance.now(), frameN = 0, hiddenLoading = false;

  // 느린 노트북에서는 해상도 → AO → 그림자 → 후처리 순으로 자동으로 낮춤 (?q= 로 고정하면 그대로)
  let perfAcc = 0, perfN = 0, perfStep = 0;
  const adaptQuality = (rawDt) => {
    if (qParam != null || app.qualityManual || document.hidden || rawDt > 0.25) return;
    perfAcc += rawDt; perfN++;
    if (perfN < 90) return;
    const avg = perfAcc / perfN;
    perfAcc = 0; perfN = 0;
    if (avg < 0.028) return;
    if (perfStep === 0 && renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); resize(); perfStep = 1; return; }
    if (perfStep <= 1 && post.level >= 2) { app.setQuality(1, false); perfStep = 2; return; }
    if (perfStep <= 2) { sun.shadow.mapSize.set(1024, 1024); if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; } perfStep = 3; return; }
    if (perfStep <= 3 && post.level >= 1 && avg > 0.034) { app.setQuality(0, false); perfStep = 4; }
  };
  function frame(now) {
    // 디버그·화면 찍기용 일시 정지 (__RG.paused = true 이면 advance()로만 진행)
    if (app.paused) { last = now; requestAnimationFrame(frame); return; }
    const raw = Math.max(0, (now - last) / 1000);
    const rdt = Math.min(0.05, raw);
    last = now;
    step(rdt);
    draw();
    adaptQuality(raw);
    requestAnimationFrame(frame);
  }
  function step(rdt) {
    app.realT += rdt;
    if (app.slowUntil && app.realT > app.slowUntil) { app.timeScale = 1; app.slowUntil = 0; }
    const dt = rdt * app.timeScale;
    app.simT += dt;
    ctx.t = app.simT;

    signals.update(dt);
    link.tick();
    const useReal = link.connected && link.mode !== 'META';
    twin.update(dt, link, useReal && link.twinOn && !app.twinSuppressed);
    traffic.update(dt, ctx);
    player.update(dt, ctx);
    rg.update(dt, app.simT, traffic.peds, useReal && !app.twinSuppressed ? link.realDetected : false, app.night, signals.ped('E'));
    if (app.metrics) app.metrics.update(dt, app.simT, { signals, rg, peds: traffic.peds, vehicles: traffic.vehicles });
    link.setMeta(rg.metaState);
    director.update(rdt);

    // 통계
    for (const v of traffic.vehicles) {
      if (!v.route.rg) continue;
      if (!v._counted && v.s > v.yieldS) { v._counted = true; app.stats.turns++; }
      if (!v._rgStop && v.reason === 'rg' && v.v < 0.1) { v._rgStop = true; app.stats.rgStops++; }
    }
    // 운전 모드 이벤트
    if (app.mode === 'drive') {
      for (const ev of player.events.splice(0)) {
        if (ev.kind === 'restart') restartDrive();
        else ui.flash(ev.kind === 'ok' ? 'ok' : ev.kind, ev.title, ev.sub, 2.6);
      }
      const fz = player.front.z;
      if (!player.scenarioSpawned && fz < G.STOP.NB + 30 && fz > G.STOP.NB + 4 && player.trial && !player.trial.judged) {
        player.scenarioSpawned = true;
        const kid = Math.random() < 0.35;
        traffic.spawnPed({ kind: kid ? 'kid' : 'adult', path: Math.random() < 0.6 ? seCrossingTrip({ fromX: rand(15, 20), ox: rand(-0.4, 0.8), oz: rand(-0.2, 0.6) }) : southApproachTrip({ fromZ: rand(G.WALK_Z + 6, G.WALK_Z + 12) }) });
      }
      $('spd').textContent = Math.round(Math.abs(player.v) * 3.6);
      $('scOk').textContent = player.stats.ok;
      $('scBad').textContent = player.stats.bad;
    }
    if (app.followNpc && (app.followNpc.dead || !traffic.vehicles.includes(app.followNpc))) {
      app.followNpc = null;
      if (app.mode === 'sandbox') rig.setShot('corner', { k: 1.5 });
    }

    rig.update(rdt);
  }
  function draw() {
    // 표시 갱신
    updateSignalViews(world, signals, app.simT);
    const look = rig.look;
    sun.position.copy(look).add(SUN_OFF);
    sun.target.position.copy(look);
    ui.updateVerdict(rg, link);
    ui.updateDevice(link, rg);
    ui.updateSignals(signals, app.simT);
    const cmp = app.mode === 'compare';
    if (!cmp && frameN % 2 === 0) ui.drawMinimap(app);
    if (app.mode === 'sandbox') {
      $('stTurns').textContent = app.stats.turns;
      $('stStops').textContent = app.stats.rgStops;
      $('stNear').textContent = app.stats.near;
    }
    // 라벨
    const showTg = app.mode !== 'drive' && !(rig.mode === 'follow' && rig.followKind === 'driver') && ui.el.title.dataset.on !== 'true';
    const showDev = showTg && !cmp;
    if (showDev) {
      ui.placeLabel(ledLabel, camera, ledPos.x, ledPos.y + 0.75, ledPos.z, 'Right Guard LED');
      ui.placeLabel(radarLabel, camera, RG.pole.x, G.CURB_H + RG.radarHeight + 0.35, RG.pole.z, rg.enabled ? '레이더 · LD2450' : '레이더 꺼짐');
    } else { ui.hideLabel(ledLabel); ui.hideLabel(radarLabel); }
    tLabels.forEach((l, i) => {
      const tg = rg.targets[i];
      if (!tg || !showTg) { ui.hideLabel(l); return; }
      const h = (tg.p.height || 1.7) + 0.35;
      const calm = !tg.p.isTwin && tg.risk === 'wait';
      const text = tg.p.isTwin ? `현실 보행자 · ${tg.dist.toFixed(1)} m` : `T${i + 1}${calm ? ' · 대기' : ''} · ${tg.dist.toFixed(1)} m`;
      ui.placeLabel(l, camera, tg.p.x, tg.p.y + h, tg.p.z, text, tg.p.isTwin ? 'cyan' : calm ? 'amber' : 'red');
    });
    if (twin.visible && !rg.targets.some((t) => t.p.isTwin)) {
      ui.placeLabel(twinLabel, camera, twin.p.x, twin.p.y + 2.1, twin.p.z, twin.hasPos ? '현실 보행자 (LD2450)' : '현실 보행자 감지');
    } else ui.hideLabel(twinLabel);

    // 운전석 시점: 거울 갱신 + 실내를 세상 위에 겹쳐 그리기
    if (cockpit.active) {
      cockpit.beforeRender(renderer, scene, camera, post.level);
      post.setOverlay(cockpit.scene, cockpit.cam);
    } else post.setOverlay(null);
    world.sky.update(app.realT, camera.position);
    if (world.treeField) world.treeField.update(camera.position);
    post.render();
    frameN++;
    if (!hiddenLoading && frameN > 2) { $('loading').classList.add('done'); hiddenLoading = true; }
  }
  if (cmpCfg) {
    // 비교 페이지의 한 칸: 스스로 돌지 않고 부모 페이지의 명령으로만 한 걸음씩
    setupCompare(app, cmpCfg, { step, draw, ctx });
  } else {
    requestAnimationFrame(frame);
    // 탭이 잠시 가려져도 장치에 1초 하트비트가 끊기지 않게
    setInterval(() => link.tick(), 500);
  }
  // 디버그·테스트용: 시뮬레이션 빨리 감기
  app.advance = (sec, h = 1 / 30, render = true) => {
    for (let k = 0; k < Math.round(sec / h); k++) step(h);
    if (render) draw();
  };
  app.G = G;
  app.RGc = RG;
  window.__RG = app;
  performance.measure('bootTotal', 'boot0');
}

boot().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) l.innerHTML = '<div class="in"><b>RIGHT GUARD</b>3D 화면을 시작하지 못했어요. 그래픽 가속(WebGL)이 켜진 Chrome·Edge에서 다시 열어 주세요.</div>';
});
