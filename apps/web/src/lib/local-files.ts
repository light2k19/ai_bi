/**
 * Loading pages from local files in the browser (no upload needed for a preview):
 *  - <input type=file>, drag-and-drop, paste
 *  - File System Access API (open a file or folder, watch it for changes, save back)
 *  - .aibi packages are unzipped client-side with fflate
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { PageBundle, PackageManifest, PACKAGE_SPEC, type PageBundleInput } from "@aibi/page-spec";
import type { LocalModuleSource } from "@aibi/runtime-api/protocol";

export interface LoadedDraft {
  bundle: PageBundleInput;
  localModules: Record<string, LocalModuleSource & { version: string }>;
  manifest: PackageManifest | null;
  fileName: string;
  warnings: string[];
}

export interface NamedFile {
  path: string;
  file: File;
}

const base = (p: string) => p.split("/").pop()!.replace(/\.(tsx|jsx|ts|js|mjs)$/, "");

async function sha256Hex(data: Uint8Array) {
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Read a zip (.aibi package or zipped folder). */
async function fromZip(buf: ArrayBuffer, fileName: string): Promise<LoadedDraft> {
  const raw = unzipSync(new Uint8Array(buf));
  const entries: Record<string, Uint8Array> = {};
  for (const [p, d] of Object.entries(raw)) if (!p.endsWith("/")) entries[p.replace(/\\/g, "/")] = d;
  // tolerate a single top-level folder
  const roots = new Set(Object.keys(entries).map((k) => k.split("/")[0]));
  if (!entries["page.json"] && !entries["manifest.json"] && roots.size === 1) {
    const r = [...roots][0] + "/";
    for (const k of Object.keys(entries)) {
      entries[k.slice(r.length)] = entries[k];
      delete entries[k];
    }
  }
  const warnings: string[] = [];
  if (entries["CHECKSUMS.json"]) {
    const sums = JSON.parse(strFromU8(entries["CHECKSUMS.json"])) as Record<string, string>;
    for (const [p, h] of Object.entries(sums)) {
      if (!entries[p]) throw new Error(`package is incomplete: ${p} is missing`);
      if ((await sha256Hex(entries[p])) !== h) throw new Error(`checksum mismatch for ${p}: the package was modified or is corrupted`);
    }
  } else warnings.push("The package has no checksums.");
  let manifest: PackageManifest | null = null;
  if (entries["manifest.json"]) {
    const m = PackageManifest.safeParse(JSON.parse(strFromU8(entries["manifest.json"])));
    if (m.success) manifest = m.data;
    else warnings.push("manifest.json is not valid; using page.json only");
  }
  if (!entries["page.json"]) throw new Error("The package has no page.json");
  const pj = JSON.parse(strFromU8(entries["page.json"])) as Record<string, unknown>;
  const bundle: PageBundleInput = { page: ("page" in pj ? pj.page : pj) as never, components: {}, scripts: {}, assets: {} };
  for (const [p, d] of Object.entries(entries)) {
    if (p.startsWith("components/")) bundle.components![base(p)] = strFromU8(d);
    else if (p.startsWith("scripts/")) bundle.scripts![base(p)] = strFromU8(d);
    else if (p.startsWith("assets/")) bundle.assets![p.slice(7)] = strFromU8(d);
  }
  const localModules: LoadedDraft["localModules"] = {};
  for (const m of manifest?.requires.modules ?? []) {
    if (!m.bundled || !m.file || !entries[m.file]) continue;
    const files: Record<string, string> = {};
    for (const [h, p] of Object.entries(m.files ?? {})) if (entries[p]) files[h] = strFromU8(entries[p]);
    const entryHash = m.hash ?? (await sha256Hex(entries[m.file]));
    files[entryHash] = strFromU8(entries[m.file]);
    localModules[m.name] = { entry: entryHash, files, version: m.version };
  }
  return { bundle, localModules, manifest, fileName, warnings };
}

/** Build a draft from any mix of dropped / picked files. */
export async function draftFromFiles(files: NamedFile[]): Promise<LoadedDraft> {
  if (!files.length) throw new Error("No files");
  const zip = files.find((f) => /\.(aibi|zip)$/i.test(f.path));
  if (zip) return fromZip(await zip.file.arrayBuffer(), zip.file.name);
  let bundle: PageBundleInput | null = null;
  const components: Record<string, string> = {};
  const scripts: Record<string, string> = {};
  const assets: Record<string, string> = {};
  for (const { path, file } of files) {
    const name = path.split("/").pop()!;
    if (/\.json$/i.test(name) && !path.includes("assets/")) {
      const j = JSON.parse(await file.text()) as Record<string, unknown>;
      if (name === "manifest.json" || name === "CHECKSUMS.json" || name === "aibi.config.json" || name === "catalogue.json" || name.endsWith(".schema.json")) continue;
      bundle = "page" in j ? (j as PageBundleInput) : { page: j as never };
    } else if (/\.(tsx|jsx)$/i.test(name) || path.includes("components/")) components[base(name)] = await file.text();
    else if (/\.(m?js|ts)$/i.test(name) && !path.includes("modules/") && !name.startsWith("aibi.")) scripts[base(name)] = await file.text();
    else if (path.includes("assets/")) assets[name] = await file.text();
  }
  if (!bundle) throw new Error("No page.json (or page bundle JSON) found in the selection");
  bundle = { ...bundle, components: { ...(bundle.components ?? {}), ...components }, scripts: { ...(bundle.scripts ?? {}), ...scripts }, assets: { ...(bundle.assets ?? {}), ...assets } };
  return { bundle, localModules: {}, manifest: null, fileName: files[0].file.name, warnings: [] };
}

export function draftFromText(text: string): LoadedDraft {
  const j = JSON.parse(text) as Record<string, unknown>;
  const bundle: PageBundleInput = "page" in j ? (j as PageBundleInput) : { page: j as never };
  return { bundle, localModules: {}, manifest: null, fileName: "pasted.json", warnings: [] };
}

/** Files from a drag-and-drop DataTransfer, including dropped folders. */
export async function filesFromDataTransfer(dt: DataTransfer): Promise<NamedFile[]> {
  const items = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean) as FileSystemEntry[];
  if (!items.length) return [...dt.files].map((f) => ({ path: f.name, file: f }));
  const out: NamedFile[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      const kids = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      for (const k of kids) await walk(k, `${prefix}${entry.name}/`);
    }
  };
  for (const e of items) await walk(e, "");
  // strip the dropped folder name so paths look like package paths
  const roots = new Set(out.map((f) => f.path.split("/")[0]));
  if (roots.size === 1 && out.every((f) => f.path.includes("/"))) for (const f of out) f.path = f.path.slice(f.path.indexOf("/") + 1);
  return out;
}

/* ───────── File System Access API (Chrome, Edge) ───────── */

export const fsAccessSupported = () => typeof window !== "undefined" && "showOpenFilePicker" in window;

type PickerWindow = Window & {
  showOpenFilePicker(o?: unknown): Promise<FileSystemFileHandle[]>;
  showSaveFilePicker(o?: unknown): Promise<FileSystemFileHandle>;
  showDirectoryPicker(o?: unknown): Promise<FileSystemDirectoryHandle>;
};

export async function pickFile(): Promise<FileSystemFileHandle> {
  const [h] = await (window as unknown as PickerWindow).showOpenFilePicker({
    types: [{ description: "AI BI page", accept: { "application/json": [".json"], "application/zip": [".aibi", ".zip"] } }],
    excludeAcceptAllOption: false,
  });
  return h;
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  return (window as unknown as PickerWindow).showDirectoryPicker({ mode: "read" });
}

export async function filesFromHandle(h: FileSystemHandle): Promise<{ files: NamedFile[]; lastModified: number }> {
  if (h.kind === "file") {
    const f = await (h as FileSystemFileHandle).getFile();
    return { files: [{ path: f.name, file: f }], lastModified: f.lastModified };
  }
  const out: NamedFile[] = [];
  let last = 0;
  const walk = async (dir: FileSystemDirectoryHandle, prefix: string) => {
    for await (const [name, child] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      if (child.kind === "file") {
        const f = await (child as FileSystemFileHandle).getFile();
        last = Math.max(last, f.lastModified);
        out.push({ path: prefix + name, file: f });
      } else await walk(child as FileSystemDirectoryHandle, `${prefix}${name}/`);
    }
  };
  await walk(h as FileSystemDirectoryHandle, "");
  return { files: out, lastModified: last };
}

export async function ensurePermission(h: FileSystemHandle, mode: "read" | "readwrite" = "read") {
  const hh = h as FileSystemHandle & { queryPermission?(o: unknown): Promise<string>; requestPermission?(o: unknown): Promise<string> };
  if ((await hh.queryPermission?.({ mode })) === "granted") return true;
  return (await hh.requestPermission?.({ mode })) === "granted";
}

/** Poll a handle and call back when its contents change (watch mode). */
export function watchHandle(h: FileSystemHandle, onChange: (d: LoadedDraft) => void, onError: (e: Error) => void, everyMs = 1000) {
  let last = -1;
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const { files, lastModified } = await filesFromHandle(h);
      if (last >= 0 && lastModified !== last) onChange(await draftFromFiles(files));
      last = lastModified;
    } catch (e) {
      onError(e as Error);
    }
    if (!stopped) setTimeout(tick, everyMs);
  };
  void tick();
  return () => {
    stopped = true;
  };
}

/** Build a .aibi package in the browser (no module vendoring beyond what is local). */
export async function buildPackage(bundleInput: PageBundleInput, localModules: Record<string, LocalModuleSource & { version?: string }> = {}): Promise<Uint8Array> {
  const bundle = PageBundle.parse(bundleInput);
  const files: Record<string, Uint8Array> = {};
  files["page.json"] = strToU8(JSON.stringify(bundle.page, null, 2));
  for (const [n, s] of Object.entries(bundle.components)) files[`components/${n}.tsx`] = strToU8(s);
  for (const [n, s] of Object.entries(bundle.scripts)) files[`scripts/${n}.js`] = strToU8(s);
  for (const [n, s] of Object.entries(bundle.assets)) files[`assets/${n}`] = strToU8(s);
  const modules: PackageManifest["requires"]["modules"] = [];
  for (const m of bundle.page.modules) {
    const lm = localModules[m.name];
    const entry: PackageManifest["requires"]["modules"][number] = { name: m.name, version: m.version, hash: m.hash, integrity: m.integrity, bundled: false, url: m.url, providesWidgets: m.providesWidgets };
    if (lm) {
      const dir = `modules/${m.name.replace(/[@/]/g, "_")}@${m.version}`;
      entry.bundled = true;
      entry.files = {};
      for (const [h, code] of Object.entries(lm.files)) {
        files[`${dir}/${h}.mjs`] = strToU8(code);
        entry.files[h] = `${dir}/${h}.mjs`;
      }
      entry.file = `${dir}/${lm.entry}.mjs`;
      entry.hash = lm.entry;
    }
    modules.push(entry);
  }
  const req = bundle.page.requires;
  const manifest: PackageManifest = {
    spec: PACKAGE_SPEC,
    name: bundle.page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page",
    version: "1.0.0",
    title: bundle.page.title,
    description: bundle.page.description,
    exportedAt: new Date().toISOString(),
    app: { name: "ai-bi", version: "0.1.0", minVersion: "0.1.0" },
    kind: "page",
    page: { id: bundle.page.id, file: "page.json" },
    requires: {
      skills: Object.entries(req?.skills ?? {}).map(([id, range]) => ({ id, range })),
      sources: Object.entries(req?.sources ?? {}).map(([alias, s]) => ({ alias, skill: s.skill, dialect: s.dialect, tables: s.tables ?? [], columns: s.columns })),
      modules,
    },
    contents: { components: Object.keys(bundle.components), scripts: Object.keys(bundle.scripts), assets: Object.keys(bundle.assets) },
    sampleData: false,
    checksums: "CHECKSUMS.json",
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  const sums: Record<string, string> = {};
  for (const [p, d] of Object.entries(files)) sums[p] = await sha256Hex(d);
  files["CHECKSUMS.json"] = strToU8(JSON.stringify(sums, null, 2));
  return zipSync(files, { level: 6 });
}

/** Save with the File System Access API when available, else download. */
export async function saveToDisk(data: Uint8Array | string, suggestedName: string, existing?: FileSystemFileHandle): Promise<FileSystemFileHandle | null> {
  const blob = new Blob([data as BlobPart], { type: typeof data === "string" ? "application/json" : "application/zip" });
  if (existing || "showSaveFilePicker" in window) {
    try {
      const h =
        existing ??
        (await (window as unknown as PickerWindow).showSaveFilePicker({
          suggestedName,
          types: suggestedName.endsWith(".json") ? [{ description: "Page bundle", accept: { "application/json": [".json"] } }] : [{ description: "AI BI package", accept: { "application/zip": [".aibi"] } }],
        }));
      if (!(await ensurePermission(h, "readwrite"))) throw new Error("Permission denied");
      const w = await (h as FileSystemFileHandle & { createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(blob);
      await w.close();
      return h;
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
      throw e;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = suggestedName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return null;
}
