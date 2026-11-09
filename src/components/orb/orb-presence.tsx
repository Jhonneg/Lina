"use client";

import dynamic from "next/dynamic";
import { Component, memo, type ReactNode, type RefObject } from "react";
import type { OrbState } from "./orb-state";
import type { OrbDiagnostics } from "./orb-debug";
import { OrbFallback } from "./orb-fallback";

const NoiseOrb = dynamic(() => import("./noise-orb"), { ssr: false, loading: () => <OrbFallback /> });

class OrbBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <OrbFallback unavailable /> : this.props.children; }
}

export const OrbPresence = memo(function OrbPresence({ state, diagnosticsRef }: { state: OrbState; diagnosticsRef?: RefObject<OrbDiagnostics | null> }) {
  return <OrbBoundary><NoiseOrb state={state} diagnosticsRef={diagnosticsRef} /></OrbBoundary>;
});
