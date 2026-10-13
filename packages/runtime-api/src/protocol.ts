/**
 * postMessage protocol between the host app and the sandboxed page runtime (separate origin).
 * The runtime never holds credentials: every query goes through the host, which calls the API.
 */
import type { PageBundle, Catalogue, Grid } from "@aibi/page-spec";
import type { QueryResult } from "@aibi/transforms";
import type { ThemeTokens } from "./index";

export const PROTOCOL = "aibi-runtime/1";

export interface ClientSkillRef {
  id: string;
  version: string;
  builtin: boolean;
  url?: string;
}

export interface RuntimeConfig {
  catalogue: Catalogue;
  clientSkills: ClientSkillRef[];
  /** theme skill capabilities: { light: tokens, dark: tokens, palette } */
  theme: Record<string, unknown>;
  embedHosts: string[];
  apiUrl: string;
  locale?: string;
  currency?: string;
}

/** Source code of modules that exist only locally (browser storage), keyed by module name. */
export interface LocalModuleSource {
  entry: string;
  files: Record<string, string>;
}

export type RuntimeMode = "view" | "edit" | "render";

export type HostToRuntime =
  | {
      type: "init";
      bundle: PageBundle;
      config: RuntimeConfig;
      filters?: Record<string, unknown>;
      mode: RuntimeMode;
      colorMode: "auto" | "light" | "dark";
      localModules?: Record<string, LocalModuleSource>;
      selected?: string | null;
    }
  | { type: "update"; bundle: PageBundle; localModules?: Record<string, LocalModuleSource> }
  | { type: "setFilters"; filters: Record<string, unknown> }
  | { type: "setMode"; mode: RuntimeMode }
  | { type: "setColorMode"; colorMode: "auto" | "light" | "dark" }
  | { type: "select"; widgetId: string | null }
  | { type: "queryResult"; reqId: string; result?: QueryResult; error?: string }
  | { type: "aiResult"; reqId: string; text?: string; error?: string }
  | { type: "command"; name: "refresh" | "print" | "getState" | "runScript"; args?: Record<string, unknown> };

export interface DatasetSummary {
  id: string;
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  totalRows: number;
  error?: string;
}

export type RuntimeToHost =
  | { type: "hello" }
  | { type: "query"; reqId: string; datasetId: string; source: string; request: Record<string, unknown>; filters: Record<string, unknown> }
  | { type: "ai"; reqId: string; kind: "narrative" | "ask"; widgetId?: string; prompt: string; datasets: DatasetSummary[]; maxWords?: number; refresh?: boolean; filters: Record<string, unknown> }
  | { type: "state"; filtersRaw: Record<string, unknown>; filterValues: Record<string, unknown>; datasets: DatasetSummary[] }
  | { type: "ready"; errors: Record<string, string> }
  | { type: "layout"; grids: Record<string, Grid> }
  | { type: "selected"; widgetId: string | null }
  | { type: "filtersChanged"; filtersRaw: Record<string, unknown> }
  | { type: "askWidget"; widgetId: string; title?: string; widgetType: string; props?: Record<string, unknown>; dataset?: DatasetSummary }
  | { type: "event"; name: string; payload?: unknown }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; source?: string }
  | { type: "height"; height: number };

export type Envelope<T> = T & { protocol: typeof PROTOCOL };
