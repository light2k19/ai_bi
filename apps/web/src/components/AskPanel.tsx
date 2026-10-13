import { useEffect, useRef, useState } from "react";
import { Send, Sparkles, X } from "lucide-react";
import type { PageBundle } from "@aibi/page-spec";
import type { DatasetSummary } from "@aibi/runtime-api/protocol";
import { stream } from "../lib/api";
import { Markdown } from "./Markdown";
import { Button, IconButton, Textarea } from "./ui";
import type { RuntimeState } from "./RuntimeFrame";

export interface AskContext {
  widgetId: string;
  title?: string;
  widgetType: string;
  props?: Record<string, unknown>;
  dataset?: DatasetSummary;
}

interface Msg {
  role: "user" | "assistant";
  text: string;
  error?: boolean;
}

const SUGGESTIONS = ["Summarise this page in 3 bullet points", "What changed versus last year, and why?", "Which items are below target?", "What should I look at first?"];

export function AskPanel({ slug, bundle, getState, context, onClose }: { slug: string; bundle: PageBundle; getState: () => Promise<RuntimeState>; context: AskContext | null; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);
  useEffect(() => () => abort.current?.abort(), []);

  const ask = async (question: string) => {
    if (!question.trim() || busy) return;
    setQ("");
    setBusy(true);
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text }));
    setMsgs((m) => [...m, { role: "user", text: question }, { role: "assistant", text: "" }]);
    abort.current = new AbortController();
    try {
      const st = await getState();
      const datasets = context?.dataset ? [context.dataset] : st.datasets.map((d) => ({ ...d, rows: d.rows.slice(0, 150) }));
      await stream(
        `/projects/${slug}/ai/ask`,
        {
          question,
          page: { title: bundle.page.title, description: bundle.page.description, filters: st.filterValues },
          bundle,
          datasets,
          widget: context ? { id: context.widgetId, type: context.widgetType, title: context.title, props: context.props } : undefined,
          history,
        },
        (e) => {
          if (e.type === "text") setMsgs((m) => [...m.slice(0, -1), { role: "assistant", text: m[m.length - 1].text + String(e.delta) }]);
          if (e.type === "error") setMsgs((m) => [...m.slice(0, -1), { role: "assistant", text: String(e.message), error: true }]);
        },
        abort.current.signal,
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") setMsgs((m) => [...m.slice(0, -1), { role: "assistant", text: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="flex h-full w-full flex-col border-l border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <Sparkles className="size-4 text-accent" />
        <div className="flex-1">
          <div className="text-[14px] font-semibold">Ask about this page</div>
          {context && <div className="truncate text-xs text-muted">About: {context.title ?? context.widgetId}</div>}
        </div>
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {msgs.length === 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-muted">Answers use the data currently shown on the page, with your filters.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => void ask(s)} className="rounded-lg border border-line px-3 py-2 text-left text-[13px] hover:border-accent/50 hover:bg-surface2">
                {s}
              </button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-3">
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="self-end rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-[13px] text-white">
                {m.text}
              </div>
            ) : (
              <div key={i} className={`rounded-2xl rounded-bl-sm border px-3 py-2 text-[13px] ${m.error ? "border-danger/30 text-danger" : "border-line bg-surface2"}`}>
                {m.text ? <Markdown text={m.text} /> : <div className="skeleton h-4 w-40" />}
              </div>
            ),
          )}
        </div>
        <div ref={end} />
      </div>
      <form
        className="flex items-end gap-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <Textarea
          rows={2}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Ask a question…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask(q);
            }
          }}
        />
        <Button variant="primary" type="submit" loading={busy} disabled={!q.trim()} aria-label="Send">
          <Send className="size-4" />
        </Button>
      </form>
    </aside>
  );
}
