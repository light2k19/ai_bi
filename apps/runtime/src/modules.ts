/**
 * Module loading for page code inside the sandbox.
 *  - Page scripts and custom components are compiled with Sucrase and imported from blob: URLs.
 *  - Import specifiers are rewritten here (no import maps): react, react/jsx-runtime, react-dom,
 *    @aibi/anim, @aibi/runtime-api, @aibi/util, @components/<Name>, and declared page modules.
 *  - Page modules come from the server's content-addressed store; every file is verified against
 *    the sha256 in its name before use, its relative imports are loaded the same way, and bare
 *    react imports are bound to the runtime's single React instance.
 */
import * as React from "react";
import * as ReactDOM from "react-dom";
import * as JsxRuntime from "react/jsx-runtime";
import { transform } from "sucrase";
import type { ModuleRef } from "@aibi/page-spec";
import type { LocalModuleSource } from "@aibi/runtime-api/protocol";

export interface SharedScope {
  React: typeof React;
  ReactDOM: typeof ReactDOM;
  jsx: typeof JsxRuntime;
  anim: Record<string, unknown>;
  util: Record<string, unknown>;
  hooks: Record<string, unknown>;
}

declare global {
  interface Window {
    __aibi_shared: SharedScope;
  }
}

const ID = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const blob = (code: string) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));

let builtinUrls: Record<string, string> | null = null;
function builtins(): Record<string, string> {
  if (builtinUrls) return builtinUrls;
  const named = (obj: object, expr: string) => {
    const keys = Object.keys(obj).filter((k) => ID.test(k) && k !== "default");
    return `const M = ${expr};\nexport default (M.default ?? M);\n${keys.length ? `export const { ${keys.join(", ")} } = M;` : ""}`;
  };
  const s = window.__aibi_shared;
  builtinUrls = {
    react: blob(named(s.React, "window.__aibi_shared.React")),
    "react-dom": blob(named(s.ReactDOM, "window.__aibi_shared.ReactDOM")),
    "react/jsx-runtime": blob(`const J = window.__aibi_shared.jsx;\nexport const jsx = J.jsx, jsxs = J.jsxs, Fragment = J.Fragment;`),
    "react/jsx-dev-runtime": blob(`const J = window.__aibi_shared.jsx;\nexport const jsxDEV = J.jsx, Fragment = J.Fragment;`),
    "@aibi/anim": blob(named(s.anim, "window.__aibi_shared.anim")),
    "@aibi/util": blob(named(s.util, "window.__aibi_shared.util")),
    "@aibi/runtime-api": blob(named(s.hooks, "window.__aibi_shared.hooks")),
  };
  return builtinUrls;
}

const SPEC_RE = [
  /(\bimport\s*(?:[\w*${}\s,]+?\s*from\s*)?)(["'])([^"']+)\2/g,
  /(\bexport\s*(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*)(["'])([^"']+)\2/g,
  /(\bimport\s*\(\s*)(["'])([^"']+)\2/g,
];

/** Rewrite import specifiers with a resolver; unresolved specifiers raise a clear error. */
export function rewriteImports(code: string, resolve: (spec: string) => string | null, where: string): string {
  let out = code;
  for (const re of SPEC_RE) {
    out = out.replace(re, (m, pre: string, q: string, spec: string) => {
      if (spec.startsWith("blob:") || spec.startsWith("data:")) return m;
      const r = resolve(spec);
      if (!r) throw new Error(`${where}: cannot resolve import '${spec}'. Declare it in page modules or use @aibi/anim, @aibi/runtime-api, react.`);
      return `${pre}${q}${r}${q}`;
    });
  }
  return out;
}

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ───────────── page modules ───────────── */

const fileCache = new Map<string, Promise<string>>(); // hash -> blob url

function loadFile(hash: string, getText: (hash: string) => Promise<string>, pageModules: Record<string, string>, verify: boolean): Promise<string> {
  let p = fileCache.get(hash);
  if (p) return p;
  p = (async () => {
    const text = await getText(hash);
    if (verify) {
      const h = await sha256Hex(text);
      if (h !== hash) throw new Error(`module file ${hash.slice(0, 12)}… failed its integrity check`);
    }
    // collect relative deps first so they become blob URLs
    const rel = new Set<string>();
    for (const re of SPEC_RE) for (const m of text.matchAll(re)) if (/^\.\/[a-f0-9]{64}\.mjs$/.test(m[3])) rel.add(m[3]);
    const depUrls: Record<string, string> = {};
    for (const r of rel) depUrls[r] = await loadFile(r.slice(2, 66), getText, pageModules, verify);
    const b = builtins();
    const code = rewriteImports(
      text,
      (spec) => depUrls[spec] ?? b[spec] ?? pageModules[spec] ?? (spec.startsWith("http") ? spec : null),
      `module file ${hash.slice(0, 12)}`,
    );
    return blob(code);
  })();
  fileCache.set(hash, p);
  p.catch(() => fileCache.delete(hash));
  return p;
}

export interface LoadedModules {
  /** specifier -> URL usable by import() */
  urls: Record<string, string>;
  /** loaded namespaces by module name */
  namespaces: Record<string, Record<string, unknown>>;
  errors: Record<string, string>;
}

export async function loadPageModules(mods: ModuleRef[], apiUrl: string, local: Record<string, LocalModuleSource> = {}): Promise<LoadedModules> {
  const urls: Record<string, string> = {};
  const namespaces: Record<string, Record<string, unknown>> = {};
  const errors: Record<string, string> = {};
  // two passes so modules can import each other by name
  const pending: Record<string, string> = {};
  for (const m of mods) {
    try {
      const localSrc = local[m.name];
      let entryUrl: string;
      if (localSrc) {
        const files = localSrc.files;
        entryUrl = await loadFile(localSrc.entry, async (h) => {
          if (h === localSrc.entry && !files[h]) return files[localSrc.entry] ?? "";
          const t = files[h];
          if (t === undefined) throw new Error(`local module ${m.name} is missing file ${h}`);
          return t;
        }, pending, true);
      } else if (m.hash) {
        entryUrl = await loadFile(m.hash, async (h) => {
          const r = await fetch(`${apiUrl}/api/modules/${h}.mjs`, { credentials: "omit" });
          if (!r.ok) throw new Error(`HTTP ${r.status} loading module file`);
          return r.text();
        }, pending, true);
      } else throw new Error("module is not resolved (no content hash); save the page or add it again");
      pending[m.name] = entryUrl;
      urls[m.name] = entryUrl;
    } catch (e) {
      errors[m.name] = (e as Error).message;
    }
  }
  for (const [name, url] of Object.entries(urls)) {
    try {
      namespaces[name] = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    } catch (e) {
      errors[name] = `failed to load: ${(e as Error).message}`;
    }
  }
  return { urls, namespaces, errors };
}

/* ───────────── components & scripts ───────────── */

export interface CompiledComponents {
  components: Record<string, React.ComponentType<Record<string, unknown>>>;
  errors: Record<string, string>;
}

export async function compileComponents(sources: Record<string, string>, names: string[], moduleUrls: Record<string, string>): Promise<CompiledComponents> {
  const urls: Record<string, Promise<string>> = {};
  const errors: Record<string, string> = {};
  const components: Record<string, React.ComponentType<Record<string, unknown>>> = {};
  const b = builtins();
  const compile = (name: string, stack: string[]): Promise<string> => {
    if (name in urls) return urls[name];
    urls[name] = (async () => {
      if (stack.includes(name)) throw new Error(`circular component import: ${[...stack, name].join(" → ")}`);
      const src = sources[name];
      if (src === undefined) throw new Error(`component ${name} has no source`);
      const js = transform(src, { transforms: ["typescript", "jsx"], jsxRuntime: "automatic", production: true, filePath: `${name}.tsx` }).code;
      const deps: Record<string, string> = {};
      for (const re of SPEC_RE) for (const m of js.matchAll(re)) if (m[3].startsWith("@components/")) deps[m[3]] = await compile(m[3].slice(12), [...stack, name]);
      const code = rewriteImports(js, (spec) => deps[spec] ?? b[spec] ?? moduleUrls[spec] ?? null, `component ${name}`);
      return blob(code);
    })();
    return urls[name];
  };
  for (const n of names) {
    try {
      const url = await compile(n, []);
      const mod = (await import(/* @vite-ignore */ url)) as { default?: React.ComponentType<Record<string, unknown>> };
      if (typeof mod.default !== "function" && typeof mod.default !== "object") throw new Error("default export is not a React component");
      components[n] = mod.default as React.ComponentType<Record<string, unknown>>;
    } catch (e) {
      errors[n] = (e as Error).message;
    }
  }
  return { components, errors };
}

export type ScriptFn = (ctx: unknown) => unknown;

export async function compileScript(name: string, source: string, moduleUrls: Record<string, string>, componentUrls: Record<string, string> = {}): Promise<ScriptFn> {
  const js = transform(source, { transforms: ["typescript"], production: true, filePath: `${name}.ts` }).code;
  const b = builtins();
  const code = rewriteImports(js, (spec) => b[spec] ?? moduleUrls[spec] ?? componentUrls[spec] ?? null, `script ${name}`);
  const mod = (await import(/* @vite-ignore */ blob(code))) as { default?: ScriptFn };
  if (typeof mod.default !== "function") throw new Error(`script ${name} has no default export function`);
  return mod.default;
}

export function installShared(scope: Omit<SharedScope, "React" | "ReactDOM" | "jsx">) {
  window.__aibi_shared = { React, ReactDOM, jsx: JsxRuntime, ...scope };
}
