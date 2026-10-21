import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RG, G } from './config.js';

export function poseOf(o) {
  if (!o) return null;
  if (o.kind === 'npc') return { x: o.pos.x, z: o.pos.z, fx: o.pos.hx, fz: o.pos.hz };
  const fx = Math.sin(o.yaw), fz = Math.cos(o.yaw);
  return { x: o.x, z: o.z, fx, fz };
}

// 보문역 사거리 기준 연출 시점. 남동 모퉁이(공사장 앞) 기둥 = RG.pole
const SHOTS = {
  wide: (t) => {
    const a = 0.9 + t * 0.05;
    return { pos: [5 + Math.cos(a) * 42, 60, 5 + Math.sin(a) * 42], look: [5, 0, 4] };
  },
  device: (t) => {
    const a = 2.0 + t * 0.18;
    return { pos: [RG.pole.x + Math.cos(a) * 9, 4.4, RG.pole.z + Math.sin(a) * 9], look: [RG.pole.x + 1.6, 1.6, RG.pole.z - 2.2] };
  },
  corner: () => ({ pos: [-3, 15, 31], look: [10, 0.5, 5] }),
  cornerLow: () => ({ pos: [3, 7.5, 27], look: [11, 1.0, 5] }),
  crossing: () => ({ pos: [16.5, 7.0, 12.8], look: [9.6, 1.0, 3.8] }),
  top: () => ({ pos: [5, 66, 30], look: [5, 0, 4] }),
  link: (t) => {
    const a = 2.4 + t * 0.05;
    return { pos: [8 + Math.cos(a) * 24, 44, 5 + Math.sin(a) * 24], look: [8, 1.5, 5] };
  },
};

export class CameraRig {
  constructor(camera, dom) {
    this.cam = camera;
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.45;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 170;
    this.controls.target.set(5, 0, 4);
    this.controls.enabled = false;
    this.mode = 'cine';
    this.shot = 'wide';
    this.shotT = 0;
    this.follow = null;
    this.followKind = 'chase';
    this.pos = new THREE.Vector3(40, 44, 40);
    this.look = new THREE.Vector3(5, 0, 4);
    this.fov = 55;
    this.k = 2;
    this.custom = null;
    camera.position.copy(this.pos);
    camera.lookAt(this.look);
  }

  setShot(name, { snap = false, k = 1.8 } = {}) {
    this.mode = 'cine';
    this.controls.enabled = false;
    this.shot = name;
    this.custom = typeof name === 'function' ? name : null;
    this.shotT = 0;
    this.k = k;
    if (snap) this._snap = true;
  }

  setFollow(obj, kind = 'chase', { snap = false } = {}) {
    this.mode = 'follow';
    this.controls.enabled = false;
    this.follow = obj;
    this.followKind = kind;
    if (snap) this._snap = true;
  }

  setOrbit(target) {
    this.mode = 'orbit';
    if (target) this.controls.target.copy(target);
    else this.controls.target.copy(this.look);
    this.controls.enabled = true;
    this.cam.position.copy(this.pos);
    this.fovTarget = 55;
  }

  update(dt) {
    this.shotT += dt;
    // 운전석 시점이 아니면 실내를 걷고 숨겨 둔 차를 다시 보이게
    if (this.cockpit && this.cockpit.active && !(this.mode === 'follow' && this.followKind === 'driver')) this.cockpit.release();
    let wantPos = null, wantLook = null, fov = 55, k = this.k;
    if (this.mode === 'orbit') {
      this.controls.update();
      this.pos.copy(this.cam.position);
      this.look.copy(this.controls.target);
      this._fov(55, dt);
      return;
    }
    if (this.mode === 'cine') {
      const s = this.custom ? this.custom(this.shotT) : SHOTS[this.shot](this.shotT);
      wantPos = new THREE.Vector3(...s.pos);
      wantLook = new THREE.Vector3(...s.look);
      fov = s.fov || 55;
    } else if (this.mode === 'follow') {
      const p = poseOf(this.follow);
      if (!p) return;
      // 운전석 시점: 차 안 운전자 눈 위치에 고정 (실내는 real/cockpit.js 가 겹쳐 그림)
      if (this.followKind === 'driver' && this.cockpit && this.cockpit.place(this.follow, this.cam, dt, p)) {
        this.pos.copy(this.cam.position);
        this.look.copy(this.cockpit.lookPoint);
        this._fov(this.cockpit.fov, dt);
        this._snap = false;
        return;
      }
      const rx = -p.fz, rz = p.fx; // 오른쪽
      if (this.followKind === 'driver') {
        // 보닛 위 시점 (지붕에 가리지 않게 앞유리 바로 앞)
        wantPos = new THREE.Vector3(p.x + p.fx * 1.55 - rx * 0.3, 1.38, p.z + p.fz * 1.55 - rz * 0.3);
        wantLook = new THREE.Vector3(wantPos.x + p.fx * 10 + rx * 3.0, 1.55, wantPos.z + p.fz * 10 + rz * 3.0);
        fov = 70;
        k = 14;
      } else if (this.followKind === 'side') {
        wantPos = new THREE.Vector3(p.x - p.fx * 3 + rx * 9, 5.5, p.z - p.fz * 3 + rz * 9);
        wantLook = new THREE.Vector3(p.x + p.fx * 4, 1, p.z + p.fz * 4);
        fov = 55;
        k = 3;
      } else {
        // 가로수에 가리지 않게 살짝 도로 안쪽(왼쪽)·위에서 따라감
        wantPos = new THREE.Vector3(p.x - p.fx * 8.2 - rx * 1.4, 4.1, p.z - p.fz * 8.2 - rz * 1.4);
        wantLook = new THREE.Vector3(p.x + p.fx * 6 - rx * 0.3, 1.1, p.z + p.fz * 6 - rz * 0.3);
        fov = 58;
        k = 4.5;
      }
    }
    if (this._snap) {
      this.pos.copy(wantPos);
      this.look.copy(wantLook);
      this._snap = false;
    } else {
      const a = 1 - Math.exp(-k * dt);
      this.pos.lerp(wantPos, a);
      this.look.lerp(wantLook, a);
    }
    this.cam.position.copy(this.pos);
    this.cam.lookAt(this.look);
    this._fov(fov, dt);
  }

  _fov(f, dt) {
    const nf = this.cam.fov + (f - this.cam.fov) * (1 - Math.exp(-4 * dt));
    if (Math.abs(nf - this.cam.fov) > 0.01) {
      this.cam.fov = nf;
      this.cam.updateProjectionMatrix();
    }
  }
}
