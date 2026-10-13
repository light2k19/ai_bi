import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Code2, Database, Play, Plus, Puzzle, Trash2, Filter as FilterIcon, LayoutGrid, Search, Package, ArrowUpRight } from "lucide-react";
import { PageBundle, allWidgets, type Catalogue, type Dataset, type Filter, type Widget, defaultFilterValues } from "@aibi/page-spec";
import { runPipeline, toFrame, type Frame, type QueryResult } from "@aibi/transforms";
import { api } from "../lib/api";
import { Code } from "../components/Code";
import { Badge, Button, ErrorBox, Field, Input, Modal, Select, Textarea, cx, toast, confirmDialog } from "../components/ui";
import { useDraft, updateWidget, removeWidget, nextY, uniqueId, walkWidgets } from "./draft-store";

/* ───────── shared bits ───────── */

function Section({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-line px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</div>
        <div className="flex gap-1">{actions}</div>
      </div>
      {children}
    </div>
  );
}

/** Edit an object as JSON with explicit apply. */
export function JsonEditor({ value, onApply, height = "220px", label = "Apply" }: { value: unknown; onApply: (v: unknown) => string | void; height?: string; label?: string }) {
  const initial = useMemo(() => JSON.stringify(value ?? {}, null, 2), [value]);
  const [text, setText] = useState(initial);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(initial), [initial]);
  const dirty = text !== initial;
  return (
    <div className="flex flex-col gap-1.5">
      <Code lang="json" value={text} onChange={setText} height={height} />
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="flex justify-end gap-1.5">
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => (setText(initial), setErr(null))}>
            Revert
          </Button>
        )}
        <Button
          size="sm"
          variant={dirty ? "primary" : "secondary"}
          disabled={!dirty}
          onClick={() => {
            try {
              const v = JSON.parse(text);
              const e = onApply(v);
              setErr(e || null);
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          {label}
        </Button>
      </div>
    </div>
  );
}

function ListItem({ active, onClick, icon, title, meta, error }: { active: boolean; onClick: () => void; icon: ReactNode; title: ReactNode; meta?: ReactNode; error?: boolean }) {
  return (
    <button onClick={onClick} className={cx("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]", active ? "bg-accent-soft text-accent" : "hover:bg-surface2")}>
      <span className={cx("shrink-0 [&>svg]:size-4", active ? "text-accent" : "text-muted")}>{icon}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {error && <span className="size-1.5 rounded-full bg-danger" />}
      {meta && <span className="shrink-0 text-xs text-muted">{meta}</span>}
    </button>
  );
}

/* ───────── page settings ───────── */

export function PagePanel() {
  const draft = useDraft((s) => s.draft)!;
  const set = useDraft((s) => s.set);
  const p = draft.page;
  const patch = (fn: (b: PageBundle) => void) =>
    set((b) => {
      fn(b);
      return b;
    });
  return (
    <div className="flex flex-col gap-3.5 p-3">
      <Field label="Title">
        <Input value={p.title} onChange={(e) => patch((b) => (b.page.title = e.target.value || "Untitled"))} />
      </Field>
      <Field label="Description">
        <Textarea rows={2} value={p.description ?? ""} onChange={(e) => patch((b) => (b.page.description = e.target.value || undefined))} />
      </Field>
      <Field label="Tags" hint="Comma separated">
        <Input value={(p.tags ?? []).join(", ")} onChange={(e) => patch((b) => (b.page.tags = e.target.value.split(",").map((t) => t.trim()).filter(Boolean)))} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Color mode">
          <Select value={p.theme?.mode ?? "auto"} onChange={(e) => patch((b) => (b.page.theme = { ...(b.page.theme ?? {}), mode: e.target.value as "auto" }))}>
            <option value="auto">Follow viewer</option>
            <option value="light">Always light</option>
            <option value="dark">Always dark</option>
          </Select>
        </Field>
        <Field label="Row height (px)">
          <Input type="number" min={20} max={120} value={p.layout?.rowHeight ?? 40} onChange={(e) => patch((b) => (b.page.layout = { cols: 12, gap: 12, ...(b.page.layout ?? {}), rowHeight: Number(e.target.value) || 40 }))} />
        </Field>
        <Field label="Gap (px)">
          <Input type="number" min={0} max={40} value={p.layout?.gap ?? 12} onChange={(e) => patch((b) => (b.page.layout = { cols: 12, rowHeight: 40, ...(b.page.layout ?? {}), gap: Number(e.target.value) }))} />
        </Field>
        <Field label="Auto refresh (s)" hint="0 = off">
          <Input type="number" min={0} value={p.settings?.refreshSeconds ?? 0} onChange={(e) => patch((b) => (b.page.settings = { ...(b.page.settings ?? {}), refreshSeconds: Number(e.target.value) || undefined }))} />
        </Field>
        <Field label="Locale">
          <Input placeholder="en-US" value={p.settings?.locale ?? ""} onChange={(e) => patch((b) => (b.page.settings = { ...(b.page.settings ?? {}), locale: e.target.value || undefined }))} />
        </Field>
        <Field label="Currency">
          <Input placeholder="USD" value={p.settings?.currency ?? ""} onChange={(e) => patch((b) => (b.page.settings = { ...(b.page.settings ?? {}), currency: e.target.value.toUpperCase() || undefined }))} />
        </Field>
      </div>
      <Field label="On phones">
        <Select value={p.settings?.mobileLayout ?? "stack"} onChange={(e) => patch((b) => (b.page.settings = { ...(b.page.settings ?? {}), mobileLayout: e.target.value as "stack" }))}>
          <option value="stack">Stack widgets in one column</option>
          <option value="scale">Keep the grid (scaled)</option>
        </Select>
      </Field>
      <Field label="Chart palette" hint="Comma-separated colors; empty uses the theme palette">
        <Input value={(p.theme?.palette ?? []).join(", ")} onChange={(e) => patch((b) => (b.page.theme = { mode: "auto", ...(b.page.theme ?? {}), palette: e.target.value.split(",").map((c) => c.trim()).filter(Boolean) }))} />
      </Field>
    </div>
  );
}

/* ───────── datasets ───────── */

export function DataPanel({ slug, catalogue, getFilters }: { slug: string; catalogue: Catalogue; getFilters: () => Promise<Record<string, unknown>> }) {
  const draft = useDraft((s) => s.draft)!;
  const set = useDraft((s) => s.set);
  const [sel, setSel] = useState<string | null>(draft.page.datasets[0]?.id ?? null);
  const ds = draft.page.datasets.find((d) => d.id === sel) ?? null;
  const add = (kind: "sql" | "derived") => {
    const src = catalogue.sources[0];
    set((b) => {
      const id = uniqueId(b, kind === "sql" ? "dataset" : "derived");
      b.page.datasets.push(kind === "sql" ? { id, source: src?.alias, request: src?.kind === "http" ? { method: "GET", path: "/" } : { sql: "SELECT 1 AS value", params: {} } } : { id, from: [b.page.datasets[0]?.id ?? ""], pipeline: [] });
      setSel(id);
      return b;
    });
  };
  return (
    <div className="flex h-full flex-col">
      <Section
        title="Datasets"
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => add("sql")} disabled={!catalogue.sources.length}>
              Query
            </Button>
            <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => add("derived")} disabled={!draft.page.datasets.length}>
              Derived
            </Button>
          </>
        }
      >
        {draft.page.datasets.length === 0 && <div className="text-[13px] text-muted">No datasets. Ask the AI or add a query.</div>}
        {draft.page.datasets.map((d) => (
          <ListItem key={d.id} active={d.id === sel} onClick={() => setSel(d.id)} icon={<Database />} title={d.id} meta={d.source ?? (d.from ? `from ${d.from.join(",")}` : "")} />
        ))}
      </Section>
      {ds && <DatasetEditor key={ds.id} ds={ds} slug={slug} catalogue={catalogue} getFilters={getFilters} onRenamed={setSel} />}
    </div>
  );
}

function DatasetEditor({ ds, slug, catalogue, getFilters, onRenamed }: { ds: Dataset; slug: string; catalogue: Catalogue; getFilters: () => Promise<Record<string, unknown>>; onRenamed: (id: string) => void }) {
  const set = useDraft((s) => s.set);
  const draft = useDraft((s) => s.draft)!;
  const src = catalogue.sources.find((s) => s.alias === ds.source);
  const isSql = !!ds.source && (src?.kind === "sql" || typeof ds.request?.sql === "string");
  const [sqlText, setSqlText] = useState(String(ds.request?.sql ?? ""));
  const [preview, setPreview] = useState<{ frame?: Frame; error?: string; ms?: number; loading?: boolean } | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  useEffect(() => setSqlText(String(ds.request?.sql ?? "")), [ds.request?.sql]);

  const patch = (fn: (d: Dataset) => void) =>
    set((b) => {
      const d = b.page.datasets.find((x) => x.id === ds.id);
      if (d) fn(d);
      return b;
    });

  const runPreview = async () => {
    setPreview({ loading: true });
    const t0 = performance.now();
    try {
      const raw = await getFilters();
      const filters = defaultFilterValues(draft.page.filters, raw);
      let base: Frame;
      if (ds.source && ds.request) {
        const req = isSql ? { ...ds.request, sql: sqlText } : ds.request;
        const r = await api<QueryResult>(`/projects/${slug}/query/adhoc`, { body: { source: ds.source, request: req, filters, page: { id: draft.page.id, title: draft.page.title }, maxRows: 2000, noCache: true } });
        base = toFrame(r);
      } else throw new Error("Preview derived datasets in the page preview (they need their source datasets).");
      const f = runPipeline(base, ds.pipeline as never, { datasets: {}, vars: { filters, page: { id: draft.page.id } } });
      setPreview({ frame: f, ms: Math.round(performance.now() - t0) });
      patch((d) => (d.columns = f.columns.map((c) => c.name)));
    } catch (e) {
      setPreview({ error: (e as Error).message });
    }
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Id">
            <Input
              defaultValue={ds.id}
              onBlur={(e) => {
                const id = e.target.value.trim();
                if (!id || id === ds.id) return;
                set((b) => {
                  const d = b.page.datasets.find((x) => x.id === ds.id);
                  if (d) d.id = id;
                  walkWidgets(b.page.widgets, (w) => w.dataset === ds.id && (w.dataset = id));
                  return b;
                });
                onRenamed(id);
              }}
            />
          </Field>
          {ds.source !== undefined ? (
            <Field label="Data source">
              <Select value={ds.source} onChange={(e) => patch((d) => (d.source = e.target.value))}>
                {catalogue.sources.map((s) => (
                  <option key={s.alias} value={s.alias}>
                    {s.alias} ({s.dialect ?? s.kind})
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <Field label="Derived from">
              <Select value={ds.from?.[0] ?? ""} onChange={(e) => patch((d) => (d.from = [e.target.value]))}>
                {draft.page.datasets.filter((d) => d.id !== ds.id).map((d) => (
                  <option key={d.id}>{d.id}</option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {isSql && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[13px] font-medium">SQL (read-only)</span>
              <Button size="sm" variant="ghost" icon={<Search className="size-3.5" />} onClick={() => setSchemaOpen(true)}>
                Schema
              </Button>
            </div>
            <Code lang="sql" value={sqlText} onChange={setSqlText} height="200px" />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" icon={<Play className="size-3.5" />} onClick={runPreview} loading={preview?.loading}>
                Run
              </Button>
              <Button size="sm" variant={sqlText !== ds.request?.sql ? "primary" : "secondary"} disabled={sqlText === ds.request?.sql} onClick={() => patch((d) => (d.request = { ...(d.request ?? {}), sql: sqlText }))}>
                Apply SQL
              </Button>
            </div>
            <div className="text-[13px] font-medium">Parameters</div>
            <p className="-mt-2 text-xs text-muted">Values bound to :name placeholders. Use filter bindings like {"{{filters.date.start}}"}.</p>
            <JsonEditor value={ds.request?.params ?? {}} height="110px" onApply={(v) => patch((d) => (d.request = { ...(d.request ?? {}), params: v as Record<string, unknown> }))} />
          </>
        )}
        {!isSql && ds.source && (
          <>
            <div className="text-[13px] font-medium">Request</div>
            <JsonEditor value={ds.request ?? {}} height="150px" onApply={(v) => patch((d) => (d.request = v as Record<string, unknown>))} />
            <div className="flex justify-end">
              <Button size="sm" icon={<Play className="size-3.5" />} onClick={runPreview} loading={preview?.loading}>
                Run
              </Button>
            </div>
          </>
        )}
        <div className="text-[13px] font-medium">Pipeline</div>
        <p className="-mt-2 text-xs text-muted">Transforms applied in the browser: {catalogue.transforms.map((t) => t.op).join(", ")}.</p>
        <JsonEditor value={ds.pipeline ?? []} height="140px" onApply={(v) => {
          if (!Array.isArray(v)) return "pipeline must be an array of steps";
          patch((d) => (d.pipeline = v as Dataset["pipeline"]));
        }} />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Cache (seconds)">
            <Input type="number" min={0} value={ds.cache?.ttlSeconds ?? 60} onChange={(e) => patch((d) => (d.cache = { ttlSeconds: Number(e.target.value) }))} />
          </Field>
        </div>
        {preview && !preview.loading && (
          <div className="rounded-lg border border-line">
            <div className="flex items-center justify-between border-b border-line px-2.5 py-1.5 text-xs text-muted">
              <span>{preview.error ? "Error" : `${preview.frame?.rows.length} rows · ${preview.ms} ms${preview.frame?.meta?.truncated ? " · truncated" : ""}`}</span>
            </div>
            {preview.error ? (
              <div className="p-2.5 text-xs text-danger">{preview.error}</div>
            ) : (
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-[11.5px]">
                  <thead className="sticky top-0 bg-surface2">
                    <tr>
                      {preview.frame!.columns.map((c) => (
                        <th key={c.name} className="px-2 py-1 text-left font-medium whitespace-nowrap">
                          {c.name} <span className="font-normal text-muted">{c.type}</span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.frame!.rows.slice(0, 100).map((r, i) => (
                      <tr key={i} className="border-t border-line">
                        {preview.frame!.columns.map((c) => (
                          <td key={c.name} className="px-2 py-0.5 whitespace-nowrap">
                            {r[c.name] === null || r[c.name] === undefined ? <span className="text-muted">∅</span> : String(r[c.name]).slice(0, 60)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-danger"
          icon={<Trash2 className="size-3.5" />}
          onClick={async () => {
            if (!(await confirmDialog("Delete dataset", `Delete dataset “${ds.id}”? Widgets using it will show an error.`, true))) return;
            set((b) => ((b.page.datasets = b.page.datasets.filter((d) => d.id !== ds.id)), b));
          }}
        >
          Delete dataset
        </Button>
      </div>
      <SchemaDialog open={schemaOpen} onClose={() => setSchemaOpen(false)} slug={slug} alias={ds.source} />
    </div>
  );
}

function SchemaDialog({ open, onClose, slug, alias }: { open: boolean; onClose: () => void; slug: string; alias?: string }) {
  const [q, setQ] = useState("");
  const sources = useQuery({ queryKey: ["sources", slug], queryFn: () => api<{ id: string; alias: string }[]>(`/projects/${slug}/sources`), enabled: open });
  const id = sources.data?.find((s) => s.alias === alias)?.id;
  const schema = useQuery({ queryKey: ["schema-text", slug, id, q], queryFn: () => api<{ text: string }>(`/projects/${slug}/sources/${id}/schema?format=text${q ? `&search=${encodeURIComponent(q)}` : ""}`), enabled: open && !!id });
  return (
    <Modal open={open} onClose={onClose} title={`Schema of ${alias}`} width="max-w-3xl">
      <Input placeholder="Search tables and columns" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface2 p-3 font-mono text-[11.5px] whitespace-pre">{schema.data?.text ?? (schema.isLoading ? "Loading…" : "Schema not available. An admin can load it in Admin → Data sources.")}</pre>
    </Modal>
  );
}

/* ───────── widgets ───────── */

export function WidgetsPanel({ catalogue }: { catalogue: Catalogue }) {
  const draft = useDraft((s) => s.draft)!;
  const selected = useDraft((s) => s.selected);
  const select = useDraft((s) => s.select);
  const set = useDraft((s) => s.set);
  const [adding, setAdding] = useState(false);
  const list = allWidgets(draft.page.widgets);
  const w = list.find((x) => x.id === selected) ?? null;
  return (
    <div className="flex h-full flex-col">
      <Section
        title="Widgets"
        actions={
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
            Add
          </Button>
        }
      >
        <div className="max-h-56 overflow-y-auto">
          {list.length === 0 && <div className="text-[13px] text-muted">No widgets yet.</div>}
          {list.map((x) => (
            <ListItem key={x.id} active={x.id === selected} onClick={() => select(x.id)} icon={<LayoutGrid />} title={x.title || x.id} meta={x.type.replace("echarts.", "")} />
          ))}
        </div>
      </Section>
      {w ? <WidgetEditor key={w.id} w={w} catalogue={catalogue} /> : <div className="p-4 text-[13px] text-muted">Select a widget in the list or click one in the preview to edit it. Drag and resize widgets directly in the preview.</div>}
      <AddWidgetDialog
        open={adding}
        onClose={() => setAdding(false)}
        catalogue={catalogue}
        components={draft.page.components.map((c) => c.name)}
        onAdd={(type) => {
          const info = catalogue.widgets.find((x) => x.type === type);
          set((b) => {
            const id = uniqueId(b, type.replace(/^echarts\.|^custom\./, "").toLowerCase());
            const size = info?.defaultSize ?? { w: 6, h: 8 };
            b.page.widgets.push({ id, type, title: info?.title ?? type, grid: { x: 0, y: nextY(b), w: size.w, h: size.h }, dataset: info?.needsDataset ? b.page.datasets[0]?.id : undefined, props: (info?.example as Record<string, unknown>) ?? {}, ...(type === "tabs" ? { tabs: [{ title: "Tab 1", widgets: [] }] } : {}) });
            select(id);
            return b;
          });
          setAdding(false);
        }}
      />
    </div>
  );
}

function WidgetEditor({ w, catalogue }: { w: Widget; catalogue: Catalogue }) {
  const draft = useDraft((s) => s.draft)!;
  const set = useDraft((s) => s.set);
  const select = useDraft((s) => s.select);
  const info = catalogue.widgets.find((x) => x.type === w.type);
  const patch = (fn: (x: Widget) => Widget) => set((b) => updateWidget(b, w.id, fn));
  const cols = w.dataset ? draft.page.datasets.find((d) => d.id === w.dataset)?.columns : undefined;
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="flex flex-col gap-3 p-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Title">
            <Input value={w.title ?? ""} onChange={(e) => patch((x) => ({ ...x, title: e.target.value || undefined }))} />
          </Field>
          <Field label="Subtitle">
            <Input value={w.subtitle ?? ""} onChange={(e) => patch((x) => ({ ...x, subtitle: e.target.value || undefined }))} />
          </Field>
          <Field label="Type">
            <Select value={w.type} onChange={(e) => patch((x) => ({ ...x, type: e.target.value }))}>
              {catalogue.widgets.map((c) => (
                <option key={c.type} value={c.type}>
                  {c.title}
                </option>
              ))}
              {draft.page.components.map((c) => (
                <option key={c.name} value={`custom.${c.name}`}>
                  Custom: {c.name}
                </option>
              ))}
              {!catalogue.widgets.some((c) => c.type === w.type) && !w.type.startsWith("custom.") && <option value={w.type}>{w.type}</option>}
            </Select>
          </Field>
          <Field label="Dataset">
            <Select value={w.dataset ?? ""} onChange={(e) => patch((x) => ({ ...x, dataset: e.target.value || undefined }))}>
              <option value="">(none)</option>
              {draft.page.datasets.map((d) => (
                <option key={d.id}>{d.id}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {(["x", "y", "w", "h"] as const).map((k) => (
            <Field key={k} label={k.toUpperCase()}>
              <Input type="number" value={w.grid[k]} min={k === "w" || k === "h" ? 1 : 0} max={k === "x" ? 11 : k === "w" ? 12 : undefined} onChange={(e) => patch((x) => ({ ...x, grid: { ...x.grid, [k]: Number(e.target.value) } }))} />
            </Field>
          ))}
        </div>
        {cols && <div className="text-xs text-muted">Columns: {cols.map((c) => <code key={c} className="mr-1 rounded bg-surface2 px-1">{c}</code>)}</div>}
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-medium">Props</span>
          {info?.example && (
            <Button size="sm" variant="ghost" onClick={() => patch((x) => ({ ...x, props: info.example as Record<string, unknown> }))}>
              Use example
            </Button>
          )}
        </div>
        {info && (
          <p className="-mt-2 text-xs text-muted">
            {info.description} {info.propsSchema.required?.length ? <>Required: {info.propsSchema.required.join(", ")}.</> : null}
          </p>
        )}
        <JsonEditor value={w.props ?? {}} onApply={(v) => patch((x) => ({ ...x, props: v as Record<string, unknown> }))} height="200px" />
        <details className="rounded-lg border border-line px-2.5 py-2">
          <summary className="cursor-pointer text-[13px] font-medium">Interactions, conditional styles, visibility</summary>
          <div className="mt-2 flex flex-col gap-2">
            <span className="text-xs text-muted">Interactions — e.g. {`[{ "on": "click", "action": "setFilter", "filter": "region", "value": "{{ [row.region] }}" }]`}</span>
            <JsonEditor value={w.interactions ?? []} height="110px" onApply={(v) => patch((x) => ({ ...x, interactions: v as Widget["interactions"] }))} />
            <span className="text-xs text-muted">Conditional styles — e.g. {`[{ "when": "row.margin < 0", "column": "margin", "style": { "color": "var(--danger)" } }]`}</span>
            <JsonEditor value={w.conditional ?? []} height="110px" onApply={(v) => patch((x) => ({ ...x, conditional: v as Widget["conditional"] }))} />
            <Field label="Visible when (expression)" hint="e.g. filters.region.values.length == 1">
              <Input value={w.visibleWhen ?? ""} onChange={(e) => patch((x) => ({ ...x, visibleWhen: e.target.value || undefined }))} />
            </Field>
          </div>
        </details>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-danger"
            icon={<Trash2 className="size-3.5" />}
            onClick={() => {
              set((b) => removeWidget(b, w.id));
              select(null);
            }}
          >
            Delete widget
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              set((b) => {
                const id = uniqueId(b, w.id);
                b.page.widgets.push({ ...structuredClone(w), id, grid: { ...w.grid, y: nextY(b) } });
                select(id);
                return b;
              })
            }
          >
            Duplicate
          </Button>
        </div>
      </div>
    </div>
  );
}

function AddWidgetDialog({ open, onClose, catalogue, components, onAdd }: { open: boolean; onClose: () => void; catalogue: Catalogue; components: string[]; onAdd: (type: string) => void }) {
  const [q, setQ] = useState("");
  const items = [...catalogue.widgets.map((w) => ({ type: w.type, title: w.title, description: w.description })), ...components.map((c) => ({ type: `custom.${c}`, title: c, description: "Custom component on this page" }))].filter((w) => !q || `${w.title} ${w.type} ${w.description}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Add a widget" width="max-w-3xl">
      <Input placeholder="Search widgets" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" autoFocus />
      <div className="grid max-h-[60vh] gap-2 overflow-y-auto sm:grid-cols-2">
        {items.map((w) => (
          <button key={w.type} onClick={() => onAdd(w.type)} className="rounded-xl border border-line p-3 text-left hover:border-accent/50 hover:bg-surface2">
            <div className="text-[13px] font-medium">{w.title}</div>
            <div className="mt-0.5 line-clamp-2 text-xs text-muted">{w.description}</div>
            <code className="mt-1 block text-[11px] text-muted">{w.type}</code>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/* ───────── filters ───────── */

export function FiltersPanel({ catalogue }: { catalogue: Catalogue }) {
  const draft = useDraft((s) => s.draft)!;
  const set = useDraft((s) => s.set);
  const [sel, setSel] = useState<string | null>(draft.page.filters[0]?.id ?? null);
  const f = draft.page.filters.find((x) => x.id === sel) ?? null;
  return (
    <div className="flex h-full flex-col">
      <Section
        title="Filters"
        actions={
          <Select
            className="h-7 w-36 text-xs"
            value=""
            onChange={(e) => {
              const t = catalogue.filters.find((x) => x.type === e.target.value);
              if (!t) return;
              set((b) => {
                const ex = (t.example ?? { type: t.type }) as Filter;
                const id = uniqueId(b, ex.id ?? t.type);
                b.page.filters.push({ ...ex, id, type: t.type as Filter["type"] });
                setSel(id);
                return b;
              });
            }}
          >
            <option value="">+ Add filter…</option>
            {catalogue.filters.map((t) => (
              <option key={t.type} value={t.type}>
                {t.type}
              </option>
            ))}
          </Select>
        }
      >
        {draft.page.filters.length === 0 && <div className="text-[13px] text-muted">No filters.</div>}
        {draft.page.filters.map((x) => (
          <ListItem key={x.id} active={x.id === sel} onClick={() => setSel(x.id)} icon={<FilterIcon />} title={x.label ?? x.id} meta={x.type} />
        ))}
      </Section>
      {f && (
        <div className="flex flex-col gap-2 overflow-y-auto p-3">
          <p className="text-xs text-muted">{catalogue.filters.find((t) => t.type === f.type)?.description}</p>
          <JsonEditor
            key={f.id}
            value={f}
            height="260px"
            onApply={(v) => {
              set((b) => {
                const i = b.page.filters.findIndex((x) => x.id === f.id);
                b.page.filters[i] = v as Filter;
                return b;
              });
              setSel((v as Filter).id);
            }}
          />
          <Button variant="ghost" size="sm" className="self-start text-danger" icon={<Trash2 className="size-3.5" />} onClick={() => set((b) => ((b.page.filters = b.page.filters.filter((x) => x.id !== f.id)), b))}>
            Delete filter
          </Button>
        </div>
      )}
    </div>
  );
}

/* ───────── scripts & components ───────── */

const SCRIPT_TEMPLATE = `import { reveal, stagger } from "@aibi/anim";

export default async function ({ widgets, data, events, filters }) {
  await reveal(widgets.all().map((w) => w.el).filter(Boolean), { delay: stagger(80) });
}
`;
const COMPONENT_TEMPLATE = (name: string) => `import type { WidgetRenderProps } from "@aibi/runtime-api";

export default function ${name}({ data, props, theme, format }: WidgetRenderProps) {
  const rows = data?.rows ?? [];
  return (
    <div className="grid h-full grid-cols-2 gap-2">
      {rows.slice(0, 6).map((r, i) => (
        <div key={i} className="rounded-lg p-3" style={{ background: theme.surface2 }}>
          <div className="text-xs" style={{ color: theme.muted }}>{String(Object.values(r)[0])}</div>
          <div className="text-lg font-semibold">{format(Object.values(r)[1], "compact")}</div>
        </div>
      ))}
    </div>
  );
}
`;

export function CodePanel({ logs, onRunScript }: { logs: { level: string; message: string; source?: string }[]; onRunScript: (name: string) => void }) {
  const draft = useDraft((s) => s.draft)!;
  const set = useDraft((s) => s.set);
  const [sel, setSel] = useState<{ kind: "script" | "component"; name: string } | null>(draft.page.scripts[0] ? { kind: "script", name: draft.page.scripts[0].name } : draft.page.components[0] ? { kind: "component", name: draft.page.components[0].name } : null);
  const src = sel ? (sel.kind === "script" ? draft.scripts[sel.name] : draft.components[sel.name]) : undefined;
  const [text, setText] = useState(src ?? "");
  useEffect(() => setText(src ?? ""), [src, sel?.name]);
  const script = sel?.kind === "script" ? draft.page.scripts.find((s) => s.name === sel.name) : undefined;
  const relevantLogs = logs.filter((l) => (l.source === "script" || l.source === "component" || l.source === "module") && (!sel || l.message.includes(sel.name)));
  return (
    <div className="flex h-full flex-col">
      <Section
        title="Scripts"
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus className="size-3.5" />}
            onClick={() =>
              set((b) => {
                let name = "script";
                for (let i = 2; b.scripts[name] !== undefined; i++) name = `script_${i}`;
                b.page.scripts.push({ name, runOn: "page:dataLoaded" });
                b.scripts[name] = SCRIPT_TEMPLATE;
                setSel({ kind: "script", name });
                return b;
              })
            }
          >
            Script
          </Button>
        }
      >
        {draft.page.scripts.map((s) => (
          <ListItem key={s.name} active={sel?.kind === "script" && sel.name === s.name} onClick={() => setSel({ kind: "script", name: s.name })} icon={<Code2 />} title={s.name} meta={s.runOn} />
        ))}
        {!draft.page.scripts.length && <div className="text-[13px] text-muted">Scripts animate and choreograph the page.</div>}
      </Section>
      <Section
        title="Components"
        actions={
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus className="size-3.5" />}
            onClick={() =>
              set((b) => {
                let name = "MyWidget";
                for (let i = 2; b.components[name] !== undefined; i++) name = `MyWidget${i}`;
                b.page.components.push({ name });
                b.components[name] = COMPONENT_TEMPLATE(name);
                setSel({ kind: "component", name });
                return b;
              })
            }
          >
            Component
          </Button>
        }
      >
        {draft.page.components.map((c) => (
          <ListItem key={c.name} active={sel?.kind === "component" && sel.name === c.name} onClick={() => setSel({ kind: "component", name: c.name })} icon={<Puzzle />} title={c.name} meta={`custom.${c.name}`} />
        ))}
        {!draft.page.components.length && <div className="text-[13px] text-muted">Custom TSX widgets for visuals the catalogue lacks.</div>}
      </Section>
      {sel && (
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
          {script && (
            <Field label="Runs on">
              <Select
                value={script.runOn}
                onChange={(e) =>
                  set((b) => {
                    const s = b.page.scripts.find((x) => x.name === script.name);
                    if (s) s.runOn = e.target.value;
                    return b;
                  })
                }
              >
                {["page:init", "page:dataLoaded", "filter:changed", "manual", "interval:30", "interval:60"].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            </Field>
          )}
          <Code lang={sel.kind === "component" ? "tsx" : "js"} value={text} onChange={setText} height="340px" />
          <div className="flex justify-end gap-1.5">
            {sel.kind === "script" && (
              <Button size="sm" icon={<Play className="size-3.5" />} onClick={() => onRunScript(sel.name)}>
                Run now
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="text-danger"
              onClick={() =>
                set((b) => {
                  if (sel.kind === "script") {
                    b.page.scripts = b.page.scripts.filter((s) => s.name !== sel.name);
                    delete b.scripts[sel.name];
                  } else {
                    b.page.components = b.page.components.filter((c) => c.name !== sel.name);
                    delete b.components[sel.name];
                  }
                  setSel(null);
                  return b;
                })
              }
            >
              Delete
            </Button>
            <Button
              size="sm"
              variant={text !== src ? "primary" : "secondary"}
              disabled={text === src}
              onClick={() =>
                set((b) => {
                  if (sel.kind === "script") b.scripts[sel.name] = text;
                  else b.components[sel.name] = text;
                  return b;
                })
              }
            >
              Apply
            </Button>
          </div>
          {relevantLogs.length > 0 && (
            <div className="rounded-lg border border-danger/25 bg-danger/5 p-2 font-mono text-[11.5px] text-danger">
              {relevantLogs.slice(-6).map((l, i) => (
                <div key={i}>{l.message}</div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">Imports allowed: react, @aibi/anim, @aibi/runtime-api, @components/&lt;Name&gt; and modules declared in the Modules tab. No fetch, eval, parent window, cookies or storage.</p>
        </div>
      )}
    </div>
  );
}

/* ───────── modules ───────── */

export function ModulesPanel({ slug, localNames }: { slug: string; localNames: string[] }) {
  const draft = useDraft((s) => s.draft)!;
  const set = useDraft((s) => s.set);
  const [f, setF] = useState({ name: "", version: "", registry: "esm.sh" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ name: string; version: string; hash: string; integrity: string }>(`/projects/${slug}/modules/resolve`, { body: { name: f.name.trim(), version: f.version.trim(), registry: f.registry } });
      set((b) => {
        b.page.modules = [...b.page.modules.filter((m) => m.name !== r.name), { name: r.name, version: r.version, source: "registry", registry: f.registry, hash: r.hash, integrity: r.integrity }];
        return b;
      });
      setF({ name: "", version: "", registry: f.registry });
      toast.success(`${r.name}@${r.version} added`);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="text-[13px] text-muted">Extra ES modules for scripts and components. They are fetched once, pinned with an integrity hash and vendored into page packages on export.</p>
      {draft.page.modules.map((m) => (
        <div key={m.name} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2">
          <Package className="size-4 text-muted" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">
              {m.name}@{m.version}
            </div>
            <div className="truncate font-mono text-[11px] text-muted">{m.hash ? `sha256 ${m.hash.slice(0, 16)}…` : "not resolved"}</div>
          </div>
          {localNames.includes(m.name) && <Badge tone="warning">local only</Badge>}
          <button className="text-muted hover:text-danger" aria-label={`Remove ${m.name}`} onClick={() => set((b) => ((b.page.modules = b.page.modules.filter((x) => x.name !== m.name)), b))}>
            <Trash2 className="size-4" />
          </button>
        </div>
      ))}
      <div className="rounded-xl border border-line p-3">
        <div className="mb-2 text-[13px] font-medium">Add from npm</div>
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <Input placeholder="package, e.g. canvas-confetti" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input placeholder="1.9.3" value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} />
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Select className="h-8 w-36 text-xs" value={f.registry} onChange={(e) => setF({ ...f, registry: e.target.value })}>
            <option value="esm.sh">esm.sh</option>
            <option value="jsdelivr">jsDelivr</option>
          </Select>
          <a className="inline-flex items-center gap-1 text-xs text-accent" href={f.name ? `https://www.npmjs.com/package/${f.name}` : "https://www.npmjs.com"} target="_blank" rel="noreferrer">
            npm <ArrowUpRight className="size-3" />
          </a>
          <Button size="sm" variant="primary" className="ml-auto" loading={busy} disabled={!f.name || !/^\d+\.\d+\.\d+/.test(f.version)} onClick={add}>
            Add module
          </Button>
        </div>
        <ErrorBox error={err} className="mt-2" />
      </div>
    </div>
  );
}

/* ───────── whole bundle JSON ───────── */

export function JsonPanel() {
  const draft = useDraft((s) => s.draft)!;
  const set = useDraft((s) => s.set);
  return (
    <div className="p-3">
      <p className="mb-2 text-[13px] text-muted">The whole page bundle. Edit and apply to replace the draft.</p>
      <JsonEditor
        value={draft}
        height="calc(100vh - 260px)"
        onApply={(v) => {
          const p = PageBundle.safeParse(v);
          if (!p.success) return p.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
          p.data.page.id = draft.page.id;
          set(p.data);
        }}
      />
    </div>
  );
}
