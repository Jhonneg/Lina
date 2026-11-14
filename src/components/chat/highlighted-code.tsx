import { memo, type ReactNode } from "react";
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";

const highlighter = createLowlight({ bash, c, css, javascript, json, python, sql, typescript, xml });
// Explicit grammars only: no language autodetection or full/common registry.
export function highlightCode(text: string, language: string): ReactNode {
  if (!highlighter.registered(language) || text.length > 16000) return text;
  try {
    const tree = highlighter.highlight(language, text);
    function render(nodes: typeof tree.children): ReactNode {
      return nodes.map((node, index) => {
        if (node.type === "text") return node.value;
        // Only library-produced text and span classes cross into React. Never HTML.
        if (node.type === "element") return <span key={index} className={Array.isArray(node.properties.className) ? node.properties.className.join(" ") : undefined}>{render(node.children)}</span>;
        return null;
      });
    }
    return render(tree.children);
  } catch { return text; }
}

export default memo(function HighlightedCode({ text, language }: { text: string; language: string }) {
  return <>{highlightCode(text, language)}</>;
});
