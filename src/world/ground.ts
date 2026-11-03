import { terrainHeight, terrainNormal, waterY, PLAY, valleyAxis } from './heightfield';

/**
 * The active scene's ground, used by the player and camera. Defaults to the Forgotten Valley;
 * other scenes (the temple) swap in their own functions at startup.
 */
export const ground = {
  height: terrainHeight as (x: number, z: number) => number,
  normal: terrainNormal as (x: number, z: number, e?: number) => [number, number, number],
  water: waterY as (z: number) => number,
  /** Keeps the player inside the explorable area. */
  clamp: (x: number, z: number): [number, number] => {
    const cz = Math.min(PLAY.maxZ, Math.max(PLAY.minZ, z));
    const ax = valleyAxis(cz);
    return [Math.min(ax + 380, Math.max(ax - 380, x)), cz];
  },
  /** Optional solid test for the camera boom (walls, roofs). */
  solid: null as ((x: number, y: number, z: number) => boolean) | null,
};
