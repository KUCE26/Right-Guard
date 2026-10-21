// 운전석 시점 — 경차 운전석 사진(대시보드·계기판·핸들·A필러·룸미러·사이드미러·문)을 바탕으로 만든 실내.
// 세상 장면을 그린 다음 깊이를 지우고 실내를 겹쳐 그린다(실내가 바깥 물체에 잘리거나 묻히지 않게).
// 룸미러·사이드미러에는 뒤쪽 장면을 작은 화면으로 실제로 찍어 비춘다.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { SUN_OFF } from './atmosphere.js';

// 차 기준 좌표: x = 왼쪽(+), y = 위, z = 앞. 운전석은 왼쪽.
const EYE = new THREE.Vector3(0.37, 1.16, -0.12);
const LIFT = { sedan: 0, taxi: 0, suv: 0.16, truck: 0.34, bus: 0.9 };
const PITCH = -0.1; // 도로를 살짝 내려다봄
const FOV = 64;
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const deg = Math.PI / 180;

function std(color, roughness, metalness = 0, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
}
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}
function tex(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
// 로컬 +Z 가 dir 을 보도록 (+Y 는 위쪽 유지)
function faceDir(obj, dir) {
  const m = new THREE.Matrix4().lookAt(V(0, 0, 0), dir.clone().normalize().negate(), V(0, 1, 0));
  obj.quaternion.setFromRotationMatrix(m);
}
function at(g, x, y, z, rx = 0, ry = 0, rz = 0) {
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ')));
  g.translate(x, y, z);
  return g.index ? g.toNonIndexed() : g;
}
function rbox(w, h, d, r, x, y, z, rx = 0, ry = 0, rz = 0) {
  const g = new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  return at(g, x, y, z, rx, ry, rz);
}
function box(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
  return at(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
}
function cyl(rt, rb, h, x, y, z, rx = 0, ry = 0, rz = 0, seg = 20) {
  return at(new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, rx, ry, rz);
}
// 두 점 사이 둥근 막대 (필러·문틀)
function beam(a, b, w, d, r = 0.02) {
  const dir = b.clone().sub(a);
  const len = dir.length();
  const g = new RoundedBoxGeometry(w, len, d, 3, Math.min(r, w / 2 - 1e-3, d / 2 - 1e-3));
  const q = new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), dir.normalize());
  g.applyQuaternion(q);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g.index ? g.toNonIndexed() : g;
}
function strip(geos) {
  // 병합 전에 속성 맞추기 (position·normal·uv)
  return geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k);
    if (!n.attributes.uv) n.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n.attributes.position.count * 2), 2));
    return n;
  });
}

// ── 계기판 (속도계·회전계)
function dialTexture(kind) {
  const S = 512;
  const [c, g] = canvas(S, S);
  const cx = S / 2, cy = S / 2, R = S * 0.48;
  const grd = g.createRadialGradient(cx, cy, 20, cx, cy, R);
  grd.addColorStop(0, '#1a1c1f');
  grd.addColorStop(1, '#0a0b0d');
  g.fillStyle = grd;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  g.lineWidth = 10; g.strokeStyle = '#6a6e73';
  g.beginPath(); g.arc(cx, cy, R - 5, 0, Math.PI * 2); g.stroke();
  const max = kind === 'speed' ? 200 : 8;
  const ang = (v) => Math.PI * 0.75 + Math.PI * 1.5 * (v / max);
  if (kind === 'rpm') {
    // 바깥 초록 띠 + 빨간 구간
    g.lineWidth = 7; g.strokeStyle = '#3fbf74';
    g.beginPath(); g.arc(cx, cy, R * 0.86, ang(0), ang(6.5)); g.stroke();
    g.lineWidth = 16; g.strokeStyle = '#c8261b';
    g.beginPath(); g.arc(cx, cy, R * 0.8, ang(6.5), ang(8)); g.stroke();
  } else {
    g.lineWidth = 5; g.strokeStyle = '#3fbf74';
    g.beginPath(); g.arc(cx, cy, R * 0.86, ang(0), ang(200)); g.stroke();
  }
  const step = kind === 'speed' ? 10 : 0.5;
  for (let v = 0; v <= max + 1e-6; v += step) {
    const a = ang(v);
    const major = kind === 'speed' ? v % 20 === 0 : Math.abs(v - Math.round(v)) < 1e-6;
    const r0 = R * (major ? 0.68 : 0.74), r1 = R * 0.8;
    g.strokeStyle = '#e9e9e6';
    g.lineWidth = major ? 7 : 3;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke();
    if (major && (kind === 'rpm' || v > 0)) {
      const rt = R * 0.53;
      g.fillStyle = '#efefec';
      g.font = `bold ${kind === 'speed' ? 40 : 50}px "Noto Sans KR", system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(v), cx + Math.cos(a) * rt, cy + Math.sin(a) * rt);
    }
  }
  g.fillStyle = '#9ea2a6';
  g.font = '30px "Noto Sans KR", system-ui, sans-serif';
  g.textAlign = 'center';
  g.fillText(kind === 'speed' ? 'km/h' : 'x1000 r/min', cx, cy + R * 0.42);
  return tex(c);
}
// 바늘 각도 (게이지 평면 기준 rotation.z)
const needleAngle = (v, max) => -(Math.PI * 0.75 + Math.PI * 1.5 * Math.max(0, Math.min(1, v / max))) - Math.PI / 2;

// ── 가운데 터치스크린 (내비게이션 화면)
function screenTexture() {
  const [c, g] = canvas(512, 320);
  g.fillStyle = '#0c1422'; g.fillRect(0, 0, 512, 320);
  // 골목길·큰길
  g.strokeStyle = '#1f2c3f'; g.lineWidth = 6;
  for (const [x0, y0, x1, y1] of [[0, 90, 512, 70], [0, 210, 512, 230], [120, 0, 90, 320], [400, 0, 430, 320], [0, 300, 200, 160], [300, 320, 512, 180]]) {
    g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
  }
  g.strokeStyle = '#33465f'; g.lineWidth = 16;
  g.beginPath(); g.moveTo(256, 330); g.lineTo(256, -10); g.stroke();
  g.beginPath(); g.moveTo(-10, 150); g.lineTo(522, 150); g.stroke();
  // 경로: 앞으로 가다가 오른쪽으로
  g.strokeStyle = '#3d9bff'; g.lineWidth = 10; g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(256, 290); g.lineTo(256, 168); g.quadraticCurveTo(256, 150, 276, 150); g.lineTo(500, 150); g.stroke();
  // 내 차 표시
  g.fillStyle = '#ffffff';
  g.beginPath(); g.moveTo(256, 250); g.lineTo(240, 284); g.lineTo(256, 276); g.lineTo(272, 284); g.closePath(); g.fill();
  // 위·아래 정보 줄
  g.fillStyle = 'rgba(8,12,20,0.9)'; g.fillRect(0, 0, 512, 40); g.fillRect(0, 262, 512, 58);
  g.fillStyle = '#d8e4f2'; g.font = 'bold 24px "Noto Sans KR", system-ui, sans-serif'; g.textBaseline = 'middle';
  g.textAlign = 'left'; g.fillText('14:30', 16, 20);
  g.textAlign = 'right'; g.fillText('22°C', 496, 20);
  g.textAlign = 'center'; g.fillText('보문역 사거리', 256, 20);
  g.fillStyle = '#3d9bff';
  g.beginPath(); g.moveTo(40, 300); g.lineTo(40, 282); g.lineTo(58, 282); g.lineTo(58, 274); g.lineTo(72, 288); g.lineTo(58, 302); g.lineTo(58, 294); g.lineTo(48, 294); g.lineTo(48, 300); g.closePath(); g.fill();
  g.fillStyle = '#ffffff'; g.font = 'bold 28px "Noto Sans KR", system-ui, sans-serif'; g.textAlign = 'left';
  g.fillText('우회전  120 m', 88, 291);
  g.fillStyle = '#9fb2c8'; g.font = '20px "Noto Sans KR", system-ui, sans-serif'; g.textAlign = 'right';
  g.fillText('고려대로', 496, 291);
  return tex(c);
}
// ── 룸미러에 보이는 뒷좌석 테두리 (머리받침·뒷유리 틀)
function rearMaskTexture() {
  const [c, g] = canvas(512, 128);
  g.clearRect(0, 0, 512, 128);
  const fr = g.createLinearGradient(0, 0, 0, 128);
  fr.addColorStop(0, 'rgba(60,62,66,0.95)');
  fr.addColorStop(0.18, 'rgba(60,62,66,0.0)');
  g.fillStyle = fr; g.fillRect(0, 0, 512, 128);
  for (const [x0, x1] of [[0, 60], [452, 512]]) {
    const gr = g.createLinearGradient(x0 < 100 ? 0 : 512, 0, x0 < 100 ? 70 : 442, 0);
    gr.addColorStop(0, 'rgba(38,40,43,0.97)');
    gr.addColorStop(1, 'rgba(38,40,43,0)');
    g.fillStyle = gr; g.fillRect(x0, 0, x1 - x0, 128);
  }
  g.fillStyle = 'rgba(24,25,27,0.98)';
  for (const cx of [150, 362]) { g.beginPath(); g.roundRect(cx - 58, 74, 116, 70, 22); g.fill(); }
  g.fillStyle = 'rgba(30,31,33,0.9)'; g.fillRect(0, 112, 512, 16);
  return tex(c);
}
function roundMask(w, h, r) {
  const [c, g] = canvas(w, h);
  g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff'; g.beginPath(); g.roundRect(2, 2, w - 4, h - 4, r); g.fill();
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function createCockpit() {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.02, 8);
  const root = new THREE.Group(); // 차 위치·방향을 따라감 (세상 좌표)
  scene.add(root);
  const cabin = new THREE.Group(); // 차 종류에 따라 높이만 올림
  root.add(cabin);
  const eye = new THREE.Object3D();
  eye.rotation.order = 'YXZ';
  cabin.add(eye);
  eye.position.copy(EYE);

  // 빛: 실내는 지붕에 가려 바깥보다 어둡다
  const hemi = new THREE.HemisphereLight(0xe9e7e3, 0x6a6560, 1.45);
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
  scene.add(hemi, sun, sun.target);

  const M = {
    dash: std(0x3a3c40, 0.78),
    dashTop: std(0x2a2c2f, 0.95),
    trim: std(0xa7aaad, 0.92),
    liner: std(0xbabcbd, 1.0),
    leather: std(0x121315, 0.58),
    piano: std(0x08090a, 0.16, 0.2),
    chrome: std(0xd8dbde, 0.16, 1.0),
    door: std(0x44474b, 0.8),
    seat: std(0x2c2d30, 0.9),
    housing: std(0x18191b, 0.45),
    grille: std(0x4b4e52, 0.8),
  };
  const groups = new Map(); // 재질 → 도형 목록
  const add = (mat, ...geos) => { if (!groups.has(mat)) groups.set(mat, []); groups.get(mat).push(...geos); };

  // ── 대시보드 본체 (단면을 옆으로 밀어 만듦)
  const prof = new THREE.SplineCurve([
    new THREE.Vector2(1.04, 0.965), new THREE.Vector2(0.82, 1.0), new THREE.Vector2(0.63, 0.993),
    new THREE.Vector2(0.51, 0.952), new THREE.Vector2(0.475, 0.885), new THREE.Vector2(0.5, 0.74),
    new THREE.Vector2(0.57, 0.56), new THREE.Vector2(0.82, 0.45), new THREE.Vector2(1.06, 0.45),
  ]).getPoints(40);
  const dashShape = new THREE.Shape(prof);
  const dashGeo = new THREE.ExtrudeGeometry(dashShape, { depth: 1.52, bevelEnabled: false, curveSegments: 4 });
  dashGeo.rotateY(-Math.PI / 2);
  dashGeo.translate(0.76, 0, 0);
  add(M.dash, dashGeo);
  // 윗면을 조금 더 어둡고 무광으로 (얇은 덮개)
  const topShape = new THREE.Shape([
    new THREE.Vector2(1.04, 0.968), new THREE.Vector2(0.82, 1.003), new THREE.Vector2(0.64, 0.996),
    new THREE.Vector2(0.64, 0.988), new THREE.Vector2(0.82, 0.995), new THREE.Vector2(1.04, 0.96),
  ]);
  const topGeo = new THREE.ExtrudeGeometry(topShape, { depth: 1.5, bevelEnabled: false });
  topGeo.rotateY(-Math.PI / 2);
  topGeo.translate(0.75, 0, 0);
  add(M.dashTop, topGeo);
  // 앞유리 아래 송풍구 줄
  add(M.grille, box(1.1, 0.006, 0.03, 0, 0.972, 1.0));

  // ── 계기판 덮개 + 게이지
  // 계기판은 대시보드 앞면에서 운전자 쪽으로 튀어나온 모양 (위에 덮개)
  const hood = new THREE.CylinderGeometry(0.125, 0.125, 0.11, 28, 1, true, -Math.PI / 2, Math.PI);
  hood.rotateX(-Math.PI / 2); // 위쪽 반원이 게이지를 덮도록
  hood.translate(EYE.x, 0.925, 0.47);
  add(M.dashTop, hood.toNonIndexed());
  const cluster = new THREE.Group();
  cluster.position.set(EYE.x, 0.918, 0.488);
  faceDir(cluster, EYE.clone().sub(cluster.position).add(V(0, 0.05, 0)));
  cabin.add(cluster);
  const backPlate = new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.12, 0.01, 3, 0.004), std(0x0b0c0e, 0.6));
  backPlate.position.z = -0.006;
  cluster.add(backPlate);
  const rpmTex = dialTexture('rpm'), spdTex = dialTexture('speed');
  const dialMat = (t) => new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: 0xffffff, emissiveIntensity: 0.08, roughness: 0.4 });
  const rpmDialMat = dialMat(rpmTex), spdDialMat = dialMat(spdTex);
  const rpmDial = new THREE.Mesh(new THREE.CircleGeometry(0.05, 48), rpmDialMat);
  rpmDial.position.set(-0.06, -0.004, 0);
  const spdDial = new THREE.Mesh(new THREE.CircleGeometry(0.06, 48), spdDialMat);
  spdDial.position.set(0.05, 0, 0);
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.05), std(0x0c1014, 0.3, 0, { emissive: 0x1a2a3a, emissiveIntensity: 0.4 }));
  lcd.position.set(0.12, 0.004, 0.0);
  cluster.add(rpmDial, spdDial, lcd);
  const needleMat = new THREE.MeshBasicMaterial({ color: 0xff3a14 });
  const needleGeo = (len) => {
    const s = new THREE.Shape([new THREE.Vector2(-0.0022, 0), new THREE.Vector2(0.0022, 0), new THREE.Vector2(0.0007, len), new THREE.Vector2(-0.0007, len)]);
    return new THREE.ShapeGeometry(s);
  };
  const rpmNeedle = new THREE.Mesh(needleGeo(0.04), needleMat);
  rpmNeedle.position.set(-0.06, -0.004, 0.002);
  const spdNeedle = new THREE.Mesh(needleGeo(0.05), needleMat);
  spdNeedle.position.set(0.05, 0, 0.002);
  const capGeo = new THREE.CircleGeometry(0.008, 20);
  const capMat = std(0x111111, 0.5);
  const cap1 = new THREE.Mesh(capGeo, capMat); cap1.position.set(-0.06, -0.004, 0.003);
  const cap2 = new THREE.Mesh(capGeo, capMat); cap2.position.set(0.05, 0, 0.003);
  cluster.add(rpmNeedle, spdNeedle, cap1, cap2);

  // ── 핸들 (돌아가는 부분) + 핸들 기둥·레버 (고정)
  const COL = V(0, Math.sin(25 * deg), -Math.cos(25 * deg)); // 운전자 쪽, 위로 25°
  const wheelBase = new THREE.Group();
  wheelBase.position.set(EYE.x, 0.86, 0.27);
  faceDir(wheelBase, COL);
  cabin.add(wheelBase);
  const wheel = new THREE.Group();
  wheelBase.add(wheel);
  const wheelGeos = [
    new THREE.TorusGeometry(0.185, 0.0175, 14, 64).toNonIndexed(),
    rbox(0.12, 0.05, 0.026, 0.01, -0.115, -0.012, -0.004),
    rbox(0.12, 0.05, 0.026, 0.01, 0.115, -0.012, -0.004),
    rbox(0.06, 0.11, 0.024, 0.01, 0, -0.12, -0.006),
    rbox(0.155, 0.12, 0.05, 0.022, 0, -0.012, 0.004),
  ];
  wheel.add(new THREE.Mesh(mergeGeometries(strip(wheelGeos)), M.leather));
  // 스포크 버튼 판 + 가운데 장식(일반 타원형, 상표 없음)
  const btn = [rbox(0.05, 0.034, 0.008, 0.004, -0.122, -0.008, 0.012), rbox(0.05, 0.034, 0.008, 0.004, 0.122, -0.008, 0.012)];
  wheel.add(new THREE.Mesh(mergeGeometries(strip(btn)), M.housing));
  const badge = new THREE.Mesh(new THREE.CircleGeometry(0.022, 32), M.chrome);
  badge.scale.set(1.5, 0.75, 1);
  badge.position.set(0, -0.01, 0.031);
  wheel.add(badge);
  const fixed = [
    rbox(0.09, 0.095, 0.34, 0.025, 0, -0.03, -0.2), // 핸들 기둥 덮개
    cyl(0.009, 0.009, 0.15, -0.1, 0.0, -0.1, 0, 0, Math.PI / 2, 10), // 왼쪽 레버 (방향지시등)
    cyl(0.009, 0.009, 0.15, 0.1, 0.0, -0.1, 0, 0, Math.PI / 2, 10), // 오른쪽 레버 (와이퍼)
  ];
  wheelBase.add(new THREE.Mesh(mergeGeometries(strip(fixed)), M.housing));

  // ── 가운데 화면 · 버튼 · 송풍구
  const stack = new THREE.Group();
  stack.position.set(0.0, 0.86, 0.465);
  faceDir(stack, V(0.18, 0.28, -1));
  cabin.add(stack);
  stack.add(new THREE.Mesh(new RoundedBoxGeometry(0.25, 0.17, 0.03, 3, 0.012), M.piano));
  const trimRing = new THREE.Mesh(new RoundedBoxGeometry(0.262, 0.182, 0.02, 3, 0.014), M.chrome);
  trimRing.position.z = -0.006;
  stack.add(trimRing);
  const scrTex = screenTexture();
  const screenMat = new THREE.MeshStandardMaterial({ map: scrTex, emissiveMap: scrTex, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.12, metalness: 0.1 });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.19, 0.115), screenMat);
  screen.position.z = 0.0155;
  stack.add(screen);
  const lower = [
    rbox(0.2, 0.05, 0.02, 0.008, 0, -0.12, 0.004), // 오디오 버튼 줄
    cyl(0.017, 0.017, 0.02, -0.06, -0.255, 0.004, Math.PI / 2, 0, 0), // 공조 다이얼
    cyl(0.017, 0.017, 0.02, 0.0, -0.255, 0.004, Math.PI / 2, 0, 0),
    cyl(0.017, 0.017, 0.02, 0.06, -0.255, 0.004, Math.PI / 2, 0, 0),
  ];
  const lowerMesh = new THREE.Mesh(mergeGeometries(strip(lower)), M.housing);
  stack.add(lowerMesh);
  const hazard = new THREE.Mesh(new THREE.CircleGeometry(0.014, 3), new THREE.MeshStandardMaterial({ color: 0xd2261b, emissive: 0x6a0c06, emissiveIntensity: 0.4, roughness: 0.4 }));
  hazard.position.set(0, -0.18, 0.016);
  hazard.rotation.z = Math.PI / 2;
  stack.add(hazard);
  const panel = new THREE.Mesh(new RoundedBoxGeometry(0.24, 0.24, 0.02, 3, 0.01), M.dash);
  panel.position.set(0, -0.2, -0.004);
  stack.add(panel);
  for (const [x, y, z, w] of [[0.64, 0.88, 0.47, 0.1], [-0.6, 0.9, 0.475, 0.1], [0.17, 0.88, 0.47, 0.06], [-0.17, 0.88, 0.47, 0.06]]) {
    const vent = new THREE.Group();
    vent.position.set(x, y, z);
    faceDir(vent, EYE.clone().sub(vent.position));
    vent.add(new THREE.Mesh(new RoundedBoxGeometry(w + 0.016, 0.06, 0.012, 3, 0.008), M.chrome));
    const slats = new THREE.Mesh(new THREE.PlaneGeometry(w, 0.045), std(0x0b0b0c, 0.7));
    slats.position.z = 0.0065;
    vent.add(slats);
    cabin.add(vent);
  }

  // ── A필러 · 앞유리 윗틀 · 천장 · 햇빛가리개 · 룸미러
  const HEADER_Y = 1.295, HEADER_Z = 0.38;
  for (const s of [1, -1]) {
    add(M.trim, beam(V(s * 0.73, 0.965, 1.03), V(s * 0.63, HEADER_Y, HEADER_Z), 0.1, 0.065, 0.025));
    add(M.grille, cyl(0.032, 0.032, 0.012, s * 0.72, 1.0, 0.96, Math.PI / 2 - 0.5, s * 0.6, 0, 18)); // 트위터
    add(M.trim, beam(V(s * 0.63, HEADER_Y, HEADER_Z), V(s * 0.68, 1.31, -0.6), 0.08, 0.05, 0.02)); // 지붕 옆 틀
    add(M.trim, beam(V(s * 0.73, 1.0, -0.6), V(s * 0.68, 1.31, -0.62), 0.11, 0.09, 0.02)); // B필러
    add(M.trim, beam(V(s * 0.72, 1.0, -1.45), V(s * 0.6, 1.3, -1.25), 0.2, 0.08, 0.02)); // C필러
  }
  add(M.trim, box(1.3, 0.05, 0.07, 0, HEADER_Y + 0.012, HEADER_Z - 0.01));
  add(M.liner, box(1.42, 0.03, 2.0, 0, 1.325, -0.62));
  const rearMirror = new THREE.Group();
  rearMirror.position.set(-0.01, 1.215, 0.44);
  faceDir(rearMirror, EYE.clone().sub(rearMirror.position));
  cabin.add(rearMirror);
  add(M.housing, cyl(0.008, 0.008, 0.07, -0.01, 1.26, 0.45)); // 룸미러 기둥
  add(M.housing, rbox(0.075, 0.05, 0.03, 0.006, -0.01, 1.165, 0.47)); // 블랙박스
  rearMirror.add(new THREE.Mesh(new RoundedBoxGeometry(0.27, 0.075, 0.03, 4, 0.03), M.housing));

  // ── 문 안쪽 · 사이드미러 (밖)
  for (const s of [1, -1]) {
    add(M.door, rbox(0.08, 0.6, 1.6, 0.02, s * 0.78, 0.7, 0.2));
    add(M.dash, rbox(0.07, 0.035, 1.4, 0.012, s * 0.745, 1.0, 0.15)); // 창틀(벨트라인)
    add(M.door, rbox(0.09, 0.05, 0.36, 0.015, s * 0.73, 0.74, -0.15)); // 팔걸이
    add(M.grille, cyl(0.06, 0.06, 0.01, s * 0.735, 0.55, 0.45, 0, 0, Math.PI / 2, 24)); // 스피커
  }
  const sideMirrors = [];
  for (const s of [1, -1]) {
    const g = new THREE.Group();
    g.position.set(s * 0.95, 1.03, 0.82);
    faceDir(g, EYE.clone().sub(g.position));
    cabin.add(g);
    g.add(new THREE.Mesh(new RoundedBoxGeometry(0.2, 0.12, 0.07, 4, 0.03), M.housing));
    add(M.housing, beam(V(s * 0.8, 1.0, 0.9), V(s * 0.92, 1.02, 0.84), 0.05, 0.04, 0.015)); // 거울 팔
    sideMirrors.push({ s, g });
  }

  // ── 보조석 · 가운데 콘솔 · 뒷좌석 (고개를 돌리면 보임)
  add(M.seat, rbox(0.5, 0.13, 0.52, 0.05, -0.37, 0.52, -0.22));
  add(M.seat, rbox(0.5, 0.64, 0.13, 0.05, -0.37, 0.86, -0.53, -0.2, 0, 0));
  add(M.seat, rbox(0.26, 0.17, 0.1, 0.04, -0.37, 1.25, -0.63, -0.15, 0, 0));
  add(M.dash, rbox(0.2, 0.2, 0.75, 0.03, 0, 0.5, -0.15));
  add(M.piano, cyl(0.012, 0.012, 0.12, 0, 0.62, 0.2), cyl(0.028, 0.024, 0.04, 0, 0.69, 0.2));
  add(M.seat, rbox(1.36, 0.5, 0.14, 0.05, 0, 0.75, -1.25, -0.18, 0, 0));

  for (const [mat, geos] of groups) {
    const mesh = new THREE.Mesh(mergeGeometries(strip(geos)), mat);
    cabin.add(mesh);
  }

  // ── 거울: 뒤쪽 장면을 작은 화면으로 찍어 비춤 (좌우 반전)
  const mirrorDefs = [
    { key: 'rear', w: 448, h: 112, fov: 13, pos: V(-0.01, 1.22, -0.25), yaw: 0, pitch: -0.035 },
    { key: 'left', w: 224, h: 144, fov: 20, pos: V(0.96, 1.05, 0.78), yaw: -0.2, pitch: -0.06 },
    { key: 'right', w: 224, h: 144, fov: 25, pos: V(-0.96, 1.05, 0.78), yaw: 0.24, pitch: -0.06 },
  ];
  const mirrors = mirrorDefs.map((d) => {
    const rt = new THREE.WebGLRenderTarget(d.w, d.h, { type: THREE.HalfFloatType });
    const mc = new THREE.PerspectiveCamera(d.fov, d.w / d.h, 0.3, 160);
    mc.rotation.order = 'YXZ';
    mc.position.copy(d.pos);
    mc.rotation.set(d.pitch, d.yaw, 0);
    cabin.add(mc);
    const t = rt.texture;
    t.wrapS = THREE.RepeatWrapping;
    t.repeat.x = -1;
    t.offset.x = 1;
    const mat = new THREE.MeshBasicMaterial({ map: t, color: 0xd2d2d2 });
    return { ...d, rt, cam: mc, mat };
  });
  const rearGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.245, 0.06), mirrors[0].mat);
  rearGlass.position.z = 0.0155;
  rearMirror.add(rearGlass);
  const rearMask = new THREE.Mesh(new THREE.PlaneGeometry(0.245, 0.06), new THREE.MeshBasicMaterial({ map: rearMaskTexture(), transparent: true, depthWrite: false }));
  rearMask.position.z = 0.0165;
  rearMirror.add(rearMask);
  const sideMask = roundMask(128, 80, 22);
  for (const sm of sideMirrors) {
    const m = mirrors[sm.s > 0 ? 1 : 2];
    m.mat.alphaMap = sideMask;
    m.mat.alphaTest = 0.5;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.175, 0.105), m.mat);
    glass.position.z = 0.036;
    sm.g.add(glass);
  }

  const cockpit = {
    scene, cam, root, active: false, target: null, fov: FOV,
    look: 0, // 손으로 고개 돌리기: −1 왼쪽 · +1 오른쪽
    yaw: 0, pitch: PITCH, speed: 0, steer: 0, rpm: 0.8,
    lookPoint: new THREE.Vector3(),
    _prevH: null, _hidden: [], _mi: 0,

    // 따라갈 차가 바뀌면 그 차의 겉모습을 숨김 (실내에서 차체 안쪽이 보이지 않게). 밤 노면 불빛은 남김
    _attach(obj) {
      if (this.target === obj) return;
      this._restore();
      this.target = obj;
      this._prevH = null;
      this.yaw = 0;
      const mesh = obj && obj.mesh;
      if (!mesh) return;
      const fx = mesh.userData && mesh.userData.fx;
      for (const ch of mesh.children) {
        if (ch === fx) {
          for (const f of fx.children) if (f.isSprite) { this._hidden.push([f, f.visible]); f.visible = false; }
          continue;
        }
        this._hidden.push([ch, ch.visible]);
        ch.visible = false;
      }
      cabin.position.y = LIFT[obj.type] || 0;
    },
    _restore() {
      for (const [o, v] of this._hidden) o.visible = v;
      this._hidden = [];
      this.target = null;
    },
    release() {
      this._restore();
      this.active = false;
    },

    // 차 자세 → 실내·눈 위치 → 세상 카메라 (매 단계)
    place(obj, camera, dt, pose) {
      if (!obj || obj.dead || !pose) { this.release(); return false; }
      this._attach(obj);
      this.active = true;
      const heading = Math.atan2(pose.fx, pose.fz);
      root.position.set(pose.x, 0, pose.z);
      root.rotation.set(0, heading, 0);
      // 속도·핸들
      const npc = obj.kind === 'npc';
      const v = npc ? obj.v : obj.v || 0;
      let steer = 0;
      if (!npc) steer = obj.steer || 0;
      else if (this._prevH != null && dt > 0) {
        let dh = heading - this._prevH;
        while (dh > Math.PI) dh -= 2 * Math.PI;
        while (dh < -Math.PI) dh += 2 * Math.PI;
        const ds = Math.max(0.05, Math.abs(v) * dt);
        steer = Math.atan(2.7 * (dh / ds));
      }
      this._prevH = heading;
      const k = 1 - Math.exp(-(dt || 0.016) * 6);
      this.steer += (steer - this.steer) * k;
      this.speed += (Math.abs(v) * 3.6 - this.speed) * Math.min(1, (dt || 0.016) * 4);
      const rpmT = 0.8 + Math.min(5.2, ((this.speed % 38) / 38) * 2.6 + this.speed / 60);
      this.rpm += (rpmT - this.rpm) * Math.min(1, (dt || 0.016) * 3);
      wheel.rotation.z = this.steer * 14;
      spdNeedle.rotation.z = needleAngle(this.speed, 200);
      rpmNeedle.rotation.z = needleAngle(this.rpm, 8);
      // 고개: 가는 쪽을 미리 봄 + 우회전 전에는 오른쪽 횡단보도를 살핌 + 손으로 돌리기(Q·E)
      let auto = 0;
      if (npc && obj.route) {
        const ahead = {};
        obj.route.sample(Math.min(obj.route.length - 0.1, obj.s + Math.max(7, Math.min(14, Math.abs(v) * 1.8))), ahead);
        const dx = ahead.x - pose.x, dz = ahead.z - pose.z;
        const fwd = dx * pose.fx + dz * pose.fz, left = dx * pose.fz - dz * pose.fx;
        auto = Math.atan2(left, Math.max(0.5, fwd)) * 0.85;
        if (obj.route.turn === 'R' && obj.yieldS != null && obj.s > obj.yieldS - 26 && obj.s < obj.yieldS + 2) auto -= 0.32;
      } else if (!npc) {
        auto = (this.steer / 0.6) * 0.45;
      }
      const manual = this.look < 0 ? 1.25 : this.look > 0 ? -1.4 : 0;
      const want = Math.max(-1.45, Math.min(1.35, manual || auto));
      this.yaw += (want - this.yaw) * (1 - Math.exp(-(dt || 0.016) * (manual ? 5 : 3)));
      eye.rotation.set(this.pitch, Math.PI + this.yaw, 0);
      // 고개를 많이 돌리면 머리도 그쪽으로 조금 움직임
      eye.position.set(EYE.x + Math.sin(this.yaw) * 0.05, EYE.y, EYE.z + Math.abs(Math.sin(this.yaw)) * 0.03);
      root.updateMatrixWorld(true);
      eye.getWorldPosition(camera.position);
      eye.getWorldQuaternion(camera.quaternion);
      camera.updateMatrixWorld();
      // 그림자 기준점: 앞쪽 도로
      this.lookPoint.set(pose.x + pose.fx * 12, 0, pose.z + pose.fz * 12);
      return true;
    },

    // 세상 장면을 그리기 직전: 겹쳐 그릴 카메라 맞추기 + 거울 한 개씩 번갈아 갱신
    beforeRender(renderer, world, worldCam, level) {
      cam.position.copy(worldCam.position);
      cam.quaternion.copy(worldCam.quaternion);
      if (cam.fov !== worldCam.fov || cam.aspect !== worldCam.aspect) {
        cam.fov = worldCam.fov;
        cam.aspect = worldCam.aspect;
        cam.updateProjectionMatrix();
      }
      cam.updateMatrixWorld();
      scene.environment = world.environment;
      scene.environmentIntensity = (world.environmentIntensity || 1) * 0.9;
      sun.position.copy(root.position).add(SUN_OFF);
      sun.target.position.copy(root.position);
      sun.target.updateMatrixWorld();
      if (level < 0) return;
      // 가볍게(0): 4프레임에 한 번, 그 외: 매 프레임 한 거울씩
      this._frame = (this._frame || 0) + 1;
      if (level === 0 && this._frame % 4) return;
      const m = mirrors[this._mi++ % mirrors.length];
      const prevRT = renderer.getRenderTarget();
      const shadowAuto = renderer.shadowMap.autoUpdate;
      renderer.shadowMap.autoUpdate = false;
      renderer.setRenderTarget(m.rt);
      renderer.clear();
      renderer.render(world, m.cam);
      renderer.setRenderTarget(prevRT);
      renderer.shadowMap.autoUpdate = shadowAuto;
    },

    setNight(on) {
      hemi.intensity = on ? 0.14 : 1.45;
      hemi.color.setHex(on ? 0x7a8cc0 : 0xe9e7e3);
      sun.intensity = on ? 0.04 : 1.6;
      rpmDialMat.emissiveIntensity = spdDialMat.emissiveIntensity = on ? 0.85 : 0.08;
      screenMat.emissiveIntensity = on ? 0.55 : 0.25;
    },
  };
  return cockpit;
}
