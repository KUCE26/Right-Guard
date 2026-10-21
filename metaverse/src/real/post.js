// 후처리: MSAA → 앰비언트 오클루전(GTAO) → 블룸 → 색 보정 → 톤 매핑
// level 0 = 후처리 없음(직접 그리기) · 1 = 가볍게(MSAA·색 보정·밤 블룸) · 2 = 고화질(+GTAO, 낮에도 약한 블룸)
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSat: { value: 1.0 },
    uVig: { value: 0.22 },
    uTint: { value: new THREE.Vector3(1, 1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSat;
    uniform float uVig;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      c.rgb = mix(vec3(l), c.rgb, uSat) * uTint;
      vec2 d = vUv - 0.5;
      c.rgb *= clamp(1.0 - uVig * dot(d, d) * 2.2, 0.0, 1.0);
      gl_FragColor = c;
    }`,
};

export function createPost(renderer, scene, camera, { level = 2 } = {}) {
  const size = new THREE.Vector2();
  renderer.getDrawingBufferSize(size);
  const rt = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  const renderPass = new RenderPass(scene, camera);
  const gtao = new GTAOPass(scene, camera, Math.max(1, size.x >> 1), Math.max(1, size.y >> 1));
  gtao.blendIntensity = 0.85;
  gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
  // 하늘·유리·빛무리·홀로그램처럼 반투명하거나 표시용인 것은 AO 계산에서 뺌
  gtao.overrideVisibility = function overrideVisibility() {
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      cache.set(o, o.visible);
      if (o.isPoints || o.isLine || o.isSprite || o.userData.noAO) { o.visible = false; return; }
      const m = o.material;
      if (m && (Array.isArray(m) ? m.every((x) => x.transparent) : m.transparent)) o.visible = false;
    });
  };
  const bloom = new UnrealBloomPass(new THREE.Vector2(Math.max(1, size.x >> 1), Math.max(1, size.y >> 1)), 0.12, 0.45, 0.92);
  const grade = new ShaderPass(GradeShader);
  const output = new OutputPass();
  composer.addPass(renderPass);
  composer.addPass(gtao);
  composer.addPass(bloom);
  composer.addPass(grade);
  composer.addPass(output);

  const cur = new THREE.Vector2();
  let lastW = 0, lastH = 0, lastPr = 0;
  const post = {
    level, composer, gtao, bloom, grade, night: false, aoScale: 0.5,
    setLevel(l) {
      post.level = l;
      gtao.enabled = l >= 2;
      post.applyBloom();
    },
    applyBloom() {
      const n = post.night;
      bloom.enabled = post.level >= 2 || n;
      bloom.strength = n ? 0.85 : 0.12;
      bloom.radius = n ? 0.6 : 0.45;
      bloom.threshold = n ? 0.6 : 0.92;
      grade.uniforms.uSat.value = n ? 1.0 : 1.04;
      grade.uniforms.uVig.value = n ? 0.32 : 0.22;
    },
    setNight(on) {
      post.night = on;
      post.applyBloom();
    },
    setSize(w, h) {
      // w, h: 캔버스 CSS 크기. 실제 그리기 크기는 renderer의 pixelRatio를 따름
      lastW = w; lastH = h; lastPr = renderer.getPixelRatio();
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
      const pr = renderer.getPixelRatio();
      const aw = Math.max(1, Math.round(w * pr * post.aoScale)), ah = Math.max(1, Math.round(h * pr * post.aoScale));
      gtao.setSize(aw, ah);
    },
    render(dt) {
      if (post.level <= 0) {
        renderer.setRenderTarget(null);
        renderer.render(scene, camera);
        return;
      }
      renderer.getSize(cur);
      if (cur.x !== lastW || cur.y !== lastH || renderer.getPixelRatio() !== lastPr) post.setSize(cur.x, cur.y);
      composer.render(dt);
    },
  };
  post.setLevel(level);
  return post;
}
