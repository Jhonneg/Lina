"use client";

import { useRef, useState } from "react";
import { ORB_STATES, type OrbState } from "./orb-state";
import { OrbPresence } from "./orb-presence";
import { OrbDebug, type OrbDiagnostics } from "./orb-debug";
import styles from "./orb.module.css";

export function OrbDemo() {
  const [state, setState] = useState<OrbState>("idle");
  const diagnosticsRef = useRef<OrbDiagnostics | null>(null);
  return (
    <section className={styles.demo} aria-label="Lain presence preview">
      <div className={styles.stage} role="group" aria-label={`Amber noise orb, ${state}`}>
        <OrbPresence state={state} diagnosticsRef={process.env.NODE_ENV === "development" ? diagnosticsRef : undefined} />
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
