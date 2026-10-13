import { checkReadOnly, tokenize, significant, unquote, type Dialect } from "@aibi/sql-guard";
import type { ZodError } from "zod";
import { PageBundle, allWidgets, type Requires, type Widget, type PageBundleInput } from "./page";
import { type Catalogue, checkSchema, EMPTY_CATALOGUE } from "./catalogue";
import { findBindings } from "./bindings";
import { memberPaths, compileExpr } from "./expr";
import { FILTER_FIELDS } from "./filters";
import { checkCode } from "./code-check";

export interface Issue {
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  /** the parsed bundle with defaults applied and computed fields filled (when parsing succeeded) */
  bundle?: PageBundle;
  requires?: Requires;
}

export interface ValidateOptions {
  catalogue?: Catalogue;
  /** when false, unknown widget types / sources are warnings instead of errors (e.g. local drafts before mapping) */
  strictCatalogue?: boolean;
  /** require resolved module hashes (saving to the server) */
  requireModuleHashes?: boolean;
  /** extra SQL guard options per source alias */
  sqlOptions?: Record<string, { deniedTables?: string[]; allowedSchemas?: string[] }>;
}

export function zodIssues(e: ZodError, prefix = ""): Issue[] {
  return e.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].filter(Boolean).join("."), message: i.message }));
}

const EXACT_VERSION = /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/;

/** Extract table references (FROM/JOIN targets) from a SQL query. */
export function sqlTables(sql: string, dialect: Dialect): string[] {
  try {
    const sig = significant(tokenize(sql, dialect));
    const cteNames = new Set<string>();
    for (let k = 0; k < sig.length - 2; k++) {
      if ((sig[k].upper === "WITH" || sig[k].text === ",") && (sig[k + 1].kind === "word" || sig[k + 1].kind === "quoted") && sig[k + 2].upper === "AS") {
        cteNames.add(unquote(sig[k + 1].text).toLowerCase());
      }
    }
    const out = new Set<string>();
    for (let k = 0; k < sig.length - 1; k++) {
      if (sig[k].upper === "FROM" || sig[k].upper === "JOIN") {
        const parts: string[] = [];
        let j = k + 1;
        while (sig[j] && (sig[j].kind === "word" || sig[j].kind === "quoted")) {
          parts.push(unquote(sig[j].text));
          if (sig[j + 1]?.text === ".") j += 2;
          else break;
        }
        const name = parts.join(".");
        if (name && !cteNames.has(name.toLowerCase()) && !["SELECT", "LATERAL", "UNNEST", "DUAL"].includes(name.toUpperCase())) out.add(name);
      }
    }
    return [...out];
  } catch {
    return [];
  }
}

/**
 * Request fields that hold query *code* (SQL text, GraphQL documents, URL paths). Filter values come from
 * viewers, so they may only reach a data source as bound parameters / variables / query-string values,
 * never by text interpolation into these fields.
 */
export const CODE_FIELDS = ["sql", "query", "path", "operationName"] as const;

/** Names of code fields in a dataset request that contain {{ }} bindings (must be empty). */
export function bindingsInCodeFields(request: Record<string, unknown> | undefined): string[] {
  if (!request) return [];
  return CODE_FIELDS.filter((f) => typeof request[f] === "string" && (request[f] as string).includes("{{"));
}

export function validatePage(input: PageBundleInput | unknown, opts: ValidateOptions = {}): ValidationResult {
  const cat = opts.catalogue ?? EMPTY_CATALOGUE;
  const strict = opts.strictCatalogue ?? Boolean(opts.catalogue);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const catIssue = (i: Issue) => (strict ? errors : warnings).push(i);

  const parsed = PageBundle.safeParse(input);
  if (!parsed.success) return { ok: false, errors: zodIssues(parsed.error), warnings };
  const bundle = parsed.data;
  const page = bundle.page;

  /* ── ids ── */
  const seen = new Map<string, string>();
  const claim = (id: string, kind: string, path: string) => {
    const prev = seen.get(id);
    if (prev) errors.push({ path, message: `id '${id}' is already used by a ${prev}` });
    else seen.set(id, kind);
  };
  page.filters.forEach((f, i) => claim(f.id, "filter", `filters[${i}]`));
  page.datasets.forEach((d, i) => claim(d.id, "dataset", `datasets[${i}]`));
  const widgets = allWidgets(page.widgets);
  widgets.forEach((w) => claim(w.id, "widget", `widget ${w.id}`));

  const filterById = new Map(page.filters.map((f) => [f.id, f]));
  const datasetIds = new Set(page.datasets.map((d) => d.id));
  const sourceByAlias = new Map(cat.sources.map((s) => [s.alias, s]));
  const transformByOp = new Map(cat.transforms.map((t) => [t.op, t]));
  const widgetByType = new Map(cat.widgets.map((w) => [w.type, w]));
  const moduleNames = page.modules.map((m) => m.name);
  const componentNames = page.components.map((c) => c.name);
  const moduleWidgetTypes = new Set(page.modules.flatMap((m) => m.providesWidgets ?? []));

  const requires: Requires = { skills: {}, sources: {}, modules: {} };
  const needSkill = (skill: string | undefined) => {
    if (skill && !requires.skills[skill]) requires.skills[skill] = cat.skills[skill] ? `^${cat.skills[skill]}` : "*";
  };

  /** validate a binding path such as filters.date.start; returns dependency id or null */
  const checkPath = (p: string, where: string, allowedRoots: string[]): string | null => {
    const parts = p.split(".");
    const root = parts[0];
    if (!allowedRoots.includes(root)) {
      errors.push({ path: where, message: `binding '${p}': unknown name '${root}' (allowed: ${allowedRoots.join(", ")})` });
      return null;
    }
    if (root === "filters") {
      const f = filterById.get(parts[1]);
      if (!f) {
        errors.push({ path: where, message: `binding '${p}': no filter with id '${parts[1] ?? ""}'` });
        return null;
      }
      if (parts[2] && !FILTER_FIELDS[f.type].includes(parts[2])) {
        errors.push({ path: where, message: `binding '${p}': ${f.type} filters expose ${FILTER_FIELDS[f.type].join(", ")}` });
      }
      return `filters.${f.id}`;
    }
    return null;
  };

  /* ── filters ── */
  page.filters.forEach((f, i) => {
    needSkill(cat.filters.find((x) => x.type === f.type)?.skill ?? "filter-core");
    if (f.options && !Array.isArray(f.options) && !datasetIds.has(f.options.dataset)) {
      errors.push({ path: `filters[${i}].options.dataset`, message: `no dataset '${f.options.dataset}'` });
    }
    if (f.type === "dateRange" && f.default && typeof f.default === "object" && "preset" in (f.default as object)) {
      const preset = (f.default as { preset: string }).preset;
      if (f.presets && !f.presets.includes(preset as never)) warnings.push({ path: `filters[${i}].default`, message: `default preset '${preset}' is not in presets` });
    }
  });

  /* ── datasets ── */
  const deps = new Map<string, Set<string>>();
  page.datasets.forEach((d, i) => {
    const at = `datasets[${i}]`;
    const dset = new Set<string>();
    deps.set(d.id, dset);
    if (d.source) {
      const src = sourceByAlias.get(d.source);
      if (!src) catIssue({ path: `${at}.source`, message: `unknown data source '${d.source}'${cat.sources.length ? ` (available: ${cat.sources.map((s) => s.alias).join(", ")})` : ""}` });
      const req = d.request ?? {};
      const reqEntry = (requires.sources[d.source] ??= { skill: src?.skill, dialect: src?.dialect, tables: [] });
      needSkill(src?.skill);
      const kind = src?.kind ?? (typeof req.sql === "string" ? "sql" : typeof req.path === "string" ? "http" : "other");
      if (kind === "sql") {
        if (typeof req.sql !== "string" || !req.sql.trim()) errors.push({ path: `${at}.request.sql`, message: "SQL datasets need request.sql" });
        else {
          const dialect = (src?.dialect ?? "mysql") as Dialect;
          const ro = checkReadOnly(req.sql, dialect, opts.sqlOptions?.[d.source] ?? {});
          ro.errors.forEach((m) => errors.push({ path: `${at}.request.sql`, message: m }));
          const given = Object.keys((req.params as Record<string, unknown>) ?? {});
          for (const p of ro.params) if (!given.includes(p)) errors.push({ path: `${at}.request.params`, message: `SQL uses :${p} but request.params has no '${p}'` });
          for (const g of given) if (!ro.params.includes(g)) warnings.push({ path: `${at}.request.params.${g}`, message: `parameter '${g}' is not used in the SQL` });
          for (const t of sqlTables(req.sql, dialect)) if (!reqEntry.tables!.includes(t)) reqEntry.tables!.push(t);
        }
      } else if (kind === "http") {
        if (typeof req.path !== "string") errors.push({ path: `${at}.request.path`, message: "HTTP datasets need request.path" });
        else if (/^[a-z]+:\/\//i.test(req.path) || req.path.startsWith("//")) errors.push({ path: `${at}.request.path`, message: "path must be relative to the data source base URL" });
      }
      for (const f of bindingsInCodeFields(req)) {
        errors.push({
          path: `${at}.request.${f}`,
          message: `{{ }} bindings are not allowed inside '${f}' (they would insert viewer-controlled text into the query). ${f === "sql" ? "Use :name placeholders with request.params" : f === "path" ? "Pass values as request.query parameters" : "Use variables"} instead.`,
        });
      }
      for (const b of findBindings(req)) {
        if (b.error) {
          errors.push({ path: `${at}.request.${b.path}`, message: `binding '{{${b.src}}}': ${b.error}` });
          continue;
        }
        for (const p of memberPaths(b.node!)) {
          const dep = checkPath(p, `${at}.request.${b.path}`, ["filters", "page", "user"]);
          if (dep) dset.add(dep);
        }
      }
    }
    if (d.from) {
      d.from.forEach((f) => {
        if (!datasetIds.has(f)) errors.push({ path: `${at}.from`, message: `no dataset '${f}'` });
        else dset.add(`datasets.${f}`);
      });
    }
    (d.pipeline ?? []).forEach((step, k) => {
      const t = transformByOp.get(step.op);
      if (!t) {
        catIssue({ path: `${at}.pipeline[${k}]`, message: `unknown transform '${step.op}'${cat.transforms.length ? ` (available: ${cat.transforms.map((x) => x.op).join(", ")})` : ""}` });
        return;
      }
      needSkill(t.skill);
      checkSchema(step, t.schema).forEach((m) => errors.push({ path: `${at}.pipeline[${k}]`, message: m }));
      // expressions in calc / filter steps must parse (column names with spaces: row['Gross margin'])
      const exprs: [string, unknown][] =
        step.op === "calc" && step.columns && typeof step.columns === "object" ? Object.entries(step.columns as Record<string, unknown>) : step.op === "filter" ? [["where", (step as Record<string, unknown>).where]] : [];
      for (const [name, src] of exprs) {
        if (typeof src !== "string") continue;
        try {
          compileExpr(src.replace(/\{\{[\s\S]*?\}\}/g, "0"));
        } catch (e) {
          errors.push({ path: `${at}.pipeline[${k}].${step.op === "calc" ? `columns.${name}` : "where"}`, message: `expression '${src}': ${(e as Error).message}. Use plain column names (row['Name with spaces'] for others).` });
        }
      }
      // by convention, `with` names another dataset (join, union, lookup)
      const ref = (step as Record<string, unknown>).with;
      if (typeof ref === "string") {
        if (datasetIds.has(ref)) dset.add(`datasets.${ref}`);
        else errors.push({ path: `${at}.pipeline[${k}].with`, message: `no dataset '${ref}'` });
      }
      for (const b of findBindings(step)) {
        if (b.node) for (const p of memberPaths(b.node)) {
          const dep = checkPath(p, `${at}.pipeline[${k}]`, ["filters", "page", "user"]);
          if (dep) dset.add(dep);
        }
      }
    });
  });
  // cycles among datasets
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (done.has(id)) return;
    if (visiting.has(id)) {
      errors.push({ path: `datasets.${id}`, message: `circular dataset dependency: ${[...trail, id].join(" → ")}` });
      return;
    }
    visiting.add(id);
    for (const dep of deps.get(id) ?? []) if (dep.startsWith("datasets.")) visit(dep.slice(9), [...trail, id]);
    visiting.delete(id);
    done.add(id);
  };
  for (const id of deps.keys()) visit(id, []);
  // write computed dependsOn (transitive filters)
  const transitive = (id: string, acc = new Set<string>(), guard = new Set<string>()): Set<string> => {
    if (guard.has(id)) return acc;
    guard.add(id);
    for (const dep of deps.get(id) ?? []) {
      acc.add(dep);
      if (dep.startsWith("datasets.")) transitive(dep.slice(9), acc, guard);
    }
    return acc;
  };
  for (const d of page.datasets) d.dependsOn = [...transitive(d.id)].sort();

  /* ── widgets ── */
  const checkWidget = (w: Widget, at: string) => {
    const info = widgetByType.get(w.type);
    if (w.type.startsWith("custom.")) {
      const name = w.type.slice(7);
      if (!componentNames.includes(name)) errors.push({ path: `${at}.type`, message: `custom component '${name}' is not declared in page.components` });
      needSkill("visual-custom");
    } else if (!info && !moduleWidgetTypes.has(w.type) && w.type !== "tabs") {
      catIssue({ path: `${at}.type`, message: `unknown widget type '${w.type}'` });
    } else if (info) {
      needSkill(info.skill);
      checkSchema(w.props ?? {}, info.propsSchema).forEach((m) => errors.push({ path: `${at}.props`, message: m }));
      if (info.needsDataset && !w.dataset) errors.push({ path: `${at}.dataset`, message: `${w.type} needs a dataset` });
      const ds = w.dataset ? page.datasets.find((d) => d.id === w.dataset) : undefined;
      if (ds?.columns?.length && info.columnProps) {
        for (const cp of info.columnProps) {
          const v = w.props?.[cp];
          const cols = (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((c): c is string => typeof c === "string" && !c.includes("{{"));
          for (const c of cols) if (!ds.columns.includes(c)) warnings.push({ path: `${at}.props.${cp}`, message: `column '${c}' is not in dataset '${ds.id}' (columns: ${ds.columns.join(", ")})` });
        }
      }
    }
    if (w.type === "tabs" && !w.tabs?.length) errors.push({ path: at, message: "tabs widget needs `tabs`" });
    if (w.dataset && !datasetIds.has(w.dataset)) errors.push({ path: `${at}.dataset`, message: `no dataset '${w.dataset}'` });
    (w.interactions ?? []).forEach((it, k) => {
      if ((it.action === "setFilter" || it.action === "clearFilter") && (!it.filter || !filterById.has(it.filter))) {
        errors.push({ path: `${at}.interactions[${k}].filter`, message: `no filter '${it.filter ?? ""}'` });
      }
      if (["showWidget", "hideWidget", "toggleWidget"].includes(it.action) && (!it.widget || !widgets.some((x) => x.id === it.widget))) {
        errors.push({ path: `${at}.interactions[${k}].widget`, message: `no widget '${it.widget ?? ""}'` });
      }
      if (it.value) tryExpr(it.value.replace(/^\{\{|\}\}$/g, ""), `${at}.interactions[${k}].value`);
    });
    (w.conditional ?? []).forEach((c, k) => tryExpr(c.when, `${at}.conditional[${k}].when`));
    if (w.visibleWhen) tryExpr(w.visibleWhen, `${at}.visibleWhen`);
    for (const b of findBindings(w.props ?? {})) if (b.error) errors.push({ path: `${at}.props.${b.path}`, message: `binding '{{${b.src}}}': ${b.error}` });
    (w.tabs ?? []).forEach((t, ti) => t.widgets.forEach((cw, ci) => checkWidget(cw, `${at}.tabs[${ti}].widgets[${ci}]`)));
  };
  const tryExpr = (src: string, path: string) => {
    try {
      compileExpr(src);
    } catch (e) {
      errors.push({ path, message: `expression '${src}': ${(e as Error).message}` });
    }
  };
  page.widgets.forEach((w, i) => checkWidget(w, `widgets[${i}] (${w.id})`));
  // overlap (top level grid only)
  for (let a = 0; a < page.widgets.length; a++) {
    for (let b = a + 1; b < page.widgets.length; b++) {
      const A = page.widgets[a].grid;
      const B = page.widgets[b].grid;
      if (A.x < B.x + B.w && B.x < A.x + A.w && A.y < B.y + B.h && B.y < A.y + A.h) {
        warnings.push({ path: `widgets.${page.widgets[b].id}.grid`, message: `overlaps widget '${page.widgets[a].id}'; the runtime will push it down` });
      }
    }
    if (page.widgets[a].grid.x + page.widgets[a].grid.w > 12) {
      errors.push({ path: `widgets.${page.widgets[a].id}.grid`, message: "x + w must be <= 12" });
    }
  }

  /* ── components & scripts ── */
  for (const c of page.components) {
    const src = bundle.components[c.name];
    if (src === undefined) {
      errors.push({ path: `components.${c.name}`, message: "component source is missing" });
      continue;
    }
    checkCode(src, { kind: "component", modules: moduleNames, components: componentNames }).forEach((x) =>
      errors.push({ path: `components.${c.name}${x.line ? `:${x.line}` : ""}`, message: x.message }),
    );
  }
  for (const name of Object.keys(bundle.components)) if (!componentNames.includes(name)) warnings.push({ path: `components.${name}`, message: "source has no entry in page.components and will be ignored" });
  for (const s of page.scripts) {
    const src = bundle.scripts[s.name];
    if (src === undefined) {
      errors.push({ path: `scripts.${s.name}`, message: "script source is missing" });
      continue;
    }
    checkCode(src, { kind: "script", modules: moduleNames, components: componentNames }).forEach((x) =>
      errors.push({ path: `scripts.${s.name}${x.line ? `:${x.line}` : ""}`, message: x.message }),
    );
  }
  for (const name of Object.keys(bundle.scripts)) if (!page.scripts.some((s) => s.name === name)) warnings.push({ path: `scripts.${name}`, message: "source has no entry in page.scripts and will be ignored" });
  if (page.scripts.length || page.components.length) needSkill("script-anime");

  /* ── modules ── */
  const modNames = new Set<string>();
  page.modules.forEach((m, i) => {
    const at = `modules[${i}] (${m.name})`;
    if (modNames.has(m.name)) errors.push({ path: at, message: "module declared twice" });
    modNames.add(m.name);
    if (!EXACT_VERSION.test(m.version)) errors.push({ path: `${at}.version`, message: `use an exact version like 1.2.3 (got '${m.version}')` });
    if (m.source === "url") {
      if (!m.url) errors.push({ path: `${at}.url`, message: "url modules need `url`" });
      else if (cat.moduleHosts.length) {
        const host = new URL(m.url).host;
        if (!cat.moduleHosts.includes(host)) errors.push({ path: `${at}.url`, message: `host '${host}' is not in the module allow-list (${cat.moduleHosts.join(", ")})` });
      }
    }
    if (opts.requireModuleHashes && !m.hash) errors.push({ path: at, message: "module is not resolved (no content hash); resolve it before saving" });
    requires.modules[m.name] = m.version;
  });

  page.requires = requires;
  return { ok: errors.length === 0, errors, warnings, bundle, requires };
}

/** Human-readable one-line-per-issue rendering, used in AI tool results and CLI output. */
export function formatIssues(r: Pick<ValidationResult, "errors" | "warnings">): string {
  const lines: string[] = [];
  for (const e of r.errors) lines.push(`ERROR ${e.path}: ${e.message}`);
  for (const w of r.warnings) lines.push(`WARN  ${w.path}: ${w.message}`);
  return lines.join("\n") || "OK";
}
