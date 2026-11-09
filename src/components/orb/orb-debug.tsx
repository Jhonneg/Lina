"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { ShaderMaterial } from "three";
import type { OrbMotion } from "./orb-animation";
import { ORB_STATES, type OrbState } from "./orb-state";
import styles from "./orb.module.css";

export type OrbDiagnostics = {
  selectedState: OrbState;
  reducedMotion: boolean;
  motion: OrbMotion;
  material: ShaderMaterial;
};

const UNIFORMS = ["time", "energy", "pulse", "glitch", "refinement"];

export function OrbDebug({ diagnosticsRef }: { diagnosticsRef: RefObject<OrbDiagnostics | null> }) {
  const output = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const refresh = () => {
      if (!output.current) return;
      const live = diagnosticsRef.current;
      if (!live) { output.current.textContent = "Waiting for renderer…"; return; }
      const shader = Object.fromEntries(UNIFORMS.map((name) => [name, live.material.uniforms[name]?.value]));
      output.current.textContent = JSON.stringify({
        selectedState: live.selectedState,
        reducedMotion: live.reducedMotion,
        target: ORB_STATES[live.selectedState].motion,
        current: live.motion,
        shader,
      }, (_, value) => typeof value === "number" ? Number(value.toFixed(4)) : value, 2);
    };
    refresh();
    // Diagnostics refresh outside useFrame, without React renders or per-frame
    // object allocation. The panel reads the actual material uniform objects.
    const timer = window.setInterval(refresh, 250);
    return () => window.clearInterval(timer);
  }, [diagnosticsRef]);

  return (
    <details className={styles.debug}>
      <summary>Orb animation debug</summary>
      <pre ref={output} data-orb-debug aria-live="off">Waiting for renderer…</pre>
    </details>
  );
}
