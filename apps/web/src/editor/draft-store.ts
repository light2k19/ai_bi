import { create } from "zustand";
import type { PageBundle, Grid, Widget } from "@aibi/page-spec";
import { localDb } from "../lib/local-db";

export interface DraftState {
  key: string | null; // slug:pageId for autosave
  draft: PageBundle | null;
  saved: string; // JSON of the last saved bundle (dirty check)
  baseVersion?: number;
  past: PageBundle[];
  future: PageBundle[];
  selected: string | null;
  load(key: string, bundle: PageBundle, opts?: { baseVersion?: number; savedJson?: string }): void;
  set(next: PageBundle | ((d: PageBundle) => PageBundle), opts?: { history?: boolean }): void;
  undo(): void;
  redo(): void;
  markSaved(bundle: PageBundle, baseVersion?: number): void;
  select(id: string | null): void;
  reset(): void;
}

const clone = <T,>(x: T): T => structuredClone(x);
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function autosave(key: string | null, bundle: PageBundle | null, baseVersion?: number) {
  if (!key || !bundle) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localDb.drafts.put({ key, bundle, baseVersion, updatedAt: new Date().toISOString() }).catch(() => undefined);
  }, 600);
}

export const useDraft = create<DraftState>((set, get) => ({
  key: null,
  draft: null,
  saved: "",
  past: [],
  future: [],
  selected: null,
  load(key, bundle, opts = {}) {
    set({ key, draft: clone(bundle), saved: opts.savedJson ?? JSON.stringify(bundle), baseVersion: opts.baseVersion, past: [], future: [], selected: null });
  },
  set(next, opts = {}) {
    const cur = get().draft;
    if (!cur) return;
    const n = typeof next === "function" ? next(clone(cur)) : next;
    if (JSON.stringify(n) === JSON.stringify(cur)) return;
    const history = opts.history !== false;
    set((s) => ({ draft: n, past: history ? [...s.past.slice(-79), cur] : s.past, future: history ? [] : s.future }));
    autosave(get().key, n, get().baseVersion);
  },
  undo() {
    const { past, draft, future } = get();
    if (!past.length || !draft) return;
    const prev = past[past.length - 1];
    set({ draft: prev, past: past.slice(0, -1), future: [draft, ...future] });
    autosave(get().key, prev, get().baseVersion);
  },
  redo() {
    const { past, draft, future } = get();
    if (!future.length || !draft) return;
    const next = future[0];
    set({ draft: next, past: [...past, draft], future: future.slice(1) });
    autosave(get().key, next, get().baseVersion);
  },
  markSaved(bundle, baseVersion) {
    set({ saved: JSON.stringify(bundle), baseVersion, draft: clone(bundle) });
    const key = get().key;
    if (key) localDb.drafts.delete(key).catch(() => undefined);
  },
  select(id) {
    set({ selected: id });
  },
  reset() {
    set({ key: null, draft: null, saved: "", past: [], future: [], selected: null, baseVersion: undefined });
  },
}));

export const isDirty = (s: DraftState) => !!s.draft && JSON.stringify(s.draft) !== s.saved;

/* ───────── helpers to edit the draft ───────── */

export function walkWidgets(ws: Widget[], fn: (w: Widget, list: Widget[], index: number) => void) {
  ws.forEach((w, i) => {
    fn(w, ws, i);
    for (const t of w.tabs ?? []) walkWidgets(t.widgets, fn);
  });
}

export function applyGrids(b: PageBundle, grids: Record<string, Grid>): PageBundle {
  b.page.widgets = b.page.widgets.map((w) => (grids[w.id] ? { ...w, grid: { ...w.grid, ...grids[w.id] } } : w));
  return b;
}

export function updateWidget(b: PageBundle, id: string, patch: (w: Widget) => Widget): PageBundle {
  walkWidgets(b.page.widgets, (w, list, i) => {
    if (w.id === id) list[i] = patch(w);
  });
  return b;
}

export function removeWidget(b: PageBundle, id: string): PageBundle {
  let done = false;
  walkWidgets(b.page.widgets, (w, list, i) => {
    if (!done && w.id === id) {
      list.splice(i, 1);
      done = true;
    }
  });
  return b;
}

export function nextY(b: PageBundle) {
  return b.page.widgets.reduce((m, w) => Math.max(m, w.grid.y + w.grid.h), 0);
}

export function uniqueId(b: PageBundle, base: string) {
  const ids = new Set<string>([...b.page.datasets.map((d) => d.id), ...b.page.filters.map((f) => f.id)]);
  walkWidgets(b.page.widgets, (w) => ids.add(w.id));
  const clean = base.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^[^A-Za-z_]/, "w_");
  if (!ids.has(clean)) return clean;
  for (let i = 2; ; i++) if (!ids.has(`${clean}_${i}`)) return `${clean}_${i}`;
}
