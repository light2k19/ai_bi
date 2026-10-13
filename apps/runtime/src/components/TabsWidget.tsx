import { useState } from "react";
import type { Widget } from "@aibi/page-spec";
import type { RState } from "../engine";
import { handles } from "../engine";
import { WidgetCard } from "./WidgetCard";
import { useEffect } from "react";

export function TabsWidget({ w, s }: { w: Widget; s: RState }) {
  const tabs = w.tabs ?? [];
  const [active, setActive] = useState(Number((w.props?.initial as number | undefined) ?? 0));
  useEffect(() => {
    handles.set(w.id, { select: (i: unknown) => setActive(Number(i)) });
  }, [w.id]);
  const rowHeight = s.bundle?.page.layout?.rowHeight ?? 40;
  const gap = s.bundle?.page.layout?.gap ?? 12;
  const current = tabs[Math.min(active, tabs.length - 1)];
  const rows = current ? Math.max(1, ...current.widgets.map((c) => c.grid.y + c.grid.h)) : 1;
  return (
    <div className="rt-card rt-tabs" data-widget={w.id}>
      {w.title && (
        <div className="rt-card-head">
          <div className="rt-titles">
            <div className="rt-title">{w.title}</div>
            {w.subtitle && <div className="rt-subtitle">{w.subtitle}</div>}
          </div>
        </div>
      )}
      <div className="rt-tabstrip" role="tablist">
        {tabs.map((t, i) => (
          <button key={i} role="tab" aria-selected={i === active} className={i === active ? "rt-tab rt-tab-active" : "rt-tab"} onClick={() => setActive(i)}>
            {t.title}
          </button>
        ))}
      </div>
      <div className="rt-tab-body" style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gridAutoRows: `${rowHeight}px`, gap: `${gap}px`, minHeight: rows * (rowHeight + gap) }}>
        {current?.widgets.map((c) => (
          <div key={c.id} style={{ gridColumn: `${c.grid.x + 1} / span ${c.grid.w}`, gridRow: `${c.grid.y + 1} / span ${c.grid.h}`, minWidth: 0 }}>
            <WidgetCard w={c} s={s} nested />
          </div>
        ))}
      </div>
    </div>
  );
}
