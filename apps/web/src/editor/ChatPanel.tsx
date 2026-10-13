import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ChevronRight, CircleAlert, History, Loader2, Send, Sparkles, Square, Undo2, Wrench } from "lucide-react";
import type { PageBundle } from "@aibi/page-spec";
import { api, stream } from "../lib/api";
import { useConfig } from "../lib/hooks";
import { Markdown } from "../components/Markdown";
import { Badge, Button, Textarea, cx } from "../components/ui";
import { useDraft } from "./draft-store";

interface ToolEntry {
  id: string;
  name: string;
  args: string;
  result?: string;
  ok?: boolean;
}
interface Turn {
  notes?: string[];
  user: string;
  text: string;
  tools: ToolEntry[];
  status: "running" | "done" | "error";
  error?: string;
  errors?: number;
  warnings?: number;
  before?: PageBundle;
  changed?: boolean;
  cost?: number;
}

const STARTERS = [
  "Build a sales overview: revenue, margin and orders KPIs vs last year, monthly trend, revenue by region and channel, top 10 products.",
  "Create a P&L page: revenue, COGS, gross margin and opex by month, budget vs actual by department with variance.",
  "Show headcount and salary cost by department over the last 12 months with a table of the biggest changes.",
  "Add a staged entrance animation: KPIs count up, then charts reveal one by one.",
];

const TOOL_LABEL: Record<string, string> = {
  list_sources: "Listing data sources",
  introspect_schema: "Reading schema",
  preview_query: "Running a query",
  preview_dataset: "Previewing dataset",
  explain_query: "Checking query plan",
  get_widget_schema: "Reading widget docs",
  get_script_docs: "Reading script docs",
  search_modules: "Searching modules",
  get_page: "Reading the page",
  set_page_meta: "Updating page settings",
  upsert_filter: "Saving filter",
  remove_filter: "Removing filter",
  upsert_dataset: "Saving dataset",
  remove_dataset: "Removing dataset",
  upsert_widget: "Saving widget",
  remove_widget: "Removing widget",
  move_widget: "Moving widget",
  upsert_component: "Saving component",
  remove_component: "Removing component",
  upsert_script: "Saving script",
  remove_script: "Removing script",
  add_module: "Adding module",
  remove_module: "Removing module",
  validate_page: "Validating",
  render_preview: "Taking a screenshot",
  auto_verify: "Checking every dataset",
};

export function ChatPanel({ slug, pageId, storageKey }: { slug: string; pageId?: string; storageKey: string }) {
  const cfg = useConfig();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(`aibi.session.${storageKey}`);
    } catch {
      return null;
    }
  });
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const running = turns.some((t) => t.status === "running");
  const sessions = useQuery({ queryKey: ["ai-sessions", slug, pageId], queryFn: () => api<{ id: string; title: string; updatedAt: string }[]>(`/projects/${slug}/ai/sessions${pageId ? `?pageId=${pageId}` : ""}`), enabled: !!pageId });

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  // load the transcript of a stored session
  useEffect(() => {
    if (!sessionId || turns.length) return;
    api<{ messages: { role: string; text: string; tool?: string }[] }>(`/projects/${slug}/ai/sessions/${sessionId}`)
      .then((s) => {
        const out: Turn[] = [];
        for (const m of s.messages) {
          if (m.role === "user") out.push({ user: m.text, text: "", tools: [], status: "done" });
          else if (out.length && m.role === "assistant") out[out.length - 1].text = m.text;
          else if (out.length && m.role === "tool") out[out.length - 1].tools.push({ id: String(Math.random()), name: m.tool ?? "tool", args: m.text, ok: true });
        }
        setTurns(out);
      })
      .catch(() => setSessionId(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const update = (fn: (t: Turn) => Turn) => setTurns((ts) => [...ts.slice(0, -1), fn(ts[ts.length - 1])]);

  const send = async (text: string) => {
    const msg = text.trim();
    const store = useDraft.getState();
    if (!msg || running || !store.draft) return;
    setInput("");
    const before = structuredClone(store.draft);
    setTurns((ts) => [...ts, { user: msg, text: "", tools: [], status: "running", before }]);
    abort.current = new AbortController();
    let firstDraft = true;
    try {
      await stream(
        `/projects/${slug}/ai/chat`,
        { message: msg, draft: store.draft, sessionId: sessionId ?? undefined, pageId },
        (e) => {
          switch (e.type) {
            case "session":
              setSessionId(String(e.sessionId));
              try {
                localStorage.setItem(`aibi.session.${storageKey}`, String(e.sessionId));
              } catch {
                /* ignore */
              }
              break;
            case "text":
              update((t) => ({ ...t, text: t.text + String(e.delta) }));
              break;
            case "tool_start":
              // text written before a tool call is narration: keep it with the steps, not as the answer
              update((t) => ({ ...t, notes: t.text.trim() ? [...(t.notes ?? []), t.text] : t.notes, text: "", tools: [...t.tools, { id: String(e.id), name: String(e.name), args: String(e.args) }] }));
              break;
            case "tool_end":
              update((t) => ({ ...t, tools: t.tools.map((x) => (x.id === e.id ? { ...x, result: String(e.result), ok: Boolean(e.ok) } : x)) }));
              break;
            case "draft":
              // one AI turn = one undo step
              useDraft.getState().set(e.draft as PageBundle, { history: firstDraft });
              firstDraft = false;
              break;
            case "validation":
              update((t) => ({ ...t, errors: (e.errors as unknown[]).length, warnings: (e.warnings as unknown[]).length }));
              break;
            case "usage":
              update((t) => ({ ...t, cost: Number((e.usage as { cost?: number }).cost ?? 0) }));
              break;
            case "done":
              if (e.changed) useDraft.getState().set(e.draft as PageBundle, { history: firstDraft });
              update((t) => ({ ...t, status: "done", changed: Boolean(e.changed), text: t.text || String(e.text ?? "") }));
              break;
            case "error":
              update((t) => ({ ...t, status: "error", error: String(e.message) }));
              break;
          }
        },
        abort.current.signal,
      );
      update((t) => (t.status === "running" ? { ...t, status: "done" } : t));
    } catch (err) {
      update((t) => ({ ...t, status: "error", error: (err as Error).name === "AbortError" ? "Stopped" : (err as Error).message }));
    }
  };

  const newSession = () => {
    setSessionId(null);
    setTurns([]);
    try {
      localStorage.removeItem(`aibi.session.${storageKey}`);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-muted">
        <Sparkles className="size-3.5 text-accent" />
        <span className="truncate">{cfg.data?.ai.model}</span>
        <div className="ml-auto flex items-center gap-1">
          {!!sessions.data?.length && (
            <select
              className="h-7 max-w-36 rounded-md border border-line bg-surface px-1 text-xs"
              value={sessionId ?? ""}
              onChange={(e) => {
                setTurns([]);
                setSessionId(e.target.value || null);
              }}
              aria-label="Conversation"
            >
              <option value="">New conversation</option>
              {sessions.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title}
                </option>
              ))}
            </select>
          )}
          <Button size="sm" variant="ghost" icon={<History className="size-3.5" />} onClick={newSession} disabled={running}>
            New chat
          </Button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {!turns.length && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted">Describe the analysis you want. The AI inspects your data sources, writes read-only queries, picks the visuals and lays out the page. Ask for changes the same way.</p>
            {STARTERS.map((s) => (
              <button key={s} onClick={() => void send(s)} className="rounded-lg border border-line px-3 py-2 text-left text-[13px] hover:border-accent/50 hover:bg-surface2">
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-4">
          {turns.map((t, i) => (
            <TurnView key={i} t={t} last={i === turns.length - 1} />
          ))}
        </div>
        <div ref={end} />
      </div>
      <form
        className="border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <Textarea
          rows={3}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. Add a waterfall of budget vs actual by department, and make the region chart filter the page on click"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          disabled={running}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-muted">Enter to send · Shift+Enter for a new line</span>
          {running ? (
            <Button size="sm" variant="secondary" icon={<Square className="size-3.5" />} onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" type="submit" icon={<Send className="size-3.5" />} disabled={!input.trim()}>
              Send
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function TurnView({ t, last }: { t: Turn; last: boolean }) {
  const [open, setOpen] = useState(false);
  const failed = t.tools.filter((x) => x.ok === false).length;
  return (
    <div className="flex flex-col gap-2">
      <div className="self-end rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-[13px] whitespace-pre-wrap text-white">{t.user}</div>
      {t.tools.length > 0 && (
        <div className="rounded-xl border border-line bg-surface2/60">
          <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted">
            {t.status === "running" ? <Loader2 className="size-3.5 animate-spin text-accent" /> : <Wrench className="size-3.5" />}
            <span className="flex-1 truncate">
              {t.status === "running" ? TOOL_LABEL[t.tools[t.tools.length - 1].name] ?? t.tools[t.tools.length - 1].name : `${t.tools.length} steps`}
              {failed > 0 && ` · ${failed} retried`}
            </span>
            <ChevronRight className={cx("size-3.5 transition", open && "rotate-90")} />
          </button>
          {open && (
            <div className="max-h-72 overflow-y-auto border-t border-line px-3 py-2">
              {(t.notes ?? []).map((n, i) => (
                <div key={`n${i}`} className="py-1 text-[11.5px] whitespace-pre-wrap text-muted italic">{n.slice(0, 600)}</div>
              ))}
              {t.tools.map((x) => (
                <div key={x.id} className="py-1 text-[11.5px]">
                  <div className="flex items-center gap-1.5">
                    {x.ok === undefined ? <Loader2 className="size-3 animate-spin" /> : x.ok ? <CheckCircle2 className="size-3 text-success" /> : <CircleAlert className="size-3 text-danger" />}
                    <span className="font-medium">{TOOL_LABEL[x.name] ?? x.name}</span>
                  </div>
                  {x.args && <div className="ml-4.5 truncate font-mono text-muted">{x.args.slice(0, 200)}</div>}
                  {x.result && <div className={cx("ml-4.5 line-clamp-3 font-mono whitespace-pre-wrap", x.ok ? "text-muted" : "text-danger")}>{x.result.slice(0, 400)}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {(t.text || t.status === "running") && (
        <div className="rounded-2xl rounded-bl-sm border border-line bg-surface px-3 py-2 text-[13px]">{t.text ? <Markdown text={t.text} /> : <div className="skeleton h-4 w-48" />}</div>
      )}
      {t.status === "error" && <div className="rounded-lg border border-danger/30 bg-danger/8 px-3 py-2 text-[13px] text-danger">{t.error}</div>}
      {t.status === "done" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          {t.changed ? <Badge tone={t.errors ? "danger" : "success"}>{t.errors ? `${t.errors} errors` : "page valid"}</Badge> : <Badge>no page changes</Badge>}
          {!!t.warnings && <Badge tone="warning">{t.warnings} warnings</Badge>}
          {t.cost ? <span>${t.cost.toFixed(4)}</span> : null}
          {last && t.changed && t.before && (
            <button className="ml-auto inline-flex items-center gap-1 text-accent hover:underline" onClick={() => useDraft.getState().set(t.before!)}>
              <Undo2 className="size-3.5" /> Undo this turn
            </button>
          )}
        </div>
      )}
    </div>
  );
}
