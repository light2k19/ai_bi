/** Reference documentation for page scripts and components, shown to the AI and in the authoring kit. */

export const PAGE_API_DOCS = `
## Page scripts

A page script is an ES module whose default export receives the Page API. It runs inside the
sandboxed page runtime after widgets mount (trigger \`runOn\`: page:init | page:dataLoaded (default) |
filter:changed | manual | interval:<seconds>). Return a cleanup function if you start timers.

\`\`\`js
import { animate, stagger, countUp } from "@aibi/anim"; // optional; the same helpers are on ctx.anim
export default async function ({ page, filters, data, widgets, events, anim, util, ai, state }) {
  await anim.reveal(widgets.all().map(w => w.el), { delay: anim.stagger(90) });
  const rev = data.get("revenue_by_region");          // { columns, rows: [{...}], meta }
  const total = rev.rows.reduce((s, r) => s + r.revenue, 0);
  widgets.get("kpi_total")?.handle.countUp?.(total);
  events.on("filter:changed", ({ id }) => { if (id === "region") widgets.get("bar")?.handle.highlight?.(filters.get("region").values); });
}
\`\`\`

### API
- \`page\`: { id, title, theme, el, setTitle(t), refresh(), print() }
- \`filters\`: get(id) → runtime value; set(id, raw); values; definitions
- \`data\`: get(datasetId) → { columns:[{name,type}], rows:[{col: value}], meta }; reload(id?); ids
- \`widgets\`: get(id) → { id, type, el, props, setProps(patch), handle, show(), hide() }; all(); show(id); hide(id)
- \`events\`: on(name, fn) → unsubscribe; off; emit(name, payload).
  Built-in events: page:init, page:dataLoaded, dataset:loaded {id}, filter:changed {id, value},
  widget:click {widget, row, value, name, series}, widget:hover, page:beforePrint, page:resize
- \`anim\`: see Animation helpers
- \`util\`: format(value, spec) with spec number | integer | currency[:digits|:EUR] | percent[:digits] (ratio) |
  percentRaw | compact | compactCurrency | date | datetime | month | quarter | year; sleep(ms)
- \`ai\`: ask(question, { datasets }) → markdown string (rate limited)
- \`state\`: shared object for scripts/components on the page

Widget handles (call with optional chaining): echarts widgets expose setOption(option), highlight(names[]),
downplay(), showTip(index), getInstance(); kpi exposes countUp(value?), flash(); table exposes
scrollToRow(index), highlightRows(predicateExpr); text exposes setText(markdown).

### Restrictions
No fetch/XMLHttpRequest/WebSocket, no eval/Function, no access to window.parent/top, cookies or
browser storage. Import only "@aibi/anim", "@aibi/runtime-api", "react" and modules declared in
page.modules (by name, never by URL).
`.trim();

export const ANIM_DOCS = `
## Animation helpers (@aibi/anim, also ctx.anim)

Built on the Web Animations API; every helper returns a Promise that resolves when done.
- animate(targets, keyframes, { duration=600, delay=0 | (i)=>ms, easing="cubic-bezier(.2,.7,.2,1)" })
  targets: CSS selector (scoped to the page), Element, or array. keyframes: { opacity:[0,1], transform:["translateY(20px)","none"] }
- stagger(stepMs, { start, from: "first"|"last"|"center" }) → delay function
- reveal(targets, { direction: "up"|"down"|"left"|"right", distance=16, duration, delay })
- countUp(target, to, { from=0, duration=1200, format: "currency" | (n)=>string })
- typewriter(target, text, { speed=25 })
- pulse(target), highlight(target, { color })
- timeline().add(() => promise).add(300 /* pause ms */).add(...).play()
- sleep(ms)
ECharts widgets animate their own data changes; use widget.handle.setOption({ ... }) for chart-level animation
(e.g. animationDuration, animationEasing, universalTransition) and anim helpers for DOM-level choreography.
`.trim();

export const COMPONENT_DOCS = `
## Custom components (type "custom.<Name>")

A TSX module whose default export is a React component. Declare it in page.components ({ name }) and
reference it from a widget with type "custom.<Name>". The widget's props, bound dataset and theme are passed in.

\`\`\`tsx
import { useState } from "react";
import type { WidgetRenderProps } from "@aibi/runtime-api";
export default function RegionBadges({ data, props, theme, format, emit }: WidgetRenderProps) {
  const rows = data?.rows ?? [];
  const threshold = Number(props.threshold ?? 0.9);
  return (
    <div className="flex flex-wrap gap-2 p-2">
      {rows.map((r) => (
        <button key={String(r.region)} onClick={() => emit("click", { row: r, name: r.region })}
          className="rounded-full px-3 py-1 text-sm"
          style={{ background: Number(r.attainment) < threshold ? theme.danger : theme.success, color: "#fff" }}>
          {String(r.region)} · {format(r.attainment, "percent")}
        </button>
      ))}
    </div>
  );
}
\`\`\`
Props: widget, props, data ({columns, rows}), datasets, loading, error, theme (mode, bg, surface, text,
muted, accent, success, warning, danger, palette[]), width, height, api (Page API), emit(event, payload),
setHandle(methods), format(value, spec), styleFor(row, column, value).
Tailwind utility classes are available. Hooks from "react" work. Import other page components with
"@components/<Name>". Same restrictions as scripts.
`.trim();
