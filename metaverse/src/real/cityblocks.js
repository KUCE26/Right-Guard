// 보문역 사거리 건물 — 1층 상가(4.2 m) + 층별 외벽(3.2 m) + 초록 방수 옥상 + 옥상 설비 · 실외기 · 돌출 간판
// 같은 재질끼리 한 덩어리로 합쳐 그리기 호출을 줄인다.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { facadeSet, roofSet } from './textures3d.js';
import { rooftopParts, acUnitParts, projectingSign, mergePartsInstances } from './street3d.js';

// 예전 외관 번호 → 실사 외벽 종류 (0 베이지 타일 상가 · 1 유리 오피스 · 2 붉은 벽돌 · 3 회색 콘크리트 · 4 아파트)
export const FACADE_KINDS = ['tile_cream', 'glass_curtain', 'brick_red', 'concrete_gray', 'apartment'];
const FLOOR_H = 3.2;
const SHOP_H = 4.2;
// 옥상 난간 · 1층 위 띠 색 (외벽 종류별)
const TRIM = { tile_cream: 0xd8cdb8, glass_curtain: 0x5d646b, brick_red: 0x9a5a44, concrete_gray: 0xa9aaa6, apartment: 0xe8e4dc };
// 돌출 간판 (일반 업종명만)
const SIGNS = [
  ['약국', '#1FA65A', '#ffffff'], ['내과', '#2b5fa8', '#ffffff'], ['학원', '#f2c230', '#2a1c00'], ['노래방', '#7a2fb0', '#ffe14d'],
  ['PC방', '#1d1d1d', '#39d0ff'], ['호프', '#c8341f', '#ffffff'], ['부동산', '#2f8a4a', '#ffffff'], ['안경', '#222222', '#ffffff'],
  ['미용실', '#d23a6a', '#ffffff'], ['헬스', '#e8641f', '#ffffff'], ['한의원', '#7a3b1d', '#f6e7c8'], ['치과', '#2b5fa8', '#ffffff'],
  ['당구장', '#24563a', '#ffffff'], ['세탁', '#3d5a80', '#ffffff'], ['국밥', '#8c2a1a', '#fff3d6'], ['카페', '#3b2a22', '#f4e2c4'],
];

function rng(seed) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 벽 한 면 (바깥 법선 nx,nz · 바닥 가운데 cx,y0,cz · 너비 w · 높이 h · uv 반복 ru,rv)
function wallGeo(cx, y0, cz, nx, nz, w, h, ru, rv, u0 = 0) {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * ru, uv.getY(i) * rv);
  g.rotateY(Math.atan2(nx, nz));
  g.translate(cx, y0 + h / 2, cz);
  return g;
}
function colored(g, hex) {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (g.index) return g.toNonIndexed();
  return g;
}
function box(w, h, d, x, y, z, hex) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return colored(g, hex);
}

export function createCityBlocks(scene, W, { baseY = 0, detailRadius = 95 } = {}) {
  const groups = new Map(); // 재질 키 → { mat, tileW, bays, geos }
  const facade = (kind, variant) => {
    const key = `${kind}:${variant}`;
    if (!groups.has(key)) {
      const set = facadeSet(kind, { seed: 11 + variant * 7, bays: 4 });
      const orm = set.roughnessMap || null;
      const mat = new THREE.MeshStandardMaterial({
        map: set.map,
        normalMap: set.normalMap || null,
        roughnessMap: orm,
        metalnessMap: set.metalnessMap || null,
        roughness: orm ? 1 : 0.85,
        metalness: set.metalnessMap ? 1 : 0.05,
      });
      if (set.emissiveMap) {
        mat.emissiveMap = set.emissiveMap;
        mat.emissive = new THREE.Color(0xffe3b8);
        mat.emissiveIntensity = 0;
        W.night.windowMats.push(mat);
      }
      const size = set.size || [6.4, kind === 'storefront' ? SHOP_H : FLOOR_H];
      groups.set(key, { mat, tileW: size[0], tileH: size[1], bays: 4, geos: [] });
    }
    return groups.get(key);
  };
  const roof = (() => {
    const set = roofSet();
    const mat = new THREE.MeshStandardMaterial({
      map: set.map, normalMap: set.normalMap || null, roughnessMap: set.roughnessMap || null, roughness: set.roughnessMap ? 1 : 0.9,
    });
    return { mat, tile: (set.size && set.size[0]) || 6, geos: [] };
  })();
  const trimGeos = [];
  const props = []; // { parts, matrix }
  const signMats = [];
  let nb = 0;

  // 한 면의 uv 가로 반복: 창 칸(bay)이 잘리지 않게 정수 칸으로 맞춤
  const bayRepeat = (grp, width) => {
    const bayW = grp.tileW / grp.bays;
    return Math.max(1, Math.round(width / bayW)) / grp.bays;
  };
  const faces = (x0, x1, z0, z1) => [
    { cx: (x0 + x1) / 2, cz: z1, nx: 0, nz: 1, w: x1 - x0 },
    { cx: (x0 + x1) / 2, cz: z0, nx: 0, nz: -1, w: x1 - x0 },
    { cx: x1, cz: (z0 + z1) / 2, nx: 1, nz: 0, w: z1 - z0 },
    { cx: x0, cz: (z0 + z1) / 2, nx: -1, nz: 0, w: z1 - z0 },
  ];

  const city = {
    // 건물 하나 — 실제 꼭대기 높이를 돌려줌 (층 높이에 맞춰 반올림)
    add(x0, x1, z0, z1, h, v) {
      const id = nb++;
      const R = rng(1013 + id * 7919);
      const kind = FACADE_KINDS[v % FACADE_KINDS.length];
      const w = x1 - x0, d = z1 - z0;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const near = Math.max(Math.abs(cx), Math.abs(cz)) < detailRadius;
      const hasShop = kind !== 'apartment';
      const shopH = hasShop ? SHOP_H : 0;
      const floors = Math.max(1, Math.round((h - shopH) / FLOOR_H));
      const top = baseY + shopH + floors * FLOOR_H;
      const upper = facade(kind, 0); // 종류마다 한 장 (로딩 시간 줄이기 — 창 배치는 u 오프셋으로 섞음)
      const fs = faces(x0, x1, z0, z1);
      for (const f of fs) {
        const u0 = Math.floor(R() * 4) / 4;
        upper.geos.push(wallGeo(f.cx, baseY + shopH, f.cz, f.nx, f.nz, f.w, floors * FLOOR_H, bayRepeat(upper, f.w), floors, u0));
        if (hasShop) {
          const shop = facade('storefront', id % 2);
          shop.geos.push(wallGeo(f.cx, baseY, f.cz, f.nx, f.nz, f.w, SHOP_H, bayRepeat(shop, f.w), 1, Math.floor(R() * 4) / 4));
        }
      }
      // 옥상 (초록 방수 도장)
      const rg = new THREE.PlaneGeometry(w, d);
      rg.rotateX(-Math.PI / 2);
      const ruv = rg.attributes.uv;
      for (let i = 0; i < ruv.count; i++) ruv.setXY(i, ruv.getX(i) * (w / roof.tile), ruv.getY(i) * (d / roof.tile));
      rg.translate(cx, top, cz);
      roof.geos.push(rg);
      // 옥상 난간 + 1층 위 띠
      const trim = TRIM[kind];
      const ph = kind === 'apartment' ? 1.4 : 0.9, pt = 0.22;
      trimGeos.push(
        box(w, ph, pt, cx, top + ph / 2, z0 + pt / 2, trim), box(w, ph, pt, cx, top + ph / 2, z1 - pt / 2, trim),
        box(pt, ph, d - 2 * pt, x0 + pt / 2, top + ph / 2, cz, trim), box(pt, ph, d - 2 * pt, x1 - pt / 2, top + ph / 2, cz, trim),
        box(w + 0.08, 0.1, d + 0.08, cx, top + ph + 0.05, cz, 0xcfcac0), // 난간 갓돌 (가운데는 옥상 판이 덮음)
      );
      if (hasShop) {
        trimGeos.push(
          box(w + 0.24, 0.2, 0.12, cx, baseY + SHOP_H + 0.1, z0 - 0.06, trim), box(w + 0.24, 0.2, 0.12, cx, baseY + SHOP_H + 0.1, z1 + 0.06, trim),
          box(0.12, 0.2, d, x0 - 0.06, baseY + SHOP_H + 0.1, cz, trim), box(0.12, 0.2, d, x1 + 0.06, baseY + SHOP_H + 0.1, cz, trim),
        );
      }
      if (kind === 'apartment') {
        // 아파트 꼭대기 장식 틀
        trimGeos.push(box(w * 0.5, 3.2, 0.35, cx, top + 1.6 + ph, cz + d * 0.2, 0xdcd6cb), box(w * 0.5, 0.35, d * 0.42, cx, top + 3.0 + ph, cz, 0xdcd6cb));
      }
      if (near && top - baseY < 45) {
        const m = new THREE.Matrix4().makeTranslation(cx, top, cz);
        props.push({ parts: rooftopParts({ w: Math.max(2, w - 0.8), d: Math.max(2, d - 0.8), seed: 31 + id }).parts, matrix: m });
      }
      // 실외기: 오래된 상가 건물의 길 쪽 벽
      if (near && (kind === 'tile_cream' || kind === 'brick_red' || kind === 'concrete_gray')) {
        const ac = acUnitParts().parts;
        for (const f of fs) {
          const facesRoad = Math.abs(f.nx) ? Math.abs(f.cx) > Math.abs(f.cx + f.nx * 50) : Math.abs(f.cz) > Math.abs(f.cz + f.nz * 50);
          if (!facesRoad || f.w < 5) continue;
          const n = 2 + Math.floor(R() * 5);
          for (let k = 0; k < n; k++) {
            const fl = Math.floor(R() * floors);
            const along = (R() - 0.5) * (f.w - 1.6);
            const y = baseY + shopH + fl * FLOOR_H + 0.25;
            const tx = -f.nz, tz = f.nx; // 벽을 따라가는 방향
            const m = new THREE.Matrix4().makeRotationY(Math.atan2(f.nx, f.nz));
            m.setPosition(f.cx + tx * along + f.nx * 0.02, y, f.cz + tz * along + f.nz * 0.02);
            props.push({ parts: ac, matrix: m });
          }
        }
      }
      // 돌출 간판: 교차로에 가까운 상가 건물의 길 쪽 모서리
      if (hasShop && kind !== 'glass_curtain' && Math.max(Math.abs(cx), Math.abs(cz)) < 62 && floors >= 2 && R() < 0.8) {
        const f = fs.reduce((a, b) => {
          const da = Math.abs(a.cx + a.nx * 3) + Math.abs(a.cz + a.nz * 3), db = Math.abs(b.cx + b.nx * 3) + Math.abs(b.cz + b.nz * 3);
          return da < db ? a : b;
        });
        const s = SIGNS[(id * 5 + 3) % SIGNS.length];
        const sg = projectingSign({ text: s[0], bg: s[1], fg: s[2], h: Math.min(3.4, 2.2 + floors * 0.25) });
        signMats.push(sg.faceMaterial);
        W.night.emissiveSigns.push(sg.faceMaterial);
        const tx = -f.nz, tz = f.nx;
        const side = R() < 0.5 ? -1 : 1;
        const along = side * (f.w / 2 - 0.7);
        const m = new THREE.Matrix4().makeRotationY(Math.atan2(f.nx, f.nz));
        m.setPosition(f.cx + tx * along, baseY + shopH + Math.min(floors, 3) * FLOOR_H * 0.55 + 1.2, f.cz + tz * along);
        props.push({ parts: sg.parts, matrix: m });
      }
      return top;
    },
    finish() {
      const out = [];
      for (const g of groups.values()) {
        if (!g.geos.length) continue;
        const mesh = new THREE.Mesh(mergeGeometries(g.geos), g.mat);
        mesh.castShadow = mesh.receiveShadow = true;
        out.push(mesh);
      }
      if (roof.geos.length) {
        const rm = new THREE.Mesh(mergeGeometries(roof.geos), roof.mat);
        rm.receiveShadow = true;
        out.push(rm);
      }
      if (trimGeos.length) {
        const tm = new THREE.Mesh(mergeGeometries(trimGeos), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82 }));
        tm.castShadow = tm.receiveShadow = true;
        out.push(tm);
      }
      for (const m of mergePartsInstances(props)) out.push(m);
      for (const m of out) scene.add(m);
      return out;
    },
  };
  return city;
}
