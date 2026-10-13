import crypto from "node:crypto";
import { config } from "../config";

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(10).toString("base64url")}`;
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (s: string | Buffer) => crypto.createHash("sha256").update(s).digest("hex");
export const sri = (buf: Buffer | string) => `sha384-${crypto.createHash("sha384").update(buf).digest("base64")}`;

/* passwords: scrypt */
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export function verifyPassword(pw: string, stored: string | null | undefined): boolean {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, s, h] = stored.split("$");
  const expected = Buffer.from(h, "base64");
  const got = crypto.scryptSync(pw, Buffer.from(s, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, got);
}

/* secrets at rest: AES-256-GCM with the deployment key */
const PREFIX = "enc:v1:";
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", config.key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(s: string): string {
  if (!s.startsWith(PREFIX)) return s;
  const raw = Buffer.from(s.slice(PREFIX.length), "base64");
  const d = crypto.createDecipheriv("aes-256-gcm", config.key, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
export const isEncrypted = (v: unknown) => typeof v === "string" && v.startsWith(PREFIX);

/** Encrypt the secret keys of a config object (supports `a.*.b` wildcard paths into arrays). */
export function sealSecrets(cfg: Record<string, unknown>, secretPaths: string[], previous?: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(cfg);
  for (const p of secretPaths) walkPath(out, p.split("."), (holder, key, prevHolder) => {
    const v = holder[key];
    if (v === undefined || v === null || v === "") {
      // keep the stored secret when the client sends an empty / masked value
      const pv = prevHolder?.[key];
      if (pv !== undefined) holder[key] = pv;
      return;
    }
    if (v === MASK) {
      const pv = prevHolder?.[key];
      if (pv !== undefined) holder[key] = pv;
      else delete holder[key];
      return;
    }
    if (!isEncrypted(v)) holder[key] = encrypt(String(v));
  }, previous);
  return out;
}
export function openSecrets(cfg: Record<string, unknown>, secretPaths: string[]): Record<string, unknown> {
  const out = structuredClone(cfg);
  for (const p of secretPaths) walkPath(out, p.split("."), (holder, key) => {
    const v = holder[key];
    if (isEncrypted(v)) holder[key] = decrypt(v as string);
  });
  return out;
}
export const MASK = "••••••••";
export function maskSecrets(cfg: Record<string, unknown>, secretPaths: string[]): Record<string, unknown> {
  const out = structuredClone(cfg);
  for (const p of secretPaths) walkPath(out, p.split("."), (holder, key) => {
    if (holder[key] !== undefined && holder[key] !== "") holder[key] = MASK;
  });
  return out;
}

function walkPath(
  obj: Record<string, unknown>,
  parts: string[],
  fn: (holder: Record<string, unknown>, key: string, prevHolder?: Record<string, unknown>) => void,
  prev?: Record<string, unknown>,
) {
  if (!obj || typeof obj !== "object") return;
  const [head, ...rest] = parts;
  if (!rest.length) {
    fn(obj, head, prev);
    return;
  }
  const next = obj[head];
  const prevNext = prev?.[head];
  if (rest[0] === "*" && Array.isArray(next)) {
    next.forEach((item, i) => {
      const prevItem = Array.isArray(prevNext)
        ? ((prevNext as Record<string, unknown>[]).find((x) => x && (x as { id?: unknown }).id !== undefined && x.id === (item as { id?: unknown })?.id) ?? (prevNext as Record<string, unknown>[])[i])
        : undefined;
      walkPath(item as Record<string, unknown>, rest.slice(1), fn, prevItem);
    });
    return;
  }
  walkPath(next as Record<string, unknown>, rest, fn, prevNext as Record<string, unknown> | undefined);
}

/* HMAC-signed short tokens (render tokens for PDF export) */
export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  const sig = crypto.createHmac("sha256", config.key).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function verifyToken<T extends Record<string, unknown>>(token: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = crypto.createHmac("sha256", config.key).update(body).digest("base64url");
  if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number };
  if (p.exp < Date.now() / 1000) return null;
  return p;
}
