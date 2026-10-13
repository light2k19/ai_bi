import ExcelJS from "exceljs";
import { defineServerSkill } from "@aibi/skill-sdk";
import { allWidgets } from "@aibi/page-spec";

function sheetName(s: string, used: Set<string>) {
  let base = s.replace(/[\\/?*[\]:]/g, " ").slice(0, 28) || "Sheet";
  let name = base;
  let i = 2;
  while (used.has(name.toLowerCase())) name = `${base.slice(0, 25)} ${i++}`;
  used.add(name.toLowerCase());
  return name;
}

/** Excel number format from a page format spec. */
function excelFormat(spec: string | undefined, type: string): string | undefined {
  const [kind, arg] = String(spec ?? "").split(":");
  const d = arg && /^\d+$/.test(arg) ? Number(arg) : undefined;
  const dec = (n: number) => (n > 0 ? "." + "0".repeat(n) : "");
  switch (kind) {
    case "currency":
    case "compactCurrency":
      return `#,##0${dec(d ?? 0)}`;
    case "percent":
      return `0${dec(d ?? 1)}%`;
    case "integer":
      return "#,##0";
    case "number":
    case "decimal":
    case "compact":
      return `#,##0${dec(d ?? 2)}`;
    case "date":
      return "yyyy-mm-dd";
    case "datetime":
      return "yyyy-mm-dd hh:mm";
  }
  if (type === "number") return "#,##0.##";
  if (type === "date") return "yyyy-mm-dd";
  return undefined;
}

export default defineServerSkill({
  export: {
    formats: [{ id: "xlsx", label: "Excel workbook", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" }],
    async export(_format, ctx) {
      const wb = new ExcelJS.Workbook();
      wb.creator = "AI BI";
      wb.created = new Date();
      const page = ctx.bundle.page;
      const used = new Set<string>();

      // column formats declared on widgets win over type-based defaults
      const formats = new Map<string, Map<string, string>>();
      for (const w of allWidgets(page.widgets)) {
        if (!w.dataset) continue;
        const m = formats.get(w.dataset) ?? new Map<string, string>();
        const props = (w.props ?? {}) as Record<string, unknown>;
        if (Array.isArray(props.columns)) for (const c of props.columns as { key: string; format?: string }[]) if (c.format) m.set(c.key, c.format);
        if (typeof props.format === "string") for (const k of ["series", "bars", "lines"]) for (const s of (props[k] as string[] | undefined) ?? []) m.set(s, props.format as string);
        if (props.format && typeof props.format === "object") for (const [k, v] of Object.entries(props.format as Record<string, string>)) m.set(k, v);
        if (typeof props.value === "string" && typeof props.format === "string") m.set(props.value, props.format);
        formats.set(w.dataset, m);
      }

      const about = wb.addWorksheet(sheetName("About", used));
      about.addRow([page.title]).font = { bold: true, size: 14 };
      if (page.description) about.addRow([page.description]);
      about.addRow([]);
      about.addRow(["Exported", new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC"]);
      for (const f of page.filters) {
        const v = ctx.filters[f.id] as Record<string, unknown> | undefined;
        let shown = "";
        if (v && typeof v === "object") {
          if ("start" in v) shown = `${v.start} → ${v.end}${v.preset && v.preset !== "custom" ? ` (${v.preset})` : ""}`;
          else if ("values" in v) shown = (v as { all?: boolean }).all ? "All" : (v.values as unknown[]).join(", ");
          else if ("value" in v) shown = String(v.value ?? "");
          else if ("text" in v) shown = String(v.text ?? "");
          else shown = JSON.stringify(v);
        }
        about.addRow([`Filter: ${f.label ?? f.id}`, shown]);
      }
      about.getColumn(1).width = 28;
      about.getColumn(2).width = 60;

      for (const d of page.datasets) {
        const data = ctx.datasets[d.id];
        if (!data) continue;
        const ws = wb.addWorksheet(sheetName(d.id, used), { views: [{ state: "frozen", ySplit: 1 }] });
        ws.columns = data.columns.map((c) => ({ header: c.name, key: c.name, width: Math.min(40, Math.max(10, c.name.length + 4)) }));
        ws.getRow(1).font = { bold: true };
        ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE9EEF6" } };
        for (const r of data.rows) {
          ws.addRow(
            data.columns.map((c) => {
              const v = r[c.name];
              if (c.type === "date" && typeof v === "string") {
                const dt = new Date(v.length === 10 ? `${v}T00:00:00Z` : v);
                return Number.isNaN(dt.getTime()) ? v : dt;
              }
              return v as ExcelJS.CellValue;
            }),
          );
        }
        data.columns.forEach((c, i) => {
          const fmt = excelFormat(formats.get(d.id)?.get(c.name), c.type);
          if (fmt) ws.getColumn(i + 1).numFmt = fmt;
        });
        if (data.columns.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: data.columns.length } };
      }
      const buf = await wb.xlsx.writeBuffer();
      const safe = page.title.replace(/[^\w.-]+/g, "_").slice(0, 60) || "page";
      return { body: Buffer.from(buf as ArrayBuffer), mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `${safe}.xlsx` };
    },
  },
});
