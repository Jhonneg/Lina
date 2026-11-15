import { voiceTrace } from "../../lib/voice/diagnostics";
import { parseSpeechMarkdown, speechWords, SPEECH_LIMITS, type SpeechNode } from "./spoken-text";

type PositionedNode = SpeechNode & { position?: { start: { offset?: number }; end: { offset?: number } }; children?: readonly PositionedNode[] };
// These are Markdown AST safety checks, not a second Markdown parser. Ambiguous
// trailing markup is held until remark recognizes a complete construct.
function stableWords(node: PositionedNode, source: string, final: boolean): { text: string; blocked: boolean } {
  if (["code", "html", "definition", "footnoteDefinition", "footnoteReference"].includes(node.type)) return { text: "", blocked: false };
  if (node.type === "inlineCode" || node.type === "image" || node.type === "break") return { text: speechWords(node), blocked: false };
  if (node.value !== undefined) {
    const raw = source.slice(node.position?.start.offset, node.position?.end.offset).replace(/\\[\\`*_[\]~<>|]/gu, "");
    // Only potential open Markdown constructs block a stream. Literal intraword
    // underscores, multiplication, comparisons and pipes must not swallow the suffix.
    const opening = /(?<![\p{L}\p{N}\\])(?:\*{1,3}|_{1,3}|~{2})(?=\S)|`|\[|<(?=[A-Za-z!/])/u;
    if (opening.test(raw)) {
      const index = node.value.search(opening);
      if (index >= 0) {
        if (!final) return { text: node.value.slice(0, index), blocked: true };
        // Final AST is authoritative; retain unfinished emphasis/link labels, but
        // omit incomplete inline code and link destinations rather than reading syntax.
        const text = node.value.replace(/`[^`]*$/u, "")
          .replace(/\[([^\]\n]*)(?:\]\([^\)\n]*\)?)?/gu, "$1")
          .replace(/(?<![\p{L}\p{N}])(?:\*{1,3}|_{1,3}|~{2})|(?:\*{1,3}|_{1,3}|~{2})(?![\p{L}\p{N}])/gu, "");
        return { text, blocked: false };
      }
    }
    return { text: node.value, blocked: false };
  }
  const parts: string[] = [];
  for (const child of node.children ?? []) {
    const result = stableWords(child, source, final); parts.push(result.text);
    if (result.blocked) return { text: parts.join(""), blocked: true };
    if (["paragraph", "heading", "blockquote", "listItem", "tableCell", "tableRow"].includes(child.type)) parts.push("\n");
  }
  return { text: parts.join(""), blocked: false };
}
const sentences = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;
function abbreviation(text: string) {
  return /\b(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|inc|no|fig|e\.g|i\.e|a\.m|p\.m)\.$/iu.test(text.trim()) || /(?:\b[A-Z]\.)+$/u.test(text.trim());
}
export function speechBoundary(text: string, final: boolean, trailingSpace: boolean, eager = true) {
  const max = Math.min(text.length, 240);
  let boundary = 0;
  for (const sentence of sentences?.segment(text) ?? []) {
    const end = sentence.index + sentence.segment.length;
    const prefix = text.slice(0, end).trimEnd();
    if (prefix.length > 600) break;
    if (/[.!?…]["'”’)]*$/u.test(prefix) && !abbreviation(prefix) && (end < text.length || final || trailingSpace)) {
      if (eager) return end;
      if (prefix.length <= 240 || !boundary) boundary = end;
      if (prefix.length > 240) break;
    }
  }
  if (boundary) return boundary;
  if (text.length > 240) {
    const prefix = text.slice(0, max + 1);
    let word = prefix.lastIndexOf(" ");
    const phrase = Math.max(prefix.lastIndexOf("; "), prefix.lastIndexOf(": "), prefix.lastIndexOf(", "), prefix.lastIndexOf("— "));
    if (phrase > 100) word = phrase + 1;
    if (word > 0 && !abbreviation(text.slice(0, word))) return word;
    // A long unbroken word is held, never split just to fill an audio segment.
    const nextSpace = text.indexOf(" ", max);
    if (nextSpace > 0 && nextSpace <= 600) return nextSpace;
  }
  return final ? text.length : 0;
}

/** Stores only bounded text; next() consumes one ordered segment when queue space exists. */
export class SpeechSegmenter {
  private source = "";
  private final = false;
  private dirty = true;
  private available = "";
  private consumed = "";
  private cursor = 0;
  private count = 0;
  private trailing = false;
  private ended = false;
  constructor(private readonly limit: number = SPEECH_LIMITS.total) {}
  truncated = false;
  rewritten = false;
  update(markdown: string, final = false) {
    if (this.ended) return;
    this.source = markdown.slice(0, 16000); this.final ||= final; this.dirty = true;
    if (markdown.length > 16000) this.truncated = true;
  }
  get finished() { return this.ended; }
  next(): string | undefined {
    if (this.ended) return;
    if (this.dirty) {
      // GFM may autolink a URL inside an unfinished Markdown destination. Remove
      // that pending destination before parsing the completed response.
      const markdown = this.final ? this.source.replace(/\[([^\]\n]+)\]\([^\)\n]*$/gu, "$1") : this.source;
      const result = stableWords(parseSpeechMarkdown(markdown), markdown, this.final);
      this.available = result.text.replace(/\s+/gu, " ").trim();
      this.trailing = result.blocked ? /\s$/u.test(result.text) : /\s$/u.test(this.source);
      this.dirty = false;
      // A provider rewrite/reconciliation must never replay an already consumed prefix.
      if (!this.available.startsWith(this.consumed.trimEnd())) { this.ended = true; this.truncated = true; this.rewritten = true; voiceTrace("speech-prefix-changed"); return; }
    }
    const rest = this.available.slice(this.cursor).trimStart();
    if (!rest) { if (this.final) this.ended = true; return; }
    const end = speechBoundary(rest, this.final, this.trailing, this.count === 0 && !this.final);
    if (!end) return;
    const segment = rest.slice(0, end).trim();
    if (!segment) return;
    const start = this.available.indexOf(rest, this.cursor);
    if (start + segment.length > this.limit) {
      const remaining = rest.slice(0, Math.max(0, this.limit - start));
      const boundary = remaining.lastIndexOf(" ");
      this.truncated = true; this.ended = true;
      return boundary > 0 ? remaining.slice(0, boundary) : undefined;
    }
    if (segment.length > 600 || /[\uD800-\uDBFF]$/u.test(segment)) {
      this.truncated = true; this.ended = true; return;
    }
    this.cursor = start + end; this.consumed = this.available.slice(0, this.cursor); this.count = this.cursor;
    return segment;
  }
}
