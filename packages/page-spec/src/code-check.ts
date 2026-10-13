/**
 * Static checks for page scripts and custom components. The sandbox (separate origin + CSP)
 * is the real boundary; these checks give early, explainable feedback to the AI and users
 * and block the obvious attempts to reach outside the Page API.
 */

export const BUILTIN_IMPORTS = ["react", "react/jsx-runtime", "@aibi/runtime-api", "@aibi/anim", "@aibi/util"];

const BANNED: { re: RegExp; msg: string }[] = [
  { re: /\bfetch\s*\(/, msg: "fetch() is not available; use data.get()/data.reload() from the Page API" },
  { re: /\bXMLHttpRequest\b/, msg: "XMLHttpRequest is not available; use the Page API" },
  { re: /\bWebSocket\b|\bEventSource\b/, msg: "network sockets are not available" },
  { re: /\bnavigator\s*\.\s*sendBeacon\b/, msg: "sendBeacon is not available" },
  { re: /\beval\s*\(/, msg: "eval() is not allowed" },
  { re: /\bnew\s+Function\b|\bFunction\s*\(/, msg: "the Function constructor is not allowed" },
  { re: /\bimportScripts\b/, msg: "importScripts is not allowed" },
  { re: /\b(window|self|globalThis)\s*\.\s*(parent|top|opener)\b|\bparent\s*\.\s*(postMessage|location|document|window)\b|\btop\s*\.\s*(location|document)\b/, msg: "access to the host window is not allowed" },
  { re: /\bdocument\s*\.\s*cookie\b/, msg: "cookies are not available" },
  { re: /\b(localStorage|sessionStorage|indexedDB)\b/, msg: "browser storage is not available to page code; keep state in variables or filters" },
  { re: /\bpostMessage\s*\(/, msg: "postMessage is reserved for the runtime bridge" },
  { re: /\bnew\s+(Shared)?Worker\b|\bserviceWorker\b/, msg: "workers are not allowed" },
  { re: /\bdocument\s*\.\s*write\b/, msg: "document.write is not allowed" },
  { re: /\b__aibi_bridge\b/, msg: "the internal bridge is not accessible" },
];

export interface CodeIssue {
  message: string;
  line?: number;
}

/** Remove comments and string literal contents (keeps template literals, which may contain code). */
export function stripCommentsAndStrings(code: string): string {
  let out = "";
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (c === "/" && n === "/") {
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = code.indexOf("*/", i + 2);
      const chunk = code.slice(i, end < 0 ? code.length : end + 2);
      out += chunk.replace(/[^\n]/g, " ");
      i = end < 0 ? code.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      out += c;
      i++;
      while (i < code.length && code[i] !== c && code[i] !== "\n") {
        if (code[i] === "\\") {
          out += "  ";
          i += 2;
          continue;
        }
        out += " ";
        i++;
      }
      out += code[i] ?? "";
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Import specifiers used by an ES module source. */
export function findImports(code: string): string[] {
  const out = new Set<string>();
  const res = [
    /\bimport\s+(?:[\w*{}\s,$]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s*from\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of res) for (const m of code.matchAll(re)) out.add(m[1]);
  return [...out];
}

function lineOf(code: string, index: number) {
  return code.slice(0, index).split("\n").length;
}

export function checkCode(
  code: string,
  opts: { kind: "script" | "component"; modules: string[]; components?: string[]; maxBytes?: number },
): CodeIssue[] {
  const issues: CodeIssue[] = [];
  const maxBytes = opts.maxBytes ?? 200_000;
  if (code.length > maxBytes) issues.push({ message: `source is larger than ${maxBytes} bytes` });
  const stripped = stripCommentsAndStrings(code);
  for (const b of BANNED) {
    const m = b.re.exec(stripped);
    if (m) issues.push({ message: b.msg, line: lineOf(stripped, m.index) });
  }
  const allowed = new Set([...BUILTIN_IMPORTS, ...opts.modules]);
  for (const spec of findImports(code)) {
    if (allowed.has(spec)) continue;
    if (opts.modules.some((m) => spec.startsWith(m + "/"))) continue;
    if (spec.startsWith("@components/") && (opts.components ?? []).includes(spec.slice(12))) continue;
    if (spec.startsWith("http:") || spec.startsWith("https:") || spec.startsWith("//")) {
      issues.push({ message: `import '${spec}': URLs are not allowed; add the module to the page modules list and import it by name` });
      continue;
    }
    issues.push({ message: `import '${spec}' is not declared; declare it in page.modules or use one of: ${[...allowed].join(", ")}` });
  }
  if (!/\bexport\s+default\b/.test(stripped)) {
    issues.push({ message: opts.kind === "component" ? "component must `export default` a React component" : "script must `export default` a function ({ page, filters, data, widgets, events, anim, util }) => void" });
  }
  return issues;
}
