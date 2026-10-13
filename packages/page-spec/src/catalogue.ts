/**
 * The catalogue describes what a project can use on its pages: widget types, filter types,
 * transforms, script libraries and data sources. It is built on the server from enabled
 * skills and shipped to the browser, the AI, the CLI (authoring kit) and the validator.
 * It is pure data so every consumer can validate without loading skill code.
 */

export type JsonSchema = {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null" | ("object" | "array" | "string" | "number" | "integer" | "boolean" | "null")[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  default?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  minimum?: number;
  maximum?: number;
  examples?: unknown[];
  [k: string]: unknown;
};

export interface WidgetTypeInfo {
  type: string;
  skill: string;
  title: string;
  description: string;
  /** JSON schema of `props` */
  propsSchema: JsonSchema;
  /** prop names whose value is a column name or list of column names of the bound dataset */
  columnProps?: string[];
  /** does the widget need a dataset? */
  needsDataset?: boolean;
  /** guidance for the AI: when to use it */
  aiHints?: string;
  /** methods exposed on widget.handle to page scripts */
  handleMethods?: string[];
  example?: Record<string, unknown>;
  /** default grid size */
  defaultSize?: { w: number; h: number };
}

export interface TransformInfo {
  op: string;
  skill: string;
  description: string;
  schema: JsonSchema;
  example?: Record<string, unknown>;
}

export interface FilterTypeInfo {
  type: string;
  skill: string;
  description: string;
  fields: string[];
  example?: Record<string, unknown>;
}

export interface ScriptLibInfo {
  name: string;
  skill: string;
  description: string;
  docs: string;
}

export interface SourceInfo {
  alias: string;
  name: string;
  skill: string;
  kind: "sql" | "http" | "other";
  dialect?: string;
  description?: string;
}

export interface Catalogue {
  widgets: WidgetTypeInfo[];
  transforms: TransformInfo[];
  filters: FilterTypeInfo[];
  scriptLibs: ScriptLibInfo[];
  sources: SourceInfo[];
  /** installed skills and versions */
  skills: Record<string, string>;
  /** hosts modules may be loaded from */
  moduleHosts: string[];
}

export const EMPTY_CATALOGUE: Catalogue = { widgets: [], transforms: [], filters: [], scriptLibs: [], sources: [], skills: {}, moduleHosts: [] };

/** Minimal JSON-schema checker (subset) used for widget props and transform steps. */
export function checkSchema(value: unknown, schema: JsonSchema, path = ""): string[] {
  const errs: string[] = [];
  const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
  const typeOf = (v: unknown) =>
    v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
  if (schema.anyOf || schema.oneOf) {
    const alts = (schema.anyOf ?? schema.oneOf)!;
    if (!alts.some((s) => checkSchema(value, s, path).length === 0)) errs.push(`${path || "value"}: does not match any allowed shape`);
    return errs;
  }
  if (types) {
    const t = typeOf(value);
    const okType = types.some((x) => x === t || (x === "number" && t === "integer"));
    // allow {{bindings}} strings anywhere
    const isBinding = typeof value === "string" && value.includes("{{");
    if (!okType && !isBinding) {
      errs.push(`${path || "value"}: expected ${types.join(" | ")}, got ${t}`);
      return errs;
    }
  }
  if (schema.enum && !schema.enum.includes(value as never) && !(typeof value === "string" && value.includes("{{"))) {
    errs.push(`${path || "value"}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (obj[r] === undefined) errs.push(`${path ? path + "." : ""}${r}: is required`);
    if (schema.properties) {
      for (const [k, v] of Object.entries(obj)) {
        const ps = schema.properties[k];
        if (ps) errs.push(...checkSchema(v, ps, path ? `${path}.${k}` : k));
        else if (schema.additionalProperties === false) errs.push(`${path ? path + "." : ""}${k}: unknown property`);
      }
    }
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errs.push(...checkSchema(v, schema.items!, `${path}[${i}]`)));
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: must be <= ${schema.maximum}`);
  }
  return errs;
}
