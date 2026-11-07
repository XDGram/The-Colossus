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
            // Tight glow around the sun's disk only (a wide halo washed out the whole screen when facing the sun).
            float glow = exp(-dot(ds, ds) * 90.0) * 4.0 + exp(-dot(ds, ds) * 18.0) * 0.18;
            vec3 s = (min(texture2D(tDiffuse, uv).rgb, vec3(3.0)) * 0.25 + glow) * sky;
            acc += s * decay;
            decay *= 0.965;
          }
          acc /= float(N);
          // Beams strongest near the sun, falling off across the frame.
          float fall = 1.0 - smoothstep(0.0, 1.1, distance(vUv * vec2(1.6, 1.0), uSun * vec2(1.6, 1.0)));
          vec3 rays = min(acc * uColor * uIntensity * uVisible * (0.35 + 0.65 * fall), vec3(0.3)); // beams light the scene, never cover it
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
    /** Reality glitch (0-1): slice tears, RGB split, block corruption, scanlines and flicker (the valley realm). */
    uGlitch: { value: 0 },
    /** Realm transition: the world darkens as the wind rises (0-1). */
    uDark: { value: 0 },
    uTime: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform vec3 uWarm; uniform vec3 uCool; uniform float uSaturation; uniform float uVignette; uniform float uAspect;
    uniform float uGlitch; uniform float uTime; uniform float uDark;
    varying vec2 vUv;
    float h1(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      vec4 c;
      float g = uGlitch;
      if (g > 0.001) {
        float tick = floor(uTime * 24.0);
        // Horizontal slice tears: random bands shift sideways.
        float bands = mix(14.0, 40.0, h1(vec2(tick, 3.1)));
        float band = floor(uv.y * bands);
        float r = h1(vec2(band, tick));
        if (r < 0.35 * g + 0.05 * g) uv.x += (h1(vec2(band, tick + 7.0)) - 0.5) * 0.22 * g;
        // Block corruption: coarse cells jump to another part of the image.
        vec2 cell = floor(uv * vec2(16.0, 9.0));
        float br = h1(cell + tick * 0.37);
        if (br < 0.07 * g * g) uv = fract(uv + vec2(h1(cell + 1.3), h1(cell + 2.7)) * 0.3 * g);
        // Wobble.
        uv.x += sin(uv.y * 90.0 + uTime * 40.0) * 0.003 * g;
        float split = 0.006 + 0.022 * g * h1(vec2(tick, 9.0));
        vec4 base = texture2D(tDiffuse, uv);
        c = vec4(texture2D(tDiffuse, uv + vec2(split, 0.0)).r, base.g, texture2D(tDiffuse, uv - vec2(split, split * 0.4)).b, base.a);
        c.rgb = mix(base.rgb, c.rgb, min(1.0, g * 1.6));
        // Corrupted blocks flash inverted or saturated.
        if (br < 0.035 * g) c.rgb = mix(c.rgb, vec3(1.0) - c.gbr, 0.8);
      } else c = texture2D(tDiffuse, uv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // Split-tone: shadows lean cool, highlights lean warm.
      vec3 tone = mix(uCool, uWarm, smoothstep(0.15, 0.75, l));
      vec3 col = c.rgb * tone;
      col = mix(vec3(l), col, uSaturation);
      // Gentle S-curve for depth.
      col = mix(col, col * col * (3.0 - 2.0 * col), 0.22);
      vec2 d = (vUv - 0.5) * vec2(uAspect, 1.0);
      col *= 1.0 - uVignette * smoothstep(0.35, 1.05, length(d));
      if (uDark > 0.001) {
        // Storm darkness: dim, drained of colour, a little cold, the edges closing in.
        float dl = dot(col, vec3(0.2126, 0.7152, 0.0722));
        col = mix(col, vec3(dl) * vec3(0.85, 0.9, 1.05), 0.55 * uDark);
        col *= 1.0 - 0.78 * uDark;
        col *= 1.0 - 0.5 * uDark * smoothstep(0.25, 0.9, length(d));
      }
      if (g > 0.001) {
        // Scanlines, flicker, and a blackout/whiteout pulse at full glitch.
        col *= 1.0 - 0.18 * g * (0.5 + 0.5 * sin(vUv.y * 900.0 + uTime * 60.0));
        float fl = h1(vec2(floor(uTime * 30.0), 1.7));
        col *= 1.0 - g * 0.35 * step(0.7, fl);
        col += g * g * 0.25 * step(0.93, fl);
        col += (h1(vUv * 500.0 + uTime) - 0.5) * 0.12 * g;
      }
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

  /** Storm darkness (0-1), driven by the valley-realm transition. */
  set dark(v: number) { this.grade.uniforms.uDark.value = v; }
  /** Reality glitch amount (0-1). */
  set glitch(v: number) { this.grade.uniforms.uGlitch.value = v; }
  get glitch() { return this.grade.uniforms.uGlitch.value as number; }

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
    this.grade.uniforms.uTime.value = performance.now() / 1000;
    this.composer.render();
  }
}
