export type OrbState = "idle" | "thinking" | "talking";

export type OrbParameters = {
  energy: number;
  pulsePeriod: number;
  pulsePeak: number;
};

// Approved HD Subtle state loop. Pulse peaks are applied before decay.
export const ORB_STATES = {
  idle: {
    label: "Idle", description: "A quiet moment.",
    motion: { energy: 0, pulsePeriod: 4, pulsePeak: 0.16 },
  },
  thinking: {
    label: "Thinking", description: "Following a thought.",
    motion: { energy: 1, pulsePeriod: 1.35, pulsePeak: 0.4 },
  },
  talking: {
    label: "Talking", description: "Finding a rhythm.",
    motion: { energy: 0.48, pulsePeriod: 0.42, pulsePeak: 1 },
  },
} satisfies Record<OrbState, { label: string; description: string; motion: OrbParameters }>;
