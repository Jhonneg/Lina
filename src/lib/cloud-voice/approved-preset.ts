import suppliedPreset from "../../../docs/references/lain-voice-preset.json";
import { parseDesignPreset } from "./design-presets";

/** Explicitly approved source; lab edits and browser preferences cannot replace it. */
const preset = parseDesignPreset(suppliedPreset);
export const APPROVED_VOICE_PRESET = Object.freeze({ ...preset, effects: Object.freeze({ ...preset.effects }) });
