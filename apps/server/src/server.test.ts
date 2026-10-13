import { describe, it, expect, beforeAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// isolate the data directory before the config module loads
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aibi-test-"));
process.env.AIBI_DATA_DIR = tmp;
process.env.AIBI_SECRET = "test-secret";

let crypto: typeof import("./lib/crypto");
let jsondiff: typeof import("./lib/jsondiff");
let provider: typeof import("./ai/provider");
let http: typeof import("../../../skills/datasource-http/server/index");

beforeAll(async () => {
  crypto = await import("./lib/crypto");
  jsondiff = await import("./lib/jsondiff");
  provider = await import("./ai/provider");
  http = await import("../../../skills/datasource-http/server/index");
});

describe("secrets", () => {
  it("seal, open and mask nested secret paths", () => {
    const cfg = { host: "db", password: "p@ss", providers: [{ id: "a", clientSecret: "s1" }, { id: "b", clientSecret: "s2" }] };
    const sealed = crypto.sealSecrets(cfg, ["password", "providers.*.clientSecret"]);
    expect(String(sealed.password)).toMatch(/^enc:v1:/);
    expect(JSON.stringify(sealed)).not.toContain("p@ss");
    const ps = sealed.providers as { clientSecret: string }[];
    expect(ps.map((p) => p.clientSecret.startsWith("enc:v1:"))).toEqual([true, true]);
    const opened = crypto.openSecrets(sealed, ["password", "providers.*.clientSecret"]);
    expect(opened).toEqual(cfg);
    const masked = crypto.maskSecrets(sealed, ["password"]);
    expect(masked.password).toBe(crypto.MASK);
  });
  it("keeps stored secrets when the client sends the mask or nothing", () => {
    const prev = crypto.sealSecrets({ password: "old" }, ["password"]);
    const next = crypto.sealSecrets({ password: crypto.MASK, host: "x" }, ["password"], prev);
    expect(crypto.openSecrets(next, ["password"]).password).toBe("old");
    const empty = crypto.sealSecrets({ host: "x" }, ["password"], prev);
    expect(crypto.openSecrets(empty, ["password"]).password).toBe("old");
  });
  it("passwords hash and verify", () => {
    const h = crypto.hashPassword("correct horse");
    expect(crypto.verifyPassword("correct horse", h)).toBe(true);
    expect(crypto.verifyPassword("wrong", h)).toBe(false);
  });
  it("signed tokens reject tampering and expiry", async () => {
    const t = crypto.signToken({ a: 1 }, 60);
    expect(crypto.verifyToken<{ a: number }>(t)?.a).toBe(1);
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ a: 2, exp: 9e9 })).toString("base64url");
    expect(crypto.verifyToken(`${forged}.${sig}`)).toBeNull();
    // flip the first signature character to one that is guaranteed to differ
    expect(crypto.verifyToken(`${body}.${sig[0] === "x" ? "y" : "x"}${sig.slice(1)}`)).toBeNull();
    const expired = crypto.signToken({ a: 1 }, -1);
    expect(crypto.verifyToken(expired)).toBeNull();
  });
});

describe("http datasource", () => {
  it("never leaves the base URL", () => {
    const { buildUrl } = http as unknown as { buildUrl: (b: string, p: string, q?: Record<string, unknown>) => URL };
    expect(buildUrl("https://api.example.com/v1", "/sales", { from: "2026-01-01", r: ["a", "b"] }).toString()).toBe("https://api.example.com/v1/sales?from=2026-01-01&r=a&r=b");
    expect(() => buildUrl("https://api.example.com/v1", "https://evil.example/x")).toThrow();
    expect(() => buildUrl("https://api.example.com/v1", "//evil.example/x")).toThrow();
    expect(() => buildUrl("https://api.example.com/v1", "../../admin")).toThrow();
  });
  it("selects result paths", () => {
    const { selectPath } = http as unknown as { selectPath: (d: unknown, p?: string) => unknown };
    const doc = { data: { items: [{ a: 1 }] }, results: [{ rows: [1, 2] }] };
    expect(selectPath(doc, "$.data.items")).toEqual([{ a: 1 }]);
    expect(selectPath(doc, "$.results[0].rows")).toEqual([1, 2]);
    expect(selectPath(doc, "$")).toBe(doc);
  });
});

describe("AI provider", () => {
  it("resolves chat completion endpoints for OpenRouter and local servers", () => {
    expect(provider.endpoint("https://openrouter.ai/api")).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(provider.endpoint("http://localhost:11434")).toBe("http://localhost:11434/v1/chat/completions");
    expect(provider.endpoint("http://localhost:1234/v1/")).toBe("http://localhost:1234/v1/chat/completions");
    expect(provider.endpoint("http://host/v1/chat/completions")).toBe("http://host/v1/chat/completions");
  });
  it("parses a streamed tool call and text", async () => {
    const chunks = [
      `: OPENROUTER PROCESSING\n\n`,
      `data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n`,
      `data: {"choices":[{"delta":{"content":"lo"}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"list_","arguments":"{\\"a\\""}}]}}]}\n\n`,
      `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"sources","arguments":":1}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.001}}\n\n`,
      `data: [DONE]\n\n`,
    ];
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch));
        c.close();
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    try {
      let streamed = "";
      const r = await provider.chat({ baseUrl: "http://local", apiKey: "", model: "m" }, { messages: [{ role: "user", content: "hi" }], onText: (d) => (streamed += d) });
      expect(streamed).toBe("Hello");
      expect(r.finishReason).toBe("tool_calls");
      expect(r.message.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "list_sources", arguments: '{"a":1}' } }]);
      expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5, cost: 0.001 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("version diff", () => {
  it("diffs arrays of objects by id", () => {
    const a = { widgets: [{ id: "w1", title: "A" }, { id: "w2" }] };
    const b = { widgets: [{ id: "w1", title: "B" }, { id: "w3" }] };
    const ops = jsondiff.diff(a, b).map((o) => `${o.op} ${o.path}`);
    expect(ops).toEqual(expect.arrayContaining(["replace /widgets/w1/title", "remove /widgets/w2", "add /widgets/w3"]));
  });
});
