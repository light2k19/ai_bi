import fs from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { pageJsonSchemas } from "@aibi/page-spec/json-schema";
import { PAGE_API_DOCS, ANIM_DOCS, COMPONENT_DOCS } from "@aibi/runtime-api/docs";
import { config } from "../config";
import { catalogueFor, skillInstructions } from "../skills/registry";
import type { ProjectRow, User } from "./access";
import { listInstances, schemaOf, schemaText, ensureSchema } from "./sources";
import { runQuery } from "./gateway";
import { toFrame } from "@aibi/transforms";

export function authoringGuide(projectId: string): string {
  const cat = catalogueFor(projectId);
  return `# Building AI BI pages with your own AI

You are writing a page bundle for the AI BI system: a read-only analysis page for managers.
Files you produce: \`page.json\` (the page definition), optional \`components/<Name>.tsx\`, \`scripts/<name>.js\`, \`assets/*\`.

## Workflow
1. Read \`catalogue.json\` (widgets, filters, transforms) and \`sources/<alias>.md\` (tables and columns).
2. Write \`page.json\`. Datasets reference data sources by alias and use bound parameters from filters.
3. Run \`node aibi.mjs validate .\` until there are no errors.
4. Optional live check (needs a personal access token with scope query:read):
   \`node aibi.mjs preview .\` runs every dataset against the server (read-only, 50 rows).
5. \`node aibi.mjs pack .\` creates \`<name>.aibi\`; import it in the web app (Import page) or run \`node aibi.mjs push .\`.

## Rules
- Never put data values in the page; every number comes from a dataset query at view time.
- SQL: one read-only SELECT / WITH … SELECT in the source's dialect; named parameters \`:name\` bound in \`request.params\`
  from filter bindings like \`"{{filters.date.start}}"\`. Never concatenate values into SQL.
- Use only tables/columns listed in \`sources/\`. Prefer catalogue widgets; custom components only when nothing fits.
- Declare every extra module in \`page.modules\` with an exact version; import modules by name, never by URL.
- Scripts/components may not use fetch, eval, window.parent, cookies or storage.

## Data sources in this project
${cat.sources.map((s) => `- \`${s.alias}\`: ${s.name} (${s.kind}${s.dialect ? `, ${s.dialect}` : ""})`).join("\n") || "- none configured"}

## Widget types
${cat.widgets.map((w) => `- \`${w.type}\` — ${w.description}`).join("\n")}
- \`custom.<Name>\` — your own TSX component

## Skill notes
${skillInstructions(projectId)}

${PAGE_API_DOCS}

${ANIM_DOCS}

${COMPONENT_DOCS}
`;
}

const EXAMPLE = {
  page: {
    id: "pg_example",
    title: "Revenue overview",
    description: "Revenue by region with year-over-year comparison",
    filters: [{ id: "date", type: "dateRange", label: "Period", default: { preset: "YTD" }, presets: ["MTD", "QTD", "YTD", "last12m", "custom"] }],
    datasets: [
      {
        id: "by_region",
        source: "<alias>",
        request: {
          sql: "SELECT region, SUM(amount) AS revenue FROM orders WHERE order_date >= :start AND order_date < :end GROUP BY region ORDER BY revenue DESC",
          params: { start: "{{filters.date.start}}", end: "{{filters.date.endExclusive}}" },
        },
      },
    ],
    widgets: [
      { id: "kpi_rev", type: "kpi", title: "Revenue", grid: { x: 0, y: 0, w: 3, h: 4 }, dataset: "by_region", props: { value: "revenue", aggregate: "sum", format: "compactCurrency" } },
      { id: "bar", type: "echarts.bar", title: "Revenue by region", grid: { x: 0, y: 4, w: 12, h: 9 }, dataset: "by_region", props: { x: "region", series: ["revenue"], format: "compactCurrency", horizontal: true } },
    ],
  },
  components: {},
  scripts: {},
  assets: {},
};

export async function buildAuthoringKit(project: ProjectRow, user: User, opts: { samples?: boolean } = {}): Promise<Buffer> {
  const files: Record<string, Uint8Array> = {};
  const put = (p: string, s: string) => (files[`aibi-kit-${project.slug}/${p}`] = strToU8(s));
  const guide = authoringGuide(project.id);
  put("AUTHORING.md", guide);
  put(".claude/skills/aibi-page/SKILL.md", `---\nname: aibi-page\ndescription: Build or edit AI BI analysis pages (page.json bundles) for project ${project.name}; validate and pack them with aibi.mjs.\n---\n\n${guide}`);
  put("AGENTS.md", guide);
  put("page.schema.json", JSON.stringify(pageJsonSchemas().pageBundle, null, 2));
  put("catalogue.json", JSON.stringify(catalogueFor(project.id), null, 2));
  const apiTypes = path.join(config.root, "packages/runtime-api/src/index.ts");
  if (fs.existsSync(apiTypes)) put("runtime-api.d.ts", fs.readFileSync(apiTypes, "utf8"));
  put("example/page.json", JSON.stringify(EXAMPLE, null, 2));
  put(
    "aibi.config.json",
    JSON.stringify({ server: config.publicApiUrl, project: project.slug, token: "<paste a personal access token here or set AIBI_TOKEN>" }, null, 2),
  );
  for (const inst of listInstances(project.id)) {
    if (inst.status === "disabled") continue;
    let sc = schemaOf(inst.id);
    if (!sc.snapshot) {
      try {
        await ensureSchema(project.id, inst.alias, user.id);
        sc = schemaOf(inst.id);
      } catch {
        /* unreachable source: list it without a schema */
      }
    }
    put(`sources/${inst.alias}.md`, `# ${inst.alias} — ${inst.name}\n\nSkill: ${inst.skill_id}\n\n\`\`\`\n${schemaText(sc.snapshot, sc.annotations, { maxChars: 200_000 })}\n\`\`\`\n`);
    put(`sources/${inst.alias}.json`, JSON.stringify({ alias: inst.alias, skill: inst.skill_id, snapshot: sc.snapshot, annotations: sc.annotations }, null, 2));
    if (opts.samples && sc.snapshot && (sc.snapshot.schemas.length || 0) > 0) {
      const samples: Record<string, unknown> = {};
      const dialect = sc.snapshot.dialect;
      for (const s of sc.snapshot.schemas) for (const t of s.tables.slice(0, 40)) {
        const q = dialect === "mssql" ? `SELECT TOP 3 * FROM ${s.name}.${t.name}` : dialect === "oracle" ? `SELECT * FROM ${s.name}.${t.name} FETCH FIRST 3 ROWS ONLY` : `SELECT * FROM ${dialect === "sqlite" ? t.name : `${s.name}.${t.name}`} LIMIT 3`;
        try {
          const r = await runQuery({ projectId: project.id, userId: user.id, alias: inst.alias, request: { sql: q }, kind: "export", limits: { maxRows: 3 } });
          samples[`${s.name}.${t.name}`] = toFrame(r).rows;
        } catch {
          /* skip tables the account cannot read */
        }
      }
      put(`sources/${inst.alias}.samples.json`, JSON.stringify(samples, null, 2));
    }
  }
  const cli = path.join(config.root, "packages/cli/dist/aibi.mjs");
  if (fs.existsSync(cli)) put("aibi.mjs", fs.readFileSync(cli, "utf8"));
  put(
    "README.md",
    `# AI BI authoring kit — ${project.name}\n\nOpen this folder in your AI tool (Claude Code, Cursor, Copilot, a local model) and ask it to build a page.\nThe instructions for the AI are in AUTHORING.md (also .claude/skills/aibi-page/SKILL.md and AGENTS.md).\n\nCommands (Node 20+):\n\n\`\`\`\nnode aibi.mjs validate <dir>     # offline validation against this project's catalogue\nnode aibi.mjs preview <dir>      # run datasets on the server (needs AIBI_TOKEN)\nnode aibi.mjs pack <dir>         # build <name>.aibi\nnode aibi.mjs push <dir>         # import into the project as a draft page (needs page:import scope)\nnode aibi.mjs pull <page-id>     # download a page to edit locally\n\`\`\`\n\nThe server also offers an MCP endpoint at ${config.publicApiUrl}/mcp (Bearer token) with the same tools the built-in agent uses.\n`,
  );
  return Buffer.from(zipSync(files, { level: 6 }));
}
