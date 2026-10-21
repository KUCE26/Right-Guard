import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { G, rand } from './config.js';
import { EXITS, SITE, PARK, WALKWAY, BARRIER } from './layout.js';
import {
  signTexture, radialTexture, billboardTexture,
  exitSignTexture, directionSignTexture, placeSignTexture, hoardingTexture,
  speedLimitTexture, enforcementSignTexture, roadNumberTexture,
  HOARD_TILE_M, HOARD_PLATE,
} from './textures.js';
import { createSky } from './real/atmosphere.js';
import { asphaltSet, sidewalkSet, curbSet, tactileSet, paintWearSet, manholeSet } from './real/textures3d.js';
import {
  signalHead, pedSignalHead, signalMastParts, streetLampParts, utilityPoleParts, wireGeometry, wireMaterial,
  pedFenceParts, cctvPoleParts, mergePartsInstances,
} from './real/street3d.js';
import { createCityBlocks } from './real/cityblocks.js';
import { buildTreeGrate } from './real/trees3d.js';
import { createTreeField } from './real/treefield.js';

// ───────────────────────── 기하 헬퍼
function rectGeo(x0, x1, z0, z1, y = 0) {
  const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  return g;
}
function scaleUV(g, su, sv) {
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return g;
}
function colorize(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}
export function boxAt(w, h, d, x, y, z, color) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return color !== undefined ? colorize(g, color) : g;
}
export function cylAt(rt, rb, h, x, y, z, color, seg = 10) {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(x, y, z);
  return color !== undefined ? colorize(g, color) : g;
}
// 두 점 사이 얇은 노면 띠
function stripeGeo(ax, az, bx, bz, w, y) {
  const len = Math.hypot(bx - ax, bz - az);
  const g = new THREE.PlaneGeometry(len, w);
  g.rotateX(-Math.PI / 2);
  g.rotateY(-Math.atan2(bz - az, bx - ax));
  g.translate((ax + bx) / 2, y, (az + bz) / 2);
  return g;
}

// 2D 교차 판정 헬퍼
export function segHitsBox(ax, az, bx, bz, b) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dz = bz - az;
  const p = [-dx, dx, -dz, dz];
  const q = [ax - b.x0, b.x1 - ax, az - b.z0, b.z1 - az];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
  }
  return true;
}

export function isSidewalk(x, z) {
  const ax = Math.abs(x), az = Math.abs(z);
  if (ax < G.NS_HALF || az < G.EW_HALF) return false;
  // 둥근 모서리
  const cx = G.NS_HALF + G.CORNER_R, cz = G.EW_HALF + G.CORNER_R;
  if (ax < cx && az < cz) return Math.hypot(ax - cx, az - cz) <= G.CORNER_R;
  return true;
}
export function groundY(x, z) {
  return isSidewalk(x, z) ? G.CURB_H : 0;
}

// ───────────────────────── 월드 생성 — 보문역 사거리
export function buildWorld(scene, { emblemImg, deptImg } = {}) {
  const W = {
    occluders: [], // 건물·구조물 AABB (충돌·미니맵)
    exits: EXITS,
    site: SITE,
    park: PARK,
    night: { windowMats: [], lampMats: [], glowSprites: [], pointLights: [], emissiveSigns: [] },
    vehSignals: [], pedSignals: [],
  };
  const E = G.EXT;
  const NS = G.NS_HALF, EW = G.EW_HALF, BX = G.BLOCK_X, BZ = G.BLOCK_Z;
  const baseY = G.CURB_H;
  // 인도 위 장애물 (가로수·가로등 배치 때 피함)
  const obstacles = [];
  const addObstacle = (x0, x1, z0, z1, pad = 0) => obstacles.push({ x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad });
  const blocked = (x, z, r = 1.2) => obstacles.some((o) => x > o.x0 - r && x < o.x1 + r && z > o.z0 - r && z < o.z1 + r);
  for (const e of EXITS) addObstacle(e.x0, e.x1, e.z0, e.z1);
  addObstacle(BARRIER.x0, BARRIER.x1, BARRIER.z - 0.3, BARRIER.z + 0.3);

  // 하늘 (뭉게구름이 흐르는 맑은 오후 하늘 — 카메라를 따라다님)
  W.sky = createSky();
  scene.add(W.sky.mesh);

  // 바닥
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x8a8a84, roughness: 1 });
  const ground = new THREE.Mesh(rectGeo(-600, 600, -600, 600, -0.03), groundMat);
  ground.receiveShadow = true;
  scene.add(ground);

  // ── 도로 (아스팔트) — 보문로 + 고려대로 + 모퉁이 곡선 밑면
  performance.mark('t0');
  const asp = asphaltSet({ seed: 3 });
  const roadMat = new THREE.MeshStandardMaterial({
    map: asp.map, normalMap: asp.normalMap || null, roughnessMap: asp.roughnessMap || null, roughness: asp.roughnessMap ? 1 : 0.92, metalness: 0,
  });
  W.roadMat = roadMat;
  const AT = (asp.size && asp.size[0]) || 4; // 텍스처 한 장 = AT m
  // 도로 uv 는 월드 좌표(m)/AT 로 — 이어 붙인 면 사이에 이음매가 생기지 않게
  const worldUV = (g, t) => {
    const pos = g.attributes.position, uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / t, -pos.getZ(i) / t);
    uv.needsUpdate = true;
    return g;
  };
  const roads = [
    worldUV(rectGeo(-NS, NS, -E, E, 0), AT),
    worldUV(rectGeo(-E, -NS, -EW, EW, 0), AT),
    worldUV(rectGeo(NS, E, -EW, EW, 0), AT),
  ];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const x0 = sx > 0 ? NS : -NS - G.CORNER_R, x1 = sx > 0 ? NS + G.CORNER_R : -NS;
    const z0 = sz > 0 ? EW : -EW - G.CORNER_R, z1 = sz > 0 ? EW + G.CORNER_R : -EW;
    roads.push(worldUV(rectGeo(x0, x1, z0, z1, 0), AT));
  }
  const roadMesh = new THREE.Mesh(mergeGeometries(roads), roadMat);
  roadMesh.receiveShadow = true;
  scene.add(roadMesh);

  // ── 인도 블록 4개 (둥근 모서리, 연석 높이)
  const sw = sidewalkSet({ seed: 5 });
  const swT = (sw.size && sw.size[0]) || 2;
  for (const t of [sw.map, sw.normalMap, sw.roughnessMap]) if (t) t.repeat.set(1 / swT, 1 / swT);
  const paverMat = new THREE.MeshStandardMaterial({ map: sw.map, normalMap: sw.normalMap || null, roughnessMap: sw.roughnessMap || null, roughness: sw.roughnessMap ? 1 : 0.9 });
  const cb = curbSet();
  const cbT = (cb.size && cb.size[0]) || 1;
  for (const t of [cb.map, cb.normalMap, cb.roughnessMap]) if (t) t.repeat.set(1 / cbT, 1 / cbT);
  const curbMat = new THREE.MeshStandardMaterial({ map: cb.map, normalMap: cb.normalMap || null, roughnessMap: cb.roughnessMap || null, roughness: cb.roughnessMap ? 1 : 0.8 });
  // 표지판 테두리 등 무늬 없는 회색 면 (예전 연석 재질 자리)
  const plainGray = new THREE.MeshStandardMaterial({ color: 0xc9c4ba, roughness: 0.85 });
  W.curbMat = plainGray;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const cx = sx * NS, cz = sz * EW;
      const rcx = sx * (NS + G.CORNER_R), rcz = sz * (EW + G.CORNER_R);
      const pts = [];
      pts.push([cx, sz * (EW + G.CORNER_R)]);
      pts.push([cx, sz * E]);
      pts.push([sx * E, sz * E]);
      pts.push([sx * E, cz]);
      pts.push([sx * (NS + G.CORNER_R), cz]);
      const a0 = Math.atan2(cz - rcz, 0), a1 = Math.atan2(0, cx - rcx);
      let da = a1 - a0;
      if (da > Math.PI) da -= Math.PI * 2;
      if (da < -Math.PI) da += Math.PI * 2;
      for (let i = 1; i < 14; i++) {
        const a = a0 + (da * i) / 14;
        pts.push([rcx + G.CORNER_R * Math.cos(a), rcz + G.CORNER_R * Math.sin(a)]);
      }
      const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: G.CURB_H, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, [paverMat, curbMat]);
      m.receiveShadow = true;
      scene.add(m);
    }
  }

  // ── 인도 위 표면: 점자블록, 공사장 흙, 초록 임시 보행로, 공원 잔디
  const tk = tactileSet('dots');
  const tactMat = new THREE.MeshStandardMaterial({ map: tk.map, normalMap: tk.normalMap || null, roughnessMap: tk.roughnessMap || null, roughness: tk.roughnessMap ? 1 : 0.75, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const tactGeos = [];
  const sy = baseY + 0.004;
  for (const k of ['E', 'W']) {
    const c = G.CW[k];
    for (const s of [-1, 1]) {
      const z0 = s > 0 ? EW + 0.3 : -EW - 0.7, z1 = s > 0 ? EW + 0.7 : -EW - 0.3;
      tactGeos.push(scaleUV(rectGeo(c.x0 + 0.25, c.x1 - 0.25, z0, z1, sy), (c.x1 - c.x0 - 0.5) / 0.6, 0.4 / 0.6));
    }
  }
  for (const k of ['N', 'S']) {
    const c = G.CW[k];
    for (const s of [-1, 1]) {
      const x0 = s > 0 ? NS + 0.3 : -NS - 0.7, x1 = s > 0 ? NS + 0.7 : -NS - 0.3;
      tactGeos.push(scaleUV(rectGeo(x0, x1, c.z0 + 0.25, c.z1 - 0.25, sy), 0.4 / 0.6, (c.z1 - c.z0 - 0.5) / 0.6));
    }
  }
  scene.add(new THREE.Mesh(mergeGeometries(tactGeos), tactMat));

  const flatMat = (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const dirt = new THREE.Mesh(rectGeo(SITE.x0, SITE.x1, SITE.z0, SITE.z1, baseY + 0.006), flatMat(0x8b7354));
  dirt.receiveShadow = true;
  const ww = WALKWAY.w;
  const walkway = new THREE.Mesh(mergeGeometries([
    rectGeo(BX - ww, SITE.x1, BZ - ww, BZ, sy), // 고려대로 쪽
    rectGeo(BX - ww, BX, BZ, SITE.z1, sy), // 보문로 쪽
  ]), flatMat(0x4a9a5c));
  walkway.receiveShadow = true;
  const grass = new THREE.Mesh(rectGeo(PARK.x0, PARK.x1, PARK.z0, PARK.z1, baseY + 0.006), flatMat(0x6f9a52));
  grass.receiveShadow = true;
  scene.add(dirt, walkway, grass);

  // ── 노면 표시 (흰색 / 노란색)
  const white = [], yellow = [];
  const Y = 0.014;
  // 중앙선 (2중 황색)
  for (const zz of [[-E, G.STOP.SB], [G.STOP.NB, E]]) {
    yellow.push(rectGeo(-0.24, -0.1, zz[0], zz[1], Y), rectGeo(0.1, 0.24, zz[0], zz[1], Y));
  }
  for (const xx of [[-E, G.STOP.EB], [G.STOP.WB, E]]) {
    yellow.push(rectGeo(xx[0], xx[1], -0.24, -0.1, Y), rectGeo(xx[0], xx[1], 0.1, 0.24, Y));
  }
  // 차선 구분선: 교차로 30 m 전까지 실선, 그 밖은 점선
  for (const sx of [-1, 1]) {
    const x = sx * 3.25;
    for (const dir of [-1, 1]) {
      const zStop = dir > 0 ? G.STOP.NB : G.STOP.SB;
      const solidEnd = zStop + dir * 30;
      white.push(rectGeo(x - 0.075, x + 0.075, Math.min(zStop, solidEnd), Math.max(zStop, solidEnd), Y));
      for (let z = Math.abs(solidEnd) + 5; z < E; z += 10) {
        const z0 = dir * z, z1 = dir * (z + 4);
        white.push(rectGeo(x - 0.075, x + 0.075, Math.min(z0, z1), Math.max(z0, z1), Y));
      }
    }
  }
  for (const sz of [-1, 1]) {
    const z = sz * (G.MEDIAN + 3.2);
    for (const dir of [-1, 1]) {
      const xStop = dir > 0 ? G.STOP.WB : G.STOP.EB;
      const solidEnd = xStop + dir * 30;
      white.push(rectGeo(Math.min(xStop, solidEnd), Math.max(xStop, solidEnd), z - 0.075, z + 0.075, Y));
      for (let x = Math.abs(solidEnd) + 5; x < E; x += 10) {
        const x0 = dir * x, x1 = dir * (x + 4);
        white.push(rectGeo(Math.min(x0, x1), Math.max(x0, x1), z - 0.075, z + 0.075, Y));
      }
    }
  }
  // 바깥 가장자리선
  for (const sx of [-1, 1]) {
    const x = sx * (NS - 0.25);
    white.push(rectGeo(x - 0.06, x + 0.06, -E, G.STOP.SB, Y), rectGeo(x - 0.06, x + 0.06, G.STOP.NB, E, Y));
  }
  for (const sz of [-1, 1]) {
    const z = sz * (EW - 0.25);
    white.push(rectGeo(-E, G.STOP.EB, z - 0.06, z + 0.06, Y), rectGeo(G.STOP.WB, E, z - 0.06, z + 0.06, Y));
  }
  // 정지선
  white.push(rectGeo(0.3, NS, G.STOP.NB, G.STOP.NB + 0.45, Y));
  white.push(rectGeo(-NS, -0.3, G.STOP.SB - 0.45, G.STOP.SB, Y));
  white.push(rectGeo(G.STOP.EB - 0.45, G.STOP.EB, 0.3, EW, Y));
  white.push(rectGeo(G.STOP.WB, G.STOP.WB + 0.45, -EW, -0.3, Y));
  // 횡단보도 줄무늬
  for (const k of ['N', 'S']) {
    const c = G.CW[k];
    for (let x = c.x0 + 0.3; x + 0.45 <= c.x1 - 0.1; x += 0.9) white.push(rectGeo(x, x + 0.45, c.z0, c.z1, Y));
  }
  for (const k of ['E', 'W']) {
    const c = G.CW[k];
    for (let z = c.z0 + 0.25; z + 0.45 <= c.z1 - 0.1; z += 0.9) white.push(rectGeo(c.x0, c.x1, z, z + 0.45, Y));
  }
  // 교차로 안 좌회전 유도선 (점선)
  const RL = 7.6;
  const guide = (cx, cz, a0, a1) => {
    const n = Math.ceil((Math.abs(a1 - a0) * RL) / 1.3);
    for (let i = 0; i < n; i++) {
      const t0 = a0 + ((a1 - a0) * i) / n, t1 = a0 + ((a1 - a0) * (i + 0.5)) / n;
      white.push(stripeGeo(cx + RL * Math.cos(t0), cz + RL * Math.sin(t0), cx + RL * Math.cos(t1), cz + RL * Math.sin(t1), 0.15, Y));
    }
  };
  const L = G.LANE;
  guide(L.NB_IN - RL, L.WB_IN + RL, 0, -Math.PI / 2);
  guide(L.SB_IN + RL, L.EB_IN - RL, Math.PI, Math.PI / 2);
  guide(L.NB_IN - RL, L.EB_IN - RL, Math.PI / 2, 0);
  guide(L.SB_IN + RL, L.WB_IN + RL, -Math.PI / 2, -Math.PI);
  // 차로 화살표 (직진 / 직진+우회전)
  const arrowGeo = (withRight) => {
    const s = new THREE.Shape();
    s.moveTo(-0.15, -2.6); s.lineTo(0.15, -2.6); s.lineTo(0.15, 0.6); s.lineTo(0.5, 0.6);
    s.lineTo(0, 1.8); s.lineTo(-0.5, 0.6); s.lineTo(-0.15, 0.6); s.lineTo(-0.15, -2.6);
    const geos = [new THREE.ShapeGeometry(s)];
    if (withRight) {
      const r = new THREE.Shape();
      r.moveTo(0.15, -0.6); r.lineTo(0.95, -0.6); r.lineTo(0.95, -0.95); r.lineTo(1.6, -0.4);
      r.lineTo(0.95, 0.15); r.lineTo(0.95, -0.2); r.lineTo(0.15, -0.2);
      geos.push(new THREE.ShapeGeometry(r));
    }
    const g = mergeGeometries(geos);
    g.rotateX(-Math.PI / 2); // 로컬 +y → 월드 −z
    return g;
  };
  const placeArrow = (withRight, x, z, rotY) => {
    const g = arrowGeo(withRight);
    g.rotateY(rotY);
    g.translate(x, Y, z);
    white.push(g);
  };
  for (const d of [9, 28]) {
    placeArrow(false, L.NB_IN, G.STOP.NB + d, 0);
    placeArrow(true, L.NB_OUT, G.STOP.NB + d, 0);
    placeArrow(false, L.SB_IN, G.STOP.SB - d, Math.PI);
    placeArrow(true, L.SB_OUT, G.STOP.SB - d, Math.PI);
    placeArrow(false, G.STOP.EB - d, L.EB_IN, -Math.PI / 2);
    placeArrow(true, G.STOP.EB - d, L.EB_OUT, -Math.PI / 2);
    placeArrow(false, G.STOP.WB + d, L.WB_IN, Math.PI / 2);
    placeArrow(true, G.STOP.WB + d, L.WB_OUT, Math.PI / 2);
  }

  // 노면 표시는 월드 좌표 uv 로 마모 무늬를 입힘 (2 m 한 장)
  const strip = (geos) => geos.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    n.deleteAttribute('normal');
    n.computeVertexNormals();
    const pos = n.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) / 2; uv[i * 2 + 1] = -pos.getZ(i) / 2; }
    n.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return n;
  });
  const wear = paintWearSet();
  const paintMat = (hex) => new THREE.MeshStandardMaterial({
    color: hex, map: wear.map || null, alphaMap: wear.alphaMap || null, alphaTest: wear.alphaMap ? 0.2 : 0, normalMap: wear.normalMap || null,
    roughnessMap: wear.roughnessMap || null, roughness: wear.roughnessMap ? 1 : 0.62,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const whiteMat = paintMat(0xf4f2ec);
  const yellowMat = paintMat(0xf2b630);
  const wm = new THREE.Mesh(mergeGeometries(strip(white)), whiteMat);
  const ym = new THREE.Mesh(mergeGeometries(strip(yellow)), yellowMat);
  wm.receiveShadow = ym.receiveShadow = true;
  scene.add(wm, ym);
  // 노면 속도 표시 '50' (고려대로 동쪽, 안암 방향)
  const n50 = new THREE.MeshStandardMaterial({ map: roadNumberTexture('50'), transparent: true, depthWrite: false, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (const z of [L.EB_IN, L.EB_OUT]) {
    const g = new THREE.PlaneGeometry(1.5, 3.4);
    g.rotateX(-Math.PI / 2);
    g.rotateY(-Math.PI / 2);
    g.translate(30, Y + 0.002, z);
    scene.add(new THREE.Mesh(g, n50));
  }

  // ── 먼 길 (시뮬레이션 범위 150 m 밖, 보이기만 함): 도로·보도·차선을 420 m까지 이어 지평선이 끊기지 않게
  {
    const FAR = 420;
    const fr = [], fs = [], fw = [], fy = [];
    for (const sg of [-1, 1]) {
      fr.push(worldUV(rectGeo(-NS, NS, Math.min(sg * E, sg * FAR), Math.max(sg * E, sg * FAR), 0), AT));
      fr.push(worldUV(rectGeo(Math.min(sg * E, sg * FAR), Math.max(sg * E, sg * FAR), -EW, EW, 0), AT));
      for (const side of [-1, 1]) {
        // 보문로 양쪽 보도 / 고려대로 양쪽 보도 (연석 높이의 평판)
        const a = Math.min(sg * E, sg * FAR), b = Math.max(sg * E, sg * FAR);
        fs.push(worldUV(rectGeo(side > 0 ? NS : -NS - G.SIDEWALK, side > 0 ? NS + G.SIDEWALK : -NS, a, b, baseY), 1));
        fs.push(worldUV(rectGeo(a, b, side > 0 ? EW : -EW - G.SIDEWALK, side > 0 ? EW + G.SIDEWALK : -EW, baseY), 1));
        // 차선 점선
        for (let d = E + 3; d < FAR; d += 10) {
          const d0 = sg * d, d1 = sg * (d + 4);
          fw.push(rectGeo(side * 3.25 - 0.075, side * 3.25 + 0.075, Math.min(d0, d1), Math.max(d0, d1), Y));
          fw.push(rectGeo(Math.min(d0, d1), Math.max(d0, d1), side * (G.MEDIAN + 3.2) - 0.075, side * (G.MEDIAN + 3.2) + 0.075, Y));
        }
      }
      const a = Math.min(sg * E, sg * FAR), b = Math.max(sg * E, sg * FAR);
      fy.push(rectGeo(-0.24, -0.1, a, b, Y), rectGeo(0.1, 0.24, a, b, Y));
      fy.push(rectGeo(a, b, -0.24, -0.1, Y), rectGeo(a, b, 0.1, 0.24, Y));
    }
    const farRoad = new THREE.Mesh(mergeGeometries(fr), roadMat);
    farRoad.receiveShadow = true;
    const farWalk = new THREE.Mesh(mergeGeometries(fs), paverMat);
    farWalk.receiveShadow = true;
    scene.add(farRoad, farWalk, new THREE.Mesh(mergeGeometries(strip(fw)), whiteMat), new THREE.Mesh(mergeGeometries(strip(fy)), yellowMat));
  }

  // ── 건물 (1층 상가 + 층별 외벽 + 옥상 설비 — real/cityblocks.js)
  const extraMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 });
  performance.measure('ground+markings', 't0');
  performance.mark('c0');
  const city = createCityBlocks(scene, W, { baseY });
  const overlaps = (x0, x1, z0, z1) => W.occluders.some((o) => x0 < o.x1 + 0.5 && x1 > o.x0 - 0.5 && z0 < o.z1 + 0.5 && z1 > o.z0 - 0.5)
    || (x0 < SITE.x1 && x1 > SITE.x0 && z0 < SITE.z1 && z1 > SITE.z0) || (x0 < PARK.x1 && x1 > PARK.x0 && z0 < PARK.z1 && z1 > PARK.z0);
  const addBuilding = (x0, x1, z0, z1, h, v) => {
    if (overlaps(x0, x1, z0, z1)) return null;
    const top = city.add(x0, x1, z0, z1, h, v);
    W.occluders.push({ x0, x1, z0, z1, h: top - baseY, kind: 'bld' });
    return top;
  };

  // 모퉁이 블록 (거리뷰 참고) — [x0, x1, z0, z1, 높이, 외관]
  // 외관: 0 베이지 상가 · 1 유리 오피스 · 2 벽돌·타일 · 3 회색 콘크리트 · 4 아파트
  const B = [
    // 북동 — 성북구청·고려대 쪽 상가 모퉁이
    [BX, 24, -25, -BZ, 13.6, 0], [BX, 23, -41, -27, 10.2, 3], [BX, 25, -62, -43, 22, 1],
    [26, 34, -24, -BZ, 10.2, 3], [36, 46, -27, -BZ, 20.4, 2], [48, 58, -23, -BZ, 13.6, 0],
    [27, 52, -58, -30, 34, 4], [60, 74, -26, -BZ, 17, 3],
    // 북서 — 주황 간판 치과 모퉁이
    [-23, -BX, -22, -BZ, 10.2, 0], [-26, -14, -40, -24, 23.8, 2], [-36, -25, -24, -BZ, 10.2, 3],
    [-52, -38, -26, -BZ, 17, 1], [-52, -28, -60, -30, 31, 4], [-25, -BX, -60, -42, 13.6, 0], [-70, -56, -24, -BZ, 20, 0],
    // 남서 — 갈색 타일 건물 모퉁이
    [-25, -BX, BZ, 26, 17, 2], [-38, -27, BZ, 24, 10.2, 0], [-56, -40, BZ, 30, 22, 1],
    [-24, -BX, 28, 44, 12, 3], [-52, -28, 32, 58, 30, 4], [-24, -BX, 46, 62, 18, 0],
    // 남동 — 공사장 뒤 고층 아파트
    [16, 30, 42, 54, 72, 4], [34, 48, 40, 52, 66, 4], [52, 66, 40, 52, 60, 4],
    [BX, 24, 58, 72, 16, 0], [66, 80, BZ, 28, 18, 3],
  ];
  for (const b of B) addBuilding(...b);
  // 먼 블록 (도로를 따라 스카이라인)
  let seed = 3;
  const rr = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const sx of [-1, 1]) {
    for (let z = 76; z < 140; z += 20 + rr() * 6) {
      for (const sz of [-1, 1]) {
        const len = 14 + rr() * 6, wid = 14 + rr() * 12, h = 14 + rr() * 46;
        const x0 = sx > 0 ? BX : -BX - wid, zz = sz * z;
        addBuilding(x0, x0 + wid, Math.min(zz, zz + sz * len), Math.max(zz, zz + sz * len), h, (rr() * 5) | 0);
      }
    }
    for (let x = 84; x < 140; x += 18 + rr() * 6) {
      for (const sz of [-1, 1]) {
        const len = 14 + rr() * 4, wid = 14 + rr() * 10, h = 12 + rr() * 40;
        const xx = sx * x, z0 = sz > 0 ? BZ : -BZ - wid;
        addBuilding(Math.min(xx, xx + sx * len), Math.max(xx, xx + sx * len), z0, z0 + wid, h, (rr() * 5) | 0);
      }
    }
    for (let z = 70; z < 150; z += 24) {
      for (let x = 70; x < 150; x += 26) {
        const sz = rr() < 0.5 ? -1 : 1;
        const h = 20 + rr() * 50;
        addBuilding(sx > 0 ? x : -x - 18, sx > 0 ? x + 18 : -x, sz > 0 ? z : -z - 18, sz > 0 ? z + 18 : -z, h, (rr() * 5) | 0);
      }
    }
  }

  // 먼 스카이라인 (150~360 m, 도로를 따라) — 안개 속으로 이어지는 건물 줄
  for (const sx of [-1, 1]) {
    for (let z = 142; z < 360; z += 19 + rr() * 8) {
      for (const sz of [-1, 1]) {
        const len = 14 + rr() * 8, wid = 13 + rr() * 12, h = 12 + rr() * 50;
        const x0 = sx > 0 ? BX : -BX - wid, zz = sz * z;
        addBuilding(x0, x0 + wid, Math.min(zz, zz + sz * len), Math.max(zz, zz + sz * len), h, (rr() * 5) | 0);
      }
    }
    for (let x = 142; x < 360; x += 18 + rr() * 8) {
      for (const sz of [-1, 1]) {
        const len = 14 + rr() * 6, wid = 13 + rr() * 10, h = 12 + rr() * 44;
        const xx = sx * x, z0 = sz > 0 ? BZ : -BZ - wid;
        addBuilding(Math.min(xx, xx + sx * len), Math.max(xx, xx + sx * len), z0, z0 + wid, h, (rr() * 5) | 0);
      }
    }
  }
  city.finish();
  performance.measure('city', 'c0');
  performance.mark('f0');

  // ── 1층 상가 간판 + 층별 띠 간판 (상호는 일반 명칭)
  const signMatOf = (name, bg, fg, sub) => {
    const m = new THREE.MeshStandardMaterial({ map: signTexture(name, { bg, fg, sub }), emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.6 });
    m.emissiveMap = m.map;
    W.night.emissiveSigns.push(m);
    return m;
  };
  // 면 방향: S = +z 쪽을 봄(북쪽 블록의 남쪽 면) …
  const FACE = { S: 0, N: Math.PI, E: Math.PI / 2, W: -Math.PI / 2 };
  const shop = (x, z, face, w, name, bg, fg, level = 0, sub = '') => {
    const grp = new THREE.Group();
    grp.position.set(x, baseY, z);
    grp.rotation.y = FACE[face];
    const sm = signMatOf(name, bg, fg, sub);
    if (level === 0) {
      const sign = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, 0.9, 0.22), [plainGray, plainGray, plainGray, plainGray, sm, plainGray]);
      sign.position.set(0, 3.68, 0.12);
      grp.add(sign);
    } else {
      // 2층 이상 띠 간판: 1층 4.2 m + 층마다 3.2 m, 창 아래 허리벽 높이에
      const sign = new THREE.Mesh(new THREE.BoxGeometry(w, 0.95, 0.16), [plainGray, plainGray, plainGray, plainGray, sm, plainGray]);
      sign.position.set(0, 4.2 + 3.2 * (level - 1) + 0.55, 0.09);
      grp.add(sign);
    }
    grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(grp);
  };
  const o = 0.02;
  // 북동 모퉁이: 떡집·부동산(1층), 한의원(2층 띠), 편의점·죽·안경, 카페, 치과·사진관·신발
  shop(21.2, -BZ + o, 'S', 4.6, '떡집', '#f3e3c2', '#5a3416');
  shop(16.2, -BZ + o, 'S', 4.8, '부동산', '#2f8a4a', '#ffffff');
  shop(18.5, -BZ + o, 'S', 10.2, '한의원', '#f2c230', '#3a2810', 1);
  shop(BX - o, -16.6, 'W', 5.6, '편의점', '#1f6fb2', '#ffffff');
  shop(BX - o, -22.0, 'W', 4.6, '부동산', '#2f8a4a', '#ffffff');
  shop(BX - o, -19.0, 'W', 10.6, '한의원', '#f2c230', '#3a2810', 1);
  shop(BX - o, -30.8, 'W', 5.8, '죽 전문점', '#7a3b1d', '#f6e7c8');
  shop(BX - o, -37.2, 'W', 5.2, '안경', '#2b2b2b', '#ffffff');
  shop(30, -BZ + o, 'S', 6.6, '카페', '#3b2a22', '#f4e2c4');
  shop(38.6, -BZ + o, 'S', 4.6, '사진관', '#30343a', '#ffffff');
  shop(43.6, -BZ + o, 'S', 4.4, '신발', '#c23b22', '#ffffff');
  shop(41, -BZ + o, 'S', 9.2, '치과', '#2b5fa8', '#ffffff', 2);
  // 북서 모퉁이: 주황 띠 치과의원(2층, 두 면), 휴대폰 매장·네일, 분식, 약국
  shop(-BX + o, -17.6, 'E', 8.4, '치과의원', '#e8641f', '#ffffff', 1);
  shop(-18.0, -BZ + o, 'S', 9.6, '치과의원', '#e8641f', '#ffffff', 1);
  shop(-BX + o, -16.2, 'E', 6.0, '휴대폰', '#f4f4f4', '#d4202c', 0, '통신사 대리점');
  shop(-15.8, -BZ + o, 'S', 4.8, '휴대폰', '#f4f4f4', '#d4202c', 0, '통신사 대리점');
  shop(-20.6, -BZ + o, 'S', 4.0, '네일', '#b0567a', '#ffffff');
  shop(-30.5, -BZ + o, 'S', 6.4, '분식', '#f2c230', '#3a2400');
  shop(-BX + o, -51, 'E', 6.0, '약국', '#1FA65A', '#ffffff');
  // 남서 모퉁이: 베이커리·필라테스(3층), 약국·정형외과, 피자·왁싱, 세탁소
  shop(-17.4, BZ - o, 'N', 7.0, '베이커리', '#2c4a2e', '#f3ead6');
  shop(-19.0, BZ - o, 'N', 8.6, '필라테스', '#d23a6a', '#ffffff', 2);
  shop(-BX + o, 17.4, 'E', 5.2, '약국', '#1FA65A', '#ffffff');
  shop(-BX + o, 19.6, 'E', 8.6, '정형외과', '#2b5fa8', '#ffffff', 1);
  shop(-32.5, BZ - o, 'N', 6.2, '피자', '#d8261d', '#ffffff');
  shop(-32.5, BZ - o, 'N', 5.0, '왁싱', '#222222', '#f4d27a', 1);
  shop(-BX + o, 33, 'E', 6.0, '세탁소', '#3d5a80', '#ffffff');

  // ── 남동 공사장: 가림막(흰 패널 + 고려대학교 차세대통신학과 판) + 5번 출구 공사 안내 + Right Guard 현수막
  const hoardTex = hoardingTexture(deptImg);
  // cornerAtEnd: 텍스처 u=1 쪽이 교차로 모퉁이인 면 — 모퉁이에서 한 칸이 온전히 끝나도록 맞추고 잘린 칸은 먼 끝으로
  const hoardMat = (len, cornerAtEnd) => {
    const t = hoardTex.clone();
    t.needsUpdate = true;
    const n = len / HOARD_TILE_M;
    t.repeat.set(n, 1);
    t.offset.set(cornerAtEnd ? -(n - Math.floor(n)) : 0, 0);
    return new THREE.MeshStandardMaterial({ map: t, roughness: 0.75 });
  };
  const plainWall = new THREE.MeshStandardMaterial({ color: 0xe6e8e8, roughness: 0.8 });
  const HH = 3.0;
  const lenX = SITE.x1 - SITE.x0, lenZ = SITE.z1 - SITE.z0;
  const wallX = new THREE.Mesh(new THREE.BoxGeometry(lenX, HH, 0.15), [plainWall, plainWall, plainWall, plainWall, plainWall, hoardMat(lenX, true)]);
  wallX.position.set((SITE.x0 + SITE.x1) / 2, baseY + HH / 2, SITE.z0 + 0.075);
  const wallZ = new THREE.Mesh(new THREE.BoxGeometry(0.15, HH, lenZ), [plainWall, hoardMat(lenZ, false), plainWall, plainWall, plainWall, plainWall]);
  wallZ.position.set(SITE.x0 + 0.075, baseY + HH / 2, (SITE.z0 + SITE.z1) / 2);
  const wallBack = new THREE.Mesh(mergeGeometries([
    boxAt(lenX, HH, 0.15, (SITE.x0 + SITE.x1) / 2, baseY + HH / 2, SITE.z1 - 0.075),
    boxAt(0.15, HH, lenZ, SITE.x1 - 0.075, baseY + HH / 2, (SITE.z0 + SITE.z1) / 2),
  ]), plainWall);
  for (const m of [wallX, wallZ, wallBack]) { m.castShadow = true; m.receiveShadow = true; scene.add(m); }
  W.occluders.push({ x0: SITE.x0, x1: SITE.x1, z0: SITE.z0, z1: SITE.z1, h: HH, kind: 'site' });
  // 5번 출구 공사 중 안내판 — 고려대로 쪽 면, 모퉁이 첫 칸의 학과 판 바로 위
  const plateU0 = (HOARD_TILE_M * 128 - HOARD_PLATE.x1) / 128, plateU1 = (HOARD_TILE_M * 128 - HOARD_PLATE.x0) / 128;
  const plateTop = baseY + 3.0 - HOARD_PLATE.y0 / 128;
  const e5w = plateU1 - plateU0, e5h = (e5w * 128) / 768;
  const exit5 = new THREE.Mesh(new THREE.PlaneGeometry(e5w, e5h), new THREE.MeshStandardMaterial({ map: signTexture('보문역 5번 출구 공사 중', { bg: '#f6c21c', fg: '#1a1a1a', w: 768, h: 128, fs: 0.8 }), roughness: 0.6 }));
  exit5.position.set(SITE.x0 + (plateU0 + plateU1) / 2, plateTop + 0.08 + e5h / 2, SITE.z0 - 0.02);
  exit5.rotation.y = Math.PI;
  scene.add(exit5);
  // Right Guard 현수막 (보문로 쪽 면 — 북행 운전자가 우회전 전에 봄). 모퉁이 첫 칸(문구+학과 판)은 가리지 않도록 그 다음 칸 문구 자리에
  const bbMat = new THREE.MeshStandardMaterial({ map: billboardTexture(emblemImg), emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.6 });
  bbMat.emissiveMap = bbMat.map;
  W.night.emissiveSigns.push(bbMat);
  const banner = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 2.4), bbMat);
  banner.position.set(SITE.x0 - 0.02, baseY + 1.5, SITE.z0 + HOARD_TILE_M + 0.15 + 3.2);
  banner.rotation.y = -Math.PI / 2;
  scene.add(banner);
  // 물통 방호벽 (주황·흰 교대) + 꼬깔
  const bar = [];
  let bi = 0;
  for (let x = BARRIER.x0; x + 1.2 <= BARRIER.x1 + 0.01; x += 1.25, bi++) {
    bar.push(boxAt(1.2, 0.8, 0.45, x + 0.6, baseY + 0.4, BARRIER.z, bi % 2 ? 0xf3f3ef : 0xf07a1a));
  }
  for (const [x, z] of [[NS + 0.55, 17.2], [NS + 0.55, 18.6], [NS + 0.55, 20.0], [15.0, BARRIER.z], [NS + 0.55, 22.4]]) {
    bar.push(cylAt(0.04, 0.2, 0.72, x, baseY + 0.36, z, 0xf06a14, 12));
    bar.push(cylAt(0.11, 0.14, 0.12, x, baseY + 0.42, z, 0xf7f7f2, 12));
    bar.push(boxAt(0.42, 0.04, 0.42, x, baseY + 0.02, z, 0x222222));
  }
  const barMesh = new THREE.Mesh(mergeGeometries(bar), extraMat);
  barMesh.castShadow = true;
  scene.add(barMesh);
  addObstacle(NS + 0.3, NS + 0.8, 16.8, 22.8);

  // ── 지하철 출입구 (유리 상자 + 노란 번호 표지)
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fc4d8, transparent: true, opacity: 0.34, roughness: 0.1, metalness: 0.1, depthWrite: false });
  const frameMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.6 });
  const exitFrames = [], exitGlass = [], exitDark = [], exitRoofs = [];
  const EH = 2.6;
  for (const ex of EXITS) {
    const along = ex.mouth === 'E' || ex.mouth === 'W' ? 'x' : 'z';
    const cx = (ex.x0 + ex.x1) / 2, cz = (ex.z0 + ex.z1) / 2;
    const w = ex.x1 - ex.x0, d = ex.z1 - ex.z0;
    exitFrames.push(boxAt(w, 0.3, d, cx, baseY + 0.15, cz)); // 받침
    exitRoofs.push(boxAt(w + 0.16, 0.16, d + 0.16, cx, baseY + EH + 0.08, cz)); // 지붕 (반투명 유리 캐노피)
    // 기둥 4개
    for (const px of [ex.x0 + 0.06, ex.x1 - 0.06]) for (const pz of [ex.z0 + 0.06, ex.z1 - 0.06]) exitFrames.push(boxAt(0.1, EH, 0.1, px, baseY + EH / 2, pz));
    // 유리 벽 3면 + 막힌 뒷벽 (입구 반대편)
    if (along === 'x') {
      exitGlass.push(boxAt(w, EH - 0.3, 0.04, cx, baseY + 0.3 + (EH - 0.3) / 2, ex.z0 + 0.02));
      exitGlass.push(boxAt(w, EH - 0.3, 0.04, cx, baseY + 0.3 + (EH - 0.3) / 2, ex.z1 - 0.02));
      const backX = ex.mouth === 'E' ? ex.x0 + 0.05 : ex.x1 - 0.05;
      exitFrames.push(boxAt(0.1, EH, d, backX, baseY + EH / 2, cz));
    } else {
      exitGlass.push(boxAt(0.04, EH - 0.3, d, ex.x0 + 0.02, baseY + 0.3 + (EH - 0.3) / 2, cz));
      exitGlass.push(boxAt(0.04, EH - 0.3, d, ex.x1 - 0.02, baseY + 0.3 + (EH - 0.3) / 2, cz));
      const backZ = ex.mouth === 'S' ? ex.z0 + 0.05 : ex.z1 - 0.05;
      exitFrames.push(boxAt(w, EH, 0.1, cx, baseY + EH / 2, backZ));
    }
    exitDark.push(boxAt(w - 0.3, 0.05, d - 0.3, cx, baseY + 0.31, cz)); // 내려가는 계단 (어두운 바닥)
    // 번호 표지: 입구 위 + 도로 쪽 옆면
    const sMat = new THREE.MeshStandardMaterial({ map: exitSignTexture(ex.n), emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.5 });
    sMat.emissiveMap = sMat.map;
    W.night.emissiveSigns.push(sMat);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.72), sMat);
    const side = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.72), sMat);
    const yS = baseY + EH + 0.55;
    if (ex.mouth === 'E') { sign.position.set(ex.x1 + 0.02, yS, cz); sign.rotation.y = Math.PI / 2; }
    if (ex.mouth === 'W') { sign.position.set(ex.x0 - 0.02, yS, cz); sign.rotation.y = -Math.PI / 2; }
    if (ex.mouth === 'S') { sign.position.set(cx, yS, ex.z1 + 0.02); sign.rotation.y = 0; }
    if (ex.mouth === 'N') { sign.position.set(cx, yS, ex.z0 - 0.02); sign.rotation.y = Math.PI; }
    // 도로 쪽 옆면 (출구 상자는 연석 쪽에 있음)
    const ySide = baseY + EH - 0.5; // 도로 쪽 유리벽 윗부분에 붙임
    if (along === 'x') {
      const roadSide = cz > 0 ? ex.z0 : ex.z1;
      const sx = ex.mouth === 'E' ? ex.x1 - 1.3 : ex.x0 + 1.3; // 입구 쪽으로 치우치게
      side.position.set(sx, ySide, roadSide + (cz > 0 ? -0.04 : 0.04));
      side.rotation.y = cz > 0 ? Math.PI : 0;
    } else {
      const roadSide = cx > 0 ? ex.x0 : ex.x1;
      const sz = ex.mouth === 'S' ? ex.z1 - 1.3 : ex.z0 + 1.3;
      side.position.set(roadSide + (cx > 0 ? -0.04 : 0.04), ySide, sz);
      side.rotation.y = cx > 0 ? -Math.PI / 2 : Math.PI / 2;
    }
    // 표지 받침대
    const holder = new THREE.Mesh(new THREE.BoxGeometry(along === 'x' ? 0.12 : 2.4, 0.86, along === 'x' ? 2.4 : 0.12), frameMat);
    holder.position.copy(sign.position);
    if (ex.mouth === 'E') holder.position.x -= 0.08;
    if (ex.mouth === 'W') holder.position.x += 0.08;
    if (ex.mouth === 'S') holder.position.z -= 0.08;
    if (ex.mouth === 'N') holder.position.z += 0.08;
    scene.add(sign, side, holder);
    W.occluders.push({ x0: ex.x0, x1: ex.x1, z0: ex.z0, z1: ex.z1, h: EH, kind: 'exit', n: ex.n });
  }
  const ef = new THREE.Mesh(mergeGeometries(exitFrames), frameMat);
  ef.castShadow = true;
  const eg = new THREE.Mesh(mergeGeometries(exitGlass), glassMat);
  eg.renderOrder = 3;
  const ed = new THREE.Mesh(mergeGeometries(exitDark), new THREE.MeshStandardMaterial({ color: 0x16181b, roughness: 0.9 }));
  const er = new THREE.Mesh(mergeGeometries(exitRoofs), new THREE.MeshStandardMaterial({ color: 0xb9c6cf, roughness: 0.25, metalness: 0.3, transparent: true, opacity: 0.82 }));
  er.castShadow = true;
  scene.add(ef, eg, ed, er);

  // ── 버스 정류장 (보문로 북쪽 동편, 성북구청 방면)
  const shelter = new THREE.Group();
  const SHZ = -38;
  shelter.position.set(NS + 0.25, baseY, SHZ);
  shelter.rotation.y = Math.PI / 2;
  const sMat = new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.5, metalness: 0.6 });
  const adMat = new THREE.MeshStandardMaterial({ map: signTexture('보문역', { bg: '#1d5f8a', fg: '#ffffff', sub: '버스 정류장 · 성북구청 방면', w: 256, h: 256 }), emissive: 0xffffff, emissiveIntensity: 0.05 });
  adMat.emissiveMap = adMat.map;
  W.night.emissiveSigns.push(adMat);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.12, 1.3), sMat);
  roof.position.set(0, 2.6, 0.58);
  const back = new THREE.Mesh(new THREE.BoxGeometry(4.2, 2.3, 0.05), glassMat);
  back.position.set(0, 1.35, 1.12);
  const ad = new THREE.Mesh(new THREE.BoxGeometry(0.12, 2.3, 1.1), [adMat, adMat, sMat, sMat, sMat, sMat]);
  ad.position.set(-2.1, 1.35, 0.6);
  const posts = new THREE.Mesh(mergeGeometries([cylAt(0.05, 0.05, 2.6, 2.1, 1.3, 1.12), cylAt(0.05, 0.05, 2.6, -2.1, 1.3, 1.12), cylAt(0.05, 0.05, 2.6, 2.1, 1.3, 0.1)]), sMat);
  const bench = new THREE.Mesh(boxAt(2.6, 0.08, 0.45, 0.4, 0.48, 0.8), new THREE.MeshStandardMaterial({ color: 0x8a6a4a }));
  roof.castShadow = ad.castShadow = true;
  shelter.add(roof, back, ad, posts, bench);
  scene.add(shelter);
  addObstacle(NS, NS + 1.6, SHZ - 2.3, SHZ + 2.3);

  // ── 거리 시설물 (real/street3d.js) — 같은 재질끼리 마지막에 한 덩어리로 합침
  const furniture = [];
  const placeParts = (parts, x, y, z, rotY = 0) => furniture.push({ parts, matrix: new THREE.Matrix4().makeRotationY(rotY).setPosition(x, y, z) });
  const armRot = (x0, z0, x1, z1) => Math.atan2(-(z1 - z0), x1 - x0); // 로컬 +X 팔을 (x1−x0, z1−z0) 쪽으로
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x8f969c, roughness: 0.42, metalness: 0.75 });
  W.poleMat = poleMat;

  // ── 차량 신호등: 건너편 모퉁이의 ㄱ자 지주 + 가로형 4구(적·황·좌회전·녹)
  const ARM_Y = 6.35;
  const nPostZ = G.CW.N.z0 - 1.3, ePostX = G.CW.E.x1 + 1.3;
  const vehPosts = [
    { x: NS + 0.75, z: nPostZ, armTo: [0.6, nPostZ], heads: [[L.NB_OUT, nPostZ], [L.NB_IN, nPostZ]], face: 0, group: 'NS' },
    { x: -NS - 0.75, z: -nPostZ, armTo: [-0.6, -nPostZ], heads: [[L.SB_OUT, -nPostZ], [L.SB_IN, -nPostZ]], face: Math.PI, group: 'NS' },
    { x: ePostX, z: EW + 0.75, armTo: [ePostX, 0.5], heads: [[ePostX, L.EB_OUT], [ePostX, L.EB_IN]], face: -Math.PI / 2, group: 'EW' },
    { x: -ePostX, z: -EW - 0.75, armTo: [-ePostX, -0.5], heads: [[-ePostX, L.WB_OUT], [-ePostX, L.WB_IN]], face: Math.PI / 2, group: 'EW' },
  ];
  for (const p of vehPosts) {
    const len = Math.hypot(p.armTo[0] - p.x, p.armTo[1] - p.z);
    const mast = signalMastParts({ height: ARM_Y + 0.55, armLength: len + 0.4, armY: ARM_Y });
    placeParts(mast.parts, p.x, baseY, p.z, armRot(p.x, p.z, p.armTo[0], p.armTo[1]));
    for (const [hx, hz] of p.heads) {
      const h = signalHead({ lamps: 4 });
      const dx = Math.hypot(hx - p.x, hz - p.z);
      h.group.position.set(hx, baseY + ARM_Y + 0.04 * dx - 0.085, hz);
      h.group.rotation.y = p.face;
      scene.add(h.group);
      W.vehSignals.push({ group: p.group, lamps: h.lamps });
    }
    addObstacle(p.x - 0.2, p.x + 0.2, p.z - 0.2, p.z + 0.2);
  }

  // ── 방향 표지 (보문로 동쪽 접근 · 고려대로 남쪽 접근)
  const gantry = (px, pz, toX, toZ, face, tex, label) => {
    const len = Math.hypot(toX - px, toZ - pz);
    const mast = signalMastParts({ height: 8.0, armLength: len, armY: 7.3 });
    placeParts(mast.parts, px, baseY, pz, armRot(px, pz, toX, toZ));
    const m = new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveIntensity: 0.05, roughness: 0.55 });
    m.emissiveMap = m.map;
    W.night.emissiveSigns.push(m);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(6.0, 2.62, 0.12), [plainGray, plainGray, plainGray, plainGray, m, plainGray]);
    const cx = px + (toX - px) * 0.52, cz = pz + (toZ - pz) * 0.52;
    panel.position.set(cx, 5.75, cz);
    panel.rotation.y = face;
    const pm = new THREE.MeshStandardMaterial({ map: placeSignTexture(label), roughness: 0.55 });
    const small = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.66, 0.1), [plainGray, plainGray, plainGray, plainGray, pm, plainGray]);
    small.position.set(cx, 7.95, cz);
    small.rotation.y = face;
    panel.castShadow = small.castShadow = true;
    scene.add(panel, small);
    addObstacle(px - 0.3, px + 0.3, pz - 0.3, pz + 0.3);
  };
  gantry(36, -EW - 0.9, 36, -0.4, Math.PI / 2,
    directionSignTexture({ road: G.NAMES.NS, roadEn: 'Bomun-ro', left: G.NAMES.S, up: G.NAMES.W, right: G.NAMES.N }), '보문역');
  gantry(NS + 0.9, 36, 0.4, 36, 0,
    directionSignTexture({ road: G.NAMES.EW, roadEn: 'Goryeodae-ro', left: G.NAMES.W, up: G.NAMES.N, right: G.NAMES.E }), '보문역');

  // ── 신호·과속 단속 장비 + 제한속도 50 (보문로 북쪽)
  const camZ = -16.8;
  {
    const mast = signalMastParts({ height: 7.1, armLength: NS + 0.3, armY: 6.55 });
    placeParts(mast.parts, NS + 1.1, baseY, camZ, armRot(NS + 1.1, camZ, 0.8, camZ));
  }
  const camBox = new THREE.Mesh(mergeGeometries([boxAt(0.5, 0.42, 0.8, 3.2, 6.25, camZ, 0xdfe2e4), boxAt(0.36, 0.3, 0.06, 3.2, 6.25, camZ + 0.42, 0x1b1d20)]), extraMat);
  camBox.castShadow = true;
  scene.add(camBox);
  const enfMat = new THREE.MeshStandardMaterial({ map: enforcementSignTexture(), roughness: 0.55 });
  const enf = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), enfMat);
  enf.position.set(5.2, 7.05, camZ + 0.12);
  const lim = new THREE.Mesh(new THREE.CircleGeometry(0.46, 32), new THREE.MeshStandardMaterial({ map: speedLimitTexture(50), roughness: 0.55, transparent: true }));
  lim.position.set(1.5, 7.05, camZ + 0.12);
  scene.add(enf, lim);
  addObstacle(NS + 0.9, NS + 1.3, camZ - 0.2, camZ + 0.2);

  // ── 중앙 분리대 펜스 (고려대로 동쪽) + 차선 분리봉 (보문로 남쪽)
  const fence = [];
  const fx0 = G.CW.E.x1 + 1.0, fx1 = 74;
  for (let x = fx0; x <= fx1; x += 2) {
    fence.push(boxAt(0.08, 0.62, 0.08, x, 0.31, 0, 0xf2c230));
    fence.push(boxAt(0.085, 0.16, 0.085, x, 0.7, 0, 0x1d1d1d));
    fence.push(boxAt(0.08, 0.2, 0.08, x, 0.88, 0, 0xf2c230));
  }
  fence.push(boxAt(fx1 - fx0, 0.05, 0.05, (fx0 + fx1) / 2, 0.55, 0, 0xe8e8e2));
  fence.push(boxAt(fx1 - fx0, 0.05, 0.05, (fx0 + fx1) / 2, 0.95, 0, 0xe8e8e2));
  for (let z = G.STOP.NB + 1.5; z < 42; z += 2.5) {
    fence.push(cylAt(0.06, 0.07, 0.62, 0, 0.31, z, 0xf28c28, 8));
    fence.push(cylAt(0.065, 0.065, 0.12, 0, 0.68, z, 0xf7f7f2, 8));
    fence.push(cylAt(0.06, 0.06, 0.08, 0, 0.78, z, 0xf28c28, 8));
  }
  const fenceMesh = new THREE.Mesh(mergeGeometries(fence), extraMat);
  fenceMesh.castShadow = true;
  scene.add(fenceMesh);

  // ── 보행 신호등 (각 횡단보도 양끝, 건너편을 바라봄) + 잔여시간 표시기
  const ex1 = G.CW.E.x1 + 0.3, sz1 = G.CW.S.z1 + 0.3;
  const pedPosts = [
    { cw: 'E', x: ex1, z: -EW - 0.4, face: 0 }, { cw: 'E', x: ex1, z: EW + 0.4, face: Math.PI },
    { cw: 'W', x: -ex1, z: -EW - 0.4, face: 0 }, { cw: 'W', x: -ex1, z: EW + 0.4, face: Math.PI },
    { cw: 'S', x: -NS - 0.4, z: sz1, face: Math.PI / 2 }, { cw: 'S', x: NS + 0.4, z: sz1, face: -Math.PI / 2 },
    { cw: 'N', x: -NS - 0.4, z: -sz1, face: Math.PI / 2 }, { cw: 'N', x: NS + 0.4, z: -sz1, face: -Math.PI / 2 },
  ];
  const pedPoleGeos = [];
  for (const p of pedPosts) {
    pedPoleGeos.push(cylAt(0.065, 0.075, 3.05, p.x, baseY + 1.525, p.z, undefined, 12));
    const h = pedSignalHead();
    // 머리 뒷면의 걸이가 지주(z≈−0.17)에 닿도록
    h.group.position.set(p.x + Math.sin(p.face) * 0.17, baseY + 2.55, p.z + Math.cos(p.face) * 0.17);
    h.group.rotation.y = p.face;
    scene.add(h.group);
    W.pedSignals.push({ cw: p.cw, r: h.r, g: h.g, setCountdown: h.setCountdown });
    addObstacle(p.x - 0.1, p.x + 0.1, p.z - 0.1, p.z + 0.1);
  }
  const pedPoleMesh = new THREE.Mesh(mergeGeometries(pedPoleGeos), poleMat);
  pedPoleMesh.castShadow = true;
  scene.add(pedPoleMesh);

  // ── 볼라드 (횡단보도 진입부)
  const bol = [];
  for (const k of ['E', 'W']) {
    const c = G.CW[k];
    for (const s of [-1, 1]) for (const x of [c.x0 + 0.25, c.x1 - 0.25]) bol.push(cylAt(0.11, 0.11, 0.8, x, baseY + 0.4, s * (EW + 0.35), 0x6c6f73));
  }
  for (const k of ['N', 'S']) {
    const c = G.CW[k];
    for (const s of [-1, 1]) for (const z of [c.z0 + 0.25, c.z1 - 0.3]) bol.push(cylAt(0.11, 0.11, 0.8, s * (NS + 0.35), baseY + 0.4, z, 0x6c6f73));
  }
  const bolMesh = new THREE.Mesh(mergeGeometries(bol), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }));
  bolMesh.castShadow = true;
  scene.add(bolMesh);

  // ── 가로수 (InstancedMesh) — 출구·정류장·표지 기둥을 피해서
  const treeSpots = [];
  for (const sx of [-1, 1]) {
    for (let z = 30; z < 140; z += 10.5) for (const sz of [-1, 1]) treeSpots.push([sx * (NS + 0.9), sz * z]);
    for (let x = 24; x < 140; x += 11) for (const sz of [-1, 1]) treeSpots.push([sx * x, sz * (EW + 0.9)]);
  }
  for (let i = 0; i < 12; i++) treeSpots.push([PARK.x0 + 2.5 + (i % 4) * 5.4 + (i % 3) * 0.6, PARK.z0 + 3 + Math.floor(i / 4) * 7.2]);
  // 공사장 쪽(보문로 동편·고려대로 남편) 앞에는 가로수 없음 — 거리뷰와 같게, 가림막·현수막이 보이도록
  const nearSite = (x, z) => (x > 0 && z > 0 && x < NS + 2 && z < 62) || (x > 0 && z > 0 && z < EW + 2 && x < SITE.x1 + 3);
  const trees = treeSpots.filter(([x, z]) => !blocked(x, z, 1.4) && !nearSite(x, z));
  // 실사 가로수 (느티나무·플라타너스 변형 3종, real/trees3d.js) + 보도 위 나무 보호 덮개
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  // 가까운 나무는 고해상, 먼 나무는 저해상 (카메라 위치에 따라 main.js 가 W.trees.update 호출)
  performance.measure('furniture-a', 'f0');
  performance.mark('tr0');
  const field = createTreeField(scene, trees, { baseY, seed: 7 });
  performance.measure('trees', 'tr0');
  performance.mark('f1');
  const inPark = (x, z) => x > PARK.x0 && x < PARK.x1 && z > PARK.z0 && z < PARK.z1;
  const grateSpots = trees.filter(([x, z]) => !inPark(x, z));
  if (grateSpots.length) {
    const gr = buildTreeGrate();
    const grates = new THREE.InstancedMesh(gr.geo, gr.mat, grateSpots.length);
    grateSpots.forEach(([x, z], k) => {
      m4.compose(pos.set(x, baseY + 0.004, z), q.identity(), sc.set(1, 1, 1));
      grates.setMatrixAt(k, m4);
    });
    grates.receiveShadow = true;
    grates.computeBoundingSphere();
    scene.add(grates);
  }
  for (const [x, z] of trees) addObstacle(x - 0.5, x + 0.5, z - 0.5, z + 0.5);
  W.trees = trees;
  W.treeField = field;

  // ── LED 가로등 (보도 연석 쪽, 팔이 차로 위로) + 밤에만 켜지는 빛무리·노면 불빛
  const lampSpots = [];
  for (const sx of [-1, 1]) for (let z = 22; z < 140; z += 24) for (const sz of [-1, 1]) lampSpots.push([sx * (NS + 0.45), sz * z, sx > 0 ? -1 : 1, 'x']);
  for (const sx of [-1, 1]) for (let x = 22; x < 140; x += 24) for (const sz of [-1, 1]) lampSpots.push([sx * x, sz * (EW + 0.45), sz > 0 ? -1 : 1, 'z']);
  const lamps = lampSpots.filter(([x, z]) => !blocked(x, z, 1.0));
  const lampKit = streetLampParts({ height: 9.6, arm: 2.0 });
  W.night.lampMats.push(lampKit.headMaterial);
  const glowTex = radialTexture('rgba(255,226,170,1)', 'rgba(255,226,170,0)');
  W.glowTex = glowTex;
  const poolMat = new THREE.MeshBasicMaterial({ map: glowTex, color: 0xffd08a, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  const poolGeo = new THREE.PlaneGeometry(11, 11);
  poolGeo.rotateX(-Math.PI / 2);
  const lp = new THREE.Vector3();
  for (const [x, z, dir, axis] of lamps) {
    const ry = axis === 'x' ? (dir > 0 ? 0 : Math.PI) : (dir > 0 ? -Math.PI / 2 : Math.PI / 2);
    placeParts(lampKit.parts, x, baseY, z, ry);
    addObstacle(x - 0.25, x + 0.25, z - 0.25, z + 0.25);
    const M = new THREE.Matrix4().makeRotationY(ry).setPosition(x, baseY, z);
    for (const p of lampKit.lightPoints) {
      lp.copy(p).applyMatrix4(M);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffd9a0, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.85 }));
      sp.position.copy(lp).y -= 0.08;
      sp.scale.set(2.6, 2.6, 1);
      sp.visible = false;
      scene.add(sp);
      W.night.glowSprites.push(sp);
      const pool = new THREE.Mesh(poolGeo, poolMat);
      pool.position.set(lp.x, groundY(lp.x, lp.z) + 0.02, lp.z);
      pool.visible = false;
      pool.renderOrder = 2;
      scene.add(pool);
      W.night.glowSprites.push(pool);
    }
  }
  // 야간 실광원 (교차로 네 모퉁이 + 우회전 접근로)
  for (const [x, z] of [[9.5, 9.5], [-9.5, 9.5], [9.5, -9.5], [-9.5, -9.5], [5.5, 26]]) {
    const pl = new THREE.PointLight(0xffd7a0, 0, 30, 1.6);
    pl.position.set(x, 6.8, z);
    scene.add(pl);
    W.night.pointLights.push(pl);
  }

  // ── 콘크리트 전신주 + 늘어진 전선 (거리뷰처럼 교차로 위를 가로지르는 선 포함)
  const poleRuns = []; // 같은 줄(같은 쪽 보도)의 전주들
  const tryPole = (x, z, rotY, k) => {
    for (const dd of [0, 2.5, -2.5, 5]) {
      const xx = rotY === 0 ? x : x + Math.sign(x) * dd, zz = rotY === 0 ? z + Math.sign(z) * dd : z;
      if (!blocked(xx, zz, 0.8)) {
        const kit = utilityPoleParts({ height: 11, transformer: k % 3 === 1, seed: 17 + k });
        placeParts(kit.parts, xx, baseY, zz, rotY);
        addObstacle(xx - 0.3, xx + 0.3, zz - 0.3, zz + 0.3);
        const M = new THREE.Matrix4().makeRotationY(rotY).setPosition(xx, baseY, zz);
        return { x: xx, z: zz, power: kit.attach.power.map((v) => v.clone().applyMatrix4(M)), comm: kit.attach.comm.map((v) => v.clone().applyMatrix4(M)) };
      }
    }
    return null;
  };
  let pk = 0;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    // 보문로 (남북) — 전선이 z 방향
    const runA = [];
    for (let d = 25; d < 142; d += 31) {
      if (sx > 0 && sz > 0 && d < 66) continue; // 남동 공사장 가림막 앞은 비움
      const p = tryPole(sx * (NS + 0.62), sz * d, 0, pk++);
      if (p) runA.push(p);
    }
    poleRuns.push(runA);
    // 고려대로 (동서) — 전선이 x 방향
    const runB = [];
    for (let d = 26; d < 142; d += 31) {
      if (sx > 0 && sz > 0 && d < 46) continue;
      const p = tryPole(sx * d, sz * (EW + 0.62), Math.PI / 2, pk++);
      if (p) runB.push(p);
    }
    poleRuns.push(runB);
  }
  const spans = [];
  const link = (a, b, which, n = 9) => {
    const A = a[which], B = b[which];
    for (let i = 0; i < Math.min(A.length, B.length, n); i++) spans.push([A[i], B[i]]);
  };
  for (const run of poleRuns) {
    for (let i = 0; i + 1 < run.length; i++) { link(run[i], run[i + 1], 'power'); link(run[i], run[i + 1], 'comm'); }
  }
  // 교차로 위를 가로지르는 통신선: 같은 길의 맞은편 첫 전주끼리, 그리고 모퉁이 대각선
  const first = (i) => poleRuns[i][0];
  const cross = [[0, 4], [1, 3], [2, 6], [5, 7], [0, 1], [4, 5], [6, 7]];
  for (const [i, j] of cross) {
    const a = first(i), b = first(j);
    if (a && b) link(a, b, 'comm', 3);
  }
  if (spans.length) {
    const wires = new THREE.Mesh(wireGeometry(spans, { sagPerMeter: 0.022, sagJitter: 0.25, seed: 5 }), wireMaterial);
    wires.userData.noAO = true;
    scene.add(wires);
  }

  // ── 보행자 방호 울타리 (남동 모퉁이 제외 — 공사장 물통 방벽이 있음)
  const fenceKit = (len) => pedFenceParts({ length: len }).parts;
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1]]) {
    // 보문로 쪽: 연석 따라 z 방향
    const z0 = sz * (G.WALK_Z + 2.4), z1 = sz * (G.WALK_Z + 12.4);
    const xF = sx * (NS + 0.28);
    let ok = true;
    for (let t = 0; t <= 1; t += 0.1) if (blocked(xF, z0 + (z1 - z0) * t, 0.35)) ok = false;
    if (ok) placeParts(fenceKit(10), xF, baseY, z0, armRot(xF, z0, xF, z1));
    // 고려대로 쪽: x 방향
    const x0 = sx * (G.WALK_X + 2.4), x1 = sx * (G.WALK_X + 12.4);
    const zF = sz * (EW + 0.28);
    ok = true;
    for (let t = 0; t <= 1; t += 0.1) if (blocked(x0 + (x1 - x0) * t, zF, 0.35)) ok = false;
    if (ok) placeParts(fenceKit(10), x0, baseY, zF, armRot(x0, zF, x1, zF));
  }

  // ── 방범 CCTV 기둥 (남서 모퉁이)
  for (const [x, z] of [[-(NS + 0.7), 27.5], [-(NS + 0.7), 31], [-(NS + 0.7), 24]]) {
    if (!blocked(x, z, 0.6)) { placeParts(cctvPoleParts().parts, x, baseY, z, 0); addObstacle(x - 0.3, x + 0.3, z - 0.3, z + 0.3); break; }
  }

  // ── 맨홀 뚜껑 (도로 위 데칼)
  const mh = manholeSet();
  const mhMat = new THREE.MeshStandardMaterial({ map: mh.map, normalMap: mh.normalMap || null, roughnessMap: mh.roughnessMap || null, metalnessMap: mh.metalnessMap || null, roughness: 1, metalness: mh.metalnessMap ? 1 : 0.3, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  const mhGeo = new THREE.PlaneGeometry(0.95, 0.95);
  mhGeo.rotateX(-Math.PI / 2);
  for (const [x, z, r] of [[3.4, 21.5, 0.3], [-2.6, -31, 1.1], [24.5, 2.2, 0.7], [-27, -3.6, 2.0], [1.9, 47, 0.2], [-41, 2.9, 1.4], [3.0, -52, 2.6], [52, -4.1, 0.9]]) {
    const m = new THREE.Mesh(mhGeo, mhMat);
    m.position.set(x, 0.012, z);
    m.rotation.y = r;
    m.receiveShadow = true;
    m.renderOrder = 1;
    scene.add(m);
  }

  // 시설물 합치기 (재질별 한 덩어리)
  for (const m of mergePartsInstances(furniture)) scene.add(m);
  performance.measure('furniture-b', 'f1');

  return W;
}

// 신호등 표시 갱신
export function updateSignalViews(W, signals, t) {
  for (const v of W.vehSignals) {
    const s = signals.veh(v.group);
    v.lamps.R.color.setHex(s === 'R' ? 0xff3b2f : 0x2a1210);
    v.lamps.Y.color.setHex(s === 'Y' ? 0xffb21a : 0x2a2210);
    v.lamps.G.color.setHex(s === 'G' ? 0x22e07a : 0x0f2418);
    if (v.lamps.L) v.lamps.L.color.setHex(0x0f2418); // 좌회전 화살표 (이 시뮬레이션에는 보호 좌회전 현시가 없음)
  }
  const blink = Math.floor(t * 2.5) % 2 === 0;
  for (const p of W.pedSignals) {
    const s = signals.ped(p.cw);
    p.r.color.setHex(s === 'D' ? 0xffffff : 0x2a2a2a);
    p.g.color.setHex(s === 'W' || (s === 'F' && blink) ? 0xffffff : 0x2a2a2a);
    if (p.setCountdown) {
      const rem = signals.pedRemaining(p.cw);
      p.setCountdown(s !== 'D' && Number.isFinite(rem) ? Math.ceil(rem) : null);
    }
  }
}
