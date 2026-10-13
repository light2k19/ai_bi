/**
 * Minimal MCP server (Streamable HTTP transport, JSON responses) so local agents such as
 * Claude Code or Claude Desktop can introspect schemas, preview queries, validate and import pages.
 */
import { PageBundle, validatePage, formatIssues } from "@aibi/page-spec";
import { PAGE_API_DOCS, ANIM_DOCS, COMPONENT_DOCS } from "@aibi/runtime-api/docs";
import { toFrame } from "@aibi/transforms";
import { catalogueFor } from "../skills/registry";
import type { User, Role } from "./access";
import { ensureSchema, schemaText } from "./sources";
import { runQuery } from "./gateway";
import { defaultFilterValues } from "@aibi/page-spec";
import { frameToText, computeDatasets } from "./compute";
import { authoringGuide } from "./authoring-kit";
import { createPage, saveVersion, loadPage, type PageRow } from "./pages";
import { roleAtLeast } from "./access";
import { get } from "../db";
import { config } from "../config";

interface McpCtx {
  projectId: string;
  user: User;
  role: Role;
  scopes: string[];
}

const TOOLS = [
  { name: "get_authoring_guide", description: "Rules, page format, widget list and Page API docs for building pages in this project. Read this first.", inputSchema: { type: "object", properties: {} } },
  { name: "list_sources", description: "Data sources of the project (alias, kind, dialect).", inputSchema: { type: "object", properties: {} } },
  { name: "introspect_schema", description: "Tables/columns (or API endpoints) of a data source, optionally filtered by search words.", inputSchema: { type: "object", properties: { source: { type: "string" }, search: { type: "string" } }, required: ["source"] } },
  { name: "preview_query", description: "Run a read-only dataset request and return up to 20 rows. Bindings use default filter values of `page` if given.", inputSchema: { type: "object", properties: { source: { type: "string" }, request: { type: "object" }, page: { type: "object", description: "optional page definition for filter defaults" } }, required: ["source", "request"] } },
  { name: "list_widgets", description: "Widget types with descriptions and required props.", inputSchema: { type: "object", properties: {} } },
  { name: "get_widget_schema", description: "Full props schema and example of a widget type.", inputSchema: { type: "object", properties: { type: { type: "string" } }, required: ["type"] } },
  { name: "list_transforms", description: "Dataset pipeline transforms with examples.", inputSchema: { type: "object", properties: {} } },
  { name: "get_script_docs", description: "Page API, animation helpers and custom component docs.", inputSchema: { type: "object", properties: {} } },
  { name: "validate_page", description: "Validate a page bundle { page, components, scripts, assets } against this project; also runs every dataset when run_datasets is true.", inputSchema: { type: "object", properties: { bundle: { type: "object" }, run_datasets: { type: "boolean" } }, required: ["bundle"] } },
  { name: "import_page", description: "Save a validated bundle into the project: as a new page, or as a new version when page.id matches an existing page you can edit. Returns the page URL.", inputSchema: { type: "object", properties: { bundle: { type: "object" }, message: { type: "string" } }, required: ["bundle"] } },
];

const BUILDER_TOOLS = new Set(["introspect_schema", "preview_query", "import_page"]);

async function callTool(name: string, args: Record<string, unknown>, ctx: McpCtx): Promise<string> {
  const cat = catalogueFor(ctx.projectId);
  // viewers may only run datasets of saved pages (through the web app); ad-hoc queries, schema loading and
  // running draft datasets need the builder role, exactly like the HTTP API
  if ((BUILDER_TOOLS.has(name) || (name === "validate_page" && args.run_datasets)) && !roleAtLeast(ctx.role, "builder")) return `ERROR: ${name} requires the builder role in this project`;
  switch (name) {
    case "get_authoring_guide":
      return authoringGuide(ctx.projectId);
    case "list_sources":
      return cat.sources.map((s) => `${s.alias}: ${s.name} (${s.kind}${s.dialect ? `, ${s.dialect}` : ""})`).join("\n") || "none";
    case "introspect_schema": {
      const s = await ensureSchema(ctx.projectId, String(args.source), ctx.user.id);
      return schemaText(s.snapshot, s.annotations, { search: args.search ? String(args.search) : undefined, maxChars: 30_000 });
    }
    case "preview_query": {
      const page = PageBundle.shape.page.safeParse(args.page ?? { id: "x", title: "x" });
      const filters = defaultFilterValues(page.success ? page.data.filters : []);
      const r = await runQuery({ projectId: ctx.projectId, userId: ctx.user.id, userEmail: ctx.user.email ?? ctx.user.login, alias: String(args.source), request: (args.request as Record<string, unknown>) ?? {}, scope: { filters, page: {} }, kind: "ai", limits: { maxRows: 50 } });
      return frameToText(toFrame(r), 20);
    }
    case "list_widgets":
      return cat.widgets.map((w) => `${w.type}: ${w.description} (required: ${(w.propsSchema.required ?? []).join(", ") || "none"})`).join("\n");
    case "get_widget_schema": {
      const w = cat.widgets.find((x) => x.type === args.type);
      return w ? JSON.stringify(w, null, 1) : `unknown widget type; available: ${cat.widgets.map((x) => x.type).join(", ")}`;
    }
    case "list_transforms":
      return cat.transforms.map((t) => `${t.op}: ${t.description}\n  e.g. ${JSON.stringify(t.example)}`).join("\n");
    case "get_script_docs":
      return `${PAGE_API_DOCS}\n\n${ANIM_DOCS}\n\n${COMPONENT_DOCS}`;
    case "validate_page": {
      const v = validatePage(args.bundle, { catalogue: cat });
      let out = formatIssues(v);
      if (args.run_datasets && v.bundle && v.ok) {
        const r = await computeDatasets(ctx.projectId, ctx.user, v.bundle, { kind: "ai", maxRows: 500 });
        out += "\n\nDatasets:\n" + v.bundle.page.datasets.map((d) => (r.errors[d.id] ? `ERROR ${d.id}: ${r.errors[d.id]}` : `OK ${d.id}: ${r.frames[d.id]?.rows.length ?? 0} rows, columns ${r.frames[d.id]?.columns.map((c) => c.name).join(", ")}`)).join("\n");
      }
      return out;
    }
    case "import_page": {
      if (!ctx.scopes.includes("page:import")) return "ERROR: the token lacks the page:import scope";
      if (ctx.role === "viewer") return "ERROR: importing pages requires the builder role";
      const b = PageBundle.parse(args.bundle);
      // a new version only of a page the caller can see and edit (private pages belong to their owner)
      const existing: PageRow | undefined = get<PageRow>("SELECT * FROM pages WHERE id = ? AND project_id = ? AND deleted = 0", b.page.id, ctx.projectId) ? loadPage(ctx.projectId, b.page.id, ctx.user, ctx.role, "edit") : undefined;
      const res = existing
        ? await saveVersion(ctx.projectId, existing, ctx.user, b, { message: String(args.message ?? "Pushed via MCP"), source: "import" })
        : await createPage(ctx.projectId, ctx.user, b, { message: String(args.message ?? "Imported via MCP"), source: "import", keepId: true });
      const slug = get<{ slug: string }>("SELECT slug FROM projects WHERE id = ?", ctx.projectId)?.slug;
      return `Saved page ${res.id} version ${res.versionNo}. Open: ${config.webOrigin}/p/${slug}/pages/${res.id}`;
    }
  }
  return `ERROR: unknown tool ${name}`;
}

export async function handleMcp(body: unknown, ctx: McpCtx): Promise<unknown> {
  const reqs = Array.isArray(body) ? body : [body];
  const out: unknown[] = [];
  for (const raw of reqs) {
    if (!raw || typeof raw !== "object") {
      out.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } });
      continue;
    }
    const r = raw as { jsonrpc: string; id?: string | number; method: string; params?: Record<string, unknown> };
    const reply = (result: unknown) => r.id !== undefined && out.push({ jsonrpc: "2.0", id: r.id, result });
    const fail = (code: number, message: string) => r.id !== undefined && out.push({ jsonrpc: "2.0", id: r.id, error: { code, message } });
    try {
      switch (r.method) {
        case "initialize":
          reply({ protocolVersion: (r.params?.protocolVersion as string) ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ai-bi", version: config.appVersion }, instructions: "Call get_authoring_guide first. All data access is read-only." });
          break;
        case "notifications/initialized":
        case "notifications/cancelled":
          break;
        case "ping":
          reply({});
          break;
        case "tools/list":
          reply({ tools: TOOLS });
          break;
        case "tools/call": {
          const name = String(r.params?.name);
          try {
            const text = await callTool(name, (r.params?.arguments as Record<string, unknown>) ?? {}, ctx);
            reply({ content: [{ type: "text", text }], isError: text.startsWith("ERROR") });
          } catch (e) {
            reply({ content: [{ type: "text", text: `ERROR: ${(e as Error).message}` }], isError: true });
          }
          break;
        }
        default:
          fail(-32601, `method not found: ${r.method}`);
      }
    } catch (e) {
      fail(-32603, (e as Error).message);
    }
  }
  return Array.isArray(body) ? out : (out[0] ?? null);
}
