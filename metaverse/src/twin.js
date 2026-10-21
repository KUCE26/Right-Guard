import { G, damp, angleWrap } from './config.js';
import { Pedestrian, HOLO } from './pedestrians.js';

// 현실 레이더(LD2450)가 감지한 사람을 메타버스에 홀로그램으로 표시
export class Twin {
  constructor(scene, rg, traffic) {
    this.rg = rg;
    // 좌표(RG:POS)가 없을 때 서 있는 곳: 고려대로 동쪽 횡단보도 남쪽 끝 (레이더 부채꼴 안)
    this.home = { x: G.WALK_X + 0.4, z: G.EW_HALF + 0.85 };
    this.p = new Pedestrian(scene, { kind: 'twin', path: [this.home, this.home], height: 1.7 });
    this.p.active = false;
    this.p.root.visible = false;
    this.p.state = 'twin';
    traffic.peds.push(this.p);
    this.fade = 0;
    this.t = 0;
    this.visible = false;
  }

  update(dt, link, show) {
    const p = this.p;
    this.t += dt;
    const now = performance.now() / 1000;
    const want = show && link.realDetected;
    let tx = this.home.x + Math.sin(this.t * 0.7) * 0.25, tz = this.home.z + Math.cos(this.t * 0.5) * 0.15;
    this.hasPos = false;
    if (link.realPos && now - link.realPosT < 1.5) {
      const w = this.rg.fromSensor(link.realPos.x, link.realPos.y, link.mirror);
      tx = w.x;
      tz = w.z;
      this.hasPos = true;
    }
    if (want && !this.visible) {
      // 처음 나타날 때는 바로 그 자리에
      p.x = tx;
      p.z = tz;
    }
    this.visible = want;
    this.fade = damp(this.fade, want ? 1 : 0, 6, dt);
    const show3d = this.fade > 0.03;
    p.root.visible = show3d;
    p.active = want; // 차량·레이더가 인식
    HOLO.opacity = 0.78 * this.fade;
    if (p.root.userData.ring) p.root.userData.ring.material.opacity = 0.85 * this.fade;
    if (!show3d) { p.vx = p.vz = 0; return; }
    const ox = p.x, oz = p.z;
    p.x = damp(p.x, tx, 5, dt);
    p.z = damp(p.z, tz, 5, dt);
    const vx = (p.x - ox) / Math.max(dt, 1e-3), vz = (p.z - oz) / Math.max(dt, 1e-3);
    const spd = Math.hypot(vx, vz);
    p.vx = vx;
    p.vz = vz;
    if (spd > 0.15) p.heading += angleWrap(Math.atan2(vx, vz) - p.heading) * Math.min(1, dt * 8);
    else p.heading += angleWrap(Math.PI - p.heading) * Math.min(1, dt * 2);
    p._animate(dt, spd > 0.15 ? spd : 0);
    p._place(dt);
    const s = 0.9 + 0.1 * this.fade;
    p.root.scale.setScalar(p.baseScale * s);
  }
}
