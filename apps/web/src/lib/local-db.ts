import Dexie, { type Table } from "dexie";
import type { PageBundle } from "@aibi/page-spec";
import type { LocalModuleSource } from "@aibi/runtime-api/protocol";

/** A page kept only in this browser (IndexedDB). */
export interface LocalPage {
  id: string;
  projectSlug: string;
  title: string;
  bundle: PageBundle;
  origin: "local" | "imported" | "synced";
  serverPageId?: string;
  serverVersion?: number;
  fileName?: string;
  createdAt: string;
  updatedAt: string;
}

/** Module code that came with a local package and is not (yet) in the server's module store. */
export interface LocalModule extends LocalModuleSource {
  key: string; // name@version
  name: string;
  version: string;
  size: number;
  addedAt: string;
}

/** Autosaved editor draft (server or local page) so edits survive a reload. */
export interface DraftRecord {
  key: string; // slug:pageId
  bundle: PageBundle;
  baseVersion?: number;
  updatedAt: string;
}

/** File System Access handle remembered for "edit locally, see it live". */
export interface HandleRecord {
  id: string; // local page id
  kind: "file" | "dir";
  name: string;
  handle: FileSystemHandle;
}

class LocalDb extends Dexie {
  pages!: Table<LocalPage, string>;
  modules!: Table<LocalModule, string>;
  drafts!: Table<DraftRecord, string>;
  handles!: Table<HandleRecord, string>;
  constructor() {
    super("aibi-local");
    this.version(1).stores({ pages: "id, projectSlug, updatedAt", modules: "key, name", drafts: "key, updatedAt", handles: "id" });
  }
}

export const localDb = new LocalDb();

let persistAsked = false;
export async function requestPersistence() {
  if (persistAsked) return;
  persistAsked = true;
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* not supported */
  }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number; persisted: boolean } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted } : null;
  } catch {
    return null;
  }
}

export async function localModulesFor(bundle: PageBundle): Promise<Record<string, LocalModuleSource>> {
  const out: Record<string, LocalModuleSource> = {};
  for (const m of bundle.page.modules) {
    try {
      const rec = await localDb.modules.get(`${m.name}@${m.version}`);
      if (rec) out[m.name] = { entry: rec.entry, files: rec.files };
    } catch {
      /* storage unavailable */
    }
  }
  return out;
}

export const newLocalId = () => `loc_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
