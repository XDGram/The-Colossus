import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * Cinematic finishing: soft bloom in HDR, then a filmic grade in display space
 * (warm highlights, cool shadows, gentle saturation lift, vignette).
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uWarm: { value: new THREE.Color(1.06, 0.99, 0.88) },
    uCool: { value: new THREE.Color(0.86, 0.95, 1.06) },
    uSaturation: { value: 1.12 },
    uVignette: { value: 0.32 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec3 uWarm; uniform vec3 uCool; uniform float uSaturation; uniform float uVignette; uniform float uAspect;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // Split-tone: shadows lean cool, highlights lean warm.
      vec3 tone = mix(uCool, uWarm, smoothstep(0.15, 0.75, l));
      vec3 col = c.rgb * tone;
      col = mix(vec3(l), col, uSaturation);
      // Gentle S-curve for depth.
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
      col *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(d));
      gl_FragColor = vec4(clamp(col, 0.0, 1.0), c.a);
    }`,
};

export class Post {
  readonly composer: EffectComposer;
  private grade: ShaderPass;
  bloom?: UnrealBloomPass;

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, quality: 'high' | 'low') {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // Prefer HDR; fall back to 8-bit where float colour buffers aren't renderable (keeps the image intact).
    const ext = renderer.extensions;
    const hdr = ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float');
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: quality === 'high' ? 4 : 0 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    if (quality === 'high') {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.65, 0.92);
      this.composer.addPass(this.bloom);
    }
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.resize(innerWidth, innerHeight);
  }

  resize(w: number, h: number) {
    this.composer.setSize(w, h);
    this.grade.uniforms.uAspect.value = w / h;
  }

  render() { this.composer.render(); }
}
