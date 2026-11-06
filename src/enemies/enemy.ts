import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { dressRunner } from './runner';
import { BREAKER_SCALE, CLUB, dressBreaker } from './breaker';
import { dressMentor, type HeadScan, type MentorRig } from '../player/mentor';
import { Dresser, handMount, makeMaterials } from './kit';
import { calibrateHand, wpos, wquat, type HandCal } from './ik';
import { TwoHandGrip, type GripResult } from './twohand';
import type { WeaponSample } from '../combat/hits';
import { applyLayer, type LayerCtx } from './custom';
import { WARDEN } from '../boss/moves';
import { applyBossLayer, BOSS_LAYERS } from '../boss/poses';
import { BREAKER, RUNNER, type BreakerMove, type ClubMode, type LayerName, type MoveDef, type RunnerMove } from './moves';

/** 'warden' = the Temple Warden: the older warrior's model and katana with the Iron Breaker's moveset and combat class. */
export type EnemyKind = 'runner' | 'breaker' | 'warden';
export type EnemyClass = 'runner' | 'breaker';
export type MoveName<K extends EnemyKind> = K extends 'runner' ? RunnerMove : BreakerMove;

/** Fixed two-handed stances (relative to the enemy: right, forward, up in metres; club direction). */
const STANCE: Record<'carry' | 'guard' | 'lean', { g: [number, number, number]; d: [number, number, number] }> = {
  carry: { g: [0.22, 0.44, 1.0], d: [0.18, 0.3, 0.94] },     // ready carry: held upright before the right shoulder
  guard: { g: [0.1, 0.45, 1.25], d: [-0.68, 0.18, 0.71] },   // haft raised diagonally across the chest to block
  lean: { g: [0.06, 0.55, 0.92], d: [0, 0.78, -0.62] },      // head planted on the ground ahead, leaning on it
};

/**
 * One enemy: dressed model, mixer, move playback with cross-fades, custom layers and (Breaker) the
 * two-handed club grip. No AI: callers choose moves. `object` is placed by the caller.
 */
export class Enemy<K extends EnemyKind = EnemyKind> {
  readonly object = new THREE.Group();
  readonly pivot = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly bones: Record<string, THREE.Bone> = {};
  readonly moves: Record<string, MoveDef>;
  /** Behaviour/combat class (the Warden fights as a Breaker). */
  readonly cls: EnemyClass;
  private warden?: MentorRig;
  /** Weapon segment along the mount's +Y: [from, to, radius] (club head, or the Warden's katana blade). */
  private weaponSeg: [number, number, number] = [0.6, 1.5, 0.085];
  private mixer: THREE.AnimationMixer;
  private clips = new Map<string, THREE.AnimationClip>();
  private cal: { l: HandCal; r: HandCal };
  private grip?: TwoHandGrip;
  private mount?: THREE.Object3D;
  private blades?: { l: THREE.Object3D; r: THREE.Object3D };
  move: string = 'idle';
  time = 0;
  private prev: { move: string; time: number } | null = null;
  private fade = 0; private fadeLen = 0.2;
  private clubPrev: { g: THREE.Vector3; d: THREE.Vector3 } | null = null;
  private clubFrom: { g: THREE.Vector3; d: THREE.Vector3 } | null = null;
  lastGrip: GripResult | null = null;
  /** Playback controls for behaviour: locomotion rate (feet match ground speed) and freezing a pose (attack tells). */
  rate = 1;
  frozen = false;
  groundY = 0;

  constructor(readonly kind: K, body: GLTF, anims: THREE.AnimationClip[], scan?: HeadScan) {
    this.cls = kind === 'runner' ? 'runner' : 'breaker';
    this.model = clone(body.scene);
    if (kind === 'breaker') this.model.scale.setScalar(BREAKER_SCALE);
    this.object.add(this.pivot);
    this.pivot.add(this.model);
    this.object.updateMatrixWorld(true);
    this.model.traverse((o) => {
      if ((o as THREE.Bone).isBone) this.bones[o.name] = o as THREE.Bone;
      if ((o as THREE.Mesh).isMesh) { o.castShadow = o.receiveShadow = true; (o as THREE.Mesh).frustumCulled = false; }
    });
    this.cal = { l: calibrateHand(this.bones, 'l'), r: calibrateHand(this.bones, 'r') };
    if (kind === 'runner') this.blades = dressRunner(this.model).blades;
    else if (kind === 'warden') {
      // The older warrior exactly as approved (model, head, costume, katana), drawn sword in hand.
      this.warden = dressMentor(this.model, scan);
      this.warden.setDrawn(true);
      // Weapon mount for the two-handed grip, at the right-hand grip point, with +Y along HIS katana blade.
      const bladeObj = this.bones['hand_r'].children.find((c) => c.type === 'Group' || c.type === 'Object3D' && c.children.length) ?? null;
      this.mount = handMount(new Dresser(this.model, makeMaterials('warden-mount')), 'r');
      if (bladeObj) {
        const box = new THREE.Box3().setFromObject(bladeObj);
        const c = box.getCenter(new THREE.Vector3());
        const g = THREE.MathUtils.clamp(0, 0, 1); void g;
        const from = new THREE.Vector3().setFromMatrixPosition(this.mount.matrixWorld);
        const dirW = c.sub(from).normalize();
        const hq = this.bones['hand_r'].getWorldQuaternion(new THREE.Quaternion());
        const dirL = dirW.applyQuaternion(hq.invert());
        this.mount.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirL);
      }
      this.weaponSeg = [0.08, 0.85, 0.03];
      this.grip = new TwoHandGrip(this.bones, this.cal, { tipLen: 0.85, pommelLen: 0.22, headR: 0.03, spacing: 0.15 });
    } else {
      const parts = dressBreaker(this.model);
      this.mount = parts.club;
      this.grip = new TwoHandGrip(this.bones, this.cal, { tipLen: CLUB.tip, pommelLen: CLUB.pommel, headR: CLUB.headR, spacing: CLUB.spacing });
    }
    this.model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = o.receiveShadow = true; (o as THREE.Mesh).frustumCulled = false; } });
    for (const c of anims) this.clips.set(c.name, c);
    this.moves = kind === 'warden' ? WARDEN : this.cls === 'runner' ? RUNNER : BREAKER;
    this.mixer = new THREE.AnimationMixer(this.model);
    this.play('idle' as MoveName<K>, 0);
  }

  /** Length of a move in seconds. */
  duration(name: string) {
    const m = this.moves[name];
    if (m.duration) return m.duration;
    return m.segs.reduce((s, g) => s + ((g.to ?? this.clips.get(g.clip)!.duration) - (g.from ?? 0)), 0) / (m.speed ?? 1);
  }
  /** Increments every time a move starts (attack instances for hit-once). */
  moveInstance = 0;
  play(name: MoveName<K>, fade = 0.2) {
    this.moveInstance++;
    // Kneeling moves change the club stance a lot: give the blend more time.
    if (fade > 0 && this.moves[name].club === 'lean') fade = Math.max(fade, 0.35);
    if (this.pivot.position.lengthSq() > 0 || this.pivot.rotation.y !== 0) this.bakePivot();
    this.prev = fade > 0 ? { move: this.move, time: this.time } : null;
    this.clubFrom = this.clubPrev;
    this.move = name; this.time = 0; this.fade = 0; this.fadeLen = fade;
  }
  /** Moves that drive the root (side-step, charge, spin) end with the offset baked into `object`. */
  private bakePivot() {
    this.object.position.add(this.pivot.position.clone().applyQuaternion(this.object.quaternion));
    this.object.rotation.y += this.pivot.rotation.y;
    this.pivot.position.set(0, 0, 0); this.pivot.rotation.y = 0;
  }
  /** Clip + clip time for a move at move time t. */
  private sample(name: string, t: number): { clip: THREE.AnimationClip; time: number } {
    const m = this.moves[name], sp = m.speed ?? 1;
    let tt = t * sp;
    const total = this.duration(name) * sp;
    if (m.loop) tt = ((tt % total) + total) % total;
    for (const s of m.segs) {
      const c = this.clips.get(s.clip)!, a = s.from ?? 0, b = s.to ?? c.duration;
      if (tt <= b - a || s === m.segs[m.segs.length - 1]) return { clip: c, time: Math.min(a + tt, b - 1e-3) };
      tt -= b - a;
    }
    throw new Error('unreachable');
  }
  get done() { const m = this.moves[this.move]; return !m.loop && !m.hold && this.time >= this.duration(this.move); }

  update(dt: number) {
    if (!this.frozen) this.time += dt * this.rate;
    this.fade += dt;
    const m = this.moves[this.move];
    const dur = this.duration(this.move);
    if (!m.loop && !m.hold && this.time >= dur) { this.play('idle' as MoveName<K>, 0.25); }
    this.pose();
  }

  /** Poses the skeleton for the current move/time (mixer + blend + layers + grip). */
  pose() {
    const m = this.moves[this.move];
    const t = m.hold ? Math.min(this.time, this.duration(this.move) - 1e-3) : this.time;
    this.mixer.stopAllAction();
    const w = this.prev && this.fadeLen > 0 ? THREE.MathUtils.smoothstep(this.fade / this.fadeLen, 0, 1) : 1;
    const put = (clip: THREE.AnimationClip, time: number, weight: number) => {
      const a = this.mixer.clipAction(clip); a.reset(); a.play(); a.setEffectiveWeight(weight); a.time = time; a.paused = true;
    };
    const cur = this.sample(this.move, t);
    const mw = m.under ? (m.weight ?? 1) : 1;
    put(cur.clip, cur.time, w * mw);
    if (m.under) put(this.clips.get(m.under)!, t % this.clips.get(m.under)!.duration, w * (1 - mw));
    if (this.prev && w < 1) { const p = this.sample(this.prev.move, this.prev.time + this.fade); put(p.clip, p.time, 1 - w); }
    this.mixer.update(0);
    // The Warden keeps his older, heavier carriage over every clip.
    if (this.warden) { this.object.updateMatrixWorld(true); this.warden.applyPosture(); }
    this.object.updateMatrixWorld(true);

    // Frame of reference for layers and stances.
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(wquat(this.pivot)).setY(0).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).multiplyScalar(-1).normalize();
    // Character right is -x in model space for these bodies when facing +z: check against the bones.
    if (wpos(this.bones['upperarm_r']).sub(wpos(this.bones['upperarm_l'])).dot(right) < 0) right.negate();
    const ctx: LayerCtx = { bones: this.bones, root: this.pivot, cal: this.cal, fwd, right, up, feet: { l: wpos(this.bones['foot_l']), r: wpos(this.bones['foot_r']) } };

    let out = {} as ReturnType<typeof applyLayer>;
    if (m.layer) {
      out = BOSS_LAYERS.has(m.layer) ? applyBossLayer(m.layer, t, this.duration(this.move), ctx) : applyLayer(m.layer as LayerName, t, this.duration(this.move), ctx);
      // Root drivers move the pivot (baked into `object` when the move ends).
      if (out.offset) this.pivot.position.copy(out.offset.clone().applyQuaternion(this.object.quaternion.clone().invert()));
      if (out.yaw !== undefined) this.pivot.rotation.y = out.yaw;
      if (out.offset || out.yaw !== undefined) { this.object.updateMatrixWorld(true); }
    }
    if (this.grip) this.poseClub(m.club ?? 'carry', cur.time, m.layer === 'smashTilt', out.clubLower ?? 0, fwd, right, up, w);
  }

  private poseClub(mode: ClubMode, clipTime: number, tilt: boolean, lower: number, fwd: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3, w: number) {
    if (mode === 'none') { this.lastGrip = null; return; }
    let g: THREE.Vector3, d: THREE.Vector3;
    if (mode === 'clip') {
      g = wpos(this.mount!); d = new THREE.Vector3(0, 1, 0).applyQuaternion(wquat(this.mount!)).normalize();
    } else {
      const s = STANCE[mode], o = wpos(this.pivot);
      // Kneeling (lower > 0): the planted club moves forward, clear of the knees, as the body goes down.
      g = o.clone().addScaledVector(right, s.g[0]).addScaledVector(fwd, s.g[1] + Math.min(1, lower) * 0.08).addScaledVector(up, s.g[2] - lower * 0.42);
      d = new THREE.Vector3().addScaledVector(right, s.d[0]).addScaledVector(fwd, s.d[1]).addScaledVector(up, s.d[2]).normalize();
      if (mode === 'lean') d.lerp(up.clone().multiplyScalar(-1).addScaledVector(fwd, 0.25), Math.min(1, lower) * 0.5).normalize();
    }
    // Blend from the previous move's club pose across the cross-fade.
    if (this.clubFrom && w < 1) {
      // The club settles into the new stance in the first half of the blend (ahead of the body).
      w = THREE.MathUtils.smoothstep(w, 0, 0.5);
      // Rotate (not average) the club direction between stances, so opposed directions never collapse.
      // Large stance changes pass through an upright club (both hands stay on their own side of the body).
      const rot = (a: THREE.Vector3, b: THREE.Vector3, k: number) => a.clone().applyQuaternion(new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(a, b), k)).normalize();
      const from = this.clubFrom.d.clone(), mid = up.clone().addScaledVector(fwd, 0.3).normalize();
      d = from.angleTo(d) > Math.PI / 3 ? (w < 0.5 ? rot(from, mid, w * 2) : rot(mid, d, w * 2 - 1)) : rot(from, d, w);
      // The previous grip is kept relative to the chest, so it follows the body (e.g. dropping into a kneel).
      g = wpos(this.bones['spine_03']).add(this.clubFrom.g).lerp(g, w);
    }
    this.lastGrip = this.grip!.solve(g, d, this.groundY, tilt ? TwoHandGrip.smashTilt(clipTime) : 0, true);
    this.clubPrev = { g: wpos(this.mount!).sub(wpos(this.bones['spine_03'])), d: new THREE.Vector3(0, 1, 0).applyQuaternion(wquat(this.mount!)).normalize() };
  }

  /** Weapon segments in world space for the shared hit resolver: two blades (Runner) or the club head (Breaker). */
  weapons(): WeaponSample[] {
    const seg = (m: THREE.Object3D, a: number, b: number, radius: number): WeaponSample => {
      m.updateMatrixWorld(true);
      return { hilt: m.localToWorld(new THREE.Vector3(0, a, 0)), tip: m.localToWorld(new THREE.Vector3(0, b, 0)), radius };
    };
    if (this.blades) return [seg(this.blades.r, 0.07, 0.5, 0.03), seg(this.blades.l, 0.07, 0.5, 0.03)];
    return [seg(this.mount!, this.weaponSeg[0], this.weaponSeg[1], this.weaponSeg[2])];
  }
  /** Chest position (line-of-sight origin for hits). */
  chest() { return wpos(this.bones['spine_03']); }

  /** Hits active at the current move time. */
  activeHits() { return (this.moves[this.move].hits ?? []).filter((h) => Math.abs(this.time - h.t) <= h.window); }
}
