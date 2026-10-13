import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "../../..");

const env = process.env;
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);

function dataDir() {
  const d = path.resolve(ROOT, env.AIBI_DATA_DIR ?? "data");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** A stable secret for encrypting data-source credentials and signing tokens. */
function masterKey(dir: string): Buffer {
  if (env.AIBI_SECRET) return crypto.createHash("sha256").update(env.AIBI_SECRET).digest();
  const file = path.join(dir, ".secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  return crypto.createHash("sha256").update(fs.readFileSync(file, "utf8").trim()).digest();
}

const DATA = dataDir();

export const config = {
  root: ROOT,
  dataDir: DATA,
  skillsDir: path.join(ROOT, "skills"),
  uploadedSkillsDir: path.join(DATA, "skills"),
  modulesDir: path.join(DATA, "modules"),
  packagesDir: path.join(DATA, "packages"),
  dbFile: path.join(DATA, "aibi.db"),
  key: masterKey(DATA),
  port: num(env.PORT, 8787),
  host: env.HOST ?? "127.0.0.1",
  /** origin of the host SPA (cookies, CSRF origin check) */
  webOrigin: env.AIBI_WEB_ORIGIN ?? "http://localhost:5173",
  /** separate origin serving the sandboxed page runtime */
  runtimeOrigin: env.AIBI_RUNTIME_ORIGIN ?? "http://localhost:5174",
  /** public base URL of this API as seen by browsers (module URLs) */
  publicApiUrl: env.AIBI_PUBLIC_API_URL ?? `http://localhost:${num(env.PORT, 8787)}`,
  /** port serving the built runtime in production (separate origin) */
  runtimePort: num(env.RUNTIME_PORT, 0),
  /**
   * Addresses the server itself uses to reach the API and the page runtime, for PDF export and preview
   * screenshots rendered by the headless browser on the server. The public origins can be unreachable from
   * there (Docker port mappings, reverse proxies), so these default to the local listeners.
   */
  internalApiUrl: env.AIBI_INTERNAL_API_URL ?? `http://127.0.0.1:${num(env.PORT, 8787)}`,
  internalRuntimeUrl: env.AIBI_INTERNAL_RUNTIME_URL ?? (num(env.RUNTIME_PORT, 0) ? `http://127.0.0.1:${num(env.RUNTIME_PORT, 0)}` : (env.AIBI_RUNTIME_ORIGIN ?? "http://localhost:5174")),
  webDist: path.join(ROOT, "apps/web/dist"),
  runtimeDist: path.join(ROOT, "apps/runtime/dist"),
  secureCookies: env.AIBI_SECURE_COOKIES === "1",
  sessionDays: num(env.AIBI_SESSION_DAYS, 7),
  limits: {
    maxRows: num(env.AIBI_MAX_ROWS, 10_000),
    timeoutMs: num(env.AIBI_QUERY_TIMEOUT_MS, 30_000),
    maxBytes: num(env.AIBI_MAX_RESULT_BYTES, 20_000_000),
    previewRows: 50,
    queriesPerMinute: num(env.AIBI_QUERIES_PER_MINUTE, 600),
    aiPerMinute: num(env.AIBI_AI_PER_MINUTE, 30),
    /** sign-in attempts per minute per client address (each account also gets at most 10) */
    loginsPerMinute: num(env.AIBI_LOGINS_PER_MINUTE, 30),
  },
  ai: {
    provider: env.AI_PROVIDER ?? "openai",
    baseUrl: env.AI_BASE_URL ?? "https://openrouter.ai/api",
    apiKey: env.AI_API_KEY ?? env.OPENROUTER_API_KEY ?? "",
    model: env.AI_MODEL ?? "google/gemini-2.5-flash",
    fastModel: env.AI_MODEL_FAST ?? env.AI_MODEL ?? "google/gemini-2.5-flash",
    /** native = OpenAI function calling; json = page JSON in text (for local models without tool support) */
    toolMode: (env.AI_TOOL_MODE ?? "native") as "native" | "json",
    maxTokens: num(env.AI_MAX_TOKENS, 16000),
    temperature: env.AI_TEMPERATURE ? Number(env.AI_TEMPERATURE) : undefined,
    maxToolRounds: num(env.AI_MAX_TOOL_ROUNDS, 30),
    timeoutMs: num(env.AI_TIMEOUT_MS, 180_000),
  },
  /** hosts page modules may be fetched from */
  moduleHosts: (env.AIBI_MODULE_HOSTS ?? "esm.sh,cdn.jsdelivr.net,unpkg.com").split(",").map((s) => s.trim()).filter(Boolean),
  appVersion: "0.1.0",
};

for (const d of [config.uploadedSkillsDir, config.modulesDir, config.packagesDir, path.join(DATA, "sqlite"), path.join(DATA, "imports")]) fs.mkdirSync(d, { recursive: true });
