import {
  allWidgets,
  bindingPaths,
  defaultFilterValues,
  evaluate,
  formatValue,
  type FilterValue,
  type PageBundle,
  type Widget,
  type Dataset,
} from "@aibi/page-spec";
import { runPipeline, toFrame, type Frame } from "@aibi/transforms";
import type { PageApi, ThemeTokens, WidgetRef, ClientSkillModule, WidgetDefinition, FilterUIDefinition } from "@aibi/runtime-api";
import type { RuntimeConfig, RuntimeMode, LocalModuleSource, DatasetSummary } from "@aibi/runtime-api/protocol";
import { send, queryDataset, askAi } from "./bridge";
import { createAnim } from "./anim";
import { applyTheme, buildTheme, resolveMode } from "./theme";
import { compileComponents, compileScript, installShared, loadPageModules, type ScriptFn } from "./modules";

/* ───────────── store ───────────── */

export interface RState {
  bundle: PageBundle | null;
  config: RuntimeConfig | null;
  mode: RuntimeMode;
  colorMode: "auto" | "light" | "dark";
  theme: ThemeTokens | null;
  filtersRaw: Record<string, unknown>;
  filterValues: Record<string, FilterValue>;
  filterOptions: Record<string, { value: string | number | boolean; label: string }[]>;
  frames: Record<string, Frame | undefined>;
  errors: Record<string, string>;
  loading: Record<string, boolean>;
  hidden: Record<string, boolean>;
  propOverrides: Record<string, Record<string, unknown>>;
  selected: string | null;
  widgets: Map<string, WidgetDefinition>;
  filterUIs: Map<string, FilterUIDefinition>;
  componentErrors: Record<string, string>;
  scriptErrors: Record<string, string>;
  moduleErrors: Record<string, string>;
  version: number;
  initialized: boolean;
}

let state: RState = {
  bundle: null,
  config: null,
  mode: "view",
  colorMode: "auto",
  theme: null,
  filtersRaw: {},
  filterValues: {},
  filterOptions: {},
  frames: {},
  errors: {},
  loading: {},
  hidden: {},
  propOverrides: {},
  selected: null,
  widgets: new Map(),
  filterUIs: new Map(),
  componentErrors: {},
  scriptErrors: {},
  moduleErrors: {},
  version: 0,
  initialized: false,
};
const listeners = new Set<() => void>();
export const getState = () => state;
export function setState(patch: Partial<RState>) {
  state = { ...state, ...patch, version: state.version + 1 };
  for (const l of listeners) l();
}
export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/* ───────────── events & handles ───────────── */

const eventHandlers = new Map<string, Set<(p: unknown) => void>>();
export function emitEvent(name: string, payload?: unknown) {
  for (const h of eventHandlers.get(name) ?? []) {
    try {
      h(payload);
    } catch (e) {
      log("error", `event handler for ${name}: ${(e as Error).message}`, "script");
    }
  }
  if (name.startsWith("widget:") || !name.includes(":")) send({ type: "event", name, payload: safePayload(payload) });
}
function safePayload(p: unknown) {
  try {
    return JSON.parse(JSON.stringify(p ?? null));
  } catch {
    return null;
  }
}
export const handles = new Map<string, Record<string, (...a: unknown[]) => unknown>>();
export const widgetEls = new Map<string, HTMLElement>();

export function log(level: "info" | "warn" | "error", message: string, source?: string) {
  (level === "error" ? console.error : console.log)(`[aibi:${source ?? "runtime"}] ${message}`);
  send({ type: "log", level, message, source });
}

/* ───────────── Page API ───────────── */

const rootEl = () => document.getElementById("aibi-page") ?? document.body;
export const anim = createAnim(rootEl);
const pageState: Record<string, unknown> = {};

function widgetRef(w: Widget): WidgetRef {
  return {
    id: w.id,
    type: w.type,
    get el() {
      return widgetEls.get(w.id) ?? null;
    },
    get props() {
      return { ...(w.props ?? {}), ...(state.propOverrides[w.id] ?? {}) };
    },
    setProps(patch) {
      setState({ propOverrides: { ...state.propOverrides, [w.id]: { ...(state.propOverrides[w.id] ?? {}), ...patch } } });
    },
    get handle() {
      return handles.get(w.id) ?? {};
    },
    show: () => setState({ hidden: { ...state.hidden, [w.id]: false } }),
    hide: () => setState({ hidden: { ...state.hidden, [w.id]: true } }),
  };
}

export const api: PageApi = {
  page: {
    get id() {
      return state.bundle?.page.id ?? "";
    },
    get title() {
      return state.bundle?.page.title ?? "";
    },
    get theme() {
      return state.theme!;
    },
    get el() {
      return rootEl();
    },
    setTitle(title: string) {
      if (state.bundle) setState({ bundle: { ...state.bundle, page: { ...state.bundle.page, title } } });
    },
    refresh: () => loadAll(true),
    print: () => {
      emitEvent("page:beforePrint");
      setTimeout(() => window.print(), 50);
    },
    asset: (name: string) => state.bundle?.assets[name],
    get embedHosts() {
      return state.config?.embedHosts ?? [];
    },
    get locale() {
      return state.bundle?.page.settings?.locale ?? state.config?.locale ?? navigator.language ?? "en-US";
    },
    get currency() {
      return state.bundle?.page.settings?.currency ?? state.config?.currency ?? "USD";
    },
    get mode() {
      return state.mode;
    },
  },
  filters: {
    get: (id) => state.filterValues[id],
    set: (id, raw) => setFilters({ ...state.filtersRaw, [id]: raw }, [id]),
    get values() {
      return state.filterValues;
    },
    get definitions() {
      return state.bundle?.page.filters ?? [];
    },
  },
  data: {
    get: (id) => state.frames[id],
    reload: async (id?: string) => (id ? loadDatasets(new Set([id, ...dependents(id)]), true) : loadAll(true)),
    get ids() {
      return state.bundle?.page.datasets.map((d) => d.id) ?? [];
    },
  },
  widgets: {
    get: (id) => {
      const w = state.bundle ? allWidgets(state.bundle.page.widgets).find((x) => x.id === id) : undefined;
      return w ? widgetRef(w) : undefined;
    },
    all: () => (state.bundle ? allWidgets(state.bundle.page.widgets).map(widgetRef) : []),
    show: (id) => setState({ hidden: { ...state.hidden, [id]: false } }),
    hide: (id) => setState({ hidden: { ...state.hidden, [id]: true } }),
  },
  events: {
    on(name, fn) {
      if (!eventHandlers.has(name)) eventHandlers.set(name, new Set());
      eventHandlers.get(name)!.add(fn);
      return () => eventHandlers.get(name)?.delete(fn);
    },
    off(name, fn) {
      eventHandlers.get(name)?.delete(fn);
    },
    emit: (name, payload) => emitEvent(name, payload),
  },
  anim,
  util: {
    format: (v, spec) => formatValue(v, spec, { locale: api.page.locale, currency: api.page.currency }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  },
  ai: {
    ask: (question, opts) => askAi("ask", question, summaries(opts?.datasets), state.filterValues as Record<string, unknown>),
    narrative: (o) => askAi("narrative", o.prompt, summaries(o.datasets), state.filterValues as Record<string, unknown>, { widgetId: o.widgetId, maxWords: o.maxWords, refresh: o.refresh }),
  },
  state: pageState,
};

export function summaries(ids?: string[], maxRows = 200): DatasetSummary[] {
  const list = ids?.length ? ids : Object.keys(state.frames);
  const out: DatasetSummary[] = [];
  for (const id of list) {
    const f = state.frames[id];
    if (f) out.push({ id, columns: f.columns, rows: f.rows.slice(0, maxRows), totalRows: f.rows.length, error: state.errors[id] });
  }
  return out;
}

// hooks for custom components (imported as "@aibi/runtime-api")
import { useSyncExternalStore } from "react";
const hooks = {
  useApi: () => api,
  useData: (id: string) => useSyncExternalStore(subscribe, () => state.frames[id]),
  useTheme: () => useSyncExternalStore(subscribe, () => state.theme),
  useFilters: () => useSyncExternalStore(subscribe, () => state.filterValues),
  usePageState: () => pageState,
};
installShared({ anim: anim as unknown as Record<string, unknown>, util: api.util as unknown as Record<string, unknown>, hooks });

/* ───────────── client skills ───────────── */

const builtinSkills = import.meta.glob<{ default: ClientSkillModule }>("../../../skills/*/client/index.tsx");
const loadedSkills = new Map<string, ClientSkillModule>();

async function loadClientSkills(cfg: RuntimeConfig) {
  const widgets = new Map<string, WidgetDefinition>();
  const filterUIs = new Map<string, FilterUIDefinition>();
  for (const ref of cfg.clientSkills) {
    try {
      let mod = loadedSkills.get(`${ref.id}@${ref.version}`);
      if (!mod) {
        if (ref.builtin) {
          const key = Object.keys(builtinSkills).find((k) => k.includes(`/skills/${ref.id}/client/`));
          if (!key) throw new Error("client code not bundled");
          mod = (await builtinSkills[key]()).default;
        } else if (ref.url) mod = ((await import(/* @vite-ignore */ ref.url)) as { default: ClientSkillModule }).default;
        if (mod) loadedSkills.set(`${ref.id}@${ref.version}`, mod);
      }
      for (const w of mod?.widgets ?? []) widgets.set(w.type, w);
      for (const f of mod?.filters ?? []) filterUIs.set(f.type, f);
    } catch (e) {
      log("error", `skill ${ref.id}: ${(e as Error).message}`, "skills");
    }
  }
  return { widgets, filterUIs };
}

/* ───────────── code: modules, components, scripts ───────────── */

let codeKey = "";
let moduleUrls: Record<string, string> = {};
let scripts: { name: string; runOn: string; fn: ScriptFn }[] = [];
let cleanups: (() => void)[] = [];
let tailwindLoaded = false;

async function loadCode(bundle: PageBundle, local: Record<string, LocalModuleSource> | undefined, baseWidgets: Map<string, WidgetDefinition>) {
  const key = JSON.stringify([bundle.page.modules, bundle.page.components, bundle.components, bundle.page.scripts, bundle.scripts, Object.keys(local ?? {})]);
  if (key === codeKey) return null;
  codeKey = key;
  disposeScripts();
  const widgets = new Map(baseWidgets);
  const apiUrl = state.config?.apiUrl ?? "";
  const mods = await loadPageModules(bundle.page.modules, apiUrl, local);
  moduleUrls = mods.urls;
  // modules that register widgets: export function register({ registerWidget, React })
  for (const m of bundle.page.modules) {
    const ns = mods.namespaces[m.name];
    if (ns && typeof ns.register === "function") {
      try {
        (ns.register as (r: unknown) => void)({ registerWidget: (d: WidgetDefinition) => widgets.set(d.type, d), React: window.__aibi_shared.React, api });
      } catch (e) {
        mods.errors[m.name] = `register() failed: ${(e as Error).message}`;
      }
    }
  }
  const names = bundle.page.components.map((c) => c.name);
  const comp = await compileComponents(bundle.components, names, moduleUrls);
  for (const [name, C] of Object.entries(comp.components)) widgets.set(`custom.${name}`, { type: `custom.${name}`, component: C as unknown as WidgetDefinition["component"] });
  if (names.length && !tailwindLoaded) {
    tailwindLoaded = true;
    import("@tailwindcss/browser").catch((e) => log("warn", `tailwind: ${(e as Error).message}`));
  }
  const scriptErrors: Record<string, string> = {};
  scripts = [];
  for (const s of bundle.page.scripts) {
    const src = bundle.scripts[s.name];
    if (src === undefined) continue;
    try {
      scripts.push({ name: s.name, runOn: s.runOn, fn: await compileScript(s.name, src, moduleUrls) });
    } catch (e) {
      scriptErrors[s.name] = (e as Error).message;
      log("error", `script ${s.name}: ${(e as Error).message}`, "script");
    }
  }
  for (const [n, e] of Object.entries(mods.errors)) log("error", `module ${n}: ${e}`, "module");
  for (const [n, e] of Object.entries(comp.errors)) log("error", `component ${n}: ${e}`, "component");
  return { widgets, componentErrors: comp.errors, scriptErrors, moduleErrors: mods.errors };
}

function disposeScripts() {
  for (const c of cleanups) {
    try {
      c();
    } catch {
      /* ignore */
    }
  }
  cleanups = [];
}

async function runScripts(trigger: string) {
  for (const s of scripts) {
    if (s.runOn !== trigger) continue;
    try {
      const r = await s.fn(api);
      if (typeof r === "function") cleanups.push(r as () => void);
    } catch (e) {
      setState({ scriptErrors: { ...state.scriptErrors, [s.name]: (e as Error).message } });
      log("error", `script ${s.name}: ${(e as Error).message}`, "script");
    }
  }
}

function startIntervals() {
  for (const s of scripts) {
    const m = /^interval:(\d+)$/.exec(s.runOn);
    if (!m) continue;
    const t = setInterval(async () => {
      try {
        await s.fn(api);
      } catch (e) {
        log("error", `script ${s.name}: ${(e as Error).message}`, "script");
      }
    }, Math.max(1, Number(m[1])) * 1000);
    cleanups.push(() => clearInterval(t));
  }
}

export async function runScriptByName(name: string) {
  const s = scripts.find((x) => x.name === name);
  if (!s) return;
  try {
    const r = await s.fn(api);
    if (typeof r === "function") cleanups.push(r as () => void);
  } catch (e) {
    log("error", `script ${s.name}: ${(e as Error).message}`, "script");
  }
}

/* ───────────── datasets ───────────── */

function filterDeps(d: Dataset): string[] {
  return [...new Set([...bindingPaths(d.request ?? {}), ...bindingPaths(d.pipeline ?? [])].filter((p) => p.startsWith("filters.")).map((p) => p.split(".")[1]))];
}
function dataDeps(d: Dataset): string[] {
  const steps = (d.pipeline ?? []).map((s) => (s as { with?: unknown }).with).filter((x): x is string => typeof x === "string");
  return [...new Set([...(d.from ?? []), ...steps])];
}
function dependents(id: string): string[] {
  const ds = state.bundle?.page.datasets ?? [];
  const out = new Set<string>();
  const walk = (x: string) => {
    for (const d of ds) if (!out.has(d.id) && dataDeps(d).includes(x)) {
      out.add(d.id);
      walk(d.id);
    }
  };
  walk(id);
  return [...out];
}

function computeFilterValues(raw: Record<string, unknown>, options: RState["filterOptions"]) {
  const page = state.bundle!.page;
  const opts: Record<string, (string | number | boolean)[]> = {};
  for (const [k, v] of Object.entries(options)) opts[k] = v.map((o) => o.value);
  return defaultFilterValues(page.filters, raw, { options: opts });
}

function optionsFromFrames(frames: Record<string, Frame | undefined>): RState["filterOptions"] {
  const out: RState["filterOptions"] = {};
  for (const f of state.bundle?.page.filters ?? []) {
    if (Array.isArray(f.options)) out[f.id] = f.options.map((o) => ({ value: o.value, label: o.label ?? String(o.value) }));
    else if (f.options) {
      const o = f.options;
      const fr = frames[o.dataset];
      if (fr) out[f.id] = fr.rows.filter((r) => r[o.value] !== null && r[o.value] !== undefined).map((r) => ({ value: r[o.value] as string | number | boolean, label: String(r[o.label ?? o.value] ?? r[o.value]) }));
    }
  }
  return out;
}

let generation = 0;
const latest = new Map<string, number>();
let active = 0;
const queue: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 6) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    queue.shift()?.();
  }
}

/** Load a set of datasets (and whatever they depend on that is not loaded yet). */
export async function loadDatasets(ids: Set<string>, force = false): Promise<void> {
  const bundle = state.bundle;
  if (!bundle) return;
  const gen = ++generation;
  const byId = new Map(bundle.page.datasets.map((d) => [d.id, d]));
  const promises = new Map<string, Promise<Frame | undefined>>();
  const frames = { ...state.frames };
  setState({ loading: { ...state.loading, ...Object.fromEntries([...ids].map((i) => [i, true])) } });

  const compute = (id: string): Promise<Frame | undefined> => {
    const p0 = promises.get(id);
    if (p0) return p0;
    const p = (async () => {
      const d = byId.get(id);
      if (!d) return undefined;
      if (!ids.has(id) && !force && frames[id]) return frames[id];
      for (const dep of dataDeps(d)) await compute(dep);
      latest.set(id, gen);
      try {
        let base: Frame | undefined;
        if (d.source && d.request) {
          const r = await limited(() => queryDataset(d.id, d.source!, d.request!, state.filterValues as Record<string, unknown>));
          base = toFrame(r);
        } else if (d.from?.length) base = frames[d.from[0]];
        if (!base) throw new Error(d.from?.length ? `dataset '${d.from[0]}' is not available` : "dataset has no source");
        const out = runPipeline(base, d.pipeline as never, { datasets: frames, vars: { filters: state.filterValues, page: { id: bundle.page.id, title: bundle.page.title } } });
        out.meta = { ...(base.meta ?? {}), fetchedAt: new Date().toISOString() };
        if (latest.get(id) !== gen) return frames[id];
        frames[id] = out;
        const errors = { ...state.errors };
        delete errors[id];
        setState({ frames: { ...state.frames, [id]: out }, errors, loading: { ...state.loading, [id]: false } });
        emitEvent("dataset:loaded", { id });
        return out;
      } catch (e) {
        if (latest.get(id) !== gen) return frames[id];
        setState({ errors: { ...state.errors, [id]: (e as Error).message }, loading: { ...state.loading, [id]: false } });
        return undefined;
      }
    })();
    promises.set(id, p);
    return p;
  };
  await Promise.all([...ids].map((id) => compute(id)));
}

let firstLoadDone = false;

export async function loadAll(force = false) {
  const b = state.bundle;
  if (!b) return;
  // 1. datasets that feed filter options
  const optionIds = new Set(b.page.filters.map((f) => (!Array.isArray(f.options) && f.options ? f.options.dataset : null)).filter((x): x is string => !!x));
  if (optionIds.size) {
    await loadDatasets(optionIds, force);
    const filterOptions = optionsFromFrames(state.frames);
    setState({ filterOptions, filterValues: computeFilterValues(state.filtersRaw, filterOptions) });
  }
  // 2. everything else
  const rest = new Set(b.page.datasets.map((d) => d.id).filter((id) => !optionIds.has(id)));
  await loadDatasets(rest, force);
  if (!firstLoadDone) {
    firstLoadDone = true;
    emitEvent("page:dataLoaded");
    await runScripts("page:dataLoaded");
    startIntervals();
    setTimeout(() => {
      send({ type: "ready", errors: state.errors });
      document.body.dataset.ready = "1";
    }, 900);
  } else emitEvent("page:dataLoaded");
}

export async function setFilters(raw: Record<string, unknown>, changed?: string[]) {
  const before = state.filtersRaw;
  const ids = changed ?? Object.keys({ ...before, ...raw }).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(raw[k]));
  const values = computeFilterValues(raw, state.filterOptions);
  setState({ filtersRaw: raw, filterValues: values });
  send({ type: "filtersChanged", filtersRaw: raw });
  const affected = new Set<string>();
  for (const d of state.bundle?.page.datasets ?? []) if (filterDeps(d).some((f) => ids.includes(f))) {
    affected.add(d.id);
    for (const x of dependents(d.id)) affected.add(x);
  }
  for (const id of ids) emitEvent("filter:changed", { id, value: values[id] });
  if (affected.size) await loadDatasets(affected);
  await runScripts("filter:changed");
}

/* ───────────── lifecycle ───────────── */

export async function init(msg: { bundle: PageBundle; config: RuntimeConfig; filters?: Record<string, unknown>; mode: RuntimeMode; colorMode: "auto" | "light" | "dark"; localModules?: Record<string, LocalModuleSource>; selected?: string | null }) {
  const mode = resolveMode(msg.colorMode, msg.bundle.page);
  const theme = buildTheme(msg.config.theme, mode, msg.bundle.page);
  applyTheme(theme);
  setState({ bundle: msg.bundle, config: msg.config, mode: msg.mode, colorMode: msg.colorMode, theme, filtersRaw: msg.filters ?? {}, selected: msg.selected ?? null });
  const skills = await loadClientSkills(msg.config);
  const code = await loadCode(msg.bundle, msg.localModules, skills.widgets);
  setState({
    widgets: code?.widgets ?? skills.widgets,
    filterUIs: skills.filterUIs,
    componentErrors: code?.componentErrors ?? {},
    scriptErrors: code?.scriptErrors ?? {},
    moduleErrors: code?.moduleErrors ?? {},
    filterValues: computeFilterValues(state.filtersRaw, optionsFromFrames({})),
    filterOptions: optionsFromFrames({}),
    initialized: true,
  });
  emitEvent("page:init");
  await runScripts("page:init");
  await loadAll();
}

/** A new version of the bundle (editor): keep filter state, reload only what changed. */
export async function update(bundle: PageBundle, localModules?: Record<string, LocalModuleSource>) {
  const prev = state.bundle;
  const theme = buildTheme(state.config!.theme, resolveMode(state.colorMode, bundle.page), bundle.page);
  applyTheme(theme);
  // keep only raw filter values whose filter still exists
  const filtersRaw = Object.fromEntries(Object.entries(state.filtersRaw).filter(([k]) => bundle.page.filters.some((f) => f.id === k)));
  setState({ bundle, theme, filtersRaw });
  const skills = { widgets: new Map([...state.widgets].filter(([t]) => !t.startsWith("custom."))) };
  const code = await loadCode(bundle, localModules, skills.widgets);
  if (code) {
    firstLoadDone = false;
    setState({ widgets: code.widgets, componentErrors: code.componentErrors, scriptErrors: code.scriptErrors, moduleErrors: code.moduleErrors });
  }
  const changed = new Set<string>();
  const prevById = new Map((prev?.page.datasets ?? []).map((d) => [d.id, JSON.stringify(d)]));
  for (const d of bundle.page.datasets) if (prevById.get(d.id) !== JSON.stringify(d)) {
    changed.add(d.id);
    for (const x of dependents(d.id)) changed.add(x);
  }
  const filtersChanged = JSON.stringify(prev?.page.filters) !== JSON.stringify(bundle.page.filters);
  // drop frames of removed datasets
  const ids = new Set(bundle.page.datasets.map((d) => d.id));
  setState({ frames: Object.fromEntries(Object.entries(state.frames).filter(([k]) => ids.has(k))) });
  if (filtersChanged || code) {
    await loadAll(true);
    return;
  }
  setState({ filterValues: computeFilterValues(state.filtersRaw, state.filterOptions) });
  if (changed.size) await loadDatasets(changed, true);
}

export function setColorMode(colorMode: "auto" | "light" | "dark") {
  const mode = resolveMode(colorMode, state.bundle?.page);
  const theme = buildTheme(state.config?.theme ?? {}, mode, state.bundle?.page);
  applyTheme(theme);
  setState({ colorMode, theme });
}

/** Evaluate a widget's visibleWhen. */
export function isVisible(w: Widget): boolean {
  if (state.hidden[w.id] === true) return false;
  if (state.hidden[w.id] === false) return true;
  if (w.hidden) return false;
  if (!w.visibleWhen) return true;
  try {
    return Boolean(evaluate(w.visibleWhen, { filters: state.filterValues, data: state.frames, page: { id: state.bundle?.page.id } }));
  } catch {
    return true;
  }
}

/** Run a widget interaction. */
export function runInteraction(w: Widget, on: string, payload: Record<string, unknown>) {
  for (const it of w.interactions ?? []) {
    if (it.on !== on) continue;
    const scope = { event: payload, row: payload.row ?? {}, value: payload.value, name: payload.name, series: payload.series, filters: state.filterValues };
    const val = it.value ? evaluate(it.value.replace(/^\s*\{\{([\s\S]*)\}\}\s*$/, "$1"), scope) : payload.value;
    switch (it.action) {
      case "setFilter": {
        if (!it.filter) break;
        const cur = JSON.stringify(state.filtersRaw[it.filter]);
        // clicking the same value again clears the filter
        const next = cur === JSON.stringify(val) ? undefined : val;
        const raw = { ...state.filtersRaw };
        if (next === undefined) delete raw[it.filter];
        else raw[it.filter] = next;
        void setFilters(raw, [it.filter]);
        break;
      }
      case "clearFilter": {
        if (!it.filter) break;
        const raw = { ...state.filtersRaw };
        delete raw[it.filter];
        void setFilters(raw, [it.filter]);
        break;
      }
      case "emit":
        emitEvent(it.event ?? `${w.id}:${on}`, payload);
        break;
      case "openUrl":
        if (typeof val === "string" && /^https?:\/\//.test(val)) window.open(val, "_blank", "noopener");
        else if (it.url && /^https?:\/\//.test(it.url)) window.open(it.url, "_blank", "noopener");
        break;
      case "showWidget":
        if (it.widget) api.widgets.show(it.widget);
        break;
      case "hideWidget":
        if (it.widget) api.widgets.hide(it.widget);
        break;
      case "toggleWidget":
        if (it.widget) (isVisible(allWidgets(state.bundle!.page.widgets).find((x) => x.id === it.widget)!) ? api.widgets.hide : api.widgets.show)(it.widget);
        break;
    }
  }
  emitEvent(`widget:${on}`, { widget: w.id, ...payload });
}
