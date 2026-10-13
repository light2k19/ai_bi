import { defaultFilterValues, type PageBundle, type FilterValue } from "@aibi/page-spec";
import { runPipeline, toFrame, type Frame } from "@aibi/transforms";
import { runQuery } from "./gateway";
import type { User } from "./access";

export interface ComputeResult {
  frames: Record<string, Frame>;
  errors: Record<string, string>;
  filters: Record<string, FilterValue>;
}

/**
 * Evaluate datasets of a page on the server: run source queries through the gateway (read-only, limits),
 * derive `from` datasets and apply pipelines. Filters default unless raw values are given.
 */
export async function computeDatasets(
  projectId: string,
  user: User,
  bundle: PageBundle,
  opts: { rawFilters?: Record<string, unknown>; ids?: string[]; kind?: "preview" | "export" | "ai"; maxRows?: number; pageId?: string } = {},
): Promise<ComputeResult> {
  const page = bundle.page;
  const byId = new Map(page.datasets.map((d) => [d.id, d]));
  const frames: Record<string, Frame> = {};
  const errors: Record<string, string> = {};
  const inflight = new Map<string, Promise<Frame | null>>();
  let filters: Record<string, FilterValue> = defaultFilterValues(page.filters, opts.rawFilters ?? {});

  const compute = (id: string, stack: string[] = []): Promise<Frame | null> => {
    // a dataset that is already being computed further up the chain is a cycle, not a shared result
    if (stack.includes(id)) {
      errors[id] = "circular dependency";
      return Promise.resolve(null);
    }
    const existing = inflight.get(id);
    if (existing) return existing;
    const p = (async () => {
      const d = byId.get(id);
      if (!d) {
        errors[id] = "dataset not found";
        return null;
      }
      try {
        const deps = new Set<string>([...(d.from ?? []), ...(d.pipeline ?? []).map((s) => (s as { with?: unknown }).with).filter((x): x is string => typeof x === "string")]);
        const depFrames: Record<string, Frame | undefined> = {};
        for (const dep of deps) depFrames[dep] = (await compute(dep, [...stack, id])) ?? undefined;
        let base: Frame;
        if (d.source && d.request) {
          const r = await runQuery({
            projectId,
            userId: user.id,
            userEmail: user.email ?? user.login,
            alias: d.source,
            request: d.request,
            scope: { filters, page: { id: page.id, title: page.title } },
            kind: opts.kind === "export" ? "export" : opts.kind === "ai" ? "ai" : "preview",
            pageId: opts.pageId,
            ttlSeconds: d.cache?.ttlSeconds ?? 60,
            limits: opts.maxRows ? { maxRows: opts.maxRows } : undefined,
          });
          base = toFrame(r);
        } else if (d.from?.length) {
          const f = depFrames[d.from[0]];
          if (!f) throw new Error(`source dataset '${d.from[0]}' failed`);
          base = f;
        } else throw new Error("dataset has neither source nor from");
        const out = runPipeline(base, d.pipeline as never, { datasets: { ...frames, ...depFrames }, vars: { filters, page: { id: page.id, title: page.title } } });
        frames[id] = out;
        return out;
      } catch (e) {
        errors[id] = (e as Error).message;
        return null;
      }
    })();
    inflight.set(id, p);
    return p;
  };

  // datasets feeding filter options first, so multiSelect "all" has concrete values
  const optionSets = page.filters.filter((f) => f.options && !Array.isArray(f.options)).map((f) => f.options as { dataset: string; value: string });
  if (optionSets.length) {
    const opts2: Record<string, (string | number | boolean)[]> = {};
    for (const f of page.filters) {
      if (!f.options || Array.isArray(f.options)) continue;
      const o = f.options;
      const fr = await compute(o.dataset);
      if (fr) opts2[f.id] = fr.rows.map((r) => r[o.value] as string | number | boolean).filter((v) => v !== null && v !== undefined);
    }
    filters = defaultFilterValues(page.filters, opts.rawFilters ?? {}, { options: opts2 });
    // option datasets computed with provisional filters are fine (they rarely depend on filters); recompute the rest
    for (const k of Object.keys(frames)) if (!optionSets.some((o) => o.dataset === k)) delete frames[k];
    for (const k of [...inflight.keys()]) if (!optionSets.some((o) => o.dataset === k)) inflight.delete(k);
  }
  const ids = opts.ids ?? page.datasets.map((d) => d.id);
  await Promise.all(ids.map((id) => compute(id)));
  return { frames, errors, filters };
}

/** Compact text table for AI tool results. */
export function frameToText(f: Frame, maxRows = 20): string {
  const cols = f.columns.map((c) => `${c.name}:${c.type}`).join(", ");
  const head = f.columns.map((c) => c.name);
  const lines = f.rows.slice(0, maxRows).map((r) => head.map((h) => fmtCell(r[h])).join(" | "));
  return [
    `columns: ${cols}`,
    `rows: ${f.rows.length}${f.meta?.truncated ? " (truncated by row limit)" : ""}${f.meta?.durationMs !== undefined ? `, ${f.meta.durationMs} ms` : ""}`,
    head.join(" | "),
    ...lines,
    f.rows.length > maxRows ? `… ${f.rows.length - maxRows} more rows` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
