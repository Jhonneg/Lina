import type { OrbParameters } from "./orb-state";

export type OrbMotion = {
  elapsed: number;
  lastPulse: number;
  energy: number;
  pulse: number;
  meshRotationY: number;
  meshRotationZ: number;
  shellRotationY: number;
  shellOpacity: number;
};

export function createOrbMotion(): OrbMotion {
  return {
    elapsed: 0, lastPulse: 0, energy: 0, pulse: 0,
    meshRotationY: 0, meshRotationZ: 0, shellRotationY: 0, shellOpacity: 0.035,
  };
}

export function advanceOrbMotion(current: OrbMotion, target: OrbParameters, delta: number, reduced: boolean) {
  if (reduced) {
    // The approved HD reference freezes its clock and rotations too.
    current.energy = 0;
    current.pulse = 0;
    current.shellOpacity = 0.032;
    return;
  }

  // The approved HD tick caps dt before advancing every animation channel,
  // including elapsed shader time. Keep its timing and update order intact.
  const dt = Math.min(delta, 0.05);
  current.elapsed += dt;
  const ease = Math.min(1, dt * 2.7);
  current.energy += (target.energy - current.energy) * ease;
  if (current.elapsed - current.lastPulse > target.pulsePeriod) {
    current.lastPulse = current.elapsed;
    current.pulse = target.pulsePeak;
  }
  current.pulse *= Math.exp(-dt * 6);
  current.meshRotationY += dt * (0.11 + current.energy * 0.27);
  current.meshRotationZ += dt * 0.035;
  current.shellRotationY -= dt * 0.06;
  current.shellOpacity = 0.032 + current.energy * 0.045 + current.pulse * 0.065;
}
