import type { JsonSchema } from "@aibi/page-spec";
import { Field, Input, Select, Textarea, Toggle } from "../components/ui";

const MASK = "••••••••";

/** Form generated from a (subset of) JSON schema: strings, numbers, booleans, enums, string arrays, objects as JSON. */
export function SchemaForm({ schema, value, onChange, secrets = [] }: { schema: JsonSchema; value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; secrets?: string[] }) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const set = (k: string, v: unknown) => onChange({ ...value, [k]: v });
  return (
    <div className="grid gap-3.5 sm:grid-cols-2">
      {Object.entries(props).map(([k, p]) => {
        const label = `${String(p.title ?? k)}${required.has(k) ? " *" : ""}`;
        const hint = p.description as string | undefined;
        const v = value[k];
        const type = Array.isArray(p.type) ? p.type[0] : p.type;
        const wide = type === "array" || type === "object" || (typeof hint === "string" && hint.length > 60);
        let control;
        if (p.enum) {
          control = (
            <Select value={String(v ?? p.default ?? "")} onChange={(e) => set(k, e.target.value)}>
              {(p.enum as unknown[]).map((o) => (
                <option key={String(o)} value={String(o)}>
                  {String(o)}
                </option>
              ))}
            </Select>
          );
        } else if (type === "boolean") {
          control = (
            <div className="flex h-9 items-center">
              <Toggle checked={Boolean(v ?? p.default ?? false)} onChange={(b) => set(k, b)} label={label} />
            </div>
          );
        } else if (type === "integer" || type === "number") {
          control = <Input type="number" value={v === undefined || v === null ? "" : String(v)} placeholder={p.default !== undefined ? String(p.default) : ""} onChange={(e) => set(k, e.target.value === "" ? undefined : Number(e.target.value))} />;
        } else if (type === "array" && (p.items as JsonSchema | undefined)?.type === "string") {
          control = <Input value={Array.isArray(v) ? (v as string[]).join(", ") : ""} placeholder="comma separated" onChange={(e) => set(k, e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />;
        } else if (type === "array" || type === "object") {
          control = (
            <Textarea
              rows={4}
              className="font-mono text-xs"
              defaultValue={v === undefined ? "" : JSON.stringify(v, null, 2)}
              placeholder={type === "array" ? "[ ]" : "{ }"}
              onBlur={(e) => {
                const t = e.target.value.trim();
                if (!t) return set(k, undefined);
                try {
                  set(k, JSON.parse(t));
                } catch {
                  /* keep previous value until valid JSON */
                }
              }}
            />
          );
        } else {
          const secret = p.format === "password" || secrets.includes(k);
          control = (
            <Input
              type={secret ? "password" : "text"}
              autoComplete={secret ? "new-password" : "off"}
              value={v === undefined || v === null ? "" : String(v)}
              placeholder={secret && v === MASK ? "unchanged" : p.default !== undefined ? String(p.default) : ""}
              onFocus={(e) => secret && v === MASK && (e.target.value = "", set(k, ""))}
              onChange={(e) => set(k, e.target.value)}
            />
          );
        }
        return (
          <Field key={k} label={label} hint={hint} className={wide ? "sm:col-span-2" : undefined}>
            {control}
          </Field>
        );
      })}
    </div>
  );
}
