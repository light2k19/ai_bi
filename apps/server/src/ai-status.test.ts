import { describe, expect, it, afterAll } from "vitest";
import http from "node:http";
import { providerStatus, markKeyRejected, resetAiStatus } from "./ai/status";

/** A fake OpenAI-compatible server: accepts one key, rejects every other. */
const server = http.createServer((req, res) => {
  const ok = req.headers.authorization === "Bearer good";
  res.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  res.end(JSON.stringify(ok ? { data: [] } : { error: { message: "invalid key" } }));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
afterAll(() => server.close());

describe("AI availability", () => {
  it("is off without a key for OpenRouter, with a rejected key, or an unreachable provider", async () => {
    resetAiStatus();
    expect(await providerStatus({ baseUrl: "https://openrouter.ai/api", apiKey: "", model: "m" })).toMatchObject({ available: false, reason: "not-configured" });
    expect(await providerStatus({ baseUrl: base, apiKey: "bad", model: "m" })).toMatchObject({ available: false, reason: "invalid-key" });
    expect(await providerStatus({ baseUrl: base, apiKey: "good", model: "m" })).toMatchObject({ available: true });
    expect(await providerStatus({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", model: "m" })).toMatchObject({ available: false, reason: "unreachable" });
  });

  it("switches off at once when a request is rejected for its key, and the result is cached", async () => {
    resetAiStatus();
    const s = { baseUrl: base, apiKey: "good", model: "m" };
    expect((await providerStatus(s)).available).toBe(true);
    markKeyRejected(s, 401);
    expect(await providerStatus(s)).toMatchObject({ available: false, reason: "invalid-key" });
  });
});
