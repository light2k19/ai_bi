import { PageBundle, validatePage, formatIssues, type PageBundleInput } from "@aibi/page-spec";
import { config } from "../config";
import { all, get, run, now, json, parse } from "../db";
import { newId, sha256 } from "../lib/crypto";
import { RateLimiter } from "../lib/cache";
import { tooMany, badRequest, notFound } from "../lib/errors";
import { catalogueFor, projectSettings } from "../skills/registry";
import type { User, Role } from "../services/access";
import { computeDatasets } from "../services/compute";
import { chat, providerSettings, ProviderError, type ChatMessage, type Usage } from "./provider";
import { systemPrompt } from "./prompts";
import { aiStatusFor } from "./status";
import { toolSpecs, runTool, MUTATING_TOOLS, type ToolEnv } from "./tools";

export type ChatEvent =
  | { type: "session"; sessionId: string }
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_end"; id: string; name: string; result: string; ok: boolean }
  | { type: "draft"; draft: PageBundle }
  | { type: "validation"; errors: { path: string; message: string }[]; warnings: { path: string; message: string }[] }
  | { type: "usage"; usage: Usage & { model: string } }
  | { type: "done"; sessionId: string; draft: PageBundle; text: string; changed: boolean }
  | { type: "error"; message: string };

const limiter = new RateLimiter();

interface SessionRow {
  id: string;
  project_id: string;
  page_id: string | null;
  user_id: string;
  title: string | null;
  messages: string;
  usage: string;
  created_at: string;
  updated_at: string;
}

interface SessionUsage extends Usage {
  lastDraftHash?: string;
  turns?: number;
}

export function listSessions(projectId: string, userId: string, pageId?: string) {
  return all<SessionRow>(
    `SELECT * FROM ai_sessions WHERE project_id = ? AND user_id = ? ${pageId ? "AND page_id = ?" : ""} ORDER BY updated_at DESC LIMIT 50`,
    ...(pageId ? [projectId, userId, pageId] : [projectId, userId]),
  ).map((s) => ({ id: s.id, pageId: s.page_id, title: s.title, updatedAt: s.updated_at, usage: parse(s.usage, {}) }));
}

/** Messages shaped for the chat UI (user text and assistant text, tool activity summarised). */
export function sessionTranscript(projectId: string, userId: string, sessionId: string) {
  const s = get<SessionRow>("SELECT * FROM ai_sessions WHERE id = ? AND project_id = ? AND user_id = ?", sessionId, projectId, userId);
  if (!s) throw notFound("Session not found");
  const msgs = parse<ChatMessage[]>(s.messages, []);
  const out: { role: "user" | "assistant" | "tool"; text: string; tool?: string }[] = [];
  for (const m of msgs) {
    if (m.role === "user") out.push({ role: "user", text: userVisible(typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("")) });
    else if (m.role === "assistant") {
      if (typeof m.content === "string" && m.content.trim()) out.push({ role: "assistant", text: m.content });
      for (const tc of m.tool_calls ?? []) out.push({ role: "tool", text: tc.function.arguments.slice(0, 300), tool: tc.function.name });
    }
  }
  return { id: s.id, pageId: s.page_id, title: s.title, messages: out, usage: parse(s.usage, {}) };
}

const DRAFT_OPEN = "<current_page_draft>";
const userVisible = (t: string) => {
  const i = t.indexOf(`\n\n${DRAFT_OPEN}`);
  const j = t.indexOf("\n\n<system_note>");
  const cut = [i, j].filter((x) => x >= 0);
  return cut.length ? t.slice(0, Math.min(...cut)) : t;
};

/** Shorten tool results of earlier turns so long sessions stay within context. */
function compactHistory(msgs: ChatMessage[]): ChatMessage[] {
  let lastUser = -1;
  msgs.forEach((m, i) => {
    if (m.role === "user") lastUser = i;
  });
  return msgs.map((m, i) => {
    if (i >= lastUser) return m;
    if (m.role === "tool" && typeof m.content === "string" && m.content.length > 1500) return { ...m, content: m.content.slice(0, 1500) + "\n…(truncated)" };
    if (m.role === "user" && typeof m.content === "string" && m.content.includes(DRAFT_OPEN)) return { ...m, content: userVisible(m.content) + "\n\n(earlier draft omitted)" };
    if (m.role === "user" && Array.isArray(m.content)) return { ...m, content: m.content.filter((p) => p.type === "text") };
    return m;
  });
}

function monthUsage(projectId: string) {
  const start = new Date();
  start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);
  return get<{ t: number; c: number }>("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t, COALESCE(SUM(cost), 0) AS c FROM ai_usage WHERE project_id = ? AND created_at >= ?", projectId, start.toISOString()) ?? { t: 0, c: 0 };
}

export async function checkAiAllowed(projectId: string, userId: string) {
  if (!limiter.check(`ai:${userId}`, config.limits.aiPerMinute)) throw tooMany("AI rate limit reached; wait a minute");
  const status = await aiStatusFor(projectId);
  if (!status.available) throw badRequest(status.message);
  const ai = (projectSettings(projectId).ai ?? {}) as { monthlyTokenBudget?: number; monthlyCostBudget?: number };
  const u = monthUsage(projectId);
  if (ai.monthlyTokenBudget && u.t >= ai.monthlyTokenBudget) throw badRequest("This project's monthly AI token budget is used up");
  if (ai.monthlyCostBudget && u.c >= ai.monthlyCostBudget) throw badRequest("This project's monthly AI cost budget is used up");
}

export function recordUsage(projectId: string, userId: string, sessionId: string | null, kind: string, model: string, u: Usage) {
  run("INSERT INTO ai_usage (project_id, user_id, session_id, kind, model, prompt_tokens, completion_tokens, cost, created_at) VALUES (?,?,?,?,?,?,?,?,?)", projectId, userId, sessionId, kind, model, u.promptTokens, u.completionTokens, u.cost, now());
}

function extractJsonBlock(text: string): unknown | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/g;
  let best: string | null = null;
  for (const m of text.matchAll(fence)) if (!best || m[1].length > best.length) best = m[1];
  const candidate = best ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/**
 * Run all datasets of the draft (default filters), store their real column names, and return a
 * problem report (dataset errors, validation errors, column mismatches) or null when clean.
 */
async function verifyDraft(env: ToolEnv): Promise<{ report: string | null; datasetErrors: Record<string, string> }> {
  if (!env.draft.page.datasets.length) return { report: null, datasetErrors: {} };
  const comp = await computeDatasets(env.projectId, env.user, env.draft, { kind: "ai", maxRows: 2000 });
  for (const d of env.draft.page.datasets) {
    const f = comp.frames[d.id];
    if (f) d.columns = f.columns.map((c) => c.name);
  }
  const v = validatePage(env.draft, { catalogue: env.catalogue });
  const lines: string[] = [];
  for (const [id, e] of Object.entries(comp.errors)) lines.push(`ERROR dataset ${id}: ${e}`);
  for (const e of v.errors) lines.push(`ERROR ${e.path}: ${e.message}`);
  for (const w of v.warnings) if (/column '/.test(w.message)) lines.push(`WARN ${w.path}: ${w.message}`);
  for (const d of env.draft.page.datasets) {
    const f = comp.frames[d.id];
    if (f && !f.rows.length) lines.push(`WARN dataset ${d.id} returned 0 rows with the default filters; check the SQL conditions and filter bindings`);
  }
  // widgets whose column props are written as bindings instead of column names
  for (const w of v.bundle ? v.bundle.page.widgets : []) {
    const s = JSON.stringify(w.props ?? {});
    if (/"(value|x|series|name|key)":"\{\{\s*row\./.test(s)) lines.push(`WARN widget ${w.id}: column props take plain column names (e.g. "value": "revenue"), not bindings like "{{row.revenue}}"`);
  }
  if (!lines.length) return { report: null, datasetErrors: comp.errors };
  const cols = Object.entries(comp.frames).map(([id, f]) => `${id}(${f.columns.map((c) => c.name).join(", ")})`).join("; ");
  return { report: `${lines.join("\n")}\nColumns of working datasets: ${cols}`, datasetErrors: comp.errors };
}

export interface BuildTurnInput {
  projectId: string;
  user: User;
  role: Role;
  sessionId?: string;
  pageId?: string;
  message: string;
  draft: PageBundleInput;
  emit: (e: ChatEvent) => void;
  signal?: AbortSignal;
  renderPreview?: ToolEnv["renderPreview"];
}

export async function runBuildTurn(input: BuildTurnInput): Promise<void> {
  const { projectId, user, emit } = input;
  await checkAiAllowed(projectId, user.id);
  const draftParsed = PageBundle.safeParse(input.draft);
  if (!draftParsed.success) throw badRequest("The draft sent with the message is not a valid page bundle");
  const draft = draftParsed.data;

  // session
  let session: SessionRow | undefined = input.sessionId ? get<SessionRow>("SELECT * FROM ai_sessions WHERE id = ? AND project_id = ? AND user_id = ?", input.sessionId, projectId, user.id) : undefined;
  if (!session) {
    const id = newId("ai");
    run("INSERT INTO ai_sessions (id, project_id, page_id, user_id, title, messages, usage, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)", id, projectId, input.pageId ?? null, user.id, input.message.slice(0, 80), "[]", "{}", now(), now());
    session = get<SessionRow>("SELECT * FROM ai_sessions WHERE id = ?", id)!;
  }
  emit({ type: "session", sessionId: session.id });
  const history = parse<ChatMessage[]>(session.messages, []);
  const sUsage = parse<SessionUsage>(session.usage, { promptTokens: 0, completionTokens: 0, cost: 0 });

  const catalogue = catalogueFor(projectId);
  const settings = providerSettings(projectSettings(projectId));
  const mode = ((projectSettings(projectId).ai as { toolMode?: "native" | "json" } | undefined)?.toolMode ?? config.ai.toolMode) as "native" | "json";
  const system: ChatMessage = { role: "system", content: systemPrompt(projectId, catalogue, mode) };

  const draftJson = JSON.stringify({ ...draft, assets: Object.fromEntries(Object.entries(draft.assets).map(([k, v]) => [k, v.length > 200 ? `(${v.length} chars)` : v])) });
  const draftHash = sha256(draftJson);
  let userText = input.message;
  const isEmpty = !draft.page.datasets.length && !draft.page.widgets.length;
  if (draftHash !== sUsage.lastDraftHash) {
    userText += isEmpty
      ? `\n\n<system_note>The page is currently empty (id ${draft.page.id}, title "${draft.page.title}"). Build it.</system_note>`
      : `\n\n${DRAFT_OPEN}\n${draftJson}\n</current_page_draft>`;
  }
  const turnMessages: ChatMessage[] = [{ role: "user", content: userText }];
  const env: ToolEnv = { projectId, user, role: input.role, catalogue, draft, dirty: false, renderPreview: input.renderPreview };
  const total: Usage = { promptTokens: 0, completionTokens: 0, cost: 0 };
  let finalText = "";
  let changed = false;
  let verifyRounds = 0;
  let nudges = 0;
  let model = settings.model;

  const addUsage = (u: Usage, m: string) => {
    total.promptTokens += u.promptTokens;
    total.completionTokens += u.completionTokens;
    total.cost += u.cost;
    model = m;
    recordUsage(projectId, user.id, session!.id, "build", m, u);
  };

  try {
    if (mode === "native") {
      const tools = toolSpecs({ withPreview: !!input.renderPreview });
      for (let round = 0; round < config.ai.maxToolRounds; round++) {
        if (input.signal?.aborted) throw new ProviderError("cancelled");
        const res = await chat(settings, {
          messages: [system, ...compactHistory(history), ...turnMessages],
          tools,
          onText: (d) => emit({ type: "text", delta: d }),
          onReasoning: (d) => emit({ type: "reasoning", delta: d }),
          signal: input.signal,
        });
        addUsage(res.usage, res.model);
        turnMessages.push(res.message);
        if (typeof res.message.content === "string" && res.message.content.trim()) finalText = res.message.content;
        const calls = res.message.tool_calls ?? [];
        if (!calls.length) {
          if (res.finishReason === "length") emit({ type: "text", delta: "\n\n(The response hit the output limit.)" });
          // the model announced work it did not do, or left a build request with no widgets: nudge it (twice at most)
          const lastText = typeof res.message.content === "string" ? res.message.content : "";
          const promised = /\b(I will|I'll|let me|I am going to|I'm going to)\b[^.]{0,80}\b(now|fix|correct|create|add|update|build|retry)\b/i.test(lastText.slice(-400));
          const noWidgets = env.draft.page.widgets.length === 0 && (changed || isEmpty);
          if ((promised || noWidgets) && nudges < 2) {
            nudges++;
            turnMessages.push({
              role: "user",
              content: noWidgets
                ? "<system_note>The page still has no widgets. Build it now with the tools (datasets, widgets, filters) instead of describing it, then summarise.</system_note>"
                : "<system_note>Carry out what you just described now, using the tools. Do not stop until the work is done, then summarise.</system_note>",
            });
            continue;
          }
          // auto-verify: run every dataset, record real columns, and send problems back for another round
          if (changed && verifyRounds < 2) {
            verifyRounds++;
            const problems = (await verifyDraft(env)).report;
            if (problems) {
              emit({ type: "tool_start", id: `verify_${verifyRounds}`, name: "auto_verify", args: "" });
              emit({ type: "tool_end", id: `verify_${verifyRounds}`, name: "auto_verify", result: problems.slice(0, 4000), ok: false });
              emit({ type: "draft", draft: env.draft });
              turnMessages.push({ role: "user", content: `<system_note>The system ran every dataset of the draft and validated it. Fix these problems with the tools, then reply with your summary again:\n${problems}</system_note>` });
              continue;
            }
          }
          break;
        }
        const images: string[] = [];
        // run calls in the order given; consecutive read-only calls run in parallel
        const results = new Map<string, string>();
        for (const c of calls) emit({ type: "tool_start", id: c.id, name: c.function.name, args: c.function.arguments.slice(0, 2000) });
        const exec = async (c: (typeof calls)[number]) => {
          const r = await runTool(c.function.name, c.function.arguments, env);
          results.set(c.id, r.text);
          if (r.image) images.push(r.image);
          emit({ type: "tool_end", id: c.id, name: c.function.name, result: r.text.slice(0, 4000), ok: !r.text.startsWith("ERROR") });
        };
        for (let k = 0; k < calls.length; ) {
          if (MUTATING_TOOLS.has(calls[k].function.name)) {
            await exec(calls[k++]);
            continue;
          }
          const group: (typeof calls)[number][] = [];
          while (k < calls.length && !MUTATING_TOOLS.has(calls[k].function.name)) group.push(calls[k++]);
          await Promise.all(group.map(exec));
        }
        for (const c of calls) turnMessages.push({ role: "tool", tool_call_id: c.id, name: c.function.name, content: (results.get(c.id) ?? "").slice(0, 30_000) });
        if (images.length) turnMessages.push({ role: "user", content: [{ type: "text", text: "Screenshot of the rendered draft:" }, ...images.map((url) => ({ type: "image_url" as const, image_url: { url } }))] });
        if (env.dirty) {
          changed = true;
          env.dirty = false;
          emit({ type: "draft", draft: env.draft });
        }
      }
    } else {
      // JSON mode: the model returns a whole bundle; the server validates and runs datasets, feeding errors back.
      for (let round = 0; round < 4; round++) {
        const res = await chat(settings, { messages: [system, ...compactHistory(history), ...turnMessages], onText: (d) => emit({ type: "text", delta: d }), signal: input.signal });
        addUsage(res.usage, res.model);
        turnMessages.push(res.message);
        const text = typeof res.message.content === "string" ? res.message.content : "";
        finalText = text.replace(/```(?:json)?[\s\S]*?```/g, "").trim() || finalText;
        const obj = extractJsonBlock(text);
        if (!obj) break; // a plain answer, no page change
        const parsed = PageBundle.safeParse(obj);
        if (!parsed.success) {
          turnMessages.push({ role: "user", content: `The JSON is not a valid page bundle: ${parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}. Send the corrected complete bundle.` });
          continue;
        }
        parsed.data.page.id = draft.page.id;
        env.draft = parsed.data;
        changed = true;
        emit({ type: "draft", draft: env.draft });
        const v = validatePage(env.draft, { catalogue });
        const comp = await computeDatasets(projectId, user, env.draft, { kind: "ai", maxRows: 500 });
        for (const [id, f] of Object.entries(comp.frames)) {
          const d = env.draft.page.datasets.find((x) => x.id === id);
          if (d) d.columns = f.columns.map((c) => c.name);
        }
        const problems = [...v.errors.map((e) => `ERROR ${e.path}: ${e.message}`), ...Object.entries(comp.errors).map(([id, e]) => `ERROR dataset ${id}: ${e}`)];
        if (!problems.length) break;
        turnMessages.push({ role: "user", content: `The system checked your page and found problems:\n${problems.join("\n")}\nColumns returned by working datasets: ${Object.entries(comp.frames).map(([id, f]) => `${id}(${f.columns.map((c) => c.name).join(", ")})`).join("; ")}\nSend the corrected complete bundle.` });
      }
    }
  } catch (e) {
    persist();
    const msg = e instanceof ProviderError ? e.message : `AI error: ${(e as Error).message}`;
    emit({ type: "error", message: msg });
    return;
  }

  function persist() {
    const usage: SessionUsage = {
      promptTokens: sUsage.promptTokens + total.promptTokens,
      completionTokens: sUsage.completionTokens + total.completionTokens,
      cost: sUsage.cost + total.cost,
      lastDraftHash: sha256(JSON.stringify({ ...env.draft, assets: Object.fromEntries(Object.entries(env.draft.assets).map(([k, v]) => [k, v.length > 200 ? `(${v.length} chars)` : v])) })),
      turns: (sUsage.turns ?? 0) + 1,
    };
    // keep stored history bounded
    let msgs = [...history, ...turnMessages];
    if (msgs.length > 400) msgs = msgs.slice(msgs.length - 400);
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    run("UPDATE ai_sessions SET messages = ?, usage = ?, page_id = COALESCE(page_id, ?), updated_at = ? WHERE id = ?", json(msgs), json(usage), input.pageId ?? null, now(), session!.id);
  }
  persist();

  // final check includes running the datasets, so "valid" means the page actually loads
  const final = changed ? await verifyDraft(env).catch(() => ({ report: null, datasetErrors: {} as Record<string, string> })) : { report: null, datasetErrors: {} as Record<string, string> };
  const v = validatePage(env.draft, { catalogue });
  if (v.bundle) env.draft.page.requires = v.bundle.page.requires;
  const datasetIssues = Object.entries(final.datasetErrors).map(([id, message]) => ({ path: `datasets.${id}`, message: `fails to load: ${message}` }));
  emit({ type: "validation", errors: [...v.errors, ...datasetIssues], warnings: v.warnings });
  emit({ type: "usage", usage: { ...total, model } });
  emit({ type: "done", sessionId: session.id, draft: env.draft, text: finalText, changed });
}

export { formatIssues };
