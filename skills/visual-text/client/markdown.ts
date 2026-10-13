import { marked } from "marked";
import DOMPurify from "dompurify";
import { resolveBindings, type Formatter } from "@aibi/page-spec";

const BINDING = /\{\{([\s\S]+?)\}\}/g;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** Markdown (GFM) → sanitized HTML. */
export function renderMarkdown(md: string): string {
  const html = marked.parse(md, { gfm: true, breaks: false, async: false });
  return DOMPurify.sanitize(typeof html === "string" ? html : "", { USE_PROFILES: { html: true } });
}

/**
 * Replace each {{ }} binding in `text` separately, so one failing expression does not blank the rest:
 * a failed binding renders as its expression text (with the error as a tooltip).
 */
export function interpolate(text: string, scope: Record<string, unknown>, formatters: Record<string, Formatter>, display: (v: unknown) => string): string {
  return text.replace(BINDING, (m) => {
    try {
      const v = resolveBindings(m, scope, formatters);
      return escapeHtml(display(v));
    } catch (e) {
      return `<code class="aibi-binding-error" title="${escapeHtml((e as Error).message ?? "Invalid binding")}">${escapeHtml(m)}</code>`;
    }
  });
}

/** Open links in a new tab and keep the opener isolated. */
export function hardenLinks(root: HTMLElement | null) {
  if (!root) return;
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    if (a.getAttribute("href")?.startsWith("#")) return;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}
