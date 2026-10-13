import { transform } from "sucrase";
import {
  Filter as FilterSchema,
  Dataset as DatasetSchema,
  Widget as WidgetSchema,
  ScriptRef,
  ComponentRef,
  validatePage,
  formatIssues,
  checkCode,
  checkSchema,
  allWidgets,
  defaultFilterValues,
  type Catalogue,
  type PageBundle,
  type Widget,
  type Issue,
} from "@aibi/page-spec";
import { checkReadOnly, type Dialect } from "@aibi/sql-guard";
import { toFrame } from "@aibi/transforms";
import { PAGE_API_DOCS, ANIM_DOCS, COMPONENT_DOCS } from "@aibi/runtime-api/docs";
import type { ZodError } from "zod";
import type { User, Role } from "../services/access";
import { ensureSchema, schemaText } from "../services/sources";
import { runQuery, explainQuery } from "../services/gateway";
import { computeDatasets, frameToText } from "../services/compute";
import { resolveModule } from "../services/modules";
import type { ToolSpec } from "./provider";

export interface ToolEnv {
  projectId: string;
  user: User;
  role: Role;
  catalogue: Catalogue;
  draft: PageBundle;
  /** set when the draft changed during this turn */
  dirty: boolean;
  /** optional screenshot renderer (headless browser) */
  renderPreview?: (draft: PageBundle) => Promise<string | null>;
}

export interface ToolResult {
  text: string;
  /** data URL of an image to show the model (vision) */
  image?: string;
}

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  mutates?: boolean;
  /** available to the viewer-facing runtime AI */
  runtime?: boolean;
  run(args: Record<string, unknown>, env: ToolEnv): Promise<ToolResult | string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = [], description?: string) => ({ type: "object", properties, required, ...(description ? { description } : {}) });
const str = (description: string) => ({ type: "string", description });

const zodMsg = (e: ZodError) => e.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; ");

function issuesFor(env: ToolEnv, filter: (i: Issue) => boolean): string {
  const v = validatePage(env.draft, { catalogue: env.catalogue });
  const errs = v.errors.filter(filter);
  const warns = v.warnings.filter(filter);
  if (!errs.length && !warns.length) return "OK";
  return formatIssues({ errors: errs, warnings: warns });
}

function upsertById<T extends { id: string }>(arr: T[], item: T) {
  const i = arr.findIndex((x) => x.id === item.id);
  if (i >= 0) arr[i] = item;
  else arr.push(item);
  return i >= 0 ? "updated" : "added";
}

function findWidgetParent(widgets: Widget[], id: string): { list: Widget[]; index: number } | null {
  const i = widgets.findIndex((w) => w.id === id);
  if (i >= 0) return { list: widgets, index: i };
  for (const w of widgets) for (const t of w.tabs ?? []) {
    const r = findWidgetParent(t.widgets, id);
    if (r) return r;
  }
  return null;
}

/**
 * Tolerate shapes weaker models commonly produce (chart-library habits) so they don't burn retries:
 * series as objects, stack as a string, table columns keyed by name/dataKey/field.
 */
function normalizeProps(type: string, props: Record<string, unknown> | undefined) {
  if (!props) return;
  const colOf = (c: Record<string, unknown>) => (c.key ?? c.value ?? c.dataKey ?? c.column ?? c.field ?? c.name ?? c.id) as string | undefined;
  if (type === "table" && Array.isArray(props.columns)) {
    props.columns = (props.columns as unknown[]).map((c) => (c && typeof c === "object" && (c as Record<string, unknown>).key === undefined ? { ...(c as object), key: colOf(c as Record<string, unknown>) } : c));
  }
  if (type.startsWith("echarts.")) {
    for (const k of ["series", "bars", "lines", "secondary", "dashed", "measures", "path"]) {
      const v = props[k];
      if (!Array.isArray(v) || !v.some((x) => x && typeof x === "object")) continue;
      const names: Record<string, string> = { ...((props.seriesNames as Record<string, string>) ?? {}) };
      props[k] = v.map((x) => {
        if (!x || typeof x !== "object") return x;
        const o = x as Record<string, unknown>;
        const col = (o.value ?? o.dataKey ?? o.column ?? o.field ?? o.key ?? o.name) as string;
        if (typeof o.name === "string" && o.name !== col) names[col] = o.name;
        return col;
      });
      if (Object.keys(names).length) props.seriesNames = names;
    }
    if (typeof props.stack === "string") props.stack = props.stack !== "false" && props.stack !== "";
    if (typeof props.series === "string") props.series = [props.series];
  }
}

/** Place a widget below existing ones when the model gives no grid. */
function nextFreeY(widgets: Widget[]) {
  return widgets.reduce((m, w) => Math.max(m, w.grid.y + w.grid.h), 0);
}

const TOOLS: ToolDef[] = [
  /* ───────── data ───────── */
  {
    name: "list_sources",
    description: "List the project's data sources (alias, kind, SQL dialect).",
    parameters: obj({}),
    runtime: true,
    async run(_a, env) {
      if (!env.catalogue.sources.length) return "No data sources configured.";
      return env.catalogue.sources.map((s) => `${s.alias}: ${s.name} (${s.kind}${s.dialect ? `, ${s.dialect}` : ""})${s.description ? ` — ${s.description}` : ""}`).join("\n");
    },
  },
  {
    name: "introspect_schema",
    description: "Show tables, columns, keys and business descriptions of a data source (or endpoints of an HTTP API). Use `search` (words) to narrow large schemas.",
    parameters: obj({ source: str("data source alias"), search: str("optional words to filter tables/columns") }, ["source"]),
    runtime: true,
    async run(a, env) {
      const s = await ensureSchema(env.projectId, String(a.source), env.user.id);
      return schemaText(s.snapshot, s.annotations, { search: a.search ? String(a.search) : undefined, maxChars: 20_000 });
    },
  },
  {
    name: "preview_query",
    description:
      "Run a read-only request against a data source and return up to 20 rows plus column types. SQL request: { sql, params }. " +
      "HTTP request: { method, path, query, resultPath }. Bindings like {{filters.date.start}} are resolved with the page's default filter values (override with `filters`).",
    parameters: obj(
      {
        source: str("data source alias"),
        request: { type: "object", description: "the dataset request object, e.g. { \"sql\": \"SELECT ...\", \"params\": { \"start\": \"{{filters.date.start}}\" } }" },
        filters: { type: "object", description: "optional raw filter values by filter id, e.g. { \"date\": { \"preset\": \"last12m\" } }" },
      },
      ["source", "request"],
    ),
    runtime: true,
    async run(a, env) {
      const filters = defaultFilterValues(env.draft.page.filters, (a.filters as Record<string, unknown>) ?? {});
      const r = await runQuery({ projectId: env.projectId, userId: env.user.id, userEmail: env.user.email ?? env.user.login, alias: String(a.source), request: (a.request as Record<string, unknown>) ?? {}, scope: { filters, page: { id: env.draft.page.id, title: env.draft.page.title } }, kind: "ai", limits: { maxRows: 50, timeoutMs: 20_000 }, ttlSeconds: 30 });
      return frameToText(toFrame(r), 20);
    },
  },
  {
    name: "explain_query",
    description: "Show the database execution plan for a SQL request to spot full scans on large tables.",
    parameters: obj({ source: str("data source alias"), request: { type: "object", description: "{ sql, params }" } }, ["source", "request"]),
    async run(a, env) {
      const filters = defaultFilterValues(env.draft.page.filters);
      return explainQuery(env.projectId, String(a.source), (a.request as Record<string, unknown>) ?? {}, { filters }, env.user.id);
    },
  },
  {
    name: "preview_dataset",
    description: "Compute a dataset of the current draft (query + pipeline, derived datasets included) with default filters and show its columns and first rows. Records the column names on the dataset.",
    parameters: obj({ id: str("dataset id"), filters: { type: "object", description: "optional raw filter values by filter id" } }, ["id"]),
    async run(a, env) {
      const id = String(a.id);
      const r = await computeDatasets(env.projectId, env.user, env.draft, { ids: [id], rawFilters: (a.filters as Record<string, unknown>) ?? {}, kind: "ai", maxRows: 2000 });
      if (r.errors[id]) {
        const deps = Object.entries(r.errors).filter(([k]) => k !== id).map(([k, e]) => `${k}: ${e}`);
        return `ERROR in dataset '${id}': ${r.errors[id]}${deps.length ? `\nupstream: ${deps.join("; ")}` : ""}`;
      }
      const f = r.frames[id];
      const ds = env.draft.page.datasets.find((d) => d.id === id);
      if (ds && f) {
        ds.columns = f.columns.map((c) => c.name);
        env.dirty = true;
      }
      return f ? frameToText(f, 15) : "no data";
    },
  },
  /* ───────── catalogue ───────── */
  {
    name: "get_widget_schema",
    description: "Full props schema, example and hints for a widget type.",
    parameters: obj({ type: str("widget type, e.g. echarts.bar") }, ["type"]),
    async run(a, env) {
      const w = env.catalogue.widgets.find((x) => x.type === a.type);
      if (!w) return `Unknown widget type '${String(a.type)}'. Available: ${env.catalogue.widgets.map((x) => x.type).join(", ")}`;
      return JSON.stringify({ type: w.type, description: w.description, aiHints: w.aiHints, needsDataset: w.needsDataset, propsSchema: w.propsSchema, example: w.example, handleMethods: w.handleMethods, defaultSize: w.defaultSize }, null, 1);
    },
  },
  {
    name: "get_script_docs",
    description: "Documentation of the Page API for scripts, the @aibi/anim animation helpers and custom TSX components.",
    parameters: obj({}),
    async run() {
      return `${PAGE_API_DOCS}\n\n${ANIM_DOCS}\n\n${COMPONENT_DOCS}`;
    },
  },
  {
    name: "search_modules",
    description: "Search npm for an ES module library to use in scripts or components (returns name, latest version, description).",
    parameters: obj({ query: str("search words, e.g. 'confetti' or 'd3 sankey'") }, ["query"]),
    async run(a) {
      const r = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(String(a.query))}&size=8`);
      if (!r.ok) return `npm search failed: HTTP ${r.status}`;
      const j = (await r.json()) as { objects: { package: { name: string; version: string; description?: string } }[] };
      return j.objects.map((o) => `${o.package.name}@${o.package.version} — ${o.package.description ?? ""}`).join("\n") || "no results";
    },
  },
  /* ───────── page ───────── */
  {
    name: "get_page",
    description: "Return the current draft page bundle as JSON.",
    parameters: obj({}),
    async run(_a, env) {
      return JSON.stringify(env.draft);
    },
  },
  {
    name: "set_page_meta",
    description: "Set page title, description, tags, theme, layout or settings (only the given fields change).",
    parameters: obj({
      title: str("page title"),
      description: str("one-sentence description"),
      tags: { type: "array", items: { type: "string" } },
      theme: { type: "object", description: "{ mode: auto|light|dark, palette?: [colors] }" },
      layout: { type: "object", description: "{ rowHeight?: 40, gap?: 12 }" },
      settings: { type: "object", description: "{ refreshSeconds?, locale?, currency? }" },
    }),
    mutates: true,
    async run(a, env) {
      const p = env.draft.page;
      if (typeof a.title === "string") p.title = a.title;
      if (typeof a.description === "string") p.description = a.description;
      if (Array.isArray(a.tags)) p.tags = a.tags.map(String);
      if (a.theme && typeof a.theme === "object") p.theme = { mode: "auto", ...(p.theme ?? {}), ...(a.theme as object) } as typeof p.theme;
      if (a.layout && typeof a.layout === "object") p.layout = { cols: 12, rowHeight: 40, gap: 12, ...(p.layout ?? {}), ...(a.layout as object) } as typeof p.layout;
      if (a.settings && typeof a.settings === "object") p.settings = { ...(p.settings ?? {}), ...(a.settings as object) };
      env.dirty = true;
      return "OK";
    },
  },
  {
    name: "upsert_filter",
    description: "Add or replace a page filter (matched by id).",
    parameters: obj({ filter: { type: "object", description: "{ id, type: dateRange|select|multiSelect|search|numberRange|toggle, label, default?, options?, presets? }" } }, ["filter"]),
    mutates: true,
    async run(a, env) {
      const p = FilterSchema.safeParse(a.filter);
      if (!p.success) return `ERROR: ${zodMsg(p.error)}`;
      const r = upsertById(env.draft.page.filters, p.data);
      env.dirty = true;
      return `${r} filter '${p.data.id}'. ${issuesFor(env, (i) => i.path.startsWith("filters"))}`;
    },
  },
  {
    name: "remove_filter",
    description: "Remove a page filter by id.",
    parameters: obj({ id: str("filter id") }, ["id"]),
    mutates: true,
    async run(a, env) {
      const before = env.draft.page.filters.length;
      env.draft.page.filters = env.draft.page.filters.filter((f) => f.id !== a.id);
      env.dirty = true;
      return before === env.draft.page.filters.length ? `no filter '${String(a.id)}'` : `removed. ${issuesFor(env, () => true)}`;
    },
  },
  {
    name: "upsert_dataset",
    description:
      "Add or replace a dataset (matched by id). Source dataset: { id, source, request: { sql, params } , pipeline? }. " +
      "Derived: { id, from: [datasetId], pipeline }. SQL is checked for read-only use immediately; then call preview_dataset.",
    parameters: obj({ dataset: { type: "object", description: "the dataset object" } }, ["dataset"]),
    mutates: true,
    async run(a, env) {
      const p = DatasetSchema.safeParse(a.dataset);
      if (!p.success) return `ERROR: ${zodMsg(p.error)}`;
      const d = p.data;
      const prev = env.draft.page.datasets.find((x) => x.id === d.id);
      if (prev?.columns && !d.columns && JSON.stringify(prev.request) === JSON.stringify(d.request)) d.columns = prev.columns;
      if (d.source && typeof d.request?.sql === "string") {
        const src = env.catalogue.sources.find((s) => s.alias === d.source);
        const ro = checkReadOnly(d.request.sql as string, (src?.dialect ?? "mysql") as Dialect);
        if (!ro.ok) return `ERROR: SQL rejected: ${ro.errors.join("; ")} (dataset not saved)`;
        if (prev && prev.request?.sql !== d.request.sql) delete d.columns;
      }
      const r = upsertById(env.draft.page.datasets, d);
      env.dirty = true;
      return `${r} dataset '${d.id}'. ${issuesFor(env, (i) => i.path.startsWith("datasets"))}`;
    },
  },
  {
    name: "remove_dataset",
    description: "Remove a dataset by id.",
    parameters: obj({ id: str("dataset id") }, ["id"]),
    mutates: true,
    async run(a, env) {
      env.draft.page.datasets = env.draft.page.datasets.filter((d) => d.id !== a.id);
      env.dirty = true;
      return `removed. ${issuesFor(env, () => true)}`;
    },
  },
  {
    name: "upsert_widget",
    description:
      "Add or replace a widget (matched by id, also inside tabs). { id, type, title?, subtitle?, grid: {x,y,w,h}, dataset?, props, interactions?, conditional?, visibleWhen?, tabs? }. " +
      "Omit grid to place it below the existing widgets with the type's default size.",
    parameters: obj({ widget: { type: "object", description: "the widget object" }, parent: str("optional: id of a tabs widget") , tab: { type: "integer", description: "tab index when parent is set" } }, ["widget"]),
    mutates: true,
    async run(a, env) {
      const raw = { ...(a.widget as Record<string, unknown>) };
      const info = env.catalogue.widgets.find((w) => w.type === raw.type);
      normalizeProps(String(raw.type), raw.props as Record<string, unknown> | undefined);
      if (!raw.grid) {
        const size = info?.defaultSize ?? { w: 6, h: 8 };
        raw.grid = { x: 0, y: nextFreeY(env.draft.page.widgets), w: size.w, h: size.h };
      }
      const p = WidgetSchema.safeParse(raw);
      if (!p.success) return `ERROR: ${zodMsg(p.error)}`;
      const w = p.data;
      if (info) {
        const errs = checkSchema(w.props ?? {}, info.propsSchema);
        if (errs.length) return `ERROR in props for ${w.type}: ${errs.join("; ")} (widget not saved; call get_widget_schema)`;
      }
      let r: string;
      if (a.parent) {
        const host = allWidgets(env.draft.page.widgets).find((x) => x.id === a.parent);
        if (!host?.tabs) return `ERROR: '${String(a.parent)}' is not a tabs widget`;
        const t = host.tabs[Number(a.tab ?? 0)];
        if (!t) return `ERROR: tab ${String(a.tab)} does not exist`;
        r = upsertById(t.widgets, w);
      } else {
        const loc = findWidgetParent(env.draft.page.widgets, w.id);
        if (loc) {
          loc.list[loc.index] = w;
          r = "updated";
        } else {
          env.draft.page.widgets.push(w);
          r = "added";
        }
      }
      env.dirty = true;
      return `${r} widget '${w.id}'. ${issuesFor(env, (i) => i.path.includes(w.id))}`;
    },
  },
  {
    name: "remove_widget",
    description: "Remove a widget by id (also inside tabs).",
    parameters: obj({ id: str("widget id") }, ["id"]),
    mutates: true,
    async run(a, env) {
      const loc = findWidgetParent(env.draft.page.widgets, String(a.id));
      if (!loc) return `no widget '${String(a.id)}'`;
      loc.list.splice(loc.index, 1);
      env.dirty = true;
      return "removed";
    },
  },
  {
    name: "move_widget",
    description: "Change a widget's grid position/size.",
    parameters: obj({ id: str("widget id"), grid: { type: "object", description: "{ x, y, w, h }" } }, ["id", "grid"]),
    mutates: true,
    async run(a, env) {
      const loc = findWidgetParent(env.draft.page.widgets, String(a.id));
      if (!loc) return `no widget '${String(a.id)}'`;
      loc.list[loc.index] = { ...loc.list[loc.index], grid: { ...loc.list[loc.index].grid, ...(a.grid as object) } };
      env.dirty = true;
      return issuesFor(env, (i) => i.path.includes(String(a.id)));
    },
  },
  {
    name: "upsert_component",
    description: "Add or replace a custom TSX component (default export React component). Use it with a widget of type custom.<Name>. Read get_script_docs first.",
    parameters: obj({ name: str("PascalCase name"), source: str("TSX source"), description: str("what it shows"), propsSchema: { type: "object", description: "optional JSON schema of its props" } }, ["name", "source"]),
    mutates: true,
    async run(a, env) {
      const ref = ComponentRef.safeParse({ name: a.name, description: a.description, propsSchema: a.propsSchema });
      if (!ref.success) return `ERROR: ${zodMsg(ref.error)}`;
      const src = String(a.source);
      try {
        transform(src, { transforms: ["typescript", "jsx"], jsxRuntime: "automatic", production: true });
      } catch (e) {
        return `ERROR: does not compile: ${(e as Error).message}`;
      }
      const issues = checkCode(src, { kind: "component", modules: env.draft.page.modules.map((m) => m.name), components: env.draft.page.components.map((c) => c.name).concat(ref.data.name) });
      if (issues.length) return `ERROR: ${issues.map((i) => `${i.line ? `line ${i.line}: ` : ""}${i.message}`).join("; ")} (component not saved)`;
      const list = env.draft.page.components;
      const i = list.findIndex((c) => c.name === ref.data.name);
      if (i >= 0) list[i] = ref.data;
      else list.push(ref.data);
      env.draft.components[ref.data.name] = src;
      env.dirty = true;
      return `saved component ${ref.data.name}; use it with { "type": "custom.${ref.data.name}" }`;
    },
  },
  {
    name: "remove_component",
    description: "Remove a custom component.",
    parameters: obj({ name: str("component name") }, ["name"]),
    mutates: true,
    async run(a, env) {
      env.draft.page.components = env.draft.page.components.filter((c) => c.name !== a.name);
      delete env.draft.components[String(a.name)];
      env.dirty = true;
      return `removed. ${issuesFor(env, () => true)}`;
    },
  },
  {
    name: "upsert_script",
    description: "Add or replace a page script (ES module, default export function receiving the Page API). Read get_script_docs first.",
    parameters: obj({ name: str("script name"), source: str("JavaScript ES module source"), runOn: str("page:dataLoaded (default) | page:init | filter:changed | manual | interval:<seconds>"), description: str("what it does") }, ["name", "source"]),
    mutates: true,
    async run(a, env) {
      const ref = ScriptRef.safeParse({ name: a.name, runOn: a.runOn ?? "page:dataLoaded", description: a.description });
      if (!ref.success) return `ERROR: ${zodMsg(ref.error)}`;
      const src = String(a.source);
      try {
        transform(src, { transforms: ["typescript"], production: true });
      } catch (e) {
        return `ERROR: syntax error: ${(e as Error).message}`;
      }
      const issues = checkCode(src, { kind: "script", modules: env.draft.page.modules.map((m) => m.name), components: env.draft.page.components.map((c) => c.name) });
      if (issues.length) return `ERROR: ${issues.map((i) => `${i.line ? `line ${i.line}: ` : ""}${i.message}`).join("; ")} (script not saved)`;
      const list = env.draft.page.scripts;
      const i = list.findIndex((s) => s.name === ref.data.name);
      if (i >= 0) list[i] = ref.data;
      else list.push(ref.data);
      env.draft.scripts[ref.data.name] = src;
      env.dirty = true;
      return `saved script ${ref.data.name} (runs on ${ref.data.runOn})`;
    },
  },
  {
    name: "remove_script",
    description: "Remove a page script.",
    parameters: obj({ name: str("script name") }, ["name"]),
    mutates: true,
    async run(a, env) {
      env.draft.page.scripts = env.draft.page.scripts.filter((s) => s.name !== a.name);
      delete env.draft.scripts[String(a.name)];
      env.dirty = true;
      return "removed";
    },
  },
  {
    name: "add_module",
    description: "Declare an extra ES module (npm package at an exact version) for scripts/components. It is fetched, vendored and pinned with an integrity hash. Import it by name.",
    parameters: obj({ name: str("npm package name"), version: str("exact version, e.g. 3.12.5"), registry: str("esm.sh (default) | jsdelivr"), providesWidgets: { type: "array", items: { type: "string" }, description: "widget types the module registers (rare)" } }, ["name", "version"]),
    mutates: true,
    async run(a, env) {
      const ref = { name: String(a.name), version: String(a.version), source: "registry" as const, registry: a.registry ? String(a.registry) : "esm.sh", providesWidgets: a.providesWidgets as string[] | undefined };
      const m = await resolveModule(env.projectId, ref, env.user.id);
      const list = env.draft.page.modules;
      const entry = { ...ref, hash: m.hash, integrity: m.integrity };
      const i = list.findIndex((x) => x.name === ref.name);
      if (i >= 0) list[i] = entry;
      else list.push(entry);
      env.dirty = true;
      return `module ${ref.name}@${ref.version} added (${m.files.length} file(s)); import it as "${ref.name}"`;
    },
  },
  {
    name: "remove_module",
    description: "Remove a declared module.",
    parameters: obj({ name: str("module name") }, ["name"]),
    mutates: true,
    async run(a, env) {
      env.draft.page.modules = env.draft.page.modules.filter((m) => m.name !== a.name);
      env.dirty = true;
      return `removed. ${issuesFor(env, () => true)}`;
    },
  },
  {
    name: "validate_page",
    description: "Validate the whole draft. Returns ERROR/WARN lines or OK.",
    parameters: obj({}),
    async run(_a, env) {
      const v = validatePage(env.draft, { catalogue: env.catalogue });
      if (v.bundle) env.draft.page.requires = v.bundle.page.requires;
      return v.errors.length || v.warnings.length ? formatIssues(v) : "OK — no errors or warnings";
    },
  },
  {
    name: "render_preview",
    description: "Render the draft page with live data and return a screenshot so you can check layout and readability.",
    parameters: obj({}),
    async run(_a, env) {
      if (!env.renderPreview) return "Preview rendering is not available on this server.";
      const img = await env.renderPreview(env.draft);
      return img ? { text: "Screenshot of the current draft attached.", image: img } : "Rendering failed.";
    },
  },
];

export function toolSpecs(opts: { runtimeOnly?: boolean; withPreview?: boolean } = {}): ToolSpec[] {
  return TOOLS.filter((t) => (!opts.runtimeOnly || t.runtime) && (t.name !== "render_preview" || opts.withPreview)).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export async function runTool(name: string, rawArgs: string, env: ToolEnv, opts: { runtimeOnly?: boolean } = {}): Promise<ToolResult> {
  const t = TOOLS.find((x) => x.name === name && (!opts.runtimeOnly || x.runtime));
  if (!t) return { text: `ERROR: unknown tool '${name}'. Call the page tools directly as function calls (for example upsert_dataset, upsert_widget), not through code or other tools. Available: ${TOOLS.filter((x) => !opts.runtimeOnly || x.runtime).map((x) => x.name).join(", ")}` };
  let args: Record<string, unknown>;
  try {
    args = rawArgs?.trim() ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    return { text: "ERROR: tool arguments were not valid JSON; send a JSON object" };
  }
  // tolerate models that send nested objects as JSON strings
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string" && /^\s*[{[]/.test(v) && ["filter", "dataset", "widget", "request", "filters", "grid", "theme", "layout", "settings", "propsSchema"].includes(k)) {
      try {
        args[k] = JSON.parse(v);
      } catch {
        /* leave as string */
      }
    }
  }
  try {
    const r = await t.run(args, env);
    return typeof r === "string" ? { text: r } : r;
  } catch (e) {
    return { text: `ERROR: ${(e as Error).message}` };
  }
}

export const MUTATING_TOOLS = new Set(TOOLS.filter((t) => t.mutates).map((t) => t.name));
