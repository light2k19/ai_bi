import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Bot, CheckCircle2, ChevronDown, Code2, Database, Download, Eye, FileDown, FileJson, FileSpreadsheet, Filter, HardDrive, LayoutGrid,
  Package, Pencil, Redo2, RefreshCw, Save, Settings2, Undo2, Upload, Radio,
} from "lucide-react";
import { emptyPage, validatePage, PageBundle, type Issue } from "@aibi/page-spec";
import type { LocalModuleSource } from "@aibi/runtime-api/protocol";
import { api, download, saveBlob, ApiError, type PageMeta } from "../lib/api";
import { canBuild, useConfig, useProject, useRuntimeConfig } from "../lib/hooks";
import { localDb, localModulesFor } from "../lib/local-db";
import { buildPackage, draftFromFiles, ensurePermission, filesFromHandle, saveToDisk, watchHandle } from "../lib/local-files";
import { RuntimeFrame, type RuntimeFrameHandle } from "../components/RuntimeFrame";
import { Badge, Button, ErrorBox, Field, IconButton, Input, Menu, MenuItem, Modal, PageLoader, Select, cx, toast, confirmDialog } from "../components/ui";
import { useColorMode } from "../components/Layout";
import { useDraft, isDirty, applyGrids } from "./draft-store";
import { ChatPanel } from "./ChatPanel";
import { CodePanel, DataPanel, FiltersPanel, JsonPanel, ModulesPanel, PagePanel, WidgetsPanel } from "./Panels";

type Panel = "ai" | "page" | "data" | "widgets" | "filters" | "code" | "modules" | "json";
const PANELS: { id: Panel; label: string; icon: React.ReactNode }[] = [
  { id: "ai", label: "AI", icon: <Bot className="size-4" /> },
  { id: "widgets", label: "Widgets", icon: <LayoutGrid className="size-4" /> },
  { id: "data", label: "Data", icon: <Database className="size-4" /> },
  { id: "filters", label: "Filters", icon: <Filter className="size-4" /> },
  { id: "code", label: "Code", icon: <Code2 className="size-4" /> },
  { id: "modules", label: "Modules", icon: <Package className="size-4" /> },
  { id: "page", label: "Page", icon: <Settings2 className="size-4" /> },
  { id: "json", label: "JSON", icon: <FileJson className="size-4" /> },
];

interface ServerPage {
  meta: PageMeta;
  version: { versionNo: number };
  bundle: PageBundle;
  canEdit: boolean;
}

const newPageId = () => `pg_${Math.random().toString(36).slice(2, 12)}`;

export function Editor({ kind }: { kind: "server" | "new" | "local" }) {
  const { pageId, localId } = useParams();
  const { slug, data: project } = useProject();
  const cfg = useConfig();
  const rc = useRuntimeConfig(slug);
  const nav = useNavigate();
  const qc = useQueryClient();
  const [colorMode] = useColorMode();
  const frame = useRef<RuntimeFrameHandle>(null);

  const draft = useDraft((s) => s.draft);
  const selected = useDraft((s) => s.selected);
  const dirty = useDraft(isDirty);
  const canUndo = useDraft((s) => s.past.length > 0);
  const canRedo = useDraft((s) => s.future.length > 0);
  const { load, set, undo, redo, select, markSaved, reset } = useDraft.getState();

  const [panel, setPanel] = useState<Panel>("ai");
  const [preview, setPreview] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [serverMeta, setServerMeta] = useState<PageMeta | null>(null);
  const [restore, setRestore] = useState<PageBundle | null>(null);
  const [localModules, setLocalModules] = useState<Record<string, LocalModuleSource>>({});
  const [logs, setLogs] = useState<{ level: string; message: string; source?: string }[]>([]);
  const [saveOpen, setSaveOpen] = useState(false);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [watching, setWatching] = useState(false);
  const [handleName, setHandleName] = useState<string | null>(null);
  const [leftWidth, setLeftWidth] = useState(440);
  const key = kind === "server" ? `${slug}:${pageId}` : kind === "local" ? `local:${localId}` : `${slug}:new`;

  /* ── load ── */
  useEffect(() => {
    let cancelled = false;
    reset();
    setLoadError(null);
    setRestore(null);
    (async () => {
      try {
        if (kind === "server") {
          const p = await api<ServerPage>(`/projects/${slug}/pages/${pageId}`);
          if (cancelled) return;
          if (!p.canEdit) throw new Error("You cannot edit this page");
          setServerMeta(p.meta);
          load(key, p.bundle, { baseVersion: p.version.versionNo });
          const saved = await localDb.drafts.get(key).catch(() => undefined);
          if (saved && JSON.stringify(saved.bundle) !== JSON.stringify(p.bundle) && saved.baseVersion === p.version.versionNo) setRestore(saved.bundle);
          setLocalModules(await localModulesFor(p.bundle));
        } else if (kind === "new") {
          const saved = await localDb.drafts.get(key).catch(() => undefined);
          const fresh = emptyPage(newPageId(), "Untitled page");
          load(key, fresh, { savedJson: JSON.stringify(fresh) });
          if (saved && (saved.bundle.page.widgets.length || saved.bundle.page.datasets.length)) setRestore(saved.bundle);
        } else {
          const lp = await localDb.pages.get(localId!);
          if (!lp) throw new Error("This local page does not exist in this browser");
          load(key, lp.bundle, { savedJson: JSON.stringify(lp.bundle) });
          setLocalModules(await localModulesFor(lp.bundle));
          const h = await localDb.handles.get(localId!);
          setHandleName(h?.name ?? null);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, slug, pageId, localId]);

  /* ── local pages save themselves to IndexedDB ── */
  useEffect(() => {
    if (kind !== "local" || !draft || !localId) return;
    const t = setTimeout(() => {
      localDb.pages.update(localId, { bundle: draft, title: draft.page.title, updatedAt: new Date().toISOString() }).then(() => markSaved(draft)).catch(() => undefined);
    }, 500);
    return () => clearTimeout(t);
  }, [draft, kind, localId, markSaved]);

  /* ── live reload from a watched file/folder ── */
  useEffect(() => {
    if (!watching || kind !== "local" || !localId) return;
    let stop: (() => void) | null = null;
    (async () => {
      const h = await localDb.handles.get(localId);
      if (!h) return setWatching(false);
      if (!(await ensurePermission(h.handle, "read"))) {
        toast.error("Permission to read the file was not granted");
        return setWatching(false);
      }
      stop = watchHandle(
        h.handle,
        (d) => {
          const p = PageBundle.safeParse(d.bundle);
          if (!p.success) return toast.error("The file changed but is not a valid page");
          set(p.data);
          toast.info(`Reloaded from ${h.name}`);
        },
        (e) => toast.error(e),
      );
    })();
    return () => stop?.();
  }, [watching, kind, localId, set]);

  /* ── validation ── */
  const validation = useMemo(() => (draft && rc.data ? validatePage(draft, { catalogue: rc.data.catalogue }) : null), [draft, rc.data]);
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  const runtimeErrors = logs.filter((l) => l.level === "error");

  /* ── keyboard ── */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const inEditor = (e.target as HTMLElement)?.closest?.(".cm-editor, input, textarea");
      if (e.key.toLowerCase() === "z" && !inEditor) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        setSaveOpen(true);
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [undo, redo]);

  /* ── leave guard ── */
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (isDirty(useDraft.getState()) && kind !== "local") e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [kind]);

  const getFilters = useCallback(async () => (await frame.current?.getState())?.filtersRaw ?? {}, []);

  if (loadError) return <div className="p-8"><ErrorBox error={loadError} /></div>;
  if (!draft || !rc.data || !cfg.data || !project) return <PageLoader />;
  if (!canBuild(project.role)) return <div className="p-8"><ErrorBox error="Editing requires the builder role in this project" /></div>;

  const statusLabel = kind === "local" ? "Saved in this browser" : dirty ? "Unsaved changes" : kind === "new" ? "Not saved yet" : `Version ${useDraft.getState().baseVersion}`;

  const exportDraft = async (format: "pdf" | "xlsx") => {
    try {
      await download(`/projects/${slug}/export/${format}`, { body: { bundle: draft, filters: await getFilters() } });
    } catch (e) {
      if (format === "pdf") {
        toast.info("Server PDF is unavailable; opening the print dialog");
        frame.current?.print();
      } else toast.error(e);
    }
  };

  const saveLocalFile = async (asJson: boolean) => {
    try {
      const name = draft.page.title.replace(/[^\w.-]+/g, "_") || "page";
      if (asJson) await saveToDisk(JSON.stringify(draft, null, 2), `${name}.json`);
      else await saveToDisk(await buildPackage(draft, localModules), `${name}.aibi`);
    } catch (e) {
      toast.error(e);
    }
  };

  const saveBackToHandle = async () => {
    const h = await localDb.handles.get(localId!);
    if (!h) return;
    try {
      if (!(await ensurePermission(h.handle, "readwrite"))) throw new Error("Write permission was not granted");
      if (h.kind === "file") {
        const isPkg = /\.(aibi|zip)$/i.test(h.name);
        await saveToDisk(isPkg ? await buildPackage(draft, localModules) : JSON.stringify(draft, null, 2), h.name, h.handle as FileSystemFileHandle);
      } else {
        const dir = h.handle as FileSystemDirectoryHandle;
        const write = async (d: FileSystemDirectoryHandle, name: string, text: string) => {
          const fh = await d.getFileHandle(name, { create: true });
          const w = await (fh as FileSystemFileHandle & { createWritable(): Promise<{ write(t: string): Promise<void>; close(): Promise<void> }> }).createWritable();
          await w.write(text);
          await w.close();
        };
        await write(dir, "page.json", JSON.stringify({ ...draft, components: undefined, scripts: undefined }, null, 2));
        if (Object.keys(draft.components).length) {
          const cd = await dir.getDirectoryHandle("components", { create: true });
          for (const [n, s] of Object.entries(draft.components)) await write(cd, `${n}.tsx`, s);
        }
        if (Object.keys(draft.scripts).length) {
          const sd = await dir.getDirectoryHandle("scripts", { create: true });
          for (const [n, s] of Object.entries(draft.scripts)) await write(sd, `${n}.js`, s);
        }
      }
      toast.success(`Saved to ${h.name}`);
    } catch (e) {
      toast.error(e);
    }
  };

  const replaceFromFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    try {
      const d = await draftFromFiles([...files].map((f) => ({ path: f.name, file: f })));
      const p = PageBundle.parse(d.bundle);
      p.page.id = draft.page.id;
      set(p);
      toast.success("Draft replaced from file (undo to go back)");
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* toolbar */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <IconButton label="Back" onClick={() => nav(kind === "server" ? `/p/${slug}/pages/${pageId}` : `/p/${slug}`)}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <input
          className="min-w-0 max-w-80 flex-shrink rounded-md bg-transparent px-1.5 py-1 text-[15px] font-semibold hover:bg-surface2 focus:bg-surface2 focus:outline-none"
          value={draft.page.title}
          onChange={(e) => set((b) => ((b.page.title = e.target.value || "Untitled"), b), { history: false })}
          aria-label="Page title"
        />
        <Badge tone={kind === "local" ? "neutral" : dirty ? "warning" : kind === "new" ? "neutral" : "success"}>
          {kind === "local" ? <HardDrive className="size-3" /> : null}
          {statusLabel}
        </Badge>
        {handleName && (
          <button onClick={() => setWatching((w) => !w)} className={cx("inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs", watching ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface2")} title="Reload automatically when the file changes on disk">
            <Radio className="size-3.5" /> {watching ? `Watching ${handleName}` : `Watch ${handleName}`}
          </button>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo} className="disabled:opacity-30">
            <Undo2 className="size-4" />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo} className="disabled:opacity-30">
            <Redo2 className="size-4" />
          </IconButton>
          <button onClick={() => setProblemsOpen((o) => !o)} className={cx("inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px]", errors.length || runtimeErrors.length ? "text-danger hover:bg-danger/10" : "text-success hover:bg-success/10")}>
            {errors.length || runtimeErrors.length ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
            {errors.length + runtimeErrors.length ? `${errors.length + runtimeErrors.length} problems` : "Valid"}
            {warnings.length > 0 && <span className="text-warning">· {warnings.length} warnings</span>}
          </button>
          <Button size="sm" variant="ghost" icon={preview ? <Pencil className="size-4" /> : <Eye className="size-4" />} onClick={() => setPreview((p) => !p)}>
            {preview ? "Edit layout" : "Preview"}
          </Button>
          <IconButton label="Refresh data" onClick={() => frame.current?.refresh()}>
            <RefreshCw className="size-4" />
          </IconButton>
          <Menu
            trigger={(t) => (
              <Button size="sm" onClick={t} icon={<Download className="size-4" />}>
                <ChevronDown className="size-3.5" />
              </Button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Package />} onClick={() => (close(), void saveLocalFile(false))}>Save as .aibi package…</MenuItem>
                <MenuItem icon={<FileJson />} onClick={() => (close(), void saveLocalFile(true))}>Save as page JSON…</MenuItem>
                {handleName && <MenuItem icon={<HardDrive />} onClick={() => (close(), void saveBackToHandle())}>Save back to {handleName}</MenuItem>}
                <label className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] hover:bg-surface2">
                  <Upload className="size-4 text-muted" /> Replace from file…
                  <input type="file" className="hidden" accept=".aibi,.zip,.json,.tsx,.js" multiple onChange={(e) => (close(), void replaceFromFiles(e.target.files), (e.target.value = ""))} />
                </label>
                <div className="my-1 border-t border-line" />
                <MenuItem icon={<FileDown />} onClick={() => (close(), void exportDraft("pdf"))}>PDF of this draft</MenuItem>
                <MenuItem icon={<FileSpreadsheet />} onClick={() => (close(), void exportDraft("xlsx"))}>Excel of this draft</MenuItem>
                {kind === "server" && dirty && (
                  <>
                    <div className="my-1 border-t border-line" />
                    <MenuItem
                      danger
                      onClick={async () => {
                        close();
                        if (!(await confirmDialog("Discard changes", "Discard all unsaved changes and reload the saved version?", true))) return;
                        await localDb.drafts.delete(key).catch(() => undefined);
                        window.location.reload();
                      }}
                    >
                      Discard unsaved changes
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Menu>
          <Button size="sm" variant="primary" icon={<Save className="size-4" />} onClick={() => setSaveOpen(true)} disabled={kind === "server" && !dirty}>
            {kind === "local" ? "Save to project" : kind === "new" ? "Save page" : "Save version"}
          </Button>
        </div>
      </div>

      {restore && (
        <div className="flex items-center justify-between gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-[13px]">
          <span>You have unsaved changes from an earlier session in this browser.</span>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => (set(restore), setRestore(null))}>Restore them</Button>
            <Button size="sm" variant="ghost" onClick={() => (setRestore(null), void localDb.drafts.delete(key))}>Discard</Button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* left panel */}
        <div className="flex shrink-0 border-r border-line bg-surface" style={{ width: leftWidth }}>
          <nav className="flex w-14 shrink-0 flex-col items-center gap-1 border-r border-line py-2">
            {PANELS.map((p) => (
              <button key={p.id} onClick={() => setPanel(p.id)} title={p.label} className={cx("flex w-12 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10.5px]", panel === p.id ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface2 hover:text-ink")}>
                {p.icon}
                {p.label}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className={cx("h-full", panel !== "ai" && "hidden")}>
              {project?.ai?.available === false ? (
                <div className="p-4 text-[13px] text-muted">
                  <div className="mb-1 font-medium text-ink">AI is off</div>
                  {project.ai.message}. You can still edit the page from the other panels and save it.
                </div>
              ) : (
                <ChatPanel slug={slug} pageId={kind === "server" ? pageId : undefined} storageKey={key} />
              )}
            </div>
            {panel !== "ai" && (
              <div className="h-full overflow-y-auto">
                {panel === "page" && <PagePanel />}
                {panel === "data" && <DataPanel slug={slug} catalogue={rc.data.catalogue} getFilters={getFilters} />}
                {panel === "widgets" && <WidgetsPanel catalogue={rc.data.catalogue} />}
                {panel === "filters" && <FiltersPanel catalogue={rc.data.catalogue} />}
                {panel === "code" && <CodePanel logs={logs} onRunScript={(n) => frame.current?.runScript(n)} />}
                {panel === "modules" && <ModulesPanel slug={slug} localNames={Object.keys(localModules)} />}
                {panel === "json" && <JsonPanel />}
              </div>
            )}
          </div>
        </div>
        <div
          className="w-1 shrink-0 cursor-col-resize hover:bg-accent/30"
          onMouseDown={(e) => {
            const start = e.clientX;
            const w0 = leftWidth;
            const move = (ev: MouseEvent) => setLeftWidth(Math.min(800, Math.max(340, w0 + ev.clientX - start)));
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
          role="separator"
          aria-label="Resize panel"
        />

        {/* preview */}
        <div className="relative flex min-w-0 flex-1 flex-col bg-bg">
          <div className="flex-1 overflow-y-auto">
            <RuntimeFrame
              ref={frame}
              slug={slug}
              runtimeUrl={cfg.data.runtimeOrigin}
              bundle={draft}
              config={rc.data}
              mode={preview ? "view" : "edit"}
              colorMode={colorMode}
              data={{ kind: "draft" }}
              localModules={localModules}
              selected={selected}
              minHeight={500}
              onSelect={(id) => {
                select(id);
                if (id && panel !== "ai") setPanel("widgets");
              }}
              onLayout={(grids) => set((b) => applyGrids(b, grids))}
              onLog={(m) => setLogs((l) => [...l.slice(-49), { level: m.level, message: m.message, source: m.source }])}
            />
          </div>
          {problemsOpen && <Problems errors={errors} warnings={warnings} logs={logs} onClose={() => setProblemsOpen(false)} onClearLogs={() => setLogs([])} />}
        </div>
      </div>

      <SaveDialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        kind={kind}
        slug={slug}
        errors={errors}
        serverMeta={serverMeta}
        localId={localId}
        localModules={localModules}
        onSaved={async (res) => {
          setSaveOpen(false);
          await qc.invalidateQueries({ queryKey: ["pages", slug] });
          if (kind === "new") {
            await localDb.drafts.delete(key).catch(() => undefined);
            reset();
            nav(`/p/${slug}/pages/${res.id}/edit`, { replace: true });
          } else if (kind === "server") {
            const p = await api<ServerPage>(`/projects/${slug}/pages/${pageId}`);
            markSaved(p.bundle, p.version.versionNo);
            setServerMeta(p.meta);
            await qc.invalidateQueries({ queryKey: ["page", slug, pageId] });
          } else if (kind === "local" && localId) {
            await localDb.pages.update(localId, { origin: "synced", serverPageId: res.id, serverVersion: res.versionNo });
          }
          toast.success(kind === "server" ? `Saved version ${res.versionNo}` : "Saved to the project");
          if (res.warnings?.length) toast.info(`${res.warnings.length} warnings — see Problems`);
        }}
      />
    </div>
  );
}

function Problems({ errors, warnings, logs, onClose, onClearLogs }: { errors: Issue[]; warnings: Issue[]; logs: { level: string; message: string; source?: string }[]; onClose: () => void; onClearLogs: () => void }) {
  return (
    <div className="absolute inset-x-0 bottom-0 max-h-[45%] overflow-y-auto border-t border-line bg-surface shadow-[0_-8px_24px_rgba(0,0,0,0.08)]">
      <div className="sticky top-0 flex items-center justify-between border-b border-line bg-surface px-3 py-2 text-[13px] font-semibold">
        Problems
        <div className="flex gap-2">
          {logs.length > 0 && <Button size="sm" variant="ghost" onClick={onClearLogs}>Clear runtime log</Button>}
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
      <div className="px-3 py-2 font-mono text-[12px]">
        {!errors.length && !warnings.length && !logs.length && <div className="py-3 text-center font-sans text-muted">No problems</div>}
        {errors.map((e, i) => (
          <div key={`e${i}`} className="py-0.5 text-danger">ERROR <span className="text-muted">{e.path}</span> {e.message}</div>
        ))}
        {warnings.map((e, i) => (
          <div key={`w${i}`} className="py-0.5 text-warning">WARN <span className="text-muted">{e.path}</span> {e.message}</div>
        ))}
        {logs.map((l, i) => (
          <div key={`l${i}`} className={cx("py-0.5", l.level === "error" ? "text-danger" : "text-muted")}>
            {l.level.toUpperCase()} [{l.source}] {l.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function SaveDialog({ open, onClose, kind, slug, errors, serverMeta, localId, localModules, onSaved }: {
  open: boolean;
  onClose: () => void;
  kind: "server" | "new" | "local";
  slug: string;
  errors: Issue[];
  serverMeta: PageMeta | null;
  localId?: string;
  localModules: Record<string, LocalModuleSource>;
  onSaved: (r: { id: string; versionNo: number; warnings?: unknown[] }) => void;
}) {
  const [message, setMessage] = useState("");
  const [visibility, setVisibility] = useState<"project" | "private">("project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [conflict, setConflict] = useState<{ currentVersion: number; changes: { op: string; path: string }[] } | null>(null);
  useEffect(() => {
    if (open) {
      setError(null);
      setConflict(null);
    }
  }, [open]);

  const save = async (force = false) => {
    const st = useDraft.getState();
    const draft = st.draft!;
    setBusy(true);
    setError(null);
    try {
      if (kind === "server") {
        const r = await api<{ id: string; versionNo: number; warnings: unknown[] }>(`/projects/${slug}/pages/${serverMeta!.id}/versions`, { body: { bundle: draft, message: message || undefined, baseVersion: st.baseVersion, force, source: "manual" } });
        onSaved(r);
      } else if (kind === "new") {
        const r = await api<{ id: string; versionNo: number; warnings: unknown[] }>(`/projects/${slug}/pages`, { body: { bundle: draft, message: message || "Created", visibility, source: "manual" } });
        onSaved(r);
      } else {
        // local page → project: through the package importer so local-only modules are vendored too
        const lp = localId ? await localDb.pages.get(localId) : undefined;
        if (!Object.keys(localModules).length && !lp?.serverPageId) {
          const r = await api<{ id: string; versionNo: number; warnings: unknown[] }>(`/projects/${slug}/pages`, { body: { bundle: draft, message: message || "Saved from a local page", visibility } });
          onSaved(r);
        } else if (!Object.keys(localModules).length && lp?.serverPageId) {
          const r = await api<{ id: string; versionNo: number; warnings: unknown[] }>(`/projects/${slug}/pages/${lp.serverPageId}/versions`, { body: { bundle: { ...draft, page: { ...draft.page, id: lp.serverPageId } }, message: message || "Updated from a local page", baseVersion: lp.serverVersion, force } });
          onSaved(r);
        } else {
          const pkg = await buildPackage(draft, localModules);
          const fd = new FormData();
          fd.append("file", new Blob([pkg as BlobPart]), "local.aibi");
          const rep = await (await fetch(`/api/projects/${slug}/import/analyze`, { method: "POST", body: fd })).json();
          if (rep.error) throw new ApiError(rep.error, 400, rep.details);
          if (rep.errors?.length) throw new ApiError("The page cannot be imported", 422, { errors: rep.errors });
          const overwrite = rep.modes.includes("version") && !!rep.conflict;
          if (overwrite && !(await confirmDialog(`Overwrite “${rep.conflict.title}”?`, `A page with this id already exists in the project (v${rep.conflict.currentVersion}). Saving replaces it with this page as v${rep.conflict.currentVersion + 1}; the old version stays in its history.`, true))) return;
          const r = await api<{ id: string; versionNo: number; warnings: unknown[] }>(`/projects/${slug}/import/${rep.importId}/commit`, { body: { mode: overwrite ? "version" : "new", mapping: {}, overwrite } });
          onSaved(r);
        }
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setConflict(e.details as { currentVersion: number; changes: { op: string; path: string }[] });
      else setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={kind === "server" ? "Save a new version" : kind === "new" ? "Save page" : "Save to project"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {conflict ? (
            <Button variant="danger" loading={busy} onClick={() => void save(true)}>Overwrite with my version</Button>
          ) : (
            <Button variant="primary" loading={busy} disabled={errors.length > 0} onClick={() => void save()}>Save</Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3.5">
        {errors.length > 0 && <ErrorBox error={Object.assign(new Error(`Fix ${errors.length} problem(s) before saving`), { details: { errors } })} />}
        <Field label="What changed?" hint="Shown in the version history">
          <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Added margin trend and region filter" autoFocus />
        </Field>
        {kind !== "server" && (
          <Field label="Who can see it">
            <Select value={visibility} onChange={(e) => setVisibility(e.target.value as "project" | "private")}>
              <option value="project">Everyone in the project</option>
              <option value="private">Only me (and project admins)</option>
            </Select>
          </Field>
        )}
        {kind === "local" && Object.keys(localModules).length > 0 && <p className="text-[13px] text-muted">This page uses modules stored only in your browser; they are uploaded with the page.</p>}
        {conflict && (
          <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-[13px]">
            <div className="font-medium">Someone saved version {conflict.currentVersion} while you were editing.</div>
            <div className="mt-1 text-muted">Saving now replaces their changes in the next version. Differences from the current version:</div>
            <div className="mt-2 max-h-40 overflow-y-auto font-mono text-[11.5px]">
              {conflict.changes.slice(0, 80).map((c, i) => (
                <div key={i}>{c.op} {c.path}</div>
              ))}
            </div>
          </div>
        )}
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

export { saveBlob };
