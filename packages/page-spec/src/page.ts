import { z } from "zod";

export const PAGE_SPEC = "aibi.page/1";

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, "ids use letters, digits, '_' or '-' and start with a letter or '_'");

/* ───────────────────────── Filters ───────────────────────── */

export const FilterType = z.enum(["dateRange", "select", "multiSelect", "search", "numberRange", "toggle"]);
export type FilterType = z.infer<typeof FilterType>;

export const FilterOption = z.object({ value: z.union([z.string(), z.number(), z.boolean()]), label: z.string().optional() });

export const FilterOptionsSource = z.union([
  z.array(FilterOption),
  z.object({ dataset: id, value: z.string(), label: z.string().optional() }),
]);

export const DATE_PRESETS = [
  "today", "yesterday", "last7d", "last30d", "last90d",
  "MTD", "QTD", "YTD", "lastMonth", "lastQuarter", "lastYear", "last12m", "custom",
] as const;
export const DatePreset = z.enum(DATE_PRESETS);

export const Filter = z.object({
  id,
  type: FilterType,
  label: z.string().optional(),
  /**
   * Default value. dateRange: { preset } or { start, end }; select: value; multiSelect: values[] or "all";
   * search: string; numberRange: { min, max }; toggle: boolean.
   */
  default: z.unknown().optional(),
  presets: z.array(DatePreset).optional(),
  options: FilterOptionsSource.optional(),
  placeholder: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  position: z.enum(["top", "left"]).default("top").optional(),
  width: z.number().int().min(1).max(12).optional(),
});
export type Filter = z.infer<typeof Filter>;

/* ───────────────────────── Datasets ───────────────────────── */

/** A transform step; `op` names a transform registered by a transform skill. */
export const TransformStep = z.object({ op: z.string().min(1) }).passthrough();
export type TransformStep = z.infer<typeof TransformStep>;

export const SqlRequest = z.object({
  sql: z.string().min(1),
  params: z.record(z.unknown()).optional(),
});
export const HttpRequest = z.object({
  method: z.enum(["GET", "POST"]).default("GET"),
  path: z.string().min(1),
  query: z.record(z.unknown()).optional(),
  body: z.unknown().optional(),
  headers: z.record(z.string()).optional(),
  resultPath: z.string().optional(),
});
/** Datasource request: shape is defined by the datasource skill (SQL or HTTP for built-ins). */
export const DatasetRequest = z.record(z.unknown());

export const Dataset = z
  .object({
    id,
    description: z.string().optional(),
    /** data source alias (skill instance) — or omit and use `from` for derived datasets */
    source: z.string().optional(),
    request: DatasetRequest.optional(),
    /** derive from other datasets (first one is the base); steps in `pipeline` may reference the others */
    from: z.array(id).optional(),
    pipeline: z.array(TransformStep).optional(),
    cache: z.object({ ttlSeconds: z.number().int().min(0).max(86400) }).optional(),
    /** computed by the validator: filter ids and dataset ids this dataset depends on */
    dependsOn: z.array(z.string()).optional(),
    /** sample of column names (for documentation and AI context; never data) */
    columns: z.array(z.string()).optional(),
  })
  .superRefine((d, ctx) => {
    if (!d.source && !d.from?.length) ctx.addIssue({ code: "custom", message: "dataset needs either `source` + `request` or `from`" });
    if (d.source && !d.request) ctx.addIssue({ code: "custom", message: "dataset with `source` needs a `request`" });
  });
export type Dataset = z.infer<typeof Dataset>;

/* ───────────────────────── Widgets ───────────────────────── */

export const Grid = z.object({
  x: z.number().int().min(0).max(11),
  y: z.number().int().min(0),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(60),
  minW: z.number().int().min(1).max(12).optional(),
  minH: z.number().int().min(1).optional(),
});
export type Grid = z.infer<typeof Grid>;

export const Interaction = z.object({
  on: z.enum(["click", "dblclick", "hover", "select"]),
  action: z.enum(["setFilter", "clearFilter", "emit", "openUrl", "showWidget", "hideWidget", "toggleWidget"]),
  filter: z.string().optional(),
  /** expression evaluated with { event, row, filters } */
  value: z.string().optional(),
  event: z.string().optional(),
  url: z.string().optional(),
  widget: z.string().optional(),
});
export type Interaction = z.infer<typeof Interaction>;

export const ConditionalStyle = z.object({
  /** expression evaluated with { row, value, column } */
  when: z.string(),
  column: z.string().optional(),
  style: z.record(z.union([z.string(), z.number()])),
});

export interface Widget {
  id: string;
  type: string;
  title?: string;
  subtitle?: string;
  grid: z.infer<typeof Grid>;
  dataset?: string;
  props?: Record<string, unknown>;
  interactions?: z.infer<typeof Interaction>[];
  conditional?: z.infer<typeof ConditionalStyle>[];
  visibleWhen?: string;
  hidden?: boolean;
  /** for container widgets (tabs): each tab holds its own widgets */
  tabs?: { title: string; widgets: Widget[] }[];
  style?: Record<string, string | number>;
}

export const Widget: z.ZodType<Widget> = z.lazy(() =>
  z.object({
    id,
    type: z.string().min(1).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    grid: Grid,
    dataset: id.optional(),
    props: z.record(z.unknown()).optional(),
    interactions: z.array(Interaction).optional(),
    conditional: z.array(ConditionalStyle).optional(),
    visibleWhen: z.string().optional(),
    hidden: z.boolean().optional(),
    tabs: z.array(z.object({ title: z.string(), widgets: z.array(Widget) })).optional(),
    style: z.record(z.union([z.string(), z.number()])).optional(),
  }),
);

/* ───────────────────────── Code assets & modules ───────────────────────── */

export const ScriptTrigger = z.union([
  z.enum(["page:init", "page:dataLoaded", "filter:changed", "manual"]),
  z.string().regex(/^interval:\d+$/),
]);

export const ScriptRef = z.object({
  name: id,
  runOn: ScriptTrigger.default("page:dataLoaded"),
  description: z.string().optional(),
});
export type ScriptRef = z.infer<typeof ScriptRef>;

export const ComponentRef = z.object({
  name: z.string().regex(/^[A-Z][A-Za-z0-9_]*$/, "component names are PascalCase"),
  description: z.string().optional(),
  /** JSON schema of props (optional) so editors and the AI can configure it */
  propsSchema: z.record(z.unknown()).optional(),
});
export type ComponentRef = z.infer<typeof ComponentRef>;

export const ModuleRef = z.object({
  /** import specifier used by scripts/components, e.g. "gsap" or "@acme/widgets" */
  name: z.string().min(1).regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(\/[A-Za-z0-9._/-]+)?$/i),
  version: z.string().min(1),
  source: z.enum(["registry", "url", "bundled"]),
  /** for registry: which registry (esm.sh, jsdelivr); for url: the URL */
  registry: z.string().optional(),
  url: z.string().url().optional(),
  /** content hash (sha256 hex) of the vendored entry file in the module store */
  hash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** SRI integrity of the entry file */
  integrity: z.string().optional(),
  /** module exports `register(runtime)` and adds widget types */
  providesWidgets: z.array(z.string()).optional(),
});
export type ModuleRef = z.infer<typeof ModuleRef>;

/* ───────────────────────── Page ───────────────────────── */

export const Requires = z.object({
  skills: z.record(z.string()).default({}),
  sources: z
    .record(
      z.object({
        skill: z.string().optional(),
        dialect: z.string().optional(),
        tables: z.array(z.string()).optional(),
        columns: z.record(z.array(z.string())).optional(),
      }),
    )
    .default({}),
  modules: z.record(z.string()).default({}),
});
export type Requires = z.infer<typeof Requires>;

export const PageDefinition = z.object({
  spec: z.literal(PAGE_SPEC).default(PAGE_SPEC),
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  tags: z.array(z.string()).optional(),
  requires: Requires.optional(),
  theme: z
    .object({
      mode: z.enum(["auto", "light", "dark"]).default("auto"),
      palette: z.array(z.string()).optional(),
      overrides: z.record(z.string()).optional(),
    })
    .optional(),
  layout: z
    .object({
      cols: z.literal(12).default(12),
      rowHeight: z.number().int().min(10).max(200).default(40),
      gap: z.number().int().min(0).max(48).default(12),
      maxWidth: z.number().int().optional(),
    })
    .optional(),
  filters: z.array(Filter).default([]),
  datasets: z.array(Dataset).default([]),
  widgets: z.array(Widget).default([]),
  components: z.array(ComponentRef).default([]),
  scripts: z.array(ScriptRef).default([]),
  modules: z.array(ModuleRef).default([]),
  settings: z
    .object({
      refreshSeconds: z.number().int().min(0).max(86400).optional(),
      printable: z.boolean().optional(),
      mobileLayout: z.enum(["stack", "scale"]).optional(),
      locale: z.string().optional(),
      currency: z.string().optional(),
    })
    .optional(),
});
export type PageDefinition = z.infer<typeof PageDefinition>;
export type PageDefinitionInput = z.input<typeof PageDefinition>;

/**
 * Everything needed to render a page except module contents and data:
 * the definition plus the source of its components and scripts.
 */
export const PageBundle = z.object({
  page: PageDefinition,
  components: z.record(z.string()).default({}),
  scripts: z.record(z.string()).default({}),
  /** small static assets (geoJSON, images as data URLs) keyed by name */
  assets: z.record(z.string()).default({}),
});
export type PageBundle = z.infer<typeof PageBundle>;
export type PageBundleInput = z.input<typeof PageBundle>;

export function emptyPage(idValue: string, title = "Untitled page"): PageBundle {
  return PageBundle.parse({ page: { id: idValue, title } });
}

/** Walk all widgets including those nested in tabs. */
export function allWidgets(widgets: Widget[]): Widget[] {
  const out: Widget[] = [];
  const walk = (ws: Widget[]) => {
    for (const w of ws) {
      out.push(w);
      if (w.tabs) for (const t of w.tabs) walk(t.widgets);
    }
  };
  walk(widgets);
  return out;
}
