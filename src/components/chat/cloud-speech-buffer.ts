import { SpeechSegmenter } from "./speech-segmenter";

/** At most three paid segments; reserve the final batch for the completion flush. */
export class CloudSpeechBuffer {
  private segmenter = new SpeechSegmenter(800);
  private pending: string[] = [];
  private final = false;
  private sent = 0;
  constructor(private readonly progressive: boolean) {}
  get truncated() { return this.segmenter.truncated; }
  get rewritten() { return this.segmenter.rewritten; }
  get finished() { return this.segmenter.finished && !this.pending.length; }
  update(content: string, final: boolean) {
    this.final ||= final; this.segmenter.update(content, final);
    let part: string | undefined;
    while ((part = this.segmenter.next()) !== undefined) this.pending.push(part);
  }
  next(): { text: string; index: number; final: boolean } | undefined {
    if (!this.pending.length || (!this.progressive && !this.final)) return;
    if (this.sent === 2 && !this.final && !this.segmenter.finished) return;
    const text = this.pending.splice(0).join(" "), index = this.sent++;
    return { text, index, final: this.segmenter.finished };
  }
}
