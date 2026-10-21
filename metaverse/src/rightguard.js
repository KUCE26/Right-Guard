import * as THREE from 'three';
import { G, RG, PAL, angleWrap, radarSeesHeight, radarBand } from './config.js';
import { PED } from './pedestrians.js';
import { drawMatrix } from './ledmatrix.js';
import { radialTexture, FONT_DISPLAY } from './textures.js';

// 가상 Right Guard 장치 = 실제 장치의 디지털 트윈
// LD2450 레이더(부채꼴 감지) → 판단(1초 안전 지연) → 32×16 LED (→ / ✕)
// 감지 거리·각도·조준·설치 높이·기울기·상하각은 조절 패널에서 바꿀 수 있다 (rebuildSensor).
// 판단은 보행 신호와 함께 본다 (신호 제어기 연동을 가정):
//   보행 녹색(점멸 전) — 모퉁이에 있는 사람은 건너려는 사람으로 보고 ✕
//   점멸·적색        — 차도(횡단보도) 위에 있거나 차도로 뛰어드는 사람만 ✕, 인도에서 기다리는 사람은 →
export class RightGuard {
  constructor(scene) {
    this.scene = scene;
    this.enabled = true;
    this.state = 'GO'; // 화면 속 최종 판단 (가상+현실)
    this.metaState = 'GO'; // 실제 장치로 보내는 판단 (가상 보행자 기준)
    this.virtualDetected = false;
    this.realDetected = false;
    this.targets = [];
    this.pedSig = 'W';
    this.waiting = false;
    this.lastVirt = -999;
    this.lastAll = -999;
    this.holdLeft = 0;
    this.pattern = null;
    this.highlight = false;
    this.events = [];
    this._build();
    this._setPattern('ARROW');
  }

  _build() {
    const { pole } = RG;
    const base = G.CURB_H;
    const grp = new THREE.Group();
    grp.position.set(pole.x, base, pole.z);
    this.group = grp;
    this.scene.add(grp);
    const metal = new THREE.MeshStandardMaterial({ color: 0x8c9196, roughness: 0.45, metalness: 0.6 });
    const poleM = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.095, 3.75, 12), metal);
    poleM.position.y = 1.875;
    poleM.castShadow = true;
    grp.add(poleM);
    // 크림슨 띠 (Right Guard 식별)
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.32, 12), new THREE.MeshStandardMaterial({ color: PAL.crimson, roughness: 0.5 }));
    band.position.y = 2.15;
    grp.add(band);
    this.poleMesh = poleM;
    this.bandMesh = band;

    // LED 패널
    const ledG = new THREE.Group();
    ledG.rotation.y = RG.ledFace;
    ledG.position.y = RG.ledHeight;
    grp.add(ledG);
    const frame = new THREE.Mesh(new THREE.BoxGeometry(RG.ledW + 0.1, RG.ledH + 0.1, 0.1), new THREE.MeshStandardMaterial({ color: 0x15161a, roughness: 0.7 }));
    frame.position.z = 0.16;
    frame.castShadow = true;
    ledG.add(frame);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 0.2), metal);
    arm.position.z = 0.06;
    ledG.add(arm);
    this.ledCanvas = document.createElement('canvas');
    this.ledCanvas.width = 512;
    this.ledCanvas.height = 256;
    this.ledTex = new THREE.CanvasTexture(this.ledCanvas);
    this.ledTex.colorSpace = THREE.SRGBColorSpace;
    this.ledTex.anisotropy = 8;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(RG.ledW, RG.ledH), new THREE.MeshBasicMaterial({ map: this.ledTex, toneMapped: false }));
    face.position.z = 0.215;
    ledG.add(face);
    this.ledFace = face;
    // 명판
    const plateC = document.createElement('canvas');
    plateC.width = 512;
    plateC.height = 80;
    const pg = plateC.getContext('2d');
    pg.fillStyle = '#910023';
    pg.fillRect(0, 0, 512, 80);
    pg.fillStyle = '#E7DECE';
    pg.font = `40px ${FONT_DISPLAY}`;
    pg.textAlign = 'center';
    pg.textBaseline = 'middle';
    pg.fillText('RIGHT GUARD', 256, 42, 480);
    const plateT = new THREE.CanvasTexture(plateC);
    plateT.colorSpace = THREE.SRGBColorSpace;
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(RG.ledW, 0.25), new THREE.MeshBasicMaterial({ map: plateT }));
    plate.position.set(0, -RG.ledH / 2 - 0.2, 0.2);
    ledG.add(plate);
    this.plate = plate;
    this.ledSpot = 'corner';
    // 발광 효과
    this.glowTex = radialTexture('rgba(255,255,255,1)', 'rgba(255,255,255,0)');
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0x22ff88, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.35 }));
    this.glow.scale.set(3.2, 2.0, 1);
    this.glow.position.set(0, 0, 0.5);
    ledG.add(this.glow);
    this.ledLight = new THREE.PointLight(0x22ff88, 0, 9, 1.8);
    this.ledLight.position.set(0, 0, 0.9);
    ledG.add(this.ledLight);
    this.ledGroup = ledG;

    // 레이더 (LD2450 케이스) — 조준(yaw) 후 아래로 기울임(pitch)
    const radar = new THREE.Group();
    radar.rotation.order = 'YXZ';
    const caseM = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.15, 0.08), new THREE.MeshStandardMaterial({ color: 0xece6da, roughness: 0.5 }));
    caseM.position.z = 0.12;
    const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.09), new THREE.MeshStandardMaterial({ color: 0x1c1f24, roughness: 0.3 }));
    lens.position.z = 0.161;
    this.radarLamp = new THREE.MeshBasicMaterial({ color: 0x22ff88, toneMapped: false });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 6), this.radarLamp);
    lamp.position.set(0.075, 0.05, 0.165);
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.1), metal);
    bracket.position.z = 0.04;
    radar.add(caseM, lens, lamp, bracket);
    grp.add(radar);
    this.radar = radar;

    // 감지 부채꼴 (바닥) · 외곽선 · 거리 링 · 스캔 빔 — rebuildSensor()가 만든다
    this.fanMat = new THREE.MeshBasicMaterial({ color: 0x1fa65a, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.NormalBlending, side: THREE.DoubleSide });
    this.kidMat = new THREE.MeshBasicMaterial({ color: 0xf4a823, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide });
    this.lineMat = new THREE.LineBasicMaterial({ color: 0x8dffc0, transparent: true, opacity: 0.7 });
    this.ringMat = new THREE.LineDashedMaterial({ color: 0x8dffc0, dashSize: 0.25, gapSize: 0.18, transparent: true, opacity: 0.5 });
    this.sweepMat = new THREE.MeshBasicMaterial({ color: 0x9dffd0, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    this.sensorGroup = new THREE.Group();
    this.sensorGroup.position.y = 0.2 - base;
    grp.add(this.sensorGroup);
    this.sweepPivot = new THREE.Group();
    this.sweepPivot.position.y = 0.2 - base + 0.01;
    grp.add(this.sweepPivot);
    this.rebuildSensor();
    // 추적 표시 (최대 3명)
    this.markers = [];
    for (let i = 0; i < RG.maxTargets; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.64, 32), new THREE.MeshBasicMaterial({ color: 0xff4a3a, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2;
      ring.visible = false;
      this.scene.add(ring);
      const lg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
      const ln = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xff7a6a, transparent: true, opacity: 0.8 }));
      ln.visible = false;
      this.scene.add(ln);
      this.markers.push({ ring, ln });
    }
    // 강조 링 (이야기 모드)
    const hl = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 48), new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }));
    hl.rotation.x = -Math.PI / 2;
    hl.position.y = 0.03;
    grp.add(hl);
    this.hlRing = hl;
  }

  // RG 값(거리·각도·조준·높이·기울기·상하각)으로 부채꼴을 다시 만든다
  rebuildSensor() {
    const sg = this.sensorGroup;
    for (const o of [...sg.children, ...this.sweepPivot.children]) {
      o.parent.remove(o);
      if (o.geometry) o.geometry.dispose();
    }
    this.radar.position.y = RG.radarHeight;
    this.radar.rotation.y = Math.atan2(Math.cos(RG.aim), Math.sin(RG.aim));
    this.radar.rotation.x = -RG.pitch;
    const t0 = -(RG.aim + RG.halfFov), tl = RG.halfFov * 2;
    // 어른·아이가 실제로 잡히는 거리 구간 (설치 높이·기울기·상하 감지각 반영)
    const ad = radarBand(PED.adultH), kd = radarBand(PED.kidH);
    this.bands = { adult: ad, kid: kd };
    const inner = ad ? Math.max(0.01, ad.near) : RG.radarRange;
    const outer = ad ? Math.max(inner + 0.05, ad.far) : RG.radarRange;
    if (ad) {
      const fanGeo = new THREE.RingGeometry(inner, outer, 56, 1, t0, tl);
      fanGeo.rotateX(-Math.PI / 2);
      const fan = new THREE.Mesh(fanGeo, this.fanMat);
      fan.renderOrder = 2;
      sg.add(fan);
      this.fan = fan;
    } else this.fan = null;
    // 아이는 못 보는 가까운 구간 (주황)
    if (ad && kd && kd.near > inner + 0.05) {
      const kg = new THREE.RingGeometry(inner, Math.min(kd.near, outer), 56, 1, t0, tl);
      kg.rotateX(-Math.PI / 2);
      const km = new THREE.Mesh(kg, this.kidMat);
      km.position.y = 0.004;
      km.renderOrder = 3;
      sg.add(km);
    } else if (ad && !kd) {
      const kg = new THREE.RingGeometry(inner, outer, 56, 1, t0, tl);
      kg.rotateX(-Math.PI / 2);
      const km = new THREE.Mesh(kg, this.kidMat);
      km.position.y = 0.004;
      km.renderOrder = 3;
      sg.add(km);
    }
    // 외곽선
    const arc = (r, n = 48) => {
      const pts = [];
      for (let i = 0; i <= n; i++) {
        const a = RG.aim - RG.halfFov + (RG.halfFov * 2 * i) / n;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0.005, Math.sin(a) * r));
      }
      return pts;
    };
    const outline = [new THREE.Vector3(Math.cos(RG.aim - RG.halfFov) * inner, 0.005, Math.sin(RG.aim - RG.halfFov) * inner), ...arc(outer)];
    outline.push(new THREE.Vector3(Math.cos(RG.aim + RG.halfFov) * inner, 0.005, Math.sin(RG.aim + RG.halfFov) * inner));
    if (inner > 0.05) outline.push(...arc(inner).reverse());
    const ol = new THREE.Line(new THREE.BufferGeometry().setFromPoints(outline), this.lineMat);
    sg.add(ol);
    this.rings = [ol];
    for (const rr of [2, 4, 6]) {
      if (rr >= outer - 0.2 || rr <= inner + 0.2) continue;
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(arc(rr, 40)), this.ringMat);
      ring.computeLineDistances();
      sg.add(ring);
      this.rings.push(ring);
    }
    // 스캔 빔 (좌우로 훑음)
    const sweepGeo = new THREE.RingGeometry(inner, outer, 12, 1, 0, 0.12);
    sweepGeo.rotateX(-Math.PI / 2);
    this.sweepPivot.add(new THREE.Mesh(sweepGeo, this.sweepMat));
    this.setEnabled(this.enabled);
  }

  // LD2450 좌표계로 측정: 거리(m), 각도(°), x(좌우, m), y(전방, m)
  // h = 사람 키(m): 설치 높이·기울기·상하 감지각 때문에 너무 가까운 작은 아이는 빔 아래로 빠질 수 있다
  measure(x, z, h = PED.adultH) {
    const dx = x - RG.pole.x, dz = z - RG.pole.z;
    const dist = Math.hypot(dx, dz);
    if (dist > RG.radarRange || dist < 0.25) return null;
    const ang = angleWrap(Math.atan2(dz, dx) - RG.aim);
    if (Math.abs(ang) > RG.halfFov) return null;
    if (!radarSeesHeight(dist, h)) return null;
    return { dist, deg: (ang * 180) / Math.PI, lx: Math.sin(ang) * dist, ly: Math.cos(ang) * dist };
  }
  // LD2450 좌표(mm) → 월드 좌표
  fromSensor(xmm, ymm, mirror = false) {
    const lx = (mirror ? -xmm : xmm) / 1000, ly = ymm / 1000;
    const fx = Math.cos(RG.aim), fz = Math.sin(RG.aim);
    const rx = -fz, rz = fx; // 센서 기준 오른쪽
    return { x: RG.pole.x + fx * ly + rx * lx, z: RG.pole.z + fz * ly + rz * lx };
  }

  // 보행자 위험도 — road: 고려대로 차도(횡단보도 포함) 위 · intent: 보행 녹색에 모퉁이에 있음(건너려는 사람)
  //                dart: 차도 쪽으로 뛰어오거나 연석을 넘어섬 · wait: 점멸·적색에 인도에서 기다리거나 지나감
  risk(p, pedSig) {
    if (p.isTwin) return 'real';
    if (p.z < G.EW_HALF + 0.1) return 'road';
    if (pedSig === 'W') return 'intent';
    const dCurb = p.z - G.EW_HALF; // 연석(차도 끝)까지 거리
    const vIn = -(p.vz || 0); // 차도 쪽(북쪽)으로 움직이는 속도
    if (vIn > 1.9 && dCurb < 3.2) return 'dart';
    if (vIn > 0.3 && dCurb < 0.28) return 'dart';
    return 'wait';
  }

  setEnabled(on) {
    this.enabled = on;
    this.sensorGroup.visible = on;
    this.sweepPivot.visible = on;
    if (!on && this.markers) for (const m of this.markers) { m.ring.visible = false; m.ln.visible = false; }
  }

  // LED 위치 비교 (관제·운전 모드의 L 키): 화면 속 LED 자리만 바꾼다. 레이더·판단·운전자 반응 모델은 그대로.
  //   corner = 지금 (남동 모퉁이 기둥 · 도로면 3.2 m) · low = 같은 기둥 2.45 m · far = 건너편 끝 (북동 모퉁이 기둥 · 3.2 m)
  setLedSpot(spot) {
    if (spot === this.ledSpot) return;
    const led = this.ledGroup;
    if (spot === 'far') {
      if (!this.farPole) {
        // 처음 고를 때만 만든다 — 효과 비교·자동 시연의 난수 순서를 건드리지 않도록
        const g = new THREE.Group();
        g.position.set(RG.farPole.x, G.CURB_H, RG.farPole.z);
        g.add(this.poleMesh.clone(), this.bandMesh.clone());
        this.scene.add(g);
        this.farPole = g;
      }
      led.position.set(RG.farPole.x - RG.pole.x, RG.ledHeight, RG.farPole.z - RG.pole.z);
      led.rotation.y = RG.farFace;
    } else {
      led.position.set(0, spot === 'low' ? RG.ledLowHeight : RG.ledHeight, 0);
      led.rotation.y = RG.ledFace;
    }
    if (this.farPole) this.farPole.visible = spot === 'far';
    // 낮춘 자리에서는 이름판을 LED 위로 올려 사람 키 높이를 비워 둠
    this.plate.position.y = spot === 'low' ? RG.ledH / 2 + 0.2 : -RG.ledH / 2 - 0.2;
    this.ledSpot = spot;
  }

  _setPattern(key) {
    if (this.pattern === key) return;
    this.pattern = key;
    drawMatrix(this.ledCanvas.getContext('2d'), 512, 256, key, { offDot: '#202227' });
    this.ledTex.needsUpdate = true;
  }

  update(dt, t, peds, realDetected, night, pedSig = 'W') {
    const targets = [];
    if (this.enabled) {
      for (const p of peds) {
        if (!p.active) continue;
        const m = this.measure(p.x, p.z, p.height || PED.adultH);
        if (m) targets.push({ p, ...m, risk: this.risk(p, pedSig) });
      }
    }
    targets.sort((a, b) => a.dist - b.dist);
    this.targets = targets.slice(0, RG.maxTargets);
    this.pedSig = pedSig;
    const prevState = this.state;
    this.virtualDetected = targets.some((tg) => !tg.p.isTwin && tg.risk !== 'wait');
    this.waiting = targets.some((tg) => !tg.p.isTwin && tg.risk === 'wait');
    this.realDetected = !!realDetected;
    if (this.virtualDetected) this.lastVirt = t;
    if (this.virtualDetected || this.realDetected) this.lastAll = t;
    if (!this.enabled) {
      this.state = 'OFF';
      this.metaState = 'GO';
      this.holdLeft = 0;
    } else {
      const detNow = this.virtualDetected || this.realDetected;
      this.metaState = this.virtualDetected || t - this.lastVirt < RG.holdSec ? 'STOP' : 'GO';
      this.state = detNow || t - this.lastAll < RG.holdSec ? 'STOP' : 'GO';
      this.holdLeft = this.state === 'STOP' && !detNow ? Math.max(0, RG.holdSec - (t - this.lastAll)) : 0;
    }
    if (prevState !== this.state) this.events.push({ t, from: prevState, to: this.state });

    // LED
    this._setPattern(this.state === 'STOP' ? 'X' : this.state === 'GO' ? 'ARROW' : 'OFF');
    const col = this.state === 'STOP' ? 0xff3a2a : this.state === 'GO' ? 0x22ff88 : 0x000000;
    this.glow.material.color.setHex(col);
    this.glow.material.opacity = this.state === 'OFF' ? 0 : night ? 0.75 : 0.28 + (this.state === 'STOP' ? 0.1 * Math.sin(t * 9) : 0);
    this.ledLight.color.setHex(col);
    this.ledLight.intensity = this.state === 'OFF' ? 0 : night ? 6 : 0;
    this.radarLamp.color.setHex(!this.enabled ? 0x222222 : this.virtualDetected || this.realDetected ? 0xff3a2a : 0x22ff88);

    // 부채꼴 색
    if (this.enabled) {
      const det = this.virtualDetected || this.realDetected;
      const c = det ? 0xe23a2e : this.state === 'STOP' ? 0xf4a823 : 0x1fa65a;
      this.fanMat.color.setHex(c);
      this.fanMat.opacity = det ? 0.28 + 0.07 * Math.sin(t * 8) : 0.2;
      this.lineMat.color.setHex(det ? 0xff8a7a : 0x8dffc0);
      for (const r of this.rings.slice(1)) r.material.color.setHex(det ? 0xff8a7a : 0x8dffc0);
      // 스캔 빔: 좌우 왕복
      const sw = Math.sin(t * 1.9) * (RG.halfFov - 0.06);
      this.sweepPivot.rotation.y = -(RG.aim + sw) - 0.06;
      this.sweepMat.color.setHex(det ? 0xffb0a0 : 0x9dffd0);
    }
    // 추적 마커
    this.markers.forEach((m, i) => {
      const tg = this.targets[i];
      if (!tg || !this.enabled) { m.ring.visible = false; m.ln.visible = false; return; }
      m.ring.visible = true;
      m.ln.visible = true;
      const y = (tg.p.y || 0) + 0.05;
      m.ring.position.set(tg.p.x, y, tg.p.z);
      const s = 1 + 0.12 * Math.sin(t * 7 + i);
      m.ring.scale.set(s, s, s);
      const calm = tg.risk === 'wait';
      m.ring.material.color.setHex(tg.p.isTwin ? 0x3fd8ff : calm ? 0xf4c04a : 0xff4a3a);
      const pos = m.ln.geometry.attributes.position;
      pos.setXYZ(0, RG.pole.x, G.CURB_H + RG.radarHeight, RG.pole.z);
      pos.setXYZ(1, tg.p.x, y + (tg.p.height || 1.7) * 0.58, tg.p.z);
      pos.needsUpdate = true;
      m.ln.material.color.setHex(tg.p.isTwin ? 0x3fd8ff : calm ? 0xf4d27a : 0xff7a6a);
    });
    // 강조 링
    const hlT = this.highlight ? 0.85 : 0;
    this.hlRing.material.opacity += (hlT - this.hlRing.material.opacity) * Math.min(1, dt * 4);
    const hs = 1 + 0.25 * Math.sin(t * 4);
    this.hlRing.scale.set(hs, hs, hs);
  }
}
