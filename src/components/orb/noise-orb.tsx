"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { DoubleSide, NormalBlending, type Group, type Mesh, type MeshBasicMaterial, type ShaderMaterial } from "three";
import { ORB_STATES, type OrbState } from "./orb-state";
import { OrbFallback } from "./orb-fallback";
import { orbFragmentShader, orbVertexShader } from "./shaders";
import { ORB_GEOMETRY, ORB_SHELL_GEOMETRY } from "./orb-geometry";
import { advanceOrbMotion, createOrbMotion } from "./orb-animation";
import type { OrbDiagnostics } from "./orb-debug";

const CAMERA_Z = 7.9;
// Match the approved camera while preserving the existing apparent dimensions.
// Changing the parent scale, not geometry radius, preserves shader wavelengths.
const DESKTOP_SCALE = 0.94 * CAMERA_Z / 7;
const MOBILE_SCALE = 0.86 * CAMERA_Z / 7;

function subscribeMotion(callback: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
function subscribeViewport(callback: () => void) {
  const query = window.matchMedia("(min-width: 640px)");
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
function subscribeVisibility(callback: () => void) {
  document.addEventListener("visibilitychange", callback);
  return () => document.removeEventListener("visibilitychange", callback);
}

function ContextMonitor({ onLost }: { onLost: () => void }) {
  const gl = useThree((root) => root.gl);
  useEffect(() => {
    const canvas = gl.domElement;
    canvas.addEventListener("webglcontextlost", onLost);
    return () => canvas.removeEventListener("webglcontextlost", onLost);
  }, [gl, onLost]);
  return null;
}

function OrbMesh({ state, reduced, visible, presentationScale, pointer, diagnosticsRef }: {
  state: OrbState;
  reduced: boolean;
  visible: boolean;
  presentationScale: number;
  pointer: RefObject<[number, number]>;
  diagnosticsRef?: RefObject<OrbDiagnostics | null>;
}) {
  const invalidate = useThree((root) => root.invalidate);
  const mesh = useRef<Mesh>(null);
  const group = useRef<Group>(null);
  const shell = useRef<Mesh>(null);
  const shellMaterial = useRef<MeshBasicMaterial>(null);
  const material = useRef<ShaderMaterial>(null);
  const motion = useRef(createOrbMotion());
  const skipDelta = useRef(true);
  const uniforms = useMemo(() => ({
    time: { value: 0 }, energy: { value: 0 }, pulse: { value: 0 }, glitch: { value: 0 }, refinement: { value: 1 },
  }), []);

  // Demand mode needs one frame when a control or motion preference changes.
  useEffect(() => { invalidate(); }, [state, reduced, invalidate]);

  useEffect(() => {
    // Exclude the hidden interval on resume; ordinary visible-frame deltas go
    // through the approved reference's clock and 50ms cap.
    skipDelta.current = true;
    invalidate();
  }, [reduced, visible, invalidate]);

  useEffect(() => {
    if (diagnosticsRef && material.current) {
      diagnosticsRef.current = { selectedState: state, reducedMotion: reduced, motion: motion.current, material: material.current };
    }
    return () => { if (diagnosticsRef) diagnosticsRef.current = null; };
  }, [diagnosticsRef, state, reduced]);

  useFrame((_, delta) => {
    if (!mesh.current || !material.current || !shell.current || !shellMaterial.current || !group.current) return;
    const dt = skipDelta.current || !visible ? 0 : delta;
    skipDelta.current = false;
    const current = motion.current;
    advanceOrbMotion(current, ORB_STATES[state].motion, dt, reduced);
    const live = material.current.uniforms;
    live.time.value = current.elapsed;
    live.energy.value = current.energy;
    live.pulse.value = current.pulse;
    live.glitch.value = 0;
    mesh.current.rotation.y = current.meshRotationY;
    mesh.current.rotation.z = current.meshRotationZ;
    shell.current.rotation.y = current.shellRotationY;
    shellMaterial.current.opacity = current.shellOpacity;
    if (!reduced) {
      const cappedDt = Math.min(dt, 0.05);
      const follow = 1 - Math.exp(-cappedDt * 4);
      group.current.rotation.x += (pointer.current[1] * 0.24 - group.current.rotation.x) * follow;
      group.current.rotation.y += (pointer.current[0] * 0.4 - group.current.rotation.y) * follow;
      group.current.position.x += (pointer.current[0] * 0.18 - group.current.position.x) * follow;
      group.current.position.y += (-pointer.current[1] * 0.12 - group.current.position.y) * follow;
    } else {
      group.current.rotation.set(0, 0, 0);
      group.current.position.set(0, 0, 0);
    }
  });

  // R3F disposes declarative geometry and material when this tree unmounts.
  return (
    <group ref={group} scale={presentationScale}>
      <mesh ref={mesh}>
        <sphereGeometry args={ORB_GEOMETRY} />
        <shaderMaterial
          ref={material}
          uniforms={uniforms}
          vertexShader={orbVertexShader}
          fragmentShader={orbFragmentShader}
          transparent
          depthWrite={false}
          side={DoubleSide}
          blending={NormalBlending}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={shell}>
        <sphereGeometry args={ORB_SHELL_GEOMETRY} />
        <meshBasicMaterial ref={shellMaterial} color={0xdb924b} wireframe transparent opacity={0.035} depthWrite={false} />
      </mesh>
    </group>
  );
}

export default function NoiseOrb({ state, diagnosticsRef }: { state: OrbState; diagnosticsRef?: RefObject<OrbDiagnostics | null> }) {
  const reduced = useSyncExternalStore(subscribeMotion, () => window.matchMedia("(prefers-reduced-motion: reduce)").matches, () => true);
  const desktop = useSyncExternalStore(subscribeViewport, () => window.matchMedia("(min-width: 640px)").matches, () => false);
  const visible = useSyncExternalStore(subscribeVisibility, () => !document.hidden, () => true);
  const pointer = useRef<[number, number]>([0, 0]);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    if (reduced || lost) return;
    const reset = () => { pointer.current[0] = 0; pointer.current[1] = 0; };
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      pointer.current[0] = Math.max(-1, Math.min(1, event.clientX / window.innerWidth * 2 - 1));
      pointer.current[1] = Math.max(-1, Math.min(1, event.clientY / window.innerHeight * 2 - 1));
    };
    window.addEventListener("pointermove", move);
    document.documentElement.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
      reset();
    };
  }, [reduced, lost]);

  if (lost) return <OrbFallback unavailable />;
  return (
    <div style={{ width: "100%", height: "100%" }}>
      <Canvas
        flat
        camera={{ position: [0, 0, CAMERA_Z], fov: 42, near: 0.1, far: 100 }}
        dpr={desktop ? [1, 1.5] : [1, 1.25]}
        frameloop={reduced || !visible ? "demand" : "always"}
        gl={{ alpha: true, antialias: true, powerPreference: "low-power" }}
        fallback={<OrbFallback unavailable />}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
          gl.domElement.setAttribute("aria-hidden", "true");
        }}
      >
        <ContextMonitor onLost={() => setLost(true)} />
        <OrbMesh state={state} reduced={reduced} visible={visible} presentationScale={desktop ? DESKTOP_SCALE : MOBILE_SCALE} pointer={pointer} diagnosticsRef={diagnosticsRef} />
      </Canvas>
    </div>
  );
}
