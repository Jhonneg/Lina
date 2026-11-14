"use client";

import { createContext, lazy, memo, Suspense, useContext } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "./copy-button";
import styles from "./markdown.module.css";

const HighlightedCode = lazy(() => import("./highlighted-code"));
const Streaming = createContext(false);
const plugins = [remarkGfm];

function CodeBlock({ text, language }: { text: string; language: string }) {
  const streaming = useContext(Streaming);
  return <div className={styles.codeBlock} data-code-language={language || "text"}>
    <div className={styles.codeHeader}><span>{language || "text"}</span><CopyButton text={text} label="Copy code" /></div>
    <pre tabIndex={0} aria-label={`${language || "Plain text"} code`}><code>
      {streaming || !language ? text : <Suspense fallback={text}><HighlightedCode text={text} language={language} /></Suspense>}
    </code></pre>
  </div>;
}

const components: Components = {
  pre({ node, children }) {
    const code = node?.children[0];
    if (code?.type !== "element" || code.tagName !== "code") return <pre>{children}</pre>;
    const classes = code.properties.className;
    const language = Array.isArray(classes) ? String(classes.find(name => String(name).startsWith("language-")) ?? "").slice(9) : "";
    const text = code.children.map(child => child.type === "text" ? child.value : "").join("");
    return <CodeBlock text={text} language={language.toLowerCase()} />;
  },
  a({ href, children }) {
    // react-markdown's default URL transform removes unsafe schemes.
    return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
  },
  // Model-generated remote images must not trigger third-party tracking requests.
  img({ alt }) { return <span>{alt || "Image"}</span>; },
  table({ children }) {
    return <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Response table"><table>{children}</table></div>;
  },
};

export const MarkdownResponse = memo(function MarkdownResponse({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return <div className={styles.markdown} data-streaming={streaming && Boolean(content)}>
    <Streaming.Provider value={streaming}>
      <Markdown skipHtml remarkPlugins={plugins} components={components}>{content}</Markdown>
    </Streaming.Provider>
    {streaming && content && <span className={styles.streamingCursor} data-streaming-cursor aria-hidden="true" />}
  </div>;
});
