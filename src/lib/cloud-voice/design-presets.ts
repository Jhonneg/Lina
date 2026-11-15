/** Voice-design schema. Main chat uses only its explicitly approved, versioned preset. */
export const DELIVERY_DEFAULT = "Calm, gentle, feminine, airy and composed. Subtle low-register resonance with natural articulation. Avoid aggressive, theatrical, hostile or excessively robotic delivery.";
export const DESIGN_RANGES = {
  bass: { label: "Bass", min: 0, max: 8, step: .25, unit: "dB" },
  metal: { label: "Metallic modulation", min: 0, max: 20, step: .5, unit: "%" },
  room: { label: "Reverb", min: 0, max: 15, step: .5, unit: "%" },
  pitch: { label: "Pitch", min: -3, max: 1, step: .1, unit: "semitones" },
  carrier: { label: "Modulation frequency", min: 30, max: 120, step: 1, unit: "Hz" },
  doubling: { label: "Vocal doubling", min: 0, max: 8, step: .5, unit: "%" },
} as const;
export type DesignParameter = keyof typeof DESIGN_RANGES;
export type DesignEffects = Record<DesignParameter, number> & { mode: "original" | "refined" | "custom" };
export const DESIGN_REFINED: DesignEffects = { mode: "refined", bass: 4.5, metal: 9, room: 8, pitch: -1.2, carrier: 68, doubling: 0 };
export const DESIGN_ORIGINAL: DesignEffects = { mode: "original", bass: 0, metal: 0, room: 0, pitch: 0, carrier: 68, doubling: 0 };
export type DesignPreset = { version: 1; name: string; voice: string; delivery: string; effects: DesignEffects };
export const PRESET_KEY = "lain.cloud-voice-design.v1";
export function parseDesignPreset(value: unknown): DesignPreset {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid preset JSON.");
  const preset = value as DesignPreset;
  if (Object.keys(value).some(key => !["version", "name", "voice", "delivery", "effects"].includes(key)) || preset.version !== 1 || typeof preset.name !== "string" || !preset.name.trim() || preset.name.length > 60 || !["marin", "shimmer", "coral", "cedar"].includes(preset.voice) || typeof preset.delivery !== "string" || preset.delivery.length > 1200 || !preset.effects || !["original", "refined", "custom"].includes(preset.effects.mode)) throw Error("Invalid preset fields.");
  for (const [key, bounds] of Object.entries(DESIGN_RANGES)) {
    const value = preset.effects[key as DesignParameter];
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) throw Error(`Invalid ${bounds.label.toLowerCase()} setting.`);
  }
  if (Object.keys(preset.effects).some(key => key !== "mode" && !Object.hasOwn(DESIGN_RANGES, key))) throw Error("Unknown effect setting.");
  const baseline = preset.effects.mode === "refined" ? DESIGN_REFINED : preset.effects.mode === "original" ? DESIGN_ORIGINAL : null;
  if (baseline && Object.keys(DESIGN_RANGES).some(key => preset.effects[key as DesignParameter] !== baseline[key as DesignParameter])) throw Error("Built-in presets must retain their original settings.");
  return { version: 1, name: preset.name.trim(), voice: preset.voice, delivery: preset.delivery, effects: { ...preset.effects } };
}
export function saveDesignPreset(storage: Pick<Storage, "getItem" | "setItem">, preset: DesignPreset) {
  const valid = parseDesignPreset(preset), existing = loadDesignPresets(storage);
  const next = [...existing.filter(item => item.name.toLowerCase() !== valid.name.toLowerCase()), valid].slice(-12);
  storage.setItem(PRESET_KEY, JSON.stringify(next)); return next;
}
export function loadDesignPresets(storage: Pick<Storage, "getItem">): DesignPreset[] {
  const raw = storage.getItem(PRESET_KEY); if (!raw) return [];
  if (raw.length > 32_000) throw Error("Saved presets exceed the size limit.");
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 12) throw Error("Invalid saved presets.");
  return value.map(parseDesignPreset);
}
