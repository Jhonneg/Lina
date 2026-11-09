# Lain 2.0 — Original Noise Orb Source Guide

**Authoritative reference:** `docs/references/lain-three-prototypes-amber.html` (user-supplied original demo). The specific orb is **panel 02 / DISTORTION**. Adapt this code to React Three Fiber, rather than approximating from still images.

## Geometry / material

- `new THREE.SphereGeometry(1.66, 112, 80)` with a custom `ShaderMaterial`:
  - `transparent: true`
  - `side: THREE.FrontSide`
  - `depthWrite: false`
  - uniforms `time`, `energy`, `pulse`, `glitch`.
- Second shell: `SphereGeometry(1.72, 34, 25)` + `MeshBasicMaterial({ color: 0xdb924b, wireframe: true, transparent: true, opacity: 0.095, depthWrite: false })`.
- Camera in four-up demo: perspective FOV 42°, position z=7; for the app adjust presentation scale so **visible orb** remains compact, ~180–240px desktop and 120–160px mobile. Do not blindly reuse panel-sized positioning.

## Exact vertex shader from original

```glsl
uniform float time;
uniform float energy;
uniform float pulse;
uniform float glitch;
varying vec3 vNormal;
varying vec3 vPos;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec3 n = normalize(position);
  float wave = sin(position.x * 5.8 + time * (0.65 + energy * 2.0))
             * sin(position.y * 6.4 - time * 0.88)
             * sin(position.z * 4.8 + time * 0.7);
  float detail = sin(position.y * 13.0 + position.x * 6.0
                   + time * (0.8 + energy * 2.5)) * 0.5;
  float displacement = (wave * 0.20 + detail * 0.045)
                     * (1.0 + energy * 0.75 + pulse * 1.8);
  vec3 pos = position + n * (displacement + glitch * 0.07
                  * sin(position.y * 55.0 + time * 40.0));
  vPos = pos;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
}
```

## Exact fragment shader from original

```glsl
uniform float time;
uniform float energy;
uniform float pulse;
varying vec3 vNormal;
varying vec3 vPos;
varying vec2 vUv;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0))), 1.9);
  float grid = min(abs(fract(vUv.x * 29.0) - 0.5), abs(fract(vUv.y * 19.0) - 0.5));
  float lines = 1.0 - smoothstep(0.01, 0.055, grid);
  float waves = sin(vPos.y * 17.0 + vPos.x * 8.0 + time * 2.0) * 0.5 + 0.5;
  vec3 col = mix(vec3(0.12, 0.055, 0.045), vec3(0.90, 0.52, 0.25),
                 clamp(f * 0.9 + lines * 0.52 + waves * 0.24 + pulse * 0.4, 0.0, 1.0));
  float a = 0.20 + f * 0.58 + lines * 0.18 + pulse * 0.18;
  gl_FragColor = vec4(col, clamp(a, 0.0, 0.95));
}
```

## Animation logic / state machine

Extracted from original demo:

```ts
const goalEnergy = mode === 'thinking' ? 1 : mode === 'talking' ? 0.48 : 0;
const ease = Math.min(1, dt * 2.7);
energy += (goalEnergy - energy) * ease;

const pulsePeriod = mode === 'talking' ? 0.42 : mode === 'thinking' ? 1.35 : 4;
if (t - lastPulse > pulsePeriod) {
  lastPulse = t;
  pulse = mode === 'talking' ? 1 : mode === 'thinking' ? 0.4 : 0.16;
}
pulse *= Math.exp(-dt * 6);

// orb mesh rotation:
mesh.rotation.y += dt * (0.11 + energy * 0.27);
mesh.rotation.z += dt * 0.035;
// second shell rotates independently:
shell.rotation.y -= dt * 0.06;
shell.material.opacity = 0.07 + energy * 0.08 + pulse * 0.12;
```

`morph` in the original state loop is **for the separate particle prototype**, not Noise Orb: do not add it to Noise Orb. The original also has a manual `glitch` button (`glitchUntil = t+0.7`) with smooth ramp and a reduced-motion preference. Glitch is optional unless reproducing the whole demo.

## React Three Fiber integration checklist

1. Reuse these **actual original shader formulas**; preserve numeric coefficients first, then compare visually, before doing any design tweaks.
2. Put uniforms in stable refs and mutate via `useFrame`; **do not** call React state setters per frame.
3. Use elapsed time and delta from R3F, with appropriate delta cap for pulse/rotation and guard when tab is hidden.
4. Set state targets from UI props, not stale closures; reset or schedule pulse timing carefully on switching modes.
5. Displace the shader sphere while rendering the separate **undistorted** low-opacity wireframe shell. Both objects contribute to the look.
6. Use the original amber palette, transparent blending, and `depthWrite=false`. Preserve geometry resolution (112×80) initially to compare visually.
7. Preserve the currently approved compact screen footprint; adjust camera/mesh scaling without changing shader constants for the initial fidelity pass.
8. Confirm reduced-motion behavior, mobile DPR cap, and proper cleanup on unmount.
9. Visually compare Idle, Thinking, and Talking against the original HTML running in a browser. The original HTML requires internet for Three.js CDN.

## Critical nuance

The source shader is not true GLSL noise or a dynamically generated mesh topology: it uses **three multiplied sine waves** plus a detail sine, and paints a **UV-based grid** in the fragment shader. Replacing the source with a simplex-noise shader or a standard wireframe material can produce a similar still image while creating very different animation.
