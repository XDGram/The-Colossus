import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * Screen-space god rays: march from each pixel toward the sun's screen position, accumulating only
 * open sky (depth at the far plane). Occluders - trees, ridges, ruins, the Colossus - carve the beams,
 * so shafts appear exactly where light passes through gaps. Runs in HDR before bloom/tonemapping.
 */
class GodRaysPass extends Pass {
  private quad: FullScreenQuad;
  readonly uniforms = {
    tDiffuse: { value: null as THREE.Texture | null },
    tDepth: { value: null as THREE.Texture | null },
    uSun: { value: new THREE.Vector2(0.5, 0.5) },
    uVisible: { value: 0 },
    uColor: { value: new THREE.Color(1.0, 0.82, 0.55) },
    uIntensity: { value: 0.8 },
  };
  constructor(samples: number) {
    super();
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: /* glsl */ `
        uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform vec2 uSun; uniform float uVisible; uniform vec3 uColor; uniform float uIntensity;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(tDiffuse, vUv);
          if (uVisible <= 0.001) { gl_FragColor = base; return; }
          const int N = ${samples};
          vec2 delta = (uSun - vUv) * (0.92 / float(N));
          float jitter = fract(sin(dot(vUv * 913.7, vec2(12.9898, 78.233))) * 43758.5453);
          vec2 uv = vUv + delta * jitter;
          float decay = 1.0;
          vec3 acc = vec3(0.0);
          for (int i = 0; i < N; i++) {
            uv += delta;
            float sky = step(0.99999, texture2D(tDepth, uv).r);
            // Open sky contributes, strongly so around the sun's disk (independent of the sky texture).
            vec2 ds = (uv - uSun) * vec2(1.6, 1.0);
            float glow = exp(-dot(ds, ds) * 60.0) * 8.0 + exp(-dot(ds, ds) * 5.0) * 0.7;
            vec3 s = (min(texture2D(tDiffuse, uv).rgb, vec3(3.0)) * 0.25 + glow) * sky;
            acc += s * decay;
            decay *= 0.965;
          }
          acc /= float(N);
          // Beams strongest near the sun, falling off across the frame.
          float fall = 1.0 - smoothstep(0.0, 1.1, distance(vUv * vec2(1.6, 1.0), uSun * vec2(1.6, 1.0)));
          vec3 rays = acc * uColor * uIntensity * uVisible * (0.35 + 0.65 * fall);
          gl_FragColor = vec4(base.rgb + rays, base.a);
        }`,
      depthTest: false, depthWrite: false,
    }));
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.tDepth.value = readBuffer.depthTexture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }
  dispose() { this.quad.dispose(); }
}

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
  rays: GodRaysPass;
  private camera: THREE.Camera;
  private sunDir = new THREE.Vector3(0, 1, 0);

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, quality: 'high' | 'low', sunDir?: THREE.Vector3) {
    this.camera = camera;
    if (sunDir) this.sunDir.copy(sunDir);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // Prefer HDR; fall back to 8-bit where float colour buffers aren't renderable (keeps the image intact).
    const ext = renderer.extensions;
    const hdr = ext.has('EXT_color_buffer_half_float') || ext.has('EXT_color_buffer_float');
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: hdr ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: quality === 'high' ? 4 : 0 });
    rt.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.composer = new EffectComposer(renderer, rt);
    // The ping-pong buffer must not share the depth texture, or the god-ray pass forms a feedback loop.
    this.composer.renderTarget2.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.composer.addPass(new RenderPass(scene, camera));
    this.rays = new GodRaysPass(quality === 'high' ? 48 : 20);
    this.composer.addPass(this.rays);
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

  render() {
    // Sun position on screen; beams fade as the sun leaves the view (allowing a margin off-screen).
    const cam = this.camera as THREE.PerspectiveCamera;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const facing = fwd.dot(this.sunDir);
    const p = cam.position.clone().addScaledVector(this.sunDir, 1000).project(cam);
    this.rays.uniforms.uSun.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
    const off = Math.max(Math.abs(p.x), Math.abs(p.y));
    this.rays.uniforms.uVisible.value = THREE.MathUtils.smoothstep(facing, 0.05, 0.45) * (1 - THREE.MathUtils.smoothstep(off, 1.2, 2.2));
    this.composer.render();
  }
}
