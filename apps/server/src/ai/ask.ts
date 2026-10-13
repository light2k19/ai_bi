import { get, run, now } from "../db";
import { sha256 } from "../lib/crypto";
import { catalogueFor, projectSettings } from "../skills/registry";
import { PageBundle } from "@aibi/page-spec";
import type { User, Role } from "../services/access";
import { roleAtLeast } from "../services/access";
import { chat, providerSettings, ProviderError, type ChatMessage } from "./provider";
import { ASK_SYSTEM, sourcesSection } from "./prompts";
import { toolSpecs, runTool, type ToolEnv } from "./tools";
import { checkAiAllowed, recordUsage } from "./orchestrator";

export interface AskDataset {
  id: string;
  columns: { name: string; type: string }[];
  rows: Record<string, unknown>[];
  totalRows?: number;
}

export interface AskInput {
  projectId: string;
  user: User;
  role: Role;
  question: string;
  page?: { title: string; description?: string; filters?: Record<string, unknown> };
  bundle?: unknown;
  datasets: AskDataset[];
  widget?: { id: string; type: string; title?: string; props?: Record<string, unknown> };
  history?: { role: "user" | "assistant"; text: string }[];
  maxWords?: number;
  /** narrative widgets: `<page>:<widget>`; the answer is stored for this exact data and filter state */
  cacheKey?: string;
  /** the page the commentary belongs to: editing the page clears it */
  pageId?: string | null;
  /** regenerate: skip the stored text and replace it with a new one */
  refresh?: boolean;
  onText?: (d: string) => void;
  signal?: AbortSignal;
}

function datasetText(d: AskDataset, maxRows = 60) {
  const head = d.columns.map((c) => c.name);
  const rows = d.rows.slice(0, maxRows).map((r) => head.map((h) => (r[h] === null || r[h] === undefined ? "" : typeof r[h] === "number" ? Number((r[h] as number).toPrecision(8)) : String(r[h]).slice(0, 60))).join(" | "));
  return `Dataset ${d.id} (${d.totalRows ?? d.rows.length} rows${d.rows.length > maxRows ? `, first ${maxRows} shown` : ""}):\n${head.join(" | ")}\n${rows.join("\n")}`;
}

/**
 * Answer a question about page data. Narrative widgets pass a cacheKey: their commentary is stored per user,
 * page, widget, prompt, data and filters, and reused with no time limit until one of those changes, someone
 * regenerates it, or the page is edited (see forgetCommentary).
 */
export async function askAboutPage(input: AskInput): Promise<{ text: string; cached: boolean }> {
  // cached per project and per user: with per-user data source logins two users may see different data
  const dataKey = input.cacheKey ? sha256(`${input.projectId}|${input.user.id}|${input.cacheKey}|${input.question}|${JSON.stringify(input.datasets.map((d) => [d.id, d.rows.slice(0, 200)]))}|${JSON.stringify(input.page?.filters ?? {})}`) : null;
  await checkAiAllowed(input.projectId, input.user.id);
  if (dataKey && !input.refresh) {
    const hit = get<{ text: string }>("SELECT text FROM narrative_cache WHERE key = ?", dataKey);
    if (hit) {
      run("UPDATE narrative_cache SET last_used_at = ? WHERE key = ?", now(), dataKey);
      input.onText?.(hit.text);
      return { text: hit.text, cached: true };
    }
  }
  const settings = providerSettings(projectSettings(input.projectId), true);
  const allowQueries = roleAtLeast(input.role, "builder") || (projectSettings(input.projectId).ai as { viewerQueries?: boolean } | undefined)?.viewerQueries === true;
  const ctx = [
    input.page ? `Page: ${input.page.title}${input.page.description ? ` — ${input.page.description}` : ""}` : "",
    input.page?.filters ? `Current filters: ${JSON.stringify(input.page.filters)}` : "",
    input.widget ? `The question is about widget '${input.widget.title ?? input.widget.id}' (${input.widget.type}) with props ${JSON.stringify(input.widget.props ?? {}).slice(0, 600)}` : "",
    "<page_data>",
    ...input.datasets.map((d) => datasetText(d)),
    "</page_data>",
  ]
    .filter(Boolean)
    .join("\n");
  const system = ASK_SYSTEM + (input.maxWords ? `\nAnswer in at most ${input.maxWords} words.` : "") + (allowQueries ? `\n\nYou may run read-only queries with the tools when the page data is not enough.\n\n${sourcesSection(input.projectId, catalogueFor(input.projectId), 3000)}` : "");
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    ...(input.history ?? []).slice(-10).map((h) => ({ role: h.role, content: h.text }) as ChatMessage),
    { role: "user", content: `${ctx}\n\nQuestion: ${input.question}` },
  ];
  const env: ToolEnv = {
    projectId: input.projectId,
    user: input.user,
    role: input.role,
    catalogue: catalogueFor(input.projectId),
    draft: PageBundle.safeParse(input.bundle).success ? PageBundle.parse(input.bundle) : PageBundle.parse({ page: { id: "adhoc", title: "adhoc" } }),
    dirty: false,
  };
  let text = "";
  for (let round = 0; round < 6; round++) {
    const res = await chat(settings, {
      messages,
      tools: allowQueries ? toolSpecs({ runtimeOnly: true }) : undefined,
      maxTokens: 3000,
      onText: (d) => {
        text += d;
        input.onText?.(d);
      },
      signal: input.signal,
    });
    recordUsage(input.projectId, input.user.id, null, input.cacheKey ? "narrative" : "ask", res.model, res.usage);
    messages.push(res.message);
    const calls = res.message.tool_calls ?? [];
    if (!calls.length) break;
    for (const c of calls) {
      const r = await runTool(c.function.name, c.function.arguments, env, { runtimeOnly: true });
      messages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: r.text.slice(0, 20_000) });
    }
  }
  if (!text.trim()) throw new ProviderError("The AI returned an empty answer");
  if (dataKey) {
    run("INSERT OR REPLACE INTO narrative_cache (key, text, created_at, page_id, last_used_at) VALUES (?,?,?,?,?)", dataKey, text, now(), input.pageId ?? null, now());
  }
  return { text, cached: false };
}

/** A page was edited (new version, other default, deleted): its stored commentary is written again on next view. */
export function forgetCommentary(pageId: string) {
  run("DELETE FROM narrative_cache WHERE page_id = ?", pageId);
}

/** Housekeeping: drop commentary nobody has opened for 60 days (filter combinations no one looks at any more). */
export function sweepCommentary() {
  return Number(run("DELETE FROM narrative_cache WHERE COALESCE(last_used_at, created_at) < ?", new Date(Date.now() - 60 * 86400_000).toISOString()).changes ?? 0);
}
