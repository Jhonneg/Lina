import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

const parser = unified().use(remarkParse).use(remarkGfm);
export const SPEECH_LIMITS = { total: 4000, chunk: 600, chunks: 8 } as const;
export type SpeechNode = { type: string; value?: string; alt?: string | null; children?: readonly SpeechNode[] };
function words(node: SpeechNode): string {
  if (["code", "html", "definition", "footnoteDefinition", "footnoteReference"].includes(node.type)) return "";
  if (node.type === "break") return " ";
  if (node.type === "image") return node.alt ?? "";
  if (node.value !== undefined) return node.value;
  const children = node.children?.map(words).filter(Boolean) ?? [];
  const separator = ["root", "list", "table", "tableRow"].includes(node.type) ? "\n" : "";
  const text = children.join(separator);
  return ["paragraph", "heading", "blockquote", "listItem", "tableCell"].includes(node.type) ? `${text}\n` : text;
}
export function parseSpeechMarkdown(markdown: string) { return parser.parse(markdown.slice(0, 16000)); }
export function speechWords(node: SpeechNode) { return words(node); }
export function spokenResponse(markdown: string) {
  const text = words(parseSpeechMarkdown(markdown)).replace(/\s+/gu, " ").trim();
  const truncated = text.length > SPEECH_LIMITS.total;
  let remaining = text.slice(0, SPEECH_LIMITS.total);
  if (truncated && remaining.lastIndexOf(" ") > SPEECH_LIMITS.total - 80) remaining = remaining.slice(0, remaining.lastIndexOf(" "));
  if (/[\uD800-\uDBFF]$/.test(remaining)) remaining = remaining.slice(0, -1);
  const chunks: string[] = [];
  while (remaining && chunks.length < SPEECH_LIMITS.chunks) {
    let end = Math.min(remaining.length, SPEECH_LIMITS.chunk);
    if (end < remaining.length) {
      const prefix = remaining.slice(0, end);
      const sentence = Math.max(prefix.lastIndexOf(". "), prefix.lastIndexOf("! "), prefix.lastIndexOf("? "));
      const word = prefix.lastIndexOf(" ");
      if (sentence > end / 2) end = sentence + 1;
      else if (word > end / 2) end = word;
      // Preserve surrogate pairs when an unusually long word needs splitting.
      if (/[\uD800-\uDBFF]$/.test(remaining.slice(0, end))) end--;
    }
    chunks.push(remaining.slice(0, end).trim()); remaining = remaining.slice(end).trimStart();
  }
  return { chunks, truncated: truncated || Boolean(remaining) };
}
