/** Minimal JSON-Patch style diff (RFC 6902 ops: add, remove, replace) for version comparison. */
export interface PatchOp {
  op: "add" | "remove" | "replace";
  path: string;
  value?: unknown;
  old?: unknown;
}

const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");

export function diff(a: unknown, b: unknown, path = "", out: PatchOp[] = []): PatchOp[] {
  if (a === b) return out;
  const ta = Array.isArray(a) ? "array" : a === null ? "null" : typeof a;
  const tb = Array.isArray(b) ? "array" : b === null ? "null" : typeof b;
  if (ta !== tb || (ta !== "object" && ta !== "array")) {
    if (a === undefined) out.push({ op: "add", path: path || "/", value: b });
    else if (b === undefined) out.push({ op: "remove", path: path || "/", old: a });
    else out.push({ op: "replace", path: path || "/", value: b, old: a });
    return out;
  }
  if (ta === "array") {
    const aa = a as unknown[];
    const bb = b as unknown[];
    // arrays of objects with ids are diffed by id for readable output
    const ids = (arr: unknown[]) => arr.every((x) => x && typeof x === "object" && typeof (x as { id?: unknown }).id === "string" || typeof (x as { name?: unknown })?.name === "string");
    if (aa.length && bb.length && ids(aa) && ids(bb)) {
      const key = (x: unknown) => String((x as { id?: string; name?: string }).id ?? (x as { name?: string }).name);
      const am = new Map(aa.map((x) => [key(x), x]));
      const bm = new Map(bb.map((x) => [key(x), x]));
      for (const [k, v] of am) if (!bm.has(k)) out.push({ op: "remove", path: `${path}/${esc(k)}`, old: v });
      for (const [k, v] of bm) {
        if (!am.has(k)) out.push({ op: "add", path: `${path}/${esc(k)}`, value: v });
        else diff(am.get(k), v, `${path}/${esc(k)}`, out);
      }
      return out;
    }
    const n = Math.max(aa.length, bb.length);
    for (let i = 0; i < n; i++) diff(aa[i], bb[i], `${path}/${i}`, out);
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) diff(ao[k], bo[k], `${path}/${esc(k)}`, out);
  return out;
}
