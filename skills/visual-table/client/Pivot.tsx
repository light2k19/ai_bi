import { useEffect, useMemo, useRef, type CSSProperties } from "react";
import type { WidgetRenderProps } from "@aibi/runtime-api";
import { accentBackground, autoSpec, compareValues, humanize, keyOf, str, strArr, toNum, type Row } from "./util";

type PivotAgg = "sum" | "avg" | "min" | "max" | "count" | "countDistinct";
const PIVOT_AGGS = new Set<PivotAgg>(["sum", "avg", "min", "max", "count", "countDistinct"]);

class Acc {
  sum = 0;
  n = 0;
  count = 0;
  min = Infinity;
  max = -Infinity;
  distinct = new Set<string>();
  add(v: unknown) {
    if (v !== null && v !== undefined && v !== "") {
      this.count++;
      this.distinct.add(keyOf(v));
    }
    const x = toNum(v);
    if (x === null) return;
    this.sum += x;
    this.n++;
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }
  value(agg: PivotAgg): number | null {
    switch (agg) {
      case "count":
        return this.count;
      case "countDistinct":
        return this.distinct.size;
      case "sum":
        return this.n ? this.sum : null;
      case "avg":
        return this.n ? this.sum / this.n : null;
      case "min":
        return this.n ? this.min : null;
      case "max":
        return this.n ? this.max : null;
    }
  }
}

const SEP = "\u0001";

export function PivotWidget(rp: WidgetRenderProps) {
  const { props, data, format, emit, setHandle, styleFor, theme } = rp;
  const names = new Set(data?.columns.map((c) => c.name) ?? []);
  const rowDims = strArr(props.rows).filter((c) => names.has(c));
  const colDims = strArr(props.columns).filter((c) => names.has(c));
  const valueCol = str(props.value) && names.has(str(props.value)!) ? str(props.value)! : undefined;
  const aggIn = str(props.agg) as PivotAgg | undefined;
  const agg: PivotAgg = aggIn && PIVOT_AGGS.has(aggIn) ? aggIn : valueCol ? "sum" : "count";
  const spec = str(props.format) ?? (agg === "count" || agg === "countDistinct" ? "integer" : data && valueCol ? autoSpec(data, valueCol) : undefined);
  const totals = props.totals === true;
  const heat = props.heat === true;
  const columnOrder = strArr(props.columnOrder);

  const model = useMemo(() => {
    const rows = data?.rows ?? [];
    const rowKeys = new Map<string, unknown[]>();
    const colKeys = new Map<string, unknown[]>();
    const cells = new Map<string, Acc>();
    const rowTot = new Map<string, Acc>();
    const colTot = new Map<string, Acc>();
    const grand = new Acc();
    const v = (r: Row) => (valueCol ? r[valueCol] : 1);
    for (const r of rows) {
      const rv = rowDims.map((d) => r[d]);
      const cv = colDims.map((d) => r[d]);
      const rk = rv.map(keyOf).join(SEP);
      const ck = cv.map(keyOf).join(SEP);
      if (!rowKeys.has(rk)) rowKeys.set(rk, rv);
      if (!colKeys.has(ck)) colKeys.set(ck, cv);
      const cellKey = rk + SEP + SEP + ck;
      let a = cells.get(cellKey);
      if (!a) cells.set(cellKey, (a = new Acc()));
      a.add(v(r));
      let t = rowTot.get(rk);
      if (!t) rowTot.set(rk, (t = new Acc()));
      t.add(v(r));
      let c = colTot.get(ck);
      if (!c) colTot.set(ck, (c = new Acc()));
      c.add(v(r));
      grand.add(v(r));
    }
    // column order: explicit list first, then natural order
    const label = (vals: unknown[]) => vals.map((x) => (x === null || x === undefined || x === "" ? "(blank)" : keyOf(x))).join(" · ");
    const colList = [...colKeys.entries()].map(([k, vals]) => ({ k, vals, label: label(vals) }));
    const rank = (c: { vals: unknown[]; label: string }) => {
      const i = columnOrder.findIndex((o) => o === c.label || o === keyOf(c.vals[0]));
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    colList.sort((a, b) => rank(a) - rank(b) || a.vals.reduce<number>((acc, x, i) => acc || compareValues(x, b.vals[i]), 0));
    const rowList = [...rowKeys.entries()].map(([k, vals]) => ({ k, vals }));
    let min = Infinity;
    let max = -Infinity;
    for (const a of cells.values()) {
      const x = a.value(agg);
      if (x === null) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    return { rowList, colList, cells, rowTot, colTot, grand, min, max };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, JSON.stringify(rowDims), JSON.stringify(colDims), valueCol, agg, JSON.stringify(columnOrder)]);

  const colLabel = (vals: unknown[]) => vals.map((x, i) => (x === null || x === undefined || x === "" ? "(blank)" : format(x, data ? autoSpec(data, colDims[i]) : undefined))).join(" · ");

  const pivotRows = useMemo(() => {
    return model.rowList.map((r) => {
      const o: Row = {};
      rowDims.forEach((d, i) => (o[d] = r.vals[i]));
      for (const c of model.colList) o[c.label] = model.cells.get(r.k + SEP + SEP + c.k)?.value(agg) ?? null;
      if (totals) o.Total = model.rowTot.get(r.k)?.value(agg) ?? null;
      return o;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, totals]);
  const pivotRef = useRef(pivotRows);
  pivotRef.current = pivotRows;

  useEffect(() => {
    setHandle({ getRows: () => pivotRef.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!data) return null;
  if (data.rows.length === 0) return <div className="aibi-table-empty">No data</div>;
  if (!rowDims.length && !colDims.length) return <div className="aibi-table-empty">Set `rows` and `columns` to columns of the dataset.</div>;

  const cellStyle = (x: number | null): CSSProperties => {
    if (!heat || x === null || !Number.isFinite(model.min)) return {};
    const t = model.max === model.min ? 0.5 : (x - model.min) / (model.max - model.min);
    return { background: accentBackground(t) };
  };

  const dimLabel = (d: string, v: unknown) => (v === null || v === undefined || v === "" ? "(blank)" : format(v, autoSpec(data, d)));
  const valueTitle = `${agg === "countDistinct" ? "Distinct count" : agg === "avg" ? "Average" : humanize(agg)} of ${valueCol ? humanize(valueCol) : "rows"}`;

  return (
    <div className="aibi-table-wrap aibi-pivot-wrap" style={{ ["--aibi-r" as string]: `${theme.radius}px` }}>
      <div className="aibi-table-scroll">
        <table className="aibi-table aibi-sticky aibi-pivot">
          <thead>
            <tr>
              {rowDims.map((d, i) => (
                <th key={d} className={`aibi-pivot-dim${i === rowDims.length - 1 ? " aibi-pivot-dim-last" : ""}`}>
                  {humanize(d)}
                </th>
              ))}
              {model.colList.map((c) => (
                <th key={c.k} style={{ textAlign: "right" }} title={valueTitle}>
                  {colDims.length ? colLabel(c.vals) : valueTitle}
                </th>
              ))}
              {totals && colDims.length > 0 && (
                <th className="aibi-pivot-total" style={{ textAlign: "right" }}>
                  Total
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {model.rowList.map((r, ri) => {
              const prev = ri > 0 ? model.rowList[ri - 1].vals : null;
              const rowObj = pivotRows[ri];
              return (
                <tr key={r.k}>
                  {rowDims.map((d, i) => {
                    const same = prev !== null && rowDims.slice(0, i + 1).every((_, j) => keyOf(prev[j]) === keyOf(r.vals[j]));
                    return (
                      <th key={d} scope="row" className={`aibi-pivot-dim${same ? " aibi-pivot-rep" : ""}${i === rowDims.length - 1 ? " aibi-pivot-dim-last" : ""}`}>
                        {same ? "" : dimLabel(d, r.vals[i])}
                      </th>
                    );
                  })}
                  {model.colList.map((c) => {
                    const x = model.cells.get(r.k + SEP + SEP + c.k)?.value(agg) ?? null;
                    const cond = styleFor(rowObj, c.label, x) as CSSProperties | undefined;
                    const evRow: Row = { ...rowObj };
                    colDims.forEach((d, i) => (evRow[d] = c.vals[i]));
                    if (valueCol) evRow[valueCol] = x;
                    return (
                      <td
                        key={c.k}
                        className="aibi-num aibi-pivot-cell"
                        style={{ textAlign: "right", ...cellStyle(x), ...cond }}
                        onClick={() => emit("click", { row: evRow, value: x, name: c.label, series: r.vals.map(keyOf).join(" · ") })}
                      >
                        {x === null ? <span className="aibi-pivot-null">–</span> : format(x, spec)}
                      </td>
                    );
                  })}
                  {totals && colDims.length > 0 && (
                    <td className="aibi-num aibi-pivot-total" style={{ textAlign: "right" }}>
                      {format(model.rowTot.get(r.k)?.value(agg), spec)}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {totals && rowDims.length > 0 && (
            <tfoot>
              <tr>
                {rowDims.map((d, i) => (
                  <td key={d} className={`aibi-pivot-dim${i === rowDims.length - 1 ? " aibi-pivot-dim-last" : ""}`}>
                    {i === 0 ? "Total" : ""}
                  </td>
                ))}
                {model.colList.map((c) => (
                  <td key={c.k} className="aibi-num" style={{ textAlign: "right" }}>
                    {format(model.colTot.get(c.k)?.value(agg), spec)}
                  </td>
                ))}
                {colDims.length > 0 && (
                  <td className="aibi-num aibi-pivot-total" style={{ textAlign: "right" }}>
                    {format(model.grand.value(agg), spec)}
                  </td>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
