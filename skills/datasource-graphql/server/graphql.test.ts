import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryError, type DatasourceInstance, type QueryLimits } from "@aibi/skill-sdk";
import skill, { assertReadOnlyDocument } from "./index";

const ds = skill.datasource!;
const LIMITS: QueryLimits = { maxRows: 100, timeoutMs: 5000, maxBytes: 1_000_000 };
const ENDPOINT = "https://api.example.com/graphql";

function inst(config: Record<string, unknown> = {}): DatasourceInstance {
  return { id: "i1", alias: "gql", config: { baseUrl: ENDPOINT, authType: "bearer", token: "secret-token", ...config } };
}

interface Call { url: string; init: RequestInit; body: { query: string; variables?: Record<string, unknown>; operationName?: string } }
let calls: Call[];
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Install a mocked fetch; `handler` returns the response for each call. */
function mockFetch(handler: (c: Call) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = { url: String(input), init, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(c);
    return handler(c);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function header(c: Call, name: string): string | undefined {
  const h = c.init.headers as Record<string, string>;
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : undefined;
}

async function expectQueryError(p: Promise<unknown>, code: string, msg?: RegExp) {
  const e = await p.then(() => null, (err: unknown) => err);
  expect(e).toBeInstanceOf(QueryError);
  expect((e as QueryError).code).toBe(code);
  if (msg) expect((e as QueryError).message).toMatch(msg);
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

const ORDERS = {
  data: {
    orders: [
      { id: "1", total: 10.5, region: "EU", customer: { name: "Acme" } },
      { id: "2", total: 20, region: "US", customer: { name: "Globex" } },
    ],
  },
};

describe("read-only check (query language)", () => {
  it("rejects a mutation document without calling the API", async () => {
    const f = mockFetch(() => json(ORDERS));
    await expectQueryError(ds.query(inst(), { query: 'mutation { deleteOrder(id: "1") { id } }' }, {}, LIMITS), "params", /mutation/);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a subscription document", async () => {
    const f = mockFetch(() => json(ORDERS));
    await expectQueryError(ds.query(inst(), { query: "subscription OnOrder { orderAdded { id } }" }, {}, LIMITS), "params", /subscription/);
    expect(f).not.toHaveBeenCalled();
  });

  it("rejects a mutation hidden after a query and comments", () => {
    expect(() => assertReadOnlyDocument("query A { a }\n# comment\nmutation B { b }")).toThrow(/mutation/);
    expect(() => assertReadOnlyDocument("{ a } mutation { b }")).toThrow(QueryError);
  });

  it("ignores the keywords inside strings, comments and field names", () => {
    expect(() => assertReadOnlyDocument('{ search(text: "mutation { x }") { id } } # subscription')).not.toThrow();
    expect(() => assertReadOnlyDocument('{ log(q: """mutation\n subscription""") { mutation subscription } }')).not.toThrow();
    expect(() => assertReadOnlyDocument("query Q($f: In = { a: 1 }) { ...F } fragment F on Query { a }")).not.toThrow();
  });

  it("rejects schema definitions and documents without an operation", () => {
    expect(() => assertReadOnlyDocument("type X { a: Int }")).toThrow(/Unsupported/);
    expect(() => assertReadOnlyDocument("fragment F on Query { a }")).toThrow(/must contain a query/);
    expect(() => assertReadOnlyDocument("{ a ")).toThrow(/unbalanced/);
  });
});

describe("request shape", () => {
  it("requires query and rejects http-style fields", async () => {
    mockFetch(() => json(ORDERS));
    await expectQueryError(ds.query(inst(), {}, {}, LIMITS), "params", /request.query is required/);
    await expectQueryError(ds.query(inst(), { query: "{ a }", path: "https://evil.example/x" }, {}, LIMITS), "params", /request.path is not supported/);
    await expectQueryError(ds.query(inst(), { query: "{ a }", method: "PUT" }, {}, LIMITS), "params", /request.method/);
    await expectQueryError(ds.query(inst(), { query: "{ a }", variables: [1] }, {}, LIMITS), "params", /variables/);
    await expectQueryError(ds.query(inst(), { query: "{ a }", resultPath: "data.a" }, {}, LIMITS), "params", /resultPath/);
    expect(calls).toHaveLength(0);
  });
});

describe("query", () => {
  it("POSTs query and variables to the configured endpoint and returns rows from resultPath", async () => {
    mockFetch(() => json(ORDERS));
    const r = await ds.query(
      inst(),
      { query: "query($from: Date) { orders(from: $from) { id total region customer { name } } }", variables: { from: "2026-01-01" }, resultPath: "$.data.orders" },
      {},
      LIMITS,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENDPOINT);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls[0].body.variables).toEqual({ from: "2026-01-01" });
    expect(calls[0].body.query).toContain("orders(from: $from)");
    expect(r.columns.map((c) => c.name)).toEqual(["id", "total", "region", "customer.name"]);
    expect(r.rows).toEqual([
      ["1", 10.5, "EU", "Acme"],
      ["2", 20, "US", "Globex"],
    ]);
    expect(r.truncated).toBe(false);
  });

  it("defaults resultPath to the single root field", async () => {
    mockFetch(() => json(ORDERS));
    const r = await ds.query(inst(), { query: "{ orders { id } }" }, {}, LIMITS);
    expect(r.rows).toHaveLength(2);
  });

  it("caps rows at maxRows and marks the result truncated", async () => {
    mockFetch(() => json({ data: { items: Array.from({ length: 10 }, (_, i) => ({ id: i })) } }));
    const r = await ds.query(inst(), { query: "{ items { id } }", resultPath: "$.data.items" }, {}, { ...LIMITS, maxRows: 3 });
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(true);
  });

  it("surfaces GraphQL errors[] (HTTP 200) as QueryError with the first message", async () => {
    mockFetch(() => json({ data: null, errors: [{ message: 'Cannot query field "foo" on type "Query".' }, { message: "second" }] }));
    await expectQueryError(ds.query(inst(), { query: "{ foo }" }, {}, LIMITS), "driver", /^Cannot query field "foo" on type "Query"\./);
  });

  it("surfaces errors[] from an HTTP 400 response", async () => {
    mockFetch(() => json({ errors: [{ message: 'Variable "$x" is never used.' }] }, 400));
    await expectQueryError(ds.query(inst(), { query: "query($x: Int) { a }" }, {}, LIMITS), "driver", /HTTP 400: Variable "\$x" is never used\./);
  });

  it("retries once on HTTP 429", async () => {
    let n = 0;
    mockFetch(() => (n++ === 0 ? json({ message: "slow down" }, 429) : json(ORDERS)));
    const r = await ds.query(inst(), { query: "{ orders { id } }" }, {}, LIMITS);
    expect(calls).toHaveLength(2);
    expect(r.rows).toHaveLength(2);
  });
});

describe("auth and isolation", () => {
  it("sends the bearer token and a page Authorization header cannot replace it", async () => {
    mockFetch(() => json(ORDERS));
    await ds.query(inst(), { query: "{ orders { id } }", headers: { Authorization: "Bearer stolen", "X-Trace": "t1" } }, {}, LIMITS);
    expect(header(calls[0], "authorization")).toBe("Bearer secret-token");
    expect(header(calls[0], "x-trace")).toBe("t1");
  });

  it("header auth: a page header with the configured name cannot replace it", async () => {
    mockFetch(() => json(ORDERS));
    const i = inst({ authType: "header", headerName: "X-API-Key", token: "k1" });
    await ds.query(i, { query: "{ orders { id } }", headers: { "x-api-key": "other", Cookie: "s=1" } }, {}, LIMITS);
    expect(header(calls[0], "x-api-key")).toBe("k1");
    expect(header(calls[0], "cookie")).toBeUndefined();
  });

  it("basic auth and no auth", async () => {
    mockFetch(() => json(ORDERS));
    await ds.query(inst({ authType: "basic", username: "u", token: "p" }), { query: "{ orders { id } }" }, {}, LIMITS);
    expect(header(calls[0], "authorization")).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    await ds.query(inst({ authType: "none" }), { query: "{ orders { id } }" }, {}, LIMITS);
    expect(header(calls[1], "authorization")).toBeUndefined();
  });

  it("refuses redirects", async () => {
    mockFetch(() => new Response(null, { status: 302, headers: { location: "https://evil.example/graphql" } }));
    await expectQueryError(ds.query(inst(), { query: "{ orders { id } }" }, {}, LIMITS), "driver", /redirects are not followed/);
    expect(calls).toHaveLength(1);
  });

  it("rejects a non-http endpoint in config", async () => {
    mockFetch(() => json(ORDERS));
    await expectQueryError(ds.query(inst({ baseUrl: "file:///etc/passwd" }), { query: "{ a }" }, {}, LIMITS), "config");
    expect(calls).toHaveLength(0);
  });
});

describe("limits", () => {
  it("fails with limit when the response is larger than maxBytes", async () => {
    mockFetch(() => json({ data: { items: [{ blob: "x".repeat(5000) }] } }));
    await expectQueryError(ds.query(inst(), { query: "{ items { blob } }" }, {}, { ...LIMITS, maxBytes: 1000 }), "limit");
  });

  it("fails with timeout when the response is slow", async () => {
    mockFetch(
      (c) =>
        new Promise<Response>((_, reject) => {
          const signal = c.init.signal!;
          signal.addEventListener("abort", () => reject(signal.reason ?? Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    await expectQueryError(ds.query(inst(), { query: "{ orders { id } }" }, {}, { ...LIMITS, timeoutMs: 50 }), "timeout");
  });

  it("uses the smaller of the project limit and config timeoutMs", async () => {
    mockFetch(
      (c) =>
        new Promise<Response>((_, reject) => {
          c.init.signal!.addEventListener("abort", () => reject(c.init.signal!.reason));
        }),
    );
    const started = Date.now();
    await expectQueryError(ds.query(inst({ timeoutMs: 50 }), { query: "{ orders { id } }" }, {}, { ...LIMITS, timeoutMs: 10_000 }), "timeout");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

const T = (kind: string, name: string | null, ofType: unknown = null) => ({ kind, name, ofType });
const NN = (t: unknown) => T("NON_NULL", null, t);
const LIST = (t: unknown) => T("LIST", null, t);
const INTROSPECTION = {
  data: {
    __schema: {
      queryType: { name: "Query" },
      types: [
        {
          kind: "OBJECT",
          name: "Query",
          description: null,
          fields: [
            {
              name: "countries",
              description: "All countries",
              args: [{ name: "filter", description: "Filter", defaultValue: "{}", type: T("INPUT_OBJECT", "CountryFilterInput") }],
              type: NN(LIST(NN(T("OBJECT", "Country")))),
            },
            { name: "country", description: null, args: [{ name: "code", description: null, defaultValue: null, type: NN(T("SCALAR", "ID")) }], type: T("OBJECT", "Country") },
          ],
          inputFields: null,
        },
        {
          kind: "OBJECT",
          name: "Country",
          description: "A country",
          fields: [
            { name: "code", description: null, args: [], type: NN(T("SCALAR", "ID")) },
            { name: "name", description: null, args: [], type: NN(T("SCALAR", "String")) },
            { name: "continent", description: null, args: [], type: NN(T("OBJECT", "Continent")) },
          ],
          inputFields: null,
        },
        { kind: "INPUT_OBJECT", name: "CountryFilterInput", description: null, fields: null, inputFields: [{ name: "continent", type: T("INPUT_OBJECT", "StringQueryOperatorInput") }] },
        { kind: "INPUT_OBJECT", name: "StringQueryOperatorInput", description: null, fields: null, inputFields: [{ name: "eq", type: T("SCALAR", "String") }, { name: "in", type: LIST(NN(T("SCALAR", "String"))) }] },
        { kind: "OBJECT", name: "__Type", description: null, fields: [{ name: "name", description: null, args: [], type: T("SCALAR", "String") }], inputFields: null },
      ],
    },
  },
};

describe("introspect", () => {
  it("maps root Query fields to POST endpoints with their arguments, and object types to tables", async () => {
    const queryType = INTROSPECTION.data.__schema.types[0];
    mockFetch((c) =>
      c.body.query.includes("__type(")
        ? json({ data: { __type: { fields: queryType.fields!.map((f) => ({ name: f.name, args: f.args })) } } })
        : json(INTROSPECTION),
    );
    const snap = await ds.introspect(inst());
    expect(calls).toHaveLength(2);
    expect(calls[0].body.query).toContain("__schema");
    expect(calls[1].body.variables).toEqual({ root: "Query" });
    expect(header(calls[0], "authorization")).toBe("Bearer secret-token");
    const eps = snap.endpoints!;
    expect(eps.map((e) => e.path)).toEqual(["countries", "country"]);
    expect(eps.every((e) => e.method === "POST")).toBe(true);
    expect(eps[0].description).toContain("All countries");
    expect(eps[0].description).toContain("[Country!]!");
    expect(eps[0].params!.filter).toContain("CountryFilterInput");
    expect(eps[0].params!.filter).toContain("continent: { eq: String, in: [String!] }");
    expect(eps[1].params).toEqual({ code: "ID!" });
    expect(eps[0].sample).toEqual({ code: "ID!", name: "String!", continent: "{…} Continent!" });
    const tables = snap.schemas[0].tables;
    expect(tables.map((t) => t.name)).toEqual(["Country"]);
    expect(tables[0].columns.map((c) => c.name)).toEqual(["code", "name"]);
  });

  it("throws when introspection is disabled (errors[])", async () => {
    mockFetch(() => json({ errors: [{ message: "GraphQL introspection is not allowed" }] }));
    await expectQueryError(ds.introspect(inst()), "driver", /introspection is not allowed/);
  });
});

describe("testConnection", () => {
  it("reports success with the host and the account kind", async () => {
    mockFetch(() => json({ data: { __typename: "Query" } }));
    const r = await ds.testConnection(inst());
    expect(r.ok).toBe(true);
    expect(r.message).toContain("api.example.com");
    expect(r.message).toContain("bearer credentials");
    expect(header(calls[0], "authorization")).toBe("Bearer secret-token");
  });

  it("returns ok:false with the HTTP status and a hint on 401", async () => {
    mockFetch(() => json({ message: "unauthorized" }, 401));
    const r = await ds.testConnection(inst());
    expect(r.ok).toBe(false);
    expect(r.message).toContain("HTTP 401");
    expect(r.message).toMatch(/Check the auth type/);
  });

  it("returns ok:false when the base URL is missing", async () => {
    mockFetch(() => json({}));
    const r = await ds.testConnection({ id: "x", alias: "x", config: { authType: "none" } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("baseUrl");
    expect(calls).toHaveLength(0);
  });
});
