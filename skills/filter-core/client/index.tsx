import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClientSkillModule, FilterUIProps } from "@aibi/runtime-api";
import { DATE_PRESETS, formatValue, type DateRangeValue, type MultiSelectValue, type NumberRangeValue, type SearchValue, type SelectValue, type ToggleValue } from "@aibi/page-spec";
import "./styles.css";

type OptValue = string | number | boolean;

const PRESET_LABELS: Record<string, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7d: "Last 7 days",
  last30d: "Last 30 days",
  last90d: "Last 90 days",
  MTD: "Month to date",
  QTD: "Quarter to date",
  YTD: "Year to date",
  lastMonth: "Last month",
  lastQuarter: "Last quarter",
  lastYear: "Last year",
  last12m: "Last 12 months",
  custom: "Custom range",
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function Field({ label, htmlFor, children, inline = false }: { label?: string; htmlFor?: string; children: ReactNode; inline?: boolean }) {
  return (
    <div className={`aibi-filter${inline ? " aibi-filter-inline" : ""}`}>
      {label && (
        <label className="aibi-filter-label" htmlFor={htmlFor}>
          {label}
        </label>
      )}
      <div className="aibi-filter-control">{children}</div>
    </div>
  );
}

const Chevron = () => (
  <svg className="aibi-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d="M2 3.5 L5 6.5 L8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function radiusVar(theme: FilterUIProps["theme"]) {
  return { ["--aibi-r" as string]: `${theme.radius}px` };
}

/* ───────────────────────── dateRange ───────────────────────── */

function fmtDate(d: string | undefined): string {
  return d ? formatValue(d, "date") : "";
}

function DateRangeFilter({ filter, raw, value, onChange, theme }: FilterUIProps) {
  const id = useId();
  const v = value as DateRangeValue | undefined;
  const presets = (filter.presets?.length ? filter.presets : DATE_PRESETS) as readonly string[];
  const rawObj = typeof raw === "string" ? { preset: raw } : isObj(raw) ? raw : {};
  const preset = typeof rawObj.preset === "string" ? rawObj.preset : rawObj.start || rawObj.end ? "custom" : (v?.preset ?? "YTD");
  const options = presets.includes(preset) ? presets : [...presets, preset];
  const isCustom = preset === "custom";
  const start = v?.start ?? (typeof rawObj.start === "string" ? rawObj.start : "");
  const end = v?.end ?? (typeof rawObj.end === "string" ? rawObj.end : "");

  const onPreset = (p: string) => {
    if (p === "custom") onChange({ preset: "custom", start, end });
    else onChange({ preset: p });
  };
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const range = start && end ? (start === end ? fmtDate(start) : `${sameYear ? formatValue(start, "date").replace(/,?\s*\d{4}$/, "") : fmtDate(start)} – ${fmtDate(end)}`) : "";

  return (
    <Field label={filter.label ?? filter.id} htmlFor={id}>
      <div className="aibi-daterange" style={radiusVar(theme)}>
        <div className="aibi-select-wrap">
          <select id={id} className="aibi-input aibi-select" value={preset} onChange={(e) => onPreset(e.target.value)}>
            {options.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p] ?? p}
              </option>
            ))}
          </select>
          <Chevron />
        </div>
        {isCustom ? (
          <div className="aibi-date-inputs">
            <input
              type="date"
              className="aibi-input aibi-date"
              value={start}
              max={end || undefined}
              aria-label="Start date"
              onChange={(e) => e.target.value && onChange({ preset: "custom", start: e.target.value, end: end || e.target.value })}
            />
            <span className="aibi-date-sep">–</span>
            <input
              type="date"
              className="aibi-input aibi-date"
              value={end}
              min={start || undefined}
              aria-label="End date"
              onChange={(e) => e.target.value && onChange({ preset: "custom", start: start || e.target.value, end: e.target.value })}
            />
          </div>
        ) : (
          range && (
            <span className="aibi-filter-hint" title={`${start} – ${end}`}>
              {range}
            </span>
          )
        )}
      </div>
    </Field>
  );
}

/* ───────────────────────── select ───────────────────────── */

function SelectFilter({ filter, raw, value, options, onChange, theme }: FilterUIProps) {
  const id = useId();
  const current = (value as SelectValue | undefined)?.value ?? (isObj(raw) ? raw.value : raw);
  const idx = options.findIndex((o) => String(o.value) === String(current));
  return (
    <Field label={filter.label ?? filter.id} htmlFor={id}>
      <div className="aibi-select-wrap" style={radiusVar(theme)}>
        <select id={id} className="aibi-input aibi-select" value={idx >= 0 ? String(idx) : ""} onChange={(e) => onChange(options[Number(e.target.value)]?.value ?? null)}>
          {idx < 0 && (
            <option value="" disabled>
              {filter.placeholder ?? "Select…"}
            </option>
          )}
          {options.map((o, i) => (
            <option key={`${String(o.value)}-${i}`} value={String(i)}>
              {o.label || String(o.value)}
            </option>
          ))}
        </select>
        <Chevron />
      </div>
    </Field>
  );
}

/* ───────────────────────── multiSelect ───────────────────────── */

function MultiSelectFilter({ filter, raw, value, options, onChange, theme }: FilterUIProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const mv = value as MultiSelectValue | undefined;
  const all = raw === "all" || raw === undefined || raw === null || (mv?.all ?? false) || (isObj(raw) && raw.all === true);
  const selectedVals: OptValue[] = all ? options.map((o) => o.value) : Array.isArray(raw) ? (raw as OptValue[]) : (mv?.values ?? []);
  const selected = useMemo(() => new Set(selectedVals.map(String)), [selectedVals]);
  const labelOf = (v: OptValue) => options.find((o) => String(o.value) === String(v))?.label || String(v);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    const t = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [open]);
  useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const commit = (next: Set<string>) => {
    if (next.size === 0 || (options.length > 0 && options.every((o) => next.has(String(o.value))))) onChange("all");
    else onChange(options.filter((o) => next.has(String(o.value))).map((o) => o.value));
  };
  const toggle = (v: OptValue) => {
    const next = new Set(selected);
    const k = String(v);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    commit(next);
  };
  const only = (v: OptValue) => onChange([v]);

  const count = all ? options.length : selectedVals.length;
  const summary = all ? "All" : selectedVals.length === 1 ? labelOf(selectedVals[0]) : selectedVals.length === 0 ? "None" : `${selectedVals.length} selected`;
  const query = q.trim().toLowerCase();
  const shown = query ? options.filter((o) => (o.label || String(o.value)).toLowerCase().includes(query)) : options;
  const someSelected = !all && count > 0;

  return (
    <Field label={filter.label ?? filter.id} htmlFor={id}>
      <div className="aibi-multi" ref={rootRef} style={radiusVar(theme)}>
        <button
          id={id}
          type="button"
          className={`aibi-input aibi-multi-btn${open ? " aibi-open" : ""}${!all ? " aibi-active" : ""}`}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={all ? "All" : selectedVals.map(labelOf).join(", ")}
        >
          <span className="aibi-multi-summary">{summary}</span>
          {!all && selectedVals.length > 1 && <span className="aibi-multi-count">{selectedVals.length}</span>}
          <Chevron />
        </button>
        {open && (
          <div className="aibi-popover" role="listbox" aria-multiselectable="true">
            {options.length > 8 && (
              <div className="aibi-popover-search">
                <input ref={searchRef} type="search" className="aibi-input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search options" />
              </div>
            )}
            {!query && (
              <label className="aibi-check aibi-check-all">
                <input
                  type="checkbox"
                  checked={all}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={() => onChange("all")}
                />
                <span className="aibi-check-label">All</span>
                <span className="aibi-check-meta">{options.length}</span>
              </label>
            )}
            <div className="aibi-popover-list">
              {shown.length === 0 && <div className="aibi-popover-empty">{options.length ? "No matches" : "No options"}</div>}
              {shown.map((o, i) => (
                <label key={`${String(o.value)}-${i}`} className="aibi-check">
                  <input type="checkbox" checked={!all && selected.has(String(o.value))} onChange={() => (all ? only(o.value) : toggle(o.value))} />
                  <span className="aibi-check-label">{o.label || String(o.value)}</span>
                  <button
                    type="button"
                    className="aibi-only"
                    onClick={(e) => {
                      e.preventDefault();
                      only(o.value);
                    }}
                  >
                    only
                  </button>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </Field>
  );
}

/* ───────────────────────── search ───────────────────────── */

function SearchFilter({ filter, raw, value, onChange, theme }: FilterUIProps) {
  const id = useId();
  const external = (value as SearchValue | undefined)?.text ?? (typeof raw === "string" ? raw : "");
  const [text, setText] = useState(external);
  const pending = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!pending.current) setText(external);
  }, [external]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const update = (t: string, immediate = false) => {
    setText(t);
    pending.current = true;
    window.clearTimeout(timer.current);
    const fire = () => {
      pending.current = false;
      onChangeRef.current(t);
    };
    if (immediate) fire();
    else timer.current = window.setTimeout(fire, 300);
  };

  return (
    <Field label={filter.label ?? filter.id} htmlFor={id}>
      <div className="aibi-search" style={radiusVar(theme)}>
        <svg className="aibi-search-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M20 20 L16.5 16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          id={id}
          type="text"
          className="aibi-input aibi-search-input"
          placeholder={filter.placeholder ?? "Search…"}
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") update(text, true);
            if (e.key === "Escape" && text) update("", true);
          }}
        />
        {text && (
          <button type="button" className="aibi-clear" onClick={() => update("", true)} aria-label="Clear search">
            ×
          </button>
        )}
      </div>
    </Field>
  );
}

/* ───────────────────────── numberRange ───────────────────────── */

function NumberRangeFilter({ filter, raw, value, onChange, theme }: FilterUIProps) {
  const id = useId();
  const nv = value as NumberRangeValue | undefined;
  const r = isObj(raw) ? raw : {};
  const extMin = nv?.min ?? (typeof r.min === "number" ? r.min : null);
  const extMax = nv?.max ?? (typeof r.max === "number" ? r.max : null);
  const [minText, setMinText] = useState(extMin === null ? "" : String(extMin));
  const [maxText, setMaxText] = useState(extMax === null ? "" : String(extMax));
  const pending = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (pending.current) return;
    setMinText(extMin === null ? "" : String(extMin));
    setMaxText(extMax === null ? "" : String(extMax));
  }, [extMin, extMax]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const parse = (s: string): number | null => {
    if (s.trim() === "") return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const schedule = (mn: string, mx: string, immediate = false) => {
    pending.current = true;
    window.clearTimeout(timer.current);
    const fire = () => {
      pending.current = false;
      onChangeRef.current({ min: parse(mn), max: parse(mx) });
    };
    if (immediate) fire();
    else timer.current = window.setTimeout(fire, 500);
  };

  return (
    <Field label={filter.label ?? filter.id} htmlFor={id}>
      <div className="aibi-numrange" style={radiusVar(theme)}>
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className="aibi-input aibi-num"
          placeholder={filter.min !== undefined ? `Min (${filter.min})` : "Min"}
          value={minText}
          aria-label="Minimum"
          onChange={(e) => (setMinText(e.target.value), schedule(e.target.value, maxText))}
          onBlur={() => pending.current && schedule(minText, maxText, true)}
          onKeyDown={(e) => e.key === "Enter" && schedule(minText, maxText, true)}
        />
        <span className="aibi-date-sep">–</span>
        <input
          type="number"
          inputMode="decimal"
          className="aibi-input aibi-num"
          placeholder={filter.max !== undefined ? `Max (${filter.max})` : "Max"}
          value={maxText}
          aria-label="Maximum"
          onChange={(e) => (setMaxText(e.target.value), schedule(minText, e.target.value))}
          onBlur={() => pending.current && schedule(minText, maxText, true)}
          onKeyDown={(e) => e.key === "Enter" && schedule(minText, maxText, true)}
        />
      </div>
    </Field>
  );
}

/* ───────────────────────── toggle ───────────────────────── */

function ToggleFilter({ filter, raw, value, onChange, theme }: FilterUIProps) {
  const on = (value as ToggleValue | undefined)?.on ?? (typeof raw === "boolean" ? raw : isObj(raw) && raw.on === true);
  return (
    <div className="aibi-filter aibi-filter-toggle" style={radiusVar(theme)}>
      <span className="aibi-filter-label aibi-label-spacer" aria-hidden="true">
        &nbsp;
      </span>
      <button type="button" role="switch" aria-checked={on} className={`aibi-switch${on ? " aibi-on" : ""}`} onClick={() => onChange(!on)}>
        <span className="aibi-switch-track">
          <span className="aibi-switch-thumb" />
        </span>
        <span className="aibi-switch-label">{filter.label ?? filter.id}</span>
      </button>
    </div>
  );
}

const mod: ClientSkillModule = {
  filters: [
    { type: "dateRange", component: DateRangeFilter },
    { type: "select", component: SelectFilter },
    { type: "multiSelect", component: MultiSelectFilter },
    { type: "search", component: SearchFilter },
    { type: "numberRange", component: NumberRangeFilter },
    { type: "toggle", component: ToggleFilter },
  ],
};

export default mod;
