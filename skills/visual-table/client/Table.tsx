import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { WidgetRenderProps } from "@aibi/runtime-api";
import { evaluate } from "@aibi/page-spec";
import {
  aggregate,
  autoSpec,
  columnType,
  compareValues,
  heatBackground,
  humanize,
  isPlain,
  isSummable,
  keyOf,
  str,
  toNum,
  type Agg,
  type Row,
} from "./util";

interface ColSpec {
  key: string;
  label: string;
  format?: string;
  align: "left" | "right" | "center";
  width?: number;
  bar: boolean;
  heat: boolean;
  heatInvert: boolean;
  delta: boolean;
  numeric: boolean;
  /** aggregate shown in the totals row (undefined → blank) */
  total?: Agg;
  /** aggregate shown in group subtotal rows */
  subtotal?: Agg;
}

interface Stats {
  min: number;
  max: number;
  maxAbs: number;
}

const AGGS = new Set(["sum", "avg", "min", "max", "count", "none"]);
const RENDER_STEP = 500;

function resolveColumns(props: Record<string, unknown>, data: NonNullable<WidgetRenderProps["data"]>, groupBy?: string): ColSpec[] {
  const given = (Array.isArray(props.columns) ? props.columns : [])
    .map((c) => (typeof c === "string" ? { key: c } : c))
    .filter((c): c is Record<string, unknown> & { key: string } => isPlain(c) && typeof c.key === "string");
  const list = given.length ? given : data.columns.filter((c) => c.name !== groupBy).map((c) => ({ key: c.name }) as Record<string, unknown> & { key: string });
  const allTotals = props.totals === true;
  return list.map((c) => {
    const type = columnType(data, c.key);
    const numeric = type === "number";
    const format = str(c.format) ?? autoSpec(data, c.key);
    const explicit = typeof c.total === "string" && AGGS.has(c.total) ? (c.total as Agg) : undefined;
    const summable = numeric && isSummable(c.key, format);
    const total = explicit ?? (allTotals && summable ? "sum" : undefined);
    const align = c.align === "left" || c.align === "right" || c.align === "center" ? c.align : numeric || c.delta === true ? "right" : "left";
    return {
      key: c.key,
      label: str(c.label) ?? humanize(c.key),
      format,
      align,
      width: toNum(c.width) ?? undefined,
      bar: c.bar === true,
      heat: c.heat === true,
      heatInvert: c.heatInvert === true,
      delta: c.delta === true,
      numeric,
      total: total === "none" ? undefined : total,
      subtotal: explicit && explicit !== "none" ? explicit : summable ? "sum" : undefined,
    };
  });
}

function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  return (
    <svg className={`aibi-sort-icon${dir ? " aibi-sort-on" : ""}`} width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
      <path d="M5 1 L8.5 5 H1.5 Z" opacity={dir === "asc" ? 1 : 0.35} />
      <path d="M5 11 L1.5 7 H8.5 Z" opacity={dir === "desc" ? 1 : 0.35} />
    </svg>
  );
}

export function TableWidget(rp: WidgetRenderProps) {
  const { props, data, format, styleFor, emit, setHandle, theme, widget } = rp;
  const groupBy = str(props.groupBy);
  const cols = useMemo(() => (data ? resolveColumns(props, data, groupBy) : []), [props, data, groupBy]);
  const sortable = props.sortable !== false;
  const defaultSort = isPlain(props.defaultSort) && typeof props.defaultSort.column === "string" ? { col: props.defaultSort.column, desc: props.defaultSort.desc === true } : null;
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(defaultSort);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [limit, setLimit] = useState(RENDER_STEP);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [highlighted, setHighlighted] = useState<Set<Row>>(new Set());
  const [flashIdx, setFlashIdx] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageSize = toNum(props.pageSize) ?? 0;
  const compact = props.density === "compact";
  const sticky = props.stickyHeader !== false;
  const rowNumbers = props.rowNumbers === true;
  const clickable = (widget.interactions ?? []).some((i) => i.on === "click" || i.on === "dblclick");

  const defaultSortKey = JSON.stringify(props.defaultSort ?? null);
  useEffect(() => setSort(defaultSort), [defaultSortKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPage(0), [query, sort, data]);

  const rows = useMemo(() => data?.rows ?? [], [data]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      cols.some((c) => {
        const v = r[c.key];
        if (v === null || v === undefined) return false;
        return keyOf(v).toLowerCase().includes(q) || format(v, c.format).toLowerCase().includes(q);
      }),
    );
  }, [rows, query, cols, format]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const out = [...filtered].sort((a, b) => compareValues(a[sort.col], b[sort.col]));
    if (sort.desc) {
      // keep nulls last when descending
      const nulls = out.filter((r) => r[sort.col] === null || r[sort.col] === undefined || r[sort.col] === "");
      const vals = out.filter((r) => !(r[sort.col] === null || r[sort.col] === undefined || r[sort.col] === ""));
      return [...vals.reverse(), ...nulls];
    }
    return out;
  }, [filtered, sort]);

  const stats = useMemo(() => {
    const out: Record<string, Stats> = {};
    for (const c of cols) {
      if (!c.bar && !c.heat) continue;
      const nums = filtered.map((r) => toNum(r[c.key])).filter((v): v is number => v !== null);
      if (!nums.length) continue;
      const min = Math.min(...nums);
      const max = Math.max(...nums);
      out[c.key] = { min, max, maxAbs: Math.max(Math.abs(min), Math.abs(max)) };
    }
    return out;
  }, [cols, filtered]);

  const paged = pageSize > 0 && !groupBy;
  const pageCount = paged ? Math.max(1, Math.ceil(sorted.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const visible = paged ? sorted.slice(safePage * pageSize, safePage * pageSize + pageSize) : sorted;
  const capped = !paged && !groupBy ? visible.slice(0, limit) : visible;

  // handles see the latest rows
  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pageSizeRef = useRef({ paged, pageSize });
  pageSizeRef.current = { paged, pageSize };

  const scrollToIndex = (index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const tr = el.querySelector<HTMLTableRowElement>(`tr[data-idx="${index}"]`);
    if (!tr) return;
    const head = el.querySelector("thead");
    el.scrollTo({ top: Math.max(0, tr.offsetTop - (head?.offsetHeight ?? 0) - 4), behavior: "smooth" });
  };

  useEffect(() => {
    setHandle({
      scrollToRow: (index: unknown) => {
        const i = Math.max(0, Math.min(sortedRef.current.length - 1, Number(index) || 0));
        const { paged: pg, pageSize: ps } = pageSizeRef.current;
        if (pg) setPage(Math.floor(i / ps));
        else setLimit((l) => Math.max(l, i + 50));
        setFlashIdx(i);
        requestAnimationFrame(() => requestAnimationFrame(() => scrollToIndex(i)));
        window.setTimeout(() => setFlashIdx((f) => (f === i ? null : f)), 1600);
      },
      highlightRows: (expr: unknown) => {
        if (typeof expr !== "string" || !expr.trim()) {
          setHighlighted(new Set());
          return [];
        }
        const hits = rowsRef.current.filter((row) => {
          try {
            return !!evaluate(expr, { ...row, row });
          } catch {
            return false;
          }
        });
        setHighlighted(new Set(hits));
        const first = hits[0] ? sortedRef.current.indexOf(hits[0]) : -1;
        if (first >= 0) {
          const { paged: pg, pageSize: ps } = pageSizeRef.current;
          if (pg) setPage(Math.floor(first / ps));
          requestAnimationFrame(() => requestAnimationFrame(() => scrollToIndex(first)));
        }
        return hits.length;
      },
      getRows: () => sortedRef.current,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;
  if (rows.length === 0) return <div className="aibi-table-empty">No data</div>;

  const onHeader = (c: ColSpec) => {
    if (!sortable) return;
    setSort((s) => (!s || s.col !== c.key ? { col: c.key, desc: c.numeric } : s.desc === c.numeric ? { col: c.key, desc: !s.desc } : null));
  };

  const renderCell = (c: ColSpec, row: Row, key: string, aggValue?: number | null, inAgg = false): ReactNode => {
    const value = inAgg ? aggValue : row[c.key];
    const cond = inAgg ? undefined : styleFor(row, c.key, value);
    const style: CSSProperties = { textAlign: c.align };
    let content: ReactNode = value === null || value === undefined ? "" : format(value, c.format);
    const n = toNum(value);
    if (!inAgg && c.heat && n !== null && stats[c.key]) {
      const s = stats[c.key];
      let t = s.max === s.min ? 0.5 : (n - s.min) / (s.max - s.min);
      if (c.heatInvert) t = 1 - t;
      style.background = heatBackground(t);
    }
    if (c.delta && n !== null) {
      const cls = n > 0 ? "aibi-delta-up" : n < 0 ? "aibi-delta-down" : "aibi-delta-flat";
      content = (
        <span className={`aibi-delta ${cls}`}>
          <span className="aibi-delta-arrow" aria-hidden="true">{n > 0 ? "▲" : n < 0 ? "▼" : "•"}</span>
          {format(Math.abs(n), c.format)}
        </span>
      );
    }
    if (!inAgg && c.bar && n !== null && stats[c.key] && stats[c.key].maxAbs > 0) {
      const pct = (Math.abs(n) / stats[c.key].maxAbs) * 100;
      content = (
        <div className="aibi-cell-bar">
          <span className={`aibi-bar${n < 0 ? " aibi-bar-neg" : ""}`} style={{ width: `${pct}%` }} />
          <span className="aibi-bar-text">{content}</span>
        </div>
      );
    }
    return (
      <td key={key} style={{ ...style, ...(cond as CSSProperties | undefined) }} className={c.numeric ? "aibi-num" : undefined}>
        {content}
      </td>
    );
  };

  const renderRow = (row: Row, idx: number) => {
    const rowStyle = styleFor(row) as CSSProperties | undefined;
    const cls = [highlighted.has(row) ? "aibi-row-hl" : "", flashIdx === idx ? "aibi-row-flash" : "", clickable ? "aibi-row-click" : ""].filter(Boolean).join(" ");
    const first = cols[0]?.key;
    return (
      <tr
        key={idx}
        data-idx={idx}
        className={cls || undefined}
        style={rowStyle}
        onClick={() => emit("click", { row, value: first ? row[first] : undefined, name: first ? row[first] : undefined })}
        onDoubleClick={() => emit("dblclick", { row, value: first ? row[first] : undefined, name: first ? row[first] : undefined })}
      >
        {rowNumbers && <td className="aibi-rownum">{idx + 1}</td>}
        {cols.map((c) => renderCell(c, row, c.key))}
      </tr>
    );
  };

  const indexOf = new Map<Row, number>();
  sorted.forEach((r, i) => indexOf.set(r, i));

  let body: ReactNode;
  if (groupBy) {
    const groups = new Map<string, { label: unknown; rows: Row[] }>();
    for (const r of sorted) {
      const k = keyOf(r[groupBy]);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { label: r[groupBy], rows: [] }));
      g.rows.push(r);
    }
    const spanLabel = rowNumbers ? 2 : 1;
    body = [...groups.entries()].map(([k, g]) => {
      const isCollapsed = collapsed.has(k);
      const toggle = () =>
        setCollapsed((s) => {
          const n = new Set(s);
          if (n.has(k)) n.delete(k);
          else n.add(k);
          return n;
        });
      return (
        <Fragment key={`g:${k}`}>
          <tr className="aibi-group-row" onClick={toggle}>
            <td colSpan={spanLabel} className="aibi-group-label">
              <span className={`aibi-caret${isCollapsed ? "" : " aibi-caret-open"}`} aria-hidden="true">▸</span>
              {g.label === null || g.label === undefined || g.label === "" ? "(blank)" : format(g.label, autoSpec(data, groupBy))}
              <span className="aibi-group-count">{g.rows.length}</span>
            </td>
            {cols.slice(1).map((c) => (c.subtotal ? renderCell(c, {}, c.key, aggregate(g.rows.map((r) => r[c.key]), c.subtotal), true) : <td key={c.key} />))}
          </tr>
          {!isCollapsed && g.rows.map((r) => renderRow(r, indexOf.get(r) ?? 0))}
        </Fragment>
      );
    });
  } else {
    body = capped.map((r) => renderRow(r, indexOf.get(r) ?? 0));
  }

  const hasTotals = cols.some((c) => c.total);
  const firstTotalIsLabel = hasTotals && !cols[0]?.total;

  return (
    <div className={`aibi-table-wrap${compact ? " aibi-compact" : ""}`} style={{ ["--aibi-r" as string]: `${theme.radius}px` }}>
      {props.search === true && (
        <div className="aibi-table-toolbar">
          <label className="aibi-table-search">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20 L16.5 16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input type="search" placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search table" />
          </label>
          <span className="aibi-table-count">
            {query ? `${filtered.length.toLocaleString()} of ${rows.length.toLocaleString()}` : `${rows.length.toLocaleString()} rows`}
          </span>
        </div>
      )}
      <div className="aibi-table-scroll" ref={scrollRef}>
        <table className={`aibi-table${sticky ? " aibi-sticky" : ""}`}>
          <colgroup>
            {rowNumbers && <col style={{ width: 44 }} />}
            {cols.map((c) => (
              <col key={c.key} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {rowNumbers && <th className="aibi-rownum">#</th>}
              {cols.map((c) => {
                const dir = sort?.col === c.key ? (sort.desc ? "desc" : "asc") : null;
                return (
                  <th
                    key={c.key}
                    style={{ textAlign: c.align }}
                    className={sortable ? "aibi-sortable" : undefined}
                    onClick={() => onHeader(c)}
                    aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}
                    title={sortable ? `Sort by ${c.label}` : undefined}
                  >
                    <span className={`aibi-th-inner${c.align === "right" ? " aibi-th-right" : c.align === "center" ? " aibi-th-center" : ""}`}>
                      <span className="aibi-th-label">{c.label}</span>
                      {sortable && <SortIcon dir={dir} />}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td className="aibi-table-nomatch" colSpan={cols.length + (rowNumbers ? 1 : 0)}>
                  No matching rows
                </td>
              </tr>
            ) : (
              body
            )}
          </tbody>
          {hasTotals && sorted.length > 0 && (
            <tfoot>
              <tr>
                {rowNumbers && <td className="aibi-rownum" />}
                {cols.map((c, i) =>
                  c.total ? (
                    renderCell(c, {}, c.key, aggregate(filtered.map((r) => r[c.key]), c.total), true)
                  ) : (
                    <td key={c.key} style={{ textAlign: c.align }}>
                      {i === 0 && firstTotalIsLabel ? "Total" : ""}
                    </td>
                  ),
                )}
              </tr>
            </tfoot>
          )}
        </table>
        {!paged && !groupBy && sorted.length > capped.length && (
          <button type="button" className="aibi-table-more" onClick={() => setLimit((l) => l + RENDER_STEP)}>
            Show more ({(sorted.length - capped.length).toLocaleString()} remaining)
          </button>
        )}
      </div>
      {paged && sorted.length > pageSize && (
        <div className="aibi-table-pager">
          <span>
            {(safePage * pageSize + 1).toLocaleString()}–{Math.min(sorted.length, (safePage + 1) * pageSize).toLocaleString()} of {sorted.length.toLocaleString()}
          </span>
          <div className="aibi-pager-btns">
            <button type="button" onClick={() => setPage(0)} disabled={safePage === 0} aria-label="First page">
              «
            </button>
            <button type="button" onClick={() => setPage(safePage - 1)} disabled={safePage === 0} aria-label="Previous page">
              ‹
            </button>
            <span className="aibi-pager-page">
              {safePage + 1} / {pageCount}
            </span>
            <button type="button" onClick={() => setPage(safePage + 1)} disabled={safePage >= pageCount - 1} aria-label="Next page">
              ›
            </button>
            <button type="button" onClick={() => setPage(pageCount - 1)} disabled={safePage >= pageCount - 1} aria-label="Last page">
              »
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
