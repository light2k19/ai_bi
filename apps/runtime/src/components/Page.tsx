import { useMemo } from "react";
import { Responsive, WidthProvider, type Layout, type Layouts } from "react-grid-layout";
import "react-grid-layout/css/styles.css";
import "react-resizable/css/styles.css";
import type { Grid, Widget } from "@aibi/page-spec";
import { setState, api, type RState } from "../engine";
import { send, isDirect } from "../bridge";
import { FilterBar } from "./FilterBar";
import { WidgetCard } from "./WidgetCard";

const ResponsiveGrid = WidthProvider(Responsive);

function stacked(widgets: Widget[]): Layout[] {
  let y = 0;
  return [...widgets]
    .sort((a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x)
    .map((w) => {
      const l = { i: w.id, x: 0, y, w: 1, h: Math.max(w.grid.h, w.type === "kpi" ? 4 : w.grid.h), static: true };
      y += l.h;
      return l;
    });
}

export function Page({ s }: { s: RState }) {
  const page = s.bundle!.page;
  const edit = s.mode === "edit";
  const rowHeight = page.layout?.rowHeight ?? 40;
  const gap = page.layout?.gap ?? 12;
  const visible = page.widgets;

  const layouts: Layouts = useMemo(
    () => ({
      lg: visible.map((w) => ({ i: w.id, x: w.grid.x, y: w.grid.y, w: w.grid.w, h: w.grid.h, minW: w.grid.minW ?? 1, minH: w.grid.minH ?? 2, static: !edit })),
      sm: page.settings?.mobileLayout === "scale" ? visible.map((w) => ({ i: w.id, x: w.grid.x, y: w.grid.y, w: w.grid.w, h: w.grid.h, static: true })) : stacked(visible),
    }),
    [visible, edit, page.settings?.mobileLayout],
  );

  const commit = (layout: Layout[]) => {
    if (!edit) return;
    const grids: Record<string, Grid> = {};
    for (const l of layout) grids[l.i] = { x: l.x, y: l.y, w: l.w, h: l.h };
    const changed = visible.some((w) => {
      const g = grids[w.id];
      return g && (g.x !== w.grid.x || g.y !== w.grid.y || g.w !== w.grid.w || g.h !== w.grid.h);
    });
    if (changed) send({ type: "layout", grids });
  };

  const empty = !page.widgets.length;

  // print / PDF: normal-flow CSS grid so cards can avoid page breaks (the drag grid is absolutely positioned)
  if (s.mode === "render") {
    const rows = Math.max(1, ...visible.map((w) => w.grid.y + w.grid.h));
    return (
      <div id="aibi-page" className="rt-page rt-mode-render">
        {isDirect() && (
          <header className="rt-print-head">
            <div>
              <h1>{page.title}</h1>
              {page.description && <p>{page.description}</p>}
            </div>
            <span>Generated {new Date().toLocaleString(api.page.locale)}</span>
          </header>
        )}
        <FilterBar s={s} />
        <div className="rt-print-grid" style={{ gridTemplateRows: `repeat(${rows}, ${rowHeight}px)`, gap: `${gap}px` }}>
          {visible.map((w) => (
            <div key={w.id} className="rt-print-cell" style={{ gridColumn: `${w.grid.x + 1} / span ${w.grid.w}`, gridRow: `${w.grid.y + 1} / span ${w.grid.h}` }}>
              <WidgetCard w={w} s={s} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div id="aibi-page" className={`rt-page rt-mode-${s.mode}`} style={page.layout?.maxWidth ? { maxWidth: page.layout.maxWidth, margin: "0 auto" } : undefined}>
      <FilterBar s={s} />
      {empty ? (
        <div className="rt-empty">
          <div className="rt-empty-icon">✦</div>
          <div className="rt-empty-title">This page is empty</div>
          <div className="rt-empty-text">{edit ? "Describe what you want in the AI panel, or add widgets in the editor." : "No widgets yet."}</div>
        </div>
      ) : (
        <ResponsiveGrid
          className="rt-grid"
          layouts={layouts}
          breakpoints={{ lg: 760, sm: 0 }}
          cols={{ lg: 12, sm: page.settings?.mobileLayout === "scale" ? 12 : 1 }}
          rowHeight={rowHeight}
          margin={[gap, gap]}
          containerPadding={[0, 0]}
          isDraggable={edit}
          isResizable={edit}
          compactType="vertical"
          draggableCancel=".rt-menu-wrap, .rt-no-drag, input, select, textarea, button"
          onDragStop={(l) => commit(l)}
          onResizeStop={(l) => commit(l)}
          resizeHandles={["se", "e", "s"]}
          useCSSTransforms
          measureBeforeMount={false}
        >
          {visible.map((w) => (
            <div key={w.id} className="rt-cell">
              <WidgetCard w={w} s={s} />
            </div>
          ))}
        </ResponsiveGrid>
      )}
      {edit && (
        <div
          className="rt-deselect"
          onMouseDown={() => {
            setState({ selected: null });
            send({ type: "selected", widgetId: null });
          }}
        />
      )}
    </div>
  );
}
