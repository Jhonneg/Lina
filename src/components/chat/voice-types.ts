/** View state shared by cloud playback controls and the voice controller. */
export type VoiceView = {
  enabled: boolean; permitted: boolean; preferredEnabled: boolean; volume: number;
  state: "idle" | "activating" | "generating" | "buffering" | "playing" | "error";
  messageId: string | null; progress: string; error: string | null; notice: string | null;
};
