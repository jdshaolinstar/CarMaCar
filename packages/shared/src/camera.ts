// Pinhole camera built only from a pose, in Babylon's left-handed, y-up convention.
import type { Vec2 } from './city';

export type V3 = [number, number, number];

export interface CameraPose {
  position: V3;
  target: V3;
  fovY: number;
  width: number;
  height: number;
  /** Set for fixed cameras inside a garage. Such a frame only reads stalls on its own level. */
  garageId?: string;
  level?: number;
  /** Height of the floor in view. Zero for the street. */
  floorY?: number;
  /** Also look for trash on this frame. Costs a second vision call. */
  scanTrash?: boolean;
}

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

export interface PinholeCamera {
  project(world: V3): [number, number] | null;
  toGround(px: number, py: number): Vec2 | null;
}

export function pinhole(pose: CameraPose): PinholeCamera {
  const forward = norm3(sub3(pose.target, pose.position));
  const right = norm3(cross3([0, 1, 0], forward));
  const up = cross3(forward, right);
  const focal = pose.height / 2 / Math.tan(pose.fovY / 2);
  return {
    project(world) {
      const d = sub3(world, pose.position);
      const zc = dot3(d, forward);
      if (zc < 0.5) return null;
      return [pose.width / 2 + (focal * dot3(d, right)) / zc, pose.height / 2 - (focal * dot3(d, up)) / zc];
    },
    toGround(px, py) {
      const a = (px - pose.width / 2) / focal;
      const b = (pose.height / 2 - py) / focal;
      const dir: V3 = [
        right[0] * a + up[0] * b + forward[0],
        right[1] * a + up[1] * b + forward[1],
        right[2] * a + up[2] * b + forward[2],
      ];
      if (dir[1] >= -1e-4) return null;
      const t = ((pose.floorY ?? 0) - pose.position[1]) / dir[1];
      return { x: pose.position[0] + dir[0] * t, z: pose.position[2] + dir[2] * t };
    },
  };
}
