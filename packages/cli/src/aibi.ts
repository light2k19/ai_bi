/**
 * aibi — command line companion for building AI BI pages with a local AI.
 *
 *   aibi validate <dir|file>       offline validation (uses catalogue.json from the authoring kit when present)
 *   aibi preview  <dir|file>       run every dataset on the server (read-only) and print columns and rows
 *   aibi pack     <dir> [-o file]  build a .aibi package
 *   aibi push     <dir|file> [--overwrite]  import into the project (new page; overwriting an existing
 *                                  page asks first, or pass --overwrite)
 *   aibi pull     <pageId> [dir]   download a page into a folder for local editing
 *
 * Server settings: aibi.config.json { server, project, token } or env AIBI_SERVER, AIBI_PROJECT, AIBI_TOKEN.
 */
import fs from "node:fs";
import readline from "node:readline/promises";
import path from "node:path";
import crypto from "node:crypto";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { PageBundle, validatePage, formatIssues, defaultFilterValues, PACKAGE_SPEC, type Catalogue, type PackageManifest, type PageBundleInput } from "@aibi/page-spec";
import { runPipeline, toFrame, type Frame, type QueryResult } from "@aibi/transforms";

const C = { red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c: keyof typeof C, s: string) => (color ? `${C[c]}${s}${C.reset}` : s);
const die = (msg: string): never => {
  console.error(paint("red", `error: ${msg}`));
  process.exit(1);
};

/* ───────── loading ───────── */

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push(path.relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

const SKIP_JSON = new Set(["manifest.json", "CHECKSUMS.json", "aibi.config.json", "catalogue.json", "page.schema.json", "package.json"]);

export function loadBundle(target: string): { bundle: PageBundleInput; dir: string } {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) die(`${target} does not exist`);
  const st = fs.statSync(abs);
  if (st.isFile() && /\.(aibi|zip)$/i.test(abs)) {
    const z = unzipSync(new Uint8Array(fs.readFileSync(abs)));
    const page = JSON.parse(strFromU8(z["page.json"] ?? die("package has no page.json")));
    const b: PageBundleInput = { page: "page" in page ? page.page : page, components: {}, scripts: {}, assets: {} };
    for (const [p, d] of Object.entries(z)) {
      if (p.startsWith("components/")) b.components![path.basename(p).replace(/\.\w+$/, "")] = strFromU8(d);
      else if (p.startsWith("scripts/")) b.scripts![path.basename(p).replace(/\.\w+$/, "")] = strFromU8(d);
      else if (p.startsWith("assets/") && !p.endsWith("/")) b.assets![p.slice(7)] = strFromU8(d);
    }
    return { bundle: b, dir: path.dirname(abs) };
  }
  if (st.isFile()) {
    const j = JSON.parse(fs.readFileSync(abs, "utf8"));
    return { bundle: "page" in j ? j : { page: j }, dir: path.dirname(abs) };
  }
  const files = walk(abs);
  const pageFile = files.includes("page.json") ? "page.json" : files.find((f) => !f.includes("/") && f.endsWith(".json") && !SKIP_JSON.has(f));
  if (!pageFile) die(`no page.json in ${target}`);
  const j = JSON.parse(fs.readFileSync(path.join(abs, pageFile!), "utf8"));
  const b: PageBundleInput = "page" in j ? { components: {}, scripts: {}, assets: {}, ...j } : { page: j, components: {}, scripts: {}, assets: {} };
  for (const f of files) {
    const text = () => fs.readFileSync(path.join(abs, f), "utf8");
    if (f.startsWith("components/") && /\.(tsx|jsx|ts|js)$/.test(f)) b.components![path.basename(f).replace(/\.\w+$/, "")] = text();
    else if (f.startsWith("scripts/") && /\.(m?js|ts)$/.test(f)) b.scripts![path.basename(f).replace(/\.\w+$/, "")] = text();
    else if (f.startsWith("assets/")) b.assets![f.slice(7)] = text();
  }
  return { bundle: b, dir: abs };
}

function findUp(start: string, name: string): string | null {
  let d = path.resolve(start);
  for (;;) {
    const p = path.join(d, name);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function loadCatalogue(dir: string): Catalogue | undefined {
  const p = findUp(dir, "catalogue.json");
  return p ? (JSON.parse(fs.readFileSync(p, "utf8")) as Catalogue) : undefined;
}

interface Settings {
  server: string;
  project: string;
  token: string;
}
function settings(dir: string): Settings {
  const p = findUp(dir, "aibi.config.json");
  const cfg = p ? (JSON.parse(fs.readFileSync(p, "utf8")) as Partial<Settings>) : {};
  const s = {
    server: (process.env.AIBI_SERVER ?? cfg.server ?? "").replace(/\/$/, ""),
    project: process.env.AIBI_PROJECT ?? cfg.project ?? "",
    token: process.env.AIBI_TOKEN ?? (cfg.token && !cfg.token.startsWith("<") ? cfg.token : ""),
  };
  if (!s.server || !s.project) die("set server and project in aibi.config.json (or AIBI_SERVER / AIBI_PROJECT)");
  if (!s.token) die("set a personal access token: AIBI_TOKEN=aibi_pat_… (create one in Settings → Personal access tokens)");
  return s;
}

async function call<T>(s: Settings, p: string, init: { method?: string; json?: unknown; body?: FormData } = {}): Promise<T> {
  const r = await fetch(`${s.server}/api/projects/${s.project}${p}`, {
    method: init.method ?? (init.json !== undefined || init.body ? "POST" : "GET"),
    headers: { authorization: `Bearer ${s.token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  const text = await r.text();
  let j: unknown = text;
  try {
    j = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!r.ok) {
    const e = j as { error?: string; details?: { errors?: { path: string; message: string }[] } };
    const extra = e?.details?.errors?.map((x) => `\n  ${x.path}: ${x.message}`).join("") ?? "";
    die(`${r.status} ${e?.error ?? text.slice(0, 300)}${extra}`);
  }
  return j as T;
}

/* ───────── packing ───────── */

const sha = (d: Uint8Array) => crypto.createHash("sha256").update(d).digest("hex");

export function pack(bundleInput: PageBundleInput): Uint8Array {
  const b = PageBundle.parse(bundleInput);
  const v = validatePage(b);
  const files: Record<string, Uint8Array> = {};
  files["page.json"] = strToU8(JSON.stringify(b.page, null, 2));
  for (const [n, s] of Object.entries(b.components)) files[`components/${n}.tsx`] = strToU8(s);
  for (const [n, s] of Object.entries(b.scripts)) files[`scripts/${n}.js`] = strToU8(s);
  for (const [n, s] of Object.entries(b.assets)) files[`assets/${n}`] = strToU8(s);
  const req = v.requires ?? { skills: {}, sources: {}, modules: {} };
  const manifest: PackageManifest = {
    spec: PACKAGE_SPEC,
    name: b.page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page",
    version: "1.0.0",
    title: b.page.title,
    description: b.page.description,
    exportedAt: new Date().toISOString(),
    app: { name: "ai-bi", version: "0.1.0", minVersion: "0.1.0" },
    kind: "page",
    page: { id: b.page.id, file: "page.json" },
    requires: {
      skills: Object.entries(req.skills).map(([id, range]) => ({ id, range })),
      sources: Object.entries(req.sources).map(([alias, s]) => ({ alias, skill: s.skill, dialect: s.dialect, tables: s.tables ?? [] })),
      modules: b.page.modules.map((m) => ({ name: m.name, version: m.version, hash: m.hash, integrity: m.integrity, bundled: false, url: m.url })),
    },
    contents: { components: Object.keys(b.components), scripts: Object.keys(b.scripts), assets: Object.keys(b.assets) },
    sampleData: false,
    checksums: "CHECKSUMS.json",
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  const sums: Record<string, string> = {};
  for (const [p, d] of Object.entries(files)) sums[p] = sha(d);
  files["CHECKSUMS.json"] = strToU8(JSON.stringify(sums, null, 2));
  return zipSync(files, { level: 6 });
}

/* ───────── commands ───────── */

function cmdValidate(target: string) {
  const { bundle, dir } = loadBundle(target);
  const catalogue = loadCatalogue(dir);
  const v = validatePage(bundle, { catalogue });
  console.log(v.errors.length ? paint("red", formatIssues(v)) : v.warnings.length ? paint("yellow", formatIssues(v)) : paint("green", "OK — no errors or warnings"));
  if (!catalogue) console.log(paint("dim", "(no catalogue.json found: widget types and data sources were not checked)"));
  if (v.errors.length) process.exit(1);
}

function table(f: Frame, n = 5) {
  const cols = f.columns.map((c) => c.name);
  const rows = f.rows.slice(0, n).map((r) => cols.map((c) => (r[c] === null || r[c] === undefined ? "∅" : String(r[c]).slice(0, 24))));
  const w = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => "  " + cells.map((c, i) => c.padEnd(w[i])).join("  ");
  return [paint("dim", line(cols)), ...rows.map(line)].join("\n");
}

async function cmdPreview(target: string) {
  const { bundle, dir } = loadBundle(target);
  const s = settings(dir);
  const b = PageBundle.parse(bundle);
  const remote = await call<{ ok: boolean; errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] }>(s, "/validate", { json: { bundle: b } });
  console.log(remote.ok ? paint("green", "server validation: OK") : paint("red", `server validation:\n${formatIssues(remote)}`));
  const filters = defaultFilterValues(b.page.filters);
  const frames: Record<string, Frame> = {};
  let failed = 0;
  const pending = [...b.page.datasets];
  for (let guard = 0; pending.length && guard < 50; guard++) {
    const d = pending.shift()!;
    const deps = [...(d.from ?? []), ...(d.pipeline ?? []).map((x) => (x as { with?: string }).with).filter((x): x is string => !!x)];
    if (deps.some((x) => !frames[x] && pending.some((p) => p.id === x))) {
      pending.push(d);
      continue;
    }
    try {
      let base: Frame;
      if (d.source && d.request) {
        const r = await call<QueryResult>(s, "/query/adhoc", { json: { source: d.source, request: d.request, filters, page: { id: b.page.id, title: b.page.title }, maxRows: 5000 } });
        base = toFrame(r);
      } else base = frames[d.from![0]] ?? die(`dataset ${d.from?.[0]} failed`);
      const f = runPipeline(base, d.pipeline as never, { datasets: frames, vars: { filters, page: { id: b.page.id } } });
      frames[d.id] = f;
      console.log(`\n${paint("bold", d.id)} ${paint("dim", `${f.rows.length} rows · ${f.columns.map((c) => `${c.name}:${c.type}`).join(", ")}`)}`);
      console.log(table(f));
    } catch (e) {
      failed++;
      console.log(`\n${paint("bold", d.id)} ${paint("red", (e as Error).message)}`);
    }
  }
  if (failed || !remote.ok) process.exit(1);
}

function cmdPack(target: string, out?: string) {
  const { bundle, dir } = loadBundle(target);
  const v = validatePage(bundle, { catalogue: loadCatalogue(dir) });
  if (v.errors.length) die(`fix validation errors first:\n${formatIssues({ errors: v.errors, warnings: [] })}`);
  const b = PageBundle.parse(bundle);
  const file = out ?? `${b.page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page"}.aibi`;
  fs.writeFileSync(file, pack(b));
  console.log(paint("green", `wrote ${file}`));
  return file;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

async function cmdPush(target: string, overwriteFlag = false) {
  const { bundle, dir } = loadBundle(target);
  const s = settings(dir);
  const zip = /\.(aibi|zip)$/i.test(target) ? new Uint8Array(fs.readFileSync(target)) : pack(bundle);
  const fd = new FormData();
  fd.append("file", new Blob([zip as BlobPart]), "push.aibi");
  const rep = await call<{ importId: string; errors: { path: string; message: string }[]; warnings: { path: string; message: string }[]; modes: string[]; sources: { alias: string; suggested: string | null }[]; conflict: { title: string; currentVersion: number } | null }>(s, "/import/analyze", { body: fd });
  for (const w of rep.warnings) console.log(paint("yellow", `warn ${w.path}: ${w.message}`));
  if (rep.errors.length) die(`the server rejected the page:\n${formatIssues({ errors: rep.errors, warnings: [] })}`);
  for (const src of rep.sources) if (!src.suggested) die(`no data source in the project matches '${src.alias}'`);
  const mode = rep.modes.includes("version") ? "version" : "new";
  let overwrite = false;
  if (mode === "version" && rep.conflict) {
    overwrite = overwriteFlag || (await confirm(`Page “${rep.conflict.title}” (v${rep.conflict.currentVersion}) already exists. Overwrite it? The old version stays in its history.`));
    if (!overwrite) die(`page “${rep.conflict.title}” already exists; run again with --overwrite to replace it (saved as v${rep.conflict.currentVersion + 1})`);
  }
  const r = await call<{ id: string; versionNo: number }>(s, `/import/${rep.importId}/commit`, { json: { mode, mapping: {}, overwrite } });
  console.log(paint("green", `${mode === "version" ? "saved new version" : "created page"} ${r.id} v${r.versionNo}`));
  console.log(`open: ${s.server.replace(/:8787$/, ":5173")}/p/${s.project}/pages/${r.id}`);
}

async function cmdPull(pageId: string, out?: string) {
  const s = settings(process.cwd());
  const r = await call<{ bundle: PageBundle; version: { versionNo: number } }>(s, `/pages/${pageId}`);
  const dir = path.resolve(out ?? pageId);
  fs.mkdirSync(dir, { recursive: true });
  const { components, scripts, assets, ...rest } = r.bundle;
  fs.writeFileSync(path.join(dir, "page.json"), JSON.stringify(rest.page, null, 2));
  for (const [n, src] of Object.entries(components)) {
    fs.mkdirSync(path.join(dir, "components"), { recursive: true });
    fs.writeFileSync(path.join(dir, "components", `${n}.tsx`), src);
  }
  for (const [n, src] of Object.entries(scripts)) {
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", `${n}.js`), src);
  }
  for (const [n, src] of Object.entries(assets)) {
    fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(dir, "assets", n), src);
  }
  console.log(paint("green", `pulled ${pageId} v${r.version.versionNo} into ${dir}`));
}

const HELP = `aibi — build AI BI pages locally

  aibi validate <dir|file>       validate offline (uses catalogue.json from the authoring kit)
  aibi preview  <dir|file>       run datasets on the server, read-only (needs a token with query:read)
  aibi pack     <dir> [-o file]  build a .aibi package
  aibi push     <dir|file> [--overwrite]
                                 import into the project (needs page:import); asks before
                                 overwriting an existing page unless --overwrite is given
  aibi pull     <pageId> [dir]   download a page for local editing (needs page:read)

Settings: aibi.config.json { "server", "project", "token" } or AIBI_SERVER, AIBI_PROJECT, AIBI_TOKEN.`;

async function main(argv: string[]) {
  const [cmd, a, ...rest] = argv;
  const opt = (flag: string) => {
    const i = rest.indexOf(flag);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  switch (cmd) {
    case "validate":
      return cmdValidate(a ?? ".");
    case "preview":
      return cmdPreview(a ?? ".");
    case "pack":
      return void cmdPack(a ?? ".", opt("-o"));
    case "push":
      return cmdPush(a && !a.startsWith("--") ? a : ".", argv.includes("--overwrite"));
    case "pull":
      if (!a) die("usage: aibi pull <pageId> [dir]");
      return cmdPull(a!, rest[0]);
    default:
      console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((e) => die((e as Error).message));
