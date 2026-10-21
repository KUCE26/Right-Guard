// 가로수 묶음: 카메라 가까이는 고해상 나무, 멀리는 저해상 나무 (InstancedMesh 를 거리별로 다시 채움)
import * as THREE from 'three';
import { buildTreeVariants } from './trees3d.js';

export function createTreeField(scene, spots, { baseY = 0, seed = 7, nearDist = 55, farDist = 320 } = {}) {
  const hi = buildTreeVariants({ count: 3, seed });
  let lo = null;
  try {
    lo = buildTreeVariants({ count: 3, seed, detail: 0.2 });
    // detail 옵션이 없는 버전이면 같은 삼각형 수가 나옴 → 저해상 묶음 없이 감
    if (lo[0].trunkGeo === hi[0].trunkGeo || (lo[0].tris && hi[0].tris && lo[0].tris.total >= hi[0].tris.total)) lo = null;
  } catch (e) { lo = null; }
  const UP = new THREE.Vector3(0, 1, 0);
  const q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const trees = spots.map(([x, z], i) => {
    const s = 0.86 + ((i * 37) % 10) / 45;
    q.setFromAxisAngle(UP, i * 1.7);
    const m = new THREE.Matrix4().compose(pos.set(x, baseY, z), q, sc.set(s, s, s));
    return { x, z, v: (i * 7 + (x > 0 ? 1 : 0)) % hi.length, m };
  });
  const make = (geo, mat, n, shadow) => {
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    im.count = 0;
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.visible = false;
    scene.add(im);
    return im;
  };
  const sets = hi.map((h, vi) => {
    const n = trees.filter((t) => t.v === vi).length;
    return {
      hiT: make(h.trunkGeo, h.trunkMat, n, true),
      hiL: make(h.leafGeo, h.leafMat, n, true),
      loT: lo ? make(lo[vi].trunkGeo, lo[vi].trunkMat, n, false) : null,
      loL: lo ? make(lo[vi].leafGeo, lo[vi].leafMat, n, false) : null,
    };
  });
  const last = new THREE.Vector3(1e9, 0, 0);
  const field = {
    trees,
    update(cam, force = false) {
      if (!force && (cam.x - last.x) ** 2 + (cam.z - last.z) ** 2 < 6) return;
      last.copy(cam);
      const cnt = sets.map(() => ({ hi: 0, lo: 0 }));
      for (const t of trees) {
        const d = Math.hypot(t.x - cam.x, t.z - cam.z);
        const S = sets[t.v], c = cnt[t.v];
        if (d < nearDist || !S.loT) {
          S.hiT.setMatrixAt(c.hi, t.m); S.hiL.setMatrixAt(c.hi, t.m); c.hi++;
        } else if (d < farDist) {
          S.loT.setMatrixAt(c.lo, t.m); S.loL.setMatrixAt(c.lo, t.m); c.lo++;
        }
      }
      sets.forEach((S, i) => {
        for (const [im, k] of [[S.hiT, cnt[i].hi], [S.hiL, cnt[i].hi], [S.loT, cnt[i].lo], [S.loL, cnt[i].lo]]) {
          if (!im) continue;
          im.count = k;
          im.visible = k > 0;
          im.instanceMatrix.needsUpdate = true;
          if (k > 0) im.computeBoundingSphere();
        }
      });
    },
  };
  field.update(new THREE.Vector3(0, 3, 0), true);
  return field;
}
