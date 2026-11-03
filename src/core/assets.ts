import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export interface TextureSet { color: THREE.Texture; normal: THREE.Texture; arh: THREE.Texture }

const BASE = `${import.meta.env.BASE_URL}assets/`;

export class Assets {
  readonly models: Record<string, GLTF> = {};
  readonly textures: Record<string, TextureSet> = {};
  private manager = new THREE.LoadingManager();
  private gltf = new GLTFLoader(this.manager).setMeshoptDecoder(MeshoptDecoder);
  private tex = new THREE.TextureLoader(this.manager);
  private total = 0;
  private done = 0;

  constructor(private renderer: THREE.WebGLRenderer, private onProgress: (p: number) => void) {}

  private tick() {
    this.done++;
    this.onProgress(this.done / this.total);
  }

  async load(models: string[], textureSets: string[]) {
    this.total = models.length + textureSets.length * 3;
    const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const loadTex = async (url: string, srgb: boolean) => {
      const t = await this.tex.loadAsync(url);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = aniso;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      this.tick();
      return t;
    };
    await Promise.all([
      ...models.map(async (m) => {
        this.models[m] = await this.gltf.loadAsync(`${BASE}models/${m}.glb`);
        this.tick();
      }),
      ...textureSets.map(async (s) => {
        const [color, normal, arh] = await Promise.all([
          loadTex(`${BASE}textures/${s}/color.webp`, true),
          loadTex(`${BASE}textures/${s}/normal.webp`, false),
          loadTex(`${BASE}textures/${s}/arh.webp`, false),
        ]);
        this.textures[s] = { color, normal, arh };
      }),
    ]);
  }
}

export const ASSET_BASE = BASE;
