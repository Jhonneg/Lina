"use client";

import dynamic from "next/dynamic";
import { Component, useRef, useState, type ReactNode } from "react";
import { ORB_STATES, type OrbState } from "./orb-state";
import { OrbFallback } from "./orb-fallback";
import { OrbDebug, type OrbDiagnostics } from "./orb-debug";
import styles from "./orb.module.css";

const NoiseOrb = dynamic(() => import("./noise-orb"), { ssr: false, loading: () => <OrbFallback /> });

class OrbBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <OrbFallback unavailable /> : this.props.children; }
}

export function OrbDemo() {
  const [state, setState] = useState<OrbState>("idle");
  const diagnosticsRef = useRef<OrbDiagnostics | null>(null);
  return (
    <section className={styles.demo} aria-label="Lain presence preview">
      <div className={styles.stage} role="group" aria-label={`Amber noise orb, ${state}`}>
        <OrbBoundary><NoiseOrb state={state} diagnosticsRef={process.env.NODE_ENV === "development" ? diagnosticsRef : undefined} /></OrbBoundary>
      </div>
      <div className={styles.status} role="status" aria-live="polite">
        <span className={styles.statusDot} aria-hidden="true" /><span>{ORB_STATES[state].label}</span>
      </div>
      <h1 className={styles.heading}>Room for a thought.</h1>
      <p className={styles.description}>{ORB_STATES[state].description}</p>
      <fieldset className={styles.controls}>
        <legend>Animation preview</legend>
        <div className={styles.buttons}>
          {(Object.keys(ORB_STATES) as OrbState[]).map((value) => (
            <button key={value} type="button" aria-pressed={state === value} onClick={() => setState(value)}>{ORB_STATES[value].label}</button>
          ))}
        </div>
      </fieldset>
      {process.env.NODE_ENV === "development" && <OrbDebug diagnosticsRef={diagnosticsRef} />}
    </section>
  );
}
