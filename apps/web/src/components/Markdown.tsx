import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text ?? "", { async: false, gfm: true, breaks: true }) as string), [text]);
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
