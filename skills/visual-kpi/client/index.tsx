import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ClientSkillModule, WidgetRenderProps } from "@aibi/runtime-api";
import { kpiSpec, kpiValues, type KpiSpec, type KpiValues } from "./kpi-model";
import "./styles.css";

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Animated number: counts up from 0 on first render and from the previous value on change.
 * `replay` (a counter) restarts from 0.
 */
function useCountUp(target: number | null, enabled: boolean, replay: number, duration = 1000): number | null {
  const [shown, setShown] = useState<number | null>(enabled && target !== null ? 0 : target);
  const shownRef = useRef<number | null>(shown);
  const replayRef = useRef(replay);
  useEffect(() => {
    if (target === null) {
      shownRef.current = null;
      setShown(null);
      return;
    }
    const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (!enabled || reduced) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    const fromZero = replayRef.current !== replay;
    replayRef.current = replay;
    const from = fromZero ? 0 : (shownRef.current ?? 0);
    if (from === target) {
      setShown(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const v = t >= 1 ? target : from + (target - from) * easeOutCubic(t);
      shownRef.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, enabled, replay, duration]);
  return shown;
}

function Sparkline({ values, color, height }: { values: number[]; color: string; height: number }) {
  const id = useId().replace(/:/g, "");
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 28 - ((v - min) / span) * 26]);
  const line = pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const area = `M0,30 L${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" L")} L100,30 Z`;
  return (
    <svg className="aibi-kpi-spark" viewBox="0 0 100 30" preserveAspectRatio="none" style={{ height }} aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#g${id})`} stroke="none" />
      <polyline points={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

interface BodyProps {
  spec: KpiSpec;
  vals: KpiValues;
  format: WidgetRenderProps["format"];
  animate: boolean;
  replay: number;
  override: number | null;
  width: number;
  height: number;
  compact: boolean;
  accent: string;
}

function KpiBody({ spec, vals, format, animate, replay, override, width, height, compact, accent }: BodyProps) {
  const target = override ?? vals.value;
  const shown = useCountUp(target, animate, replay);
  const color = spec.color ?? accent;

  const hasDelta = vals.delta !== null;
  const hasTarget = vals.target !== null && vals.target !== 0 && vals.value !== null;
  const hasSpark = vals.spark.length > 1;
  const hasNote = !!spec.note;

  // typography scales with the box: reserve room for the secondary lines, give the rest to the number
  const labelSize = clamp(Math.min(width / 18, height / 8), 11, compact ? 13 : 15);
  const lineH = labelSize * 1.5;
  const sparkH = hasSpark ? clamp(height * (compact ? 0.18 : 0.24), 14, compact ? 26 : 44) : 0;
  const reserved = lineH + (hasDelta ? lineH : 0) + (hasTarget ? lineH + 8 : 0) + sparkH + (hasNote ? lineH * 0.9 : 0) + 8;
  const valueSize = clamp(Math.min((height - reserved) / 1.15, width / (compact ? 6.8 : 6)), compact ? 16 : 18, compact ? 40 : 64);
  const showSpark = hasSpark && height - reserved > 10;
  const showNote = hasNote && (!compact || height > 110);

  const good = vals.delta === null || vals.delta === 0 ? null : spec.invert ? vals.delta < 0 : vals.delta > 0;
  const ratio = hasTarget ? (vals.value as number) / (vals.target as number) : 0;

  return (
    <div className={`aibi-kpi-body${compact ? " aibi-kpi-compact" : ""}`} style={{ ["--aibi-kpi-label" as string]: `${labelSize}px` }}>
      <div className="aibi-kpi-head">
        {spec.icon && (
          <span className="aibi-kpi-icon" style={{ ["--aibi-kpi-color" as string]: color }} aria-hidden="true">
            {spec.icon}
          </span>
        )}
        {spec.label && <span className="aibi-kpi-label" title={spec.label}>{spec.label}</span>}
      </div>
      <div className="aibi-kpi-value" style={{ fontSize: valueSize, color: spec.color }} title={vals.value !== null ? format(vals.value, spec.format) : undefined}>
        {shown === null ? "–" : format(shown, spec.format)}
      </div>
      {hasDelta && (
        <div className="aibi-kpi-delta" title={vals.compare !== null ? `${spec.compareLabel ?? "Comparison"}: ${format(vals.compare, spec.format)}` : undefined}>
          <span className={`aibi-kpi-chip ${good === null ? "aibi-kpi-flat" : good ? "aibi-kpi-good" : "aibi-kpi-bad"}`}>
            <span className="aibi-kpi-arrow" aria-hidden="true">{(vals.delta as number) > 0 ? "▲" : (vals.delta as number) < 0 ? "▼" : "•"}</span>
            {format(Math.abs(vals.delta as number), "percent:1")}
          </span>
          <span className="aibi-kpi-compare">{spec.compareLabel ?? "vs previous"}</span>
        </div>
      )}
      {hasTarget && (
        <div className="aibi-kpi-target" title={`Target ${format(vals.target, spec.format)}`}>
          <div className="aibi-kpi-track">
            <div
              className={`aibi-kpi-fill${ratio >= 1 ? " aibi-kpi-fill-done" : ""}`}
              style={{ width: `${clamp(ratio, 0, 1) * 100}%`, ...(ratio < 1 ? ({ ["--aibi-kpi-color" as string]: color } as CSSProperties) : {}) }}
            />
          </div>
          <div className="aibi-kpi-target-text">
            <strong className={ratio >= 1 ? "aibi-kpi-good-text" : undefined}>{format(ratio, "percent:0")}</strong>
            <span>of {format(vals.target, spec.format)} target</span>
          </div>
        </div>
      )}
      {showSpark && (
        <div className="aibi-kpi-spark-wrap">
          <Sparkline values={vals.spark} color={color} height={sparkH} />
        </div>
      )}
      {showNote && <div className="aibi-kpi-note">{spec.note}</div>}
    </div>
  );
}

/** count-up / flash handles shared by kpi and kpiRow */
function useKpiHandles(setHandle: WidgetRenderProps["setHandle"]) {
  const [replay, setReplay] = useState(0);
  const [override, setOverride] = useState<number | null>(null);
  const [flash, setFlash] = useState(0);
  useEffect(() => {
    setHandle({
      countUp: (value?: unknown) => {
        const n = typeof value === "number" ? value : value !== undefined && value !== null && value !== "" ? Number(value) : NaN;
        setOverride(Number.isFinite(n) ? n : null);
        setReplay((r) => r + 1);
      },
      flash: () => setFlash((f) => f + 1),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { replay, override, setOverride, flash };
}

function useFlashClass(flash: number): string {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flash) return;
    setOn(false);
    const r = requestAnimationFrame(() => setOn(true));
    const t = window.setTimeout(() => setOn(false), 950);
    return () => {
      cancelAnimationFrame(r);
      window.clearTimeout(t);
    };
  }, [flash]);
  return on ? " aibi-kpi-flash" : "";
}

function KpiWidget(rp: WidgetRenderProps) {
  const { widget, props, data, format, width, height, theme, setHandle } = rp;
  const raw = widget.props ?? {};
  const spec = useMemo(() => kpiSpec(raw, props, !widget.title), [raw, props, widget.title]);
  const vals = useMemo(() => kpiValues(spec, data), [spec, data]);
  const { replay, override, setOverride, flash } = useKpiHandles(setHandle);
  const flashCls = useFlashClass(flash);
  useEffect(() => setOverride(null), [data, setOverride]);

  if (data && data.rows.length === 0 && spec.value && "col" in spec.value) return <div className="aibi-kpi-empty">No data</div>;

  return (
    <div className={`aibi-kpi${flashCls}`} style={{ ["--aibi-r" as string]: `${theme.radius}px` }}>
      <KpiBody
        spec={spec}
        vals={vals}
        format={format}
        animate={props.animate !== false}
        replay={replay}
        override={override}
        width={width}
        height={height}
        compact={false}
        accent={theme.accent}
      />
    </div>
  );
}

function KpiRowWidget(rp: WidgetRenderProps) {
  const { widget, props, data, format, width, height, theme, setHandle } = rp;
  const rawItems = Array.isArray(widget.props?.items) ? (widget.props?.items as unknown[]) : [];
  const items = Array.isArray(props.items) ? props.items : [];
  const specs = useMemo(
    () =>
      items.map((it, i) => {
        const resolved = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
        const r = rawItems[i] && typeof rawItems[i] === "object" ? (rawItems[i] as Record<string, unknown>) : resolved;
        return kpiSpec(r, resolved, true);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(items), JSON.stringify(rawItems)],
  );
  const vals = useMemo(() => specs.map((s) => kpiValues(s, data)), [specs, data]);
  const { replay, flash } = useKpiHandles(setHandle);
  const flashCls = useFlashClass(flash);

  if (!specs.length) return <div className="aibi-kpi-empty">Add `items` to show KPIs.</div>;
  if (data && data.rows.length === 0) return <div className="aibi-kpi-empty">No data</div>;

  const n = specs.length;
  const perRow = Math.max(1, Math.min(n, Math.floor(width / 150) || 1));
  const rows = Math.ceil(n / perRow);
  const itemW = width / perRow;
  const itemH = height / rows;

  return (
    <div
      className={`aibi-kpi-row${flashCls}`}
      style={{ ["--aibi-r" as string]: `${theme.radius}px`, gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))` }}
    >
      {specs.map((s, i) => (
        <div key={i} className="aibi-kpi-item" style={{ animationDelay: `${i * 70}ms` }}>
          <KpiBody
            spec={s}
            vals={vals[i]}
            format={format}
            animate={props.animate !== false}
            replay={replay}
            override={null}
            width={itemW - 24}
            height={itemH - 8}
            compact
            accent={theme.accent}
          />
        </div>
      ))}
    </div>
  );
}

const mod: ClientSkillModule = {
  widgets: [
    { type: "kpi", component: KpiWidget },
    { type: "kpiRow", component: KpiRowWidget },
  ],
};

export default mod;
