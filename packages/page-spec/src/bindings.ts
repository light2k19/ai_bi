import { compileExpr, evalNode, memberPaths, type Node } from "./expr";

const FULL = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
const ANY = /\{\{([\s\S]+?)\}\}/g;

/** Pipe formatters usable in text bindings: {{ value | currency }} */
export type Formatter = (v: unknown, arg?: string) => string;

/**
 * Split "expr | fmt:arg" into expression and formatter. A '|' inside '||' is not a pipe.
 */
export function splitPipe(src: string): { expr: string; fmt?: string; arg?: string } {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "|" && depth === 0 && src[i + 1] !== "|" && src[i - 1] !== "|") {
      const rest = src.slice(i + 1).trim();
      const [fmt, ...argParts] = rest.split(":");
      return { expr: src.slice(0, i).trim(), fmt: fmt.trim(), arg: argParts.join(":").trim() || undefined };
    }
  }
  return { expr: src.trim() };
}

/**
 * Resolve {{ }} bindings inside any JSON-like value.
 * - A string that is exactly one binding returns the raw value (keeps arrays, numbers, dates).
 * - A string with embedded bindings is interpolated as text.
 */
export function resolveBindings<T>(value: T, scope: Record<string, unknown>, formatters: Record<string, Formatter> = {}): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const full = FULL.exec(v);
      if (full) {
        const { expr, fmt, arg } = splitPipe(full[1]);
        const r = evalNode(compileExpr(expr), scope);
        return fmt && formatters[fmt] ? formatters[fmt](r, arg) : r;
      }
      if (!v.includes("{{")) return v;
      return v.replace(ANY, (_, inner: string) => {
        const { expr, fmt, arg } = splitPipe(inner);
        const r = evalNode(compileExpr(expr), scope);
        if (fmt && formatters[fmt]) return formatters[fmt](r, arg);
        return r === null || r === undefined ? "" : typeof r === "object" ? JSON.stringify(r) : String(r);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = walk(x);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** All binding expressions inside a value, with their parsed ASTs (or parse errors). */
export function findBindings(value: unknown): { src: string; node?: Node; error?: string; path: string }[] {
  const out: { src: string; node?: Node; error?: string; path: string }[] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(ANY)) {
        const { expr } = splitPipe(m[1]);
        try {
          out.push({ src: expr, node: compileExpr(expr), path });
        } catch (e) {
          out.push({ src: expr, error: (e as Error).message, path });
        }
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(value, "");
  return out;
}

/** Member paths (e.g. "filters.date.start") referenced by the bindings in a value. */
export function bindingPaths(value: unknown): string[] {
  const out = new Set<string>();
  for (const b of findBindings(value)) if (b.node) memberPaths(b.node, out);
  return [...out];
}
