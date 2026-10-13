/**
 * OpenAI-compatible chat completions client with streaming and function calling.
 * Works with OpenRouter (https://openrouter.ai/api) and local servers that implement
 * /v1/chat/completions: Ollama, LM Studio, vLLM, llama.cpp server, LocalAI.
 */
import { config } from "../config";
import { markKeyRejected } from "./status";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** reasoning text some providers return (not sent back) */
  reasoning?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  cost: number;
}

export interface ChatResult {
  message: ChatMessage;
  finishReason: string;
  usage: Usage;
  model: string;
}

export interface ProviderSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class ProviderError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

export function endpoint(baseUrl: string): string {
  const b = baseUrl.replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b) || /\/openai$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

export const isOpenRouter = (baseUrl: string) => /openrouter\.ai/.test(baseUrl);

export function providerSettings(projectSettings: Record<string, unknown> = {}, fast = false): ProviderSettings {
  const ai = (projectSettings.ai ?? {}) as { model?: string; fastModel?: string; baseUrl?: string };
  return {
    baseUrl: ai.baseUrl || config.ai.baseUrl,
    apiKey: config.ai.apiKey,
    model: fast ? ai.fastModel || config.ai.fastModel : ai.model || config.ai.model,
  };
}

/** Streams one chat completion. `onText` receives content deltas as they arrive. */
export async function chat(
  s: ProviderSettings,
  opts: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    maxTokens?: number;
    temperature?: number;
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    signal?: AbortSignal;
    jsonMode?: boolean;
  },
): Promise<ChatResult> {
  if (!s.apiKey && isOpenRouter(s.baseUrl)) throw new ProviderError("AI is not configured: set AI_API_KEY (OpenRouter key) in .env");
  const body: Record<string, unknown> = {
    model: s.model,
    messages: opts.messages.map(({ reasoning: _r, ...m }) => m),
    stream: true,
    max_tokens: opts.maxTokens ?? config.ai.maxTokens,
  };
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  else if (config.ai.temperature !== undefined) body.temperature = config.ai.temperature;
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = "auto";
  }
  if (opts.jsonMode) body.response_format = { type: "json_object" };
  if (isOpenRouter(s.baseUrl)) body.usage = { include: true };
  else body.stream_options = { include_usage: true };

  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
  if (s.apiKey) headers.authorization = `Bearer ${s.apiKey}`;
  if (isOpenRouter(s.baseUrl)) {
    headers["HTTP-Referer"] = config.webOrigin;
    headers["X-Title"] = "AI BI";
  }

  let attempt = 0;
  for (;;) {
    attempt++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), config.ai.timeoutMs);
    const onAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(endpoint(s.baseUrl), { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < 3) {
          await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
          continue;
        }
        if (res.status === 401 || res.status === 403) markKeyRejected(s, res.status);
        throw new ProviderError(`AI provider returned HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
      }
      return await readStream(res.body, s.model, opts.onText, opts.onReasoning);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if ((e as Error).name === "AbortError") throw new ProviderError(opts.signal?.aborted ? "cancelled" : `AI request timed out after ${config.ai.timeoutMs / 1000}s`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      throw new ProviderError(`AI provider unreachable at ${endpoint(s.baseUrl)}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function readStream(stream: ReadableStream<Uint8Array>, model: string, onText?: (d: string) => void, onReasoning?: (d: string) => void): Promise<ChatResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  let usedModel = model;
  const usage: Usage = { promptTokens: 0, completionTokens: 0, cost: 0 };
  const calls: { id: string; name: string; args: string }[] = [];

  const handle = (data: string) => {
    if (data === "[DONE]") return;
    let j: {
      model?: string;
      error?: { message?: string };
      choices?: { delta?: { content?: string | null; reasoning?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null; message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };
    try {
      j = JSON.parse(data);
    } catch {
      return;
    }
    if (j.error) throw new ProviderError(`AI provider error: ${j.error.message ?? JSON.stringify(j.error)}`);
    if (j.model) usedModel = j.model;
    if (j.usage) {
      usage.promptTokens = j.usage.prompt_tokens ?? usage.promptTokens;
      usage.completionTokens = j.usage.completion_tokens ?? usage.completionTokens;
      usage.cost = j.usage.cost ?? usage.cost;
    }
    for (const ch of j.choices ?? []) {
      const d = ch.delta;
      if (d?.content) {
        content += d.content;
        onText?.(d.content);
      }
      if (d?.reasoning) {
        reasoning += d.reasoning;
        onReasoning?.(d.reasoning);
      }
      for (const tc of d?.tool_calls ?? []) {
        const idx = tc.index ?? calls.length;
        if (!calls[idx]) calls[idx] = { id: tc.id ?? `call_${idx}_${Date.now()}`, name: "", args: "" };
        if (tc.id) calls[idx].id = tc.id;
        if (tc.function?.name) calls[idx].name += tc.function.name;
        if (tc.function?.arguments) calls[idx].args += tc.function.arguments;
      }
      if (ch.finish_reason) finishReason = ch.finish_reason;
      // some servers send a final non-delta message
      if (!d && ch.message?.content) {
        content += ch.message.content;
        onText?.(ch.message.content);
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trimEnd();
      buf = buf.slice(idx + 1);
      if (!line || line.startsWith(":")) continue;
      if (line.startsWith("data:")) handle(line.slice(5).trim());
    }
  }
  if (buf.trim().startsWith("data:")) handle(buf.trim().slice(5).trim());

  const toolCalls: ToolCall[] = calls.filter(Boolean).filter((c) => c.name).map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
  const message: ChatMessage = { role: "assistant", content: content || (toolCalls.length ? null : ""), reasoning: reasoning || undefined };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { message, finishReason: toolCalls.length ? "tool_calls" : finishReason, usage, model: usedModel };
}

/** Non-streaming convenience for short helper calls. */
export async function complete(s: ProviderSettings, messages: ChatMessage[], maxTokens = 2000): Promise<{ text: string; usage: Usage; model: string }> {
  const r = await chat(s, { messages, maxTokens });
  return { text: typeof r.message.content === "string" ? r.message.content : "", usage: r.usage, model: r.model };
}
