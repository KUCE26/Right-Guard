// 하늘 · 구름 · 환경광(반사) — 2026년 5월 보문역 사거리 로드뷰처럼 맑은 오후 하늘과 뭉게구름
import * as THREE from 'three';

// 해 방향: 남서쪽 하늘, 고도 약 55° (오후 2~3시)
export const SUN_OFF = new THREE.Vector3(-42, 74, 30);
export const SUN_DIR = SUN_OFF.clone().normalize();
// 환경광(반사) 캡처에만 쓰는 레이어 — 움직이는 차·사람은 이 레이어에 없음
export const ENV_LAYER = 5;

const DAY = {
  zenith: 0x2a68c0, horizon: 0xc4d4e2, ground: 0x8d9298, sun: 0xfff1dc,
  fog: 0xc4d4e2, cloudLit: 0xffffff, cloudShade: 0x7f8ea6, cover: 0.51, bright: 1.0,
};
const NIGHT = {
  zenith: 0x03060f, horizon: 0x1b1f2e, ground: 0x0a0c10, sun: 0x9fb4ff,
  fog: 0x10141f, cloudLit: 0x2a2630, cloudShade: 0x0d0e14, cover: 0.52, bright: 1.0,
};

const VS = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w * 0.99999; // 늘 가장 먼 곳
}`;

const FS = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSun;
uniform vec3 uCloudLit;
uniform vec3 uCloudShade;
uniform float uCover;
uniform float uTime;
uniform float uNight;
uniform float uDisc;
uniform float uGain;
varying vec3 vDir;

float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(3.1, 7.7);
    a *= 0.5;
  }
  return s;
}
// 뭉게구름: x = 덮임(0~1), y = 두께(0~1)
vec2 cloud(vec2 uv) {
  vec2 q = uv * 0.42;
  vec2 w = vec2(fbm(q * 0.7 + 1.7), fbm(q * 0.7 + 9.2));
  float base = fbm(q + w * 0.65);
  float detail = fbm(q * 4.2 - w * 1.3);
  float fine = vnoise(q * 14.0 + w * 3.0);
  float d = base + (detail - 0.5) * 0.3 + (fine - 0.5) * 0.06;
  return vec2(smoothstep(uCover, uCover + 0.055, d), smoothstep(uCover + 0.02, uCover + 0.3, d));
}

void main() {
  vec3 d = normalize(vDir);
  float y = d.y;
  float mu = dot(d, uSunDir);

  // 하늘 그라데이션: 천정은 짙은 파랑, 지평선은 옅은 연무
  float h = clamp(y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uZenith, pow(h, 0.5));
  // 해 반대쪽은 조금 더 짙고, 해 쪽은 밝게 (대기 산란 흉내)
  col *= 1.0 + 0.18 * mu * (1.0 - h);
  if (y < 0.0) col = mix(uHorizon, uGround, clamp(-y * 6.0, 0.0, 1.0));

  // 해 주변 빛무리 + 해
  float day = 1.0 - uNight;
  float m = max(mu, 0.0);
  col += uSun * (pow(m, 8.0) * 0.14 + pow(m, 64.0) * 0.45 + pow(m, 700.0) * 2.0) * day;
  col += uSun * smoothstep(0.99965, 0.99985, mu) * 60.0 * uDisc * day;

  // 구름: 하늘 높이에 있는 판에 투영
  if (y > 0.0) {
    vec2 uv = d.xz / (y + 0.1) * 1.1 + vec2(uTime * 0.0045, uTime * 0.0018);
    vec2 c = cloud(uv);
    if (c.x > 0.001) {
      vec2 toSun = normalize(uSunDir.xz + 1e-5) * 0.18;
      float ahead = cloud(uv + toSun).y;
      // 두꺼운 곳은 아랫면이 회색, 해 쪽 가장자리는 밝게
      float lit = clamp(0.78 - c.y * 0.5 + (c.y - ahead) * 1.2, 0.0, 1.0);
      vec3 cc = mix(uCloudShade, uCloudLit, lit);
      cc += uSun * pow(m, 8.0) * 0.45 * (1.0 - c.y) * day; // 해 쪽 가장자리 은빛
      cc *= 0.92 + 0.2 * h;
      float fade = smoothstep(0.012, 0.14, y);
      // 지평선 가까이는 연무에 묻힘
      cc = mix(uHorizon * 1.05, cc, smoothstep(0.0, 0.25, y));
      col = mix(col, cc, c.x * fade);
    }
  }
  col *= uGain;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const C = (hex) => new THREE.Color(hex);

export function createSky({ radius = 480 } = {}) {
  const u = {
    uSunDir: { value: SUN_DIR.clone() },
    uZenith: { value: C(DAY.zenith) },
    uHorizon: { value: C(DAY.horizon) },
    uGround: { value: C(DAY.ground) },
    uSun: { value: C(DAY.sun) },
    uCloudLit: { value: C(DAY.cloudLit) },
    uCloudShade: { value: C(DAY.cloudShade) },
    uCover: { value: DAY.cover },
    uTime: { value: 0 },
    uNight: { value: 0 },
    uDisc: { value: 1 },
    uGain: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: u, vertexShader: VS, fragmentShader: FS,
    side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 48, 24), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  mesh.userData.noAO = true;
  mesh.name = 'sky';
  const fogColor = C(DAY.fog);
  const sky = {
    mesh, material, uniforms: u, fogColor,
    night: false,
    setNight(on) {
      const P = on ? NIGHT : DAY;
      sky.night = on;
      u.uZenith.value.setHex(P.zenith);
      u.uHorizon.value.setHex(P.horizon);
      u.uGround.value.setHex(P.ground);
      u.uSun.value.setHex(P.sun);
      u.uCloudLit.value.setHex(P.cloudLit);
      u.uCloudShade.value.setHex(P.cloudShade);
      u.uCover.value = P.cover;
      u.uNight.value = on ? 1 : 0;
      fogColor.setHex(P.fog);
    },
    update(t, camPos) {
      u.uTime.value = t;
      if (camPos) mesh.position.copy(camPos);
    },
  };
  return sky;
}

// 환경광: 교차로 한가운데 3 m 높이에서 정적인 세계(하늘·건물·도로)를 한 번 찍어 반사·간접광으로 씀
export function createEnvironment(renderer, scene, sky) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  const cubeCam = new THREE.CubeCamera(0.5, 1200, cubeRT);
  for (const c of cubeCam.children) c.layers.set(ENV_LAYER);
  cubeCam.position.set(0, 3.2, 0);
  let envRT = null;
  return {
    // 지금 장면에 있는 모든 물체를 '정적인 세계'로 표시 (이후에 만든 차·사람은 빠짐)
    markStatic(root) {
      root.traverse((o) => o.layers.enable(ENV_LAYER));
    },
    capture() {
      const prevEnv = scene.environment;
      scene.environment = null;
      const disc = sky ? sky.uniforms.uDisc.value : 0;
      if (sky) { sky.uniforms.uDisc.value = 0; sky.mesh.position.copy(cubeCam.position); }
      cubeCam.update(renderer, scene);
      if (sky) sky.uniforms.uDisc.value = disc;
      const rt = pmrem.fromCubemap(cubeRT.texture);
      if (envRT) envRT.dispose();
      envRT = rt;
      scene.environment = rt.texture;
      return prevEnv;
    },
  };
}
