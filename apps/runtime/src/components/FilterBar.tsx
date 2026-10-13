import type { Filter } from "@aibi/page-spec";
import { setFilters, loadAll, type RState } from "../engine";

function Fallback({ f, raw, onChange }: { f: Filter; raw: unknown; onChange: (v: unknown) => void }) {
  return <input className="rt-input" value={typeof raw === "string" ? raw : JSON.stringify(raw ?? "")} onChange={(e) => onChange(e.target.value)} aria-label={f.label ?? f.id} />;
}

export function FilterBar({ s }: { s: RState }) {
  const filters = s.bundle?.page.filters ?? [];
  const anySet = Object.keys(s.filtersRaw).length > 0;
  const fetchedAt = Object.values(s.frames).map((f) => f?.meta?.fetchedAt).filter(Boolean).sort().pop();
  const loading = Object.values(s.loading).some(Boolean);
  if (!filters.length && s.mode === "render") return null;
  return (
    <div className="rt-filterbar">
      <div className="rt-filters">
        {filters.map((f) => {
          const ui = s.filterUIs.get(f.type);
          const raw = f.id in s.filtersRaw ? s.filtersRaw[f.id] : f.default;
          const onChange = (v: unknown) => void setFilters({ ...s.filtersRaw, [f.id]: v }, [f.id]);
          return (
            <div key={f.id} className="rt-filter" style={f.width ? { minWidth: `${f.width * 60}px` } : undefined}>
              {ui ? (
                <ui.component filter={f} raw={raw} value={s.filterValues[f.id]} options={s.filterOptions[f.id] ?? []} onChange={onChange} theme={s.theme!} />
              ) : (
                <label className="rt-filter-fallback">
                  <span>{f.label ?? f.id}</span>
                  <Fallback f={f} raw={raw} onChange={onChange} />
                </label>
              )}
            </div>
          );
        })}
      </div>
      {s.mode !== "render" && (
        <div className="rt-filter-actions">
          {anySet && (
            <button className="rt-link-btn" onClick={() => void setFilters({}, filters.map((f) => f.id))}>
              Reset
            </button>
          )}
          <button className="rt-icon-btn" title={fetchedAt ? `Data loaded ${new Date(fetchedAt).toLocaleTimeString()}` : "Refresh data"} onClick={() => void loadAll(true)} aria-label="Refresh data">
            <span className={loading ? "rt-spin" : ""}>↻</span>
          </button>
        </div>
      )}
    </div>
  );
}
