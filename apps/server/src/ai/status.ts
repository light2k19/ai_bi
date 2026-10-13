/**
 * Is the AI usable? The server's provider must be configured with a key that it accepts (checked with a cheap
 * probe, cached for five minutes, a failure re-checked after a minute, and a request rejected for its key
 * flips it immediately), and the project's admin must not have turned AI off. Everything AI-related in the
 * web app hides itself while this says no, and every AI route refuses.
 */
import { sha256 } from "../lib/crypto";
import { projectSettings } from "../skills/registry";
import { endpoint, isOpenRouter, providerSettings, type ProviderSettings } from "./provider";

export type AiReason = "not-configured" | "invalid-key" | "unreachable" | "disabled";
export interface AiStatus {
  available: boolean;
  reason?: AiReason;
  message: string;
}

const cache = new Map<string, { at: number; status: AiStatus }>();
const OK_TTL = 5 * 60_000;
const FAIL_TTL = 60_000;
const cacheKey = (s: ProviderSettings) => `${s.baseUrl}|${sha256(s.apiKey)}`;
const hostOf = (s: ProviderSettings) => {
  try {
    return new URL(endpoint(s.baseUrl)).host;
  } catch {
    return s.baseUrl;
  }
};

export async function providerStatus(s: ProviderSettings): Promise<AiStatus> {
  if (!s.apiKey && isOpenRouter(s.baseUrl)) return { available: false, reason: "not-configured", message: "AI is not configured on this server: set AI_API_KEY in .env" };
  const hit = cache.get(cacheKey(s));
  if (hit && Date.now() - hit.at < (hit.status.available ? OK_TTL : FAIL_TTL)) return hit.status;
  const status = await probe(s);
  cache.set(cacheKey(s), { at: Date.now(), status });
  return status;
}

async function probe(s: ProviderSettings): Promise<AiStatus> {
  const v1 = endpoint(s.baseUrl).replace(/\/chat\/completions$/, "");
  // OpenRouter answers 401 for a bad key on its key endpoint; other OpenAI-compatible servers on the model list
  const url = isOpenRouter(s.baseUrl) ? `${v1}/auth/key` : `${v1}/models`;
  const headers: Record<string, string> = s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {};
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) return rejected(s, res.status);
    // any other answer means the server is there; a local model server may not expose this endpoint at all
    return { available: true, message: `AI available (${s.model} at ${hostOf(s)})` };
  } catch (e) {
    return { available: false, reason: "unreachable", message: `AI provider unreachable at ${hostOf(s)}: ${(e as Error).message}` };
  }
}

const rejected = (s: ProviderSettings, status: number): AiStatus => ({ available: false, reason: "invalid-key", message: `The AI API key is rejected by ${hostOf(s)} (HTTP ${status}): check AI_API_KEY` });

/** The provider refused a request for its key: AI is off until a later probe accepts the key again. */
export function markKeyRejected(s: ProviderSettings, status: number) {
  cache.set(cacheKey(s), { at: Date.now(), status: rejected(s, status) });
}

/** Status for one project: the server's provider (with the project's own base URL when set) and the project toggle. */
export async function aiStatusFor(projectId: string): Promise<AiStatus & { enabled: boolean }> {
  const ps = projectSettings(projectId);
  const enabled = (ps.ai as { enabled?: boolean } | undefined)?.enabled !== false;
  const st = await providerStatus(providerSettings(ps));
  if (!st.available) return { ...st, enabled };
  if (!enabled) return { available: false, reason: "disabled", message: "AI is turned off for this project by its admin", enabled };
  return { ...st, enabled };
}

/** For tests: forget probe results. */
export const resetAiStatus = () => cache.clear();
