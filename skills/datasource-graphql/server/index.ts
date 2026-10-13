/**
 * Generic GraphQL data source (kind "other"). The admin configures the endpoint URL and auth; the AI writes
 * `{ query, variables?, operationName?, resultPath? }`. Only `query` operations are sent; mutations and
 * subscriptions are rejected before any network call.
 */
import {
  defineServerSkill, QueryError, HttpStatusError, endpointUrl, cfgString, cfgNumber, authHeaders, safeHeaders, fetchJson, jsonToResult,
  type DatasourceInstance, type EndpointInfo, type SchemaSnapshot, type TableInfo,
} from "@aibi/skill-sdk";

const INTROSPECTION_MAX_BYTES = 20_000_000;
const MAX_ENDPOINTS = 300;
const MAX_TABLES = 300;
const ALLOWED_KEYS = new Set(["query", "variables", "operationName", "resultPath", "headers"]);

/* ───────── read-only check ───────── */

/** Replace string literals (incl. block strings) and `#` comments with blanks so keywords inside them are ignored. */
export function stripStringsAndComments(doc: string): string {
  let out = "";
  let i = 0;
  while (i < doc.length) {
    const c = doc[i];
    if (c === "#") {
      while (i < doc.length && doc[i] !== "\n" && doc[i] !== "\r") i++;
      out += " ";
    } else if (doc.startsWith('"""', i)) {
      i += 3;
      while (i < doc.length && !doc.startsWith('"""', i)) i += doc.startsWith('\\"""', i) ? 4 : 1;
      if (i >= doc.length) throw new QueryError("request.query has an unterminated block string", "params");
      i += 3;
      out += ' "" ';
    } else if (c === '"') {
      i++;
      while (i < doc.length && doc[i] !== '"' && doc[i] !== "\n") i += doc[i] === "\\" ? 2 : 1;
      if (doc[i] !== '"') throw new QueryError("request.query has an unterminated string", "params");
      i++;
      out += ' "" ';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Throw QueryError(params) unless every top-level definition of the document is a `query` operation
 * (named, or the `{ … }` shorthand) or a `fragment`. Field names such as `mutation` inside a selection set
 * are not operation keywords and are allowed.
 */
export function assertReadOnlyDocument(doc: string): void {
  const text = stripStringsAndComments(doc);
  let depth = 0;
  let expectDefinition = true;
  let operations = 0;
  const re = /[{}()[\]]|[_A-Za-z][_0-9A-Za-z]*/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const t = m[0];
    if (t === "{" || t === "(" || t === "[") {
      if (depth === 0 && expectDefinition) {
        if (t !== "{") throw new QueryError("request.query is not a valid GraphQL document", "params");
        operations++; // `{ … }` shorthand query
        expectDefinition = false;
      }
      depth++;
      continue;
    }
    if (t === "}" || t === ")" || t === "]") {
      depth--;
      if (depth < 0) throw new QueryError("request.query has unbalanced brackets", "params");
      if (depth === 0 && t === "}") expectDefinition = true;
      continue;
    }
    if (depth !== 0 || !expectDefinition) continue;
    expectDefinition = false;
    if (t === "query") operations++;
    else if (t === "mutation" || t === "subscription")
      throw new QueryError(`GraphQL ${t} operations are not allowed (read-only). Write a query operation instead.`, "params");
    else if (t !== "fragment")
      throw new QueryError(`Unsupported GraphQL definition '${t}'. Only 'query … { … }', '{ … }' and fragments are allowed.`, "params");
  }
  if (depth !== 0) throw new QueryError("request.query has unbalanced brackets", "params");
  if (operations === 0) throw new QueryError("request.query must contain a query operation, e.g. '{ items { id name } }'", "params");
}

/* ───────── transport ───────── */

interface GraphQLResponse {
  data?: Record<string, unknown> | null;
  errors?: { message?: string }[];
}

/** First GraphQL error message, for HTTP 200 and for servers that answer validation errors with 4xx + errors[]. */
function graphqlError(doc: unknown): string | null {
  const errs = (doc as GraphQLResponse | null)?.errors;
  if (!Array.isArray(errs) || !errs.length) return null;
  const more = errs.length > 1 ? ` (+${errs.length - 1} more errors)` : "";
  return `${errs[0]?.message ?? "GraphQL error"}${more}`;
}

/** POST one GraphQL document to the fixed, admin-configured endpoint. Throws QueryError for transport and GraphQL errors. */
async function post(
  inst: DatasourceInstance,
  body: { query: string; variables?: Record<string, unknown>; operationName?: string },
  pageHeaders: Record<string, unknown> | undefined,
  deadline: number,
  maxBytes: number,
): Promise<GraphQLResponse> {
  const cfg = inst.config;
  const url = endpointUrl(cfg, "baseUrl");
  const headers = safeHeaders(await authHeaders(cfg), pageHeaders);
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new QueryError("request exceeded the time limit", "timeout");
  let doc: unknown;
  try {
    // fetchJson retries one HTTP 429 (Retry-After) within the time budget
    doc = await fetchJson(url, { method: "POST", headers, body, timeoutMs: remaining, maxBytes });
  } catch (e) {
    const msg = e instanceof HttpStatusError ? graphqlError(e.json) : null;
    if (msg) throw new QueryError(`HTTP ${(e as HttpStatusError).status}: ${msg}`, "driver");
    throw e;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new QueryError("GraphQL response is not a JSON object", "driver");
  const msg = graphqlError(doc);
  if (msg) throw new QueryError(msg, "driver");
  return doc as GraphQLResponse;
}

function deadlineFor(inst: DatasourceInstance, limitMs: number): number {
  return Date.now() + Math.min(limitMs, cfgNumber(inst.config, "timeoutMs", limitMs));
}

/* ───────── request validation ───────── */

interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  resultPath?: string;
  headers?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
const given = (v: unknown) => v !== undefined && v !== null;

export function validateRequest(request: Record<string, unknown>): GraphQLRequest {
  for (const k of Object.keys(request)) {
    if (!ALLOWED_KEYS.has(k)) {
      throw new QueryError(
        `request.${k} is not supported. A GraphQL request is { "query": "{ … }", "variables": { … }, "resultPath": "$.data.<field>" } (operationName optional)`,
        "params",
      );
    }
  }
  const { query, variables, operationName, resultPath, headers } = request;
  if (typeof query !== "string" || !query.trim()) throw new QueryError('request.query is required, e.g. "{ orders { id total } }"', "params");
  if (given(variables) && !isPlainObject(variables)) throw new QueryError("request.variables must be an object of variable values", "params");
  if (given(operationName) && typeof operationName !== "string") throw new QueryError("request.operationName must be a string", "params");
  if (given(resultPath) && (typeof resultPath !== "string" || !resultPath.startsWith("$")))
    throw new QueryError('request.resultPath must be a JSONPath starting with "$", e.g. "$.data.orders"', "params");
  if (given(headers) && !isPlainObject(headers)) throw new QueryError("request.headers must be an object", "params");
  assertReadOnlyDocument(query);
  return {
    query,
    variables: given(variables) ? (variables as Record<string, unknown>) : undefined,
    operationName: given(operationName) ? (operationName as string) : undefined,
    resultPath: given(resultPath) ? (resultPath as string) : undefined,
    headers: given(headers) ? (headers as Record<string, unknown>) : undefined,
  };
}

/* ───────── introspection ───────── */

/*
 * The standard introspection query nests `ofType` 7+ levels deep and is refused by servers with a query depth
 * limit (e.g. countries.trevorblades.com allows depth 8). Introspection is therefore split into two shallow
 * queries: all types without arguments, then the root Query type's fields with their arguments.
 * Three `ofType` levels cover `[Type!]!`.
 */
const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
export const INTROSPECTION_TYPES_QUERY = `query AibiIntrospectionTypes {
  __schema {
    queryType { name }
    types {
      kind name description
      fields(includeDeprecated: false) { name description type { ${TYPE_REF} } }
      inputFields { name type { ${TYPE_REF} } }
    }
  }
}`;
export const INTROSPECTION_ROOT_QUERY = `query AibiIntrospectionRoot($root: String!) {
  __type(name: $root) {
    fields(includeDeprecated: false) { name args { name description defaultValue type { ${TYPE_REF} } } }
  }
}`;

interface TypeRef { kind: string; name: string | null; ofType?: TypeRef | null }
interface IArg { name: string; description?: string | null; defaultValue?: string | null; type: TypeRef }
interface IField { name: string; description?: string | null; args?: IArg[] | null; type: TypeRef }
interface IType { kind: string; name: string; description?: string | null; fields?: IField[] | null; inputFields?: { name: string; type: TypeRef }[] | null }

function typeString(t: TypeRef | null | undefined): string {
  if (!t) return "?";
  if (t.kind === "NON_NULL") return `${typeString(t.ofType)}!`;
  if (t.kind === "LIST") return `[${typeString(t.ofType)}]`;
  return t.name ?? "?";
}
function namedType(t: TypeRef | null | undefined): TypeRef | undefined {
  let cur = t ?? undefined;
  while (cur && (cur.kind === "NON_NULL" || cur.kind === "LIST")) cur = cur.ofType ?? undefined;
  return cur;
}
function isLeaf(t: TypeRef | null | undefined): boolean {
  const k = namedType(t)?.kind;
  return k === "SCALAR" || k === "ENUM";
}

/** Compact description of an input object type, expanded two levels: `{ continent: { eq: String, in: [String!] } }`. */
function describeInput(name: string, types: Map<string, IType>, depth: number): string {
  const t = types.get(name);
  if (!t?.inputFields || depth > 1) return name;
  const parts = t.inputFields.map((f) => {
    const n = namedType(f.type);
    const inner = n?.kind === "INPUT_OBJECT" && n.name ? describeInput(n.name, types, depth + 1) : typeString(f.type);
    return `${f.name}: ${inner}`;
  });
  const s = `{ ${parts.join(", ")} }`;
  return s.length > 400 ? `${s.slice(0, 397)}…` : s;
}

/** Map an introspection result: root Query fields → endpoints, object types → tables with scalar/enum columns. */
export function schemaFromIntrospection(data: unknown): SchemaSnapshot {
  const schema = (data as { __schema?: { queryType?: { name?: string } | null; types?: IType[] } } | null | undefined)?.__schema;
  if (!schema?.types) throw new QueryError("introspection returned no __schema", "driver");
  const types = new Map(schema.types.map((t) => [t.name, t]));
  const rootName = schema.queryType?.name ?? "Query";
  const root = types.get(rootName);

  const endpoints: EndpointInfo[] = [];
  for (const f of root?.fields ?? []) {
    if (f.name.startsWith("__")) continue;
    if (endpoints.length >= MAX_ENDPOINTS) break;
    const params: Record<string, string> = {};
    for (const a of f.args ?? []) {
      const n = namedType(a.type);
      let text = typeString(a.type);
      if (n?.kind === "INPUT_OBJECT" && n.name) text += ` ${describeInput(n.name, types, 0)}`;
      if (a.defaultValue) text += ` (default ${a.defaultValue})`;
      if (a.description) text += ` — ${a.description}`;
      params[a.name] = text;
    }
    const ret = namedType(f.type);
    const retType = ret?.name ? types.get(ret.name) : undefined;
    let sample: Record<string, string> | undefined;
    if (retType?.fields) {
      sample = {};
      for (const rf of retType.fields.slice(0, 30)) sample[rf.name] = isLeaf(rf.type) ? typeString(rf.type) : `{…} ${typeString(rf.type)}`;
    }
    const description = `${f.description ? `${f.description} — ` : ""}returns ${typeString(f.type)}; resultPath $.data.${f.name}`;
    endpoints.push({ method: "POST", path: f.name, description, params, ...(sample ? { sample } : {}) });
  }

  const tables: TableInfo[] = [];
  for (const t of schema.types) {
    if (tables.length >= MAX_TABLES) break;
    if (t.kind !== "OBJECT" || t.name.startsWith("__") || t.name === rootName || !t.fields) continue;
    const columns = t.fields
      .filter((f) => isLeaf(f.type))
      .map((f) => ({ name: f.name, type: typeString(f.type), nullable: f.type.kind !== "NON_NULL", ...(f.description ? { comment: f.description } : {}) }));
    if (columns.length) tables.push({ name: t.name, kind: "table", columns, ...(t.description ? { comment: t.description } : {}) });
  }

  return { schemas: [{ name: "types", tables }], endpoints, capturedAt: new Date().toISOString() };
}

/* ───────── handler ───────── */

function hintFor(message: string): string {
  if (/HTTP 40[13]/.test(message)) return "Check the auth type and the token / client credentials.";
  if (/HTTP 404/.test(message)) return "Check the GraphQL endpoint URL.";
  if (/HTTP 405/.test(message)) return "The URL does not accept POST; check that it is the GraphQL endpoint.";
  if (/redirect/.test(message)) return "The URL redirects; configure the final URL (check https and the trailing slash).";
  if (/time limit/.test(message)) return "The endpoint did not answer in time; check the URL and network access.";
  if (/not JSON/.test(message)) return "The URL did not return JSON; check that it is the GraphQL endpoint.";
  return "Check the endpoint URL and the auth settings.";
}

export default defineServerSkill({
  datasource: {
    kind: "other",

    async testConnection(inst) {
      try {
        const url = endpointUrl(inst.config);
        const res = await post(inst, { query: "query { __typename }" }, undefined, deadlineFor(inst, 15000), 1_000_000);
        const rootType = (res.data as { __typename?: string } | null | undefined)?.__typename ?? "Query";
        const auth = String(inst.config.authType ?? "none");
        const who = auth === "none" ? "anonymous" : `${auth} credentials`;
        return {
          ok: true,
          message: `Connected to GraphQL endpoint ${url.host} as ${who} (root type ${rootType})`,
          details: { host: url.host, rootType, authType: auth },
        };
      } catch (e) {
        const msg = (e as Error).message;
        return { ok: false, message: `${msg}. ${hintFor(msg)}` };
      }
    },

    async introspect(inst) {
      const deadline = deadlineFor(inst, 60000);
      const types = await post(inst, { query: INTROSPECTION_TYPES_QUERY }, undefined, deadline, INTROSPECTION_MAX_BYTES);
      const schema = (types.data as { __schema?: { queryType?: { name?: string } | null; types?: IType[] } } | null | undefined)?.__schema;
      if (!schema?.types) throw new QueryError("introspection returned no __schema", "driver");
      const rootName = schema.queryType?.name ?? "Query";
      const root = await post(inst, { query: INTROSPECTION_ROOT_QUERY, variables: { root: rootName } }, undefined, deadline, INTROSPECTION_MAX_BYTES);
      const rootFields = (root.data as { __type?: { fields?: { name: string; args?: IArg[] | null }[] | null } | null } | null | undefined)?.__type?.fields ?? [];
      const argsByField = new Map(rootFields.map((f) => [f.name, f.args ?? []]));
      // Merge the root fields' arguments into the types list, then map as a normal introspection result.
      const merged = schema.types.map((t) =>
        t.name === rootName && t.fields ? { ...t, fields: t.fields.map((f) => ({ ...f, args: argsByField.get(f.name) ?? [] })) } : t,
      );
      return schemaFromIntrospection({ __schema: { queryType: { name: rootName }, types: merged } });
    },

    async query(inst, request, _params, limits) {
      const started = Date.now();
      const req = validateRequest(request);
      const body = {
        query: req.query,
        ...(req.variables ? { variables: req.variables } : {}),
        ...(req.operationName ? { operationName: req.operationName } : {}),
      };
      const res = await post(inst, body, req.headers, deadlineFor(inst, limits.timeoutMs), limits.maxBytes);
      if (res.data === null || res.data === undefined) throw new QueryError("GraphQL response has no data", "driver");
      let resultPath = req.resultPath;
      if (!resultPath) {
        // Default: the single root field (`{ orders { … } }` → $.data.orders), else the whole data object.
        const keys = Object.keys(res.data);
        resultPath = keys.length === 1 ? `$.data.${keys[0]}` : "$.data";
      }
      return jsonToResult(res, resultPath, limits, started);
    },
  },
});
