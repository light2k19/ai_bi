import type { SchemaSnapshot, DatasourceInstance } from "@aibi/skill-sdk";
import { all, get, run, now, json, parse } from "../db";
import { newId, sealSecrets, openSecrets, maskSecrets, verifyPassword, MASK } from "../lib/crypto";
import { badRequest, conflict, notFound, HttpError } from "../lib/errors";
import { getSkill, datasourceHandler, enabledSkills } from "../skills/registry";
import { checkSchema } from "@aibi/page-spec";
import type { JsonSchema } from "@aibi/page-spec";
import { invalidateInstanceCache } from "./gateway";

export type CredentialMode = "shared" | "user";

export interface InstanceRow {
  id: string;
  project_id: string;
  skill_id: string;
  name: string;
  alias: string;
  description: string | null;
  config: string;
  status: string;
  status_message: string | null;
  credential_mode: CredentialMode;
  /** 1: members sign in with their AI BI login id and password */
    system_login: number;
  created_at: string;
  updated_at: string;
}

export interface Annotations {
  /** key: "schema.table" or "table" */
  tables?: Record<string, { description?: string; hidden?: boolean; columns?: Record<string, string> }>;
  glossary?: string;
}

export const secretsOf = (skillId: string) => getSkill(skillId)?.manifest.secrets ?? [];
/** config keys that identify the account (login id, password, token) */
export const credentialsOf = (skillId: string) => getSkill(skillId)?.manifest.userCredentials ?? [];

/** The login fields of a skill with their form titles, for credential prompts. */
export function credentialFields(skillId: string) {
  const props = ((getSkill(skillId)?.manifest.configSchema as JsonSchema | undefined)?.properties ?? {}) as Record<string, { title?: string; description?: string; format?: string }>;
  const secrets = secretsOf(skillId);
  return credentialsOf(skillId).map((key) => ({ key, title: props[key]?.title ?? key, description: props[key]?.description, secret: secrets.includes(key) || props[key]?.format === "password" }));
}

/**
 * Logins are personal: a data source whose skill has login fields always uses per-user sign-in, so a login
 * entered by one person is never used for anyone else. Skills without login fields (e.g. a local SQLite file)
 * stay shared.
 */
export const modeFor = (skillId: string): CredentialMode => (credentialsOf(skillId).length ? "user" : "shared");

/**
 * The login-name and password fields of a skill, when it has both. Only such skills can take a member's AI BI
 * account; token-based skills cannot.
 */
export function systemLoginFields(skillId: string): { loginKey: string; passwordKey: string } | null {
  const fields = credentialFields(skillId);
  const login = fields.find((f) => !f.secret);
  const password = fields.find((f) => f.secret && /pass|pwd/i.test(f.key));
  return login && password ? { loginKey: login.key, passwordKey: password.key } : null;
}

/** Login ids to try for an AI BI account: the full e-mail, then the part before the @. */
export function systemLoginCandidates(login: string, email?: string | null): string[] {
  return [...new Set([login, login.split("@")[0], email ?? "", email?.split("@")[0] ?? ""].filter(Boolean))];
}

/** Remove the login fields from a configuration (exports, per-user mode). */
export function withoutCredentials(skillId: string, cfg: Record<string, unknown>) {
  const out = { ...cfg };
  for (const k of credentialsOf(skillId)) delete out[k];
  return out;
}

export function publicInstance(r: InstanceRow) {
  return {
    id: r.id,
    skill: r.skill_id,
    name: r.name,
    alias: r.alias,
    description: r.description,
    status: r.status,
    statusMessage: r.status_message,
    credentialMode: r.credential_mode ?? "shared",
    credentialFields: credentialFields(r.skill_id),
    systemLogin: r.system_login === 1,
    systemLoginSupported: !!systemLoginFields(r.skill_id),
    config: maskSecrets(parse(r.config, {}), secretsOf(r.skill_id)),
    kind: (getSkill(r.skill_id)?.manifest.capabilities as { kind?: string } | undefined)?.kind ?? "other",
    dialect: (getSkill(r.skill_id)?.manifest.capabilities as { dialect?: string } | undefined)?.dialect,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const listInstances = (projectId: string) => all<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ? ORDER BY alias", projectId);

export function instanceByAlias(projectId: string, alias: string): InstanceRow {
  const r = get<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ? AND alias = ?", projectId, alias);
  if (!r) throw notFound(`No data source '${alias}' in this project`);
  return r;
}
export function instanceById(projectId: string, id: string): InstanceRow {
  const r = get<InstanceRow>("SELECT * FROM skill_instances WHERE project_id = ? AND id = ?", projectId, id);
  if (!r) throw notFound("Data source not found");
  return r;
}

export function credentialsRequired(r: InstanceRow) {
  return new HttpError(403, `Data source '${r.alias}' uses your own account. Enter your login for it on the project page (Your data source accounts).`, { code: "credentials_required", alias: r.alias, sourceId: r.id });
}

/** Pool / connection id: per-user sign-in gets one per user so connections and tokens never mix. */
export const runtimeId = (instanceId: string, userId?: string | null) => (userId ? `${instanceId}@${userId}` : instanceId);

/**
 * Configuration handed to the skill. Shared mode: the stored configuration. Per-user mode: the stored
 * configuration without login fields plus the calling user's own login; there is no fallback.
 */
export function runtimeInstance(r: InstanceRow, userId?: string | null): DatasourceInstance {
  const shared = openSecrets(parse(r.config, {}), secretsOf(r.skill_id));
  if (r.credential_mode !== "user") return { id: r.id, alias: r.alias, config: shared };
  if (!userId) throw credentialsRequired(r);
  const c = get<{ config: string }>("SELECT config FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", r.id, userId);
  if (!c) throw credentialsRequired(r);
  const mine = openSecrets(parse(c.config, {}), secretsOf(r.skill_id));
  return { id: runtimeId(r.id, userId), alias: r.alias, config: { ...withoutCredentials(r.skill_id, shared), ...mine } };
}

function validateConfig(skillId: string, cfg: Record<string, unknown>, mode: CredentialMode = "shared") {
  const skill = getSkill(skillId);
  if (!skill || skill.manifest.type !== "datasource") throw badRequest(`'${skillId}' is not a data source skill`);
  const schema = skill.manifest.configSchema as JsonSchema | undefined;
  if (schema) {
    // secrets may be omitted on update (kept from the stored config); login fields are per user in "user" mode
    const optional = new Set([...skill.manifest.secrets, ...(mode === "user" ? skill.manifest.userCredentials : [])]);
    const errs = checkSchema(cfg, { ...schema, required: (schema.required ?? []).filter((r) => !optional.has(r)) });
    if (errs.length) throw badRequest(`Invalid configuration: ${errs.join("; ")}`);
  }
}

function assertMode(skillId: string, requested?: CredentialMode) {
  if (requested && requested !== modeFor(skillId)) {
    throw badRequest(requested === "shared" ? "Logins are personal: a data source with a login cannot share one account between users. Each member signs in with their own." : `'${skillId}' has no login fields; it is shared by design`);
  }
  return modeFor(skillId);
}

/** Login values typed into the data source settings become the personal login of the person who typed them. */
function personalLogin(skillId: string, cfg: Record<string, unknown>) {
  const keys = credentialsOf(skillId);
  return Object.fromEntries(Object.entries(cfg).filter(([k, v]) => keys.includes(k) && v !== undefined && v !== null && v !== "" && v !== MASK));
}

function storeLogin(instanceId: string, skillId: string, userId: string, login: Record<string, unknown>, status = "new", message: string | null = null) {
  const prev = get<{ config: string }>("SELECT config FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", instanceId, userId);
  const sealed = sealSecrets(login, secretsOf(skillId), prev ? parse(prev.config, {}) : undefined);
  run(
    "INSERT INTO user_source_credentials (instance_id, user_id, config, status, status_message, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(instance_id, user_id) DO UPDATE SET config = excluded.config, status = excluded.status, status_message = excluded.status_message, updated_at = excluded.updated_at",
    instanceId, userId, json(prev ? { ...parse<Record<string, unknown>>(prev.config, {}), ...sealed } : sealed), status, message, now(),
  );
}

function assertSystemLogin(skillId: string, on: boolean | undefined) {
  if (on && !systemLoginFields(skillId)) throw badRequest(`'${skillId}' has no login name and password fields, so members cannot sign in to it with their AI BI account`);
}

export function createInstance(projectId: string, input: { skill: string; name: string; alias: string; description?: string; config: Record<string, unknown>; credentialMode?: CredentialMode; systemLogin?: boolean }, byUserId?: string | null) {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(input.alias)) throw badRequest("alias must be lower-case letters, digits or '_' and start with a letter");
  if (!enabledSkills(projectId).some((s) => s.manifest.id === input.skill)) throw badRequest(`skill '${input.skill}' is not enabled in this project`);
  if (get("SELECT 1 FROM skill_instances WHERE project_id = ? AND alias = ?", projectId, input.alias)) throw conflict(`alias '${input.alias}' is already used`);
  const mode = assertMode(input.skill, input.credentialMode);
  assertSystemLogin(input.skill, input.systemLogin);
  const login = personalLogin(input.skill, input.config);
  const config = mode === "user" ? withoutCredentials(input.skill, input.config) : input.config;
  validateConfig(input.skill, config, mode);
  const id = newId("ds");
  const cfg = sealSecrets(config, secretsOf(input.skill));
  run(
    "INSERT INTO skill_instances (id, project_id, skill_id, name, alias, description, config, status, credential_mode, system_login, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    id, projectId, input.skill, input.name, input.alias, input.description ?? null, json(cfg), "new", mode, input.systemLogin ? 1 : 0, now(), now(),
  );
  if (mode === "user" && byUserId && Object.keys(login).length) storeLogin(id, input.skill, byUserId, login);
  return instanceById(projectId, id);
}

/** Close the shared connection and every user's connection of an instance. */
export async function closeInstancePools(r: Pick<InstanceRow, "id" | "skill_id">) {
  const ids = [r.id, ...all<{ user_id: string }>("SELECT user_id FROM user_source_credentials WHERE instance_id = ?", r.id).map((u) => runtimeId(r.id, u.user_id))];
  for (const id of ids) {
    try {
      await datasourceHandler(r.skill_id).close?.(id);
    } catch {
      /* skill may be gone */
    }
  }
  invalidateInstanceCache(r.id);
}

export async function updateInstance(projectId: string, id: string, patch: { name?: string; description?: string; config?: Record<string, unknown>; status?: string; credentialMode?: CredentialMode; systemLogin?: boolean }, byUserId?: string | null) {
  const cur = instanceById(projectId, id);
  const mode = assertMode(cur.skill_id, patch.credentialMode);
  assertSystemLogin(cur.skill_id, patch.systemLogin);
  if (patch.systemLogin !== undefined) run("UPDATE skill_instances SET system_login = ? WHERE id = ?", patch.systemLogin ? 1 : 0, id);
  // login values in the settings belong to the person saving them
  if (patch.config && mode === "user" && byUserId) {
    const login = personalLogin(cur.skill_id, patch.config);
    if (Object.keys(login).length) storeLogin(id, cur.skill_id, byUserId, login);
  }
  let cfg = parse<Record<string, unknown>>(cur.config, {});
  if (patch.config) {
    const next = mode === "user" ? withoutCredentials(cur.skill_id, patch.config) : patch.config;
    validateConfig(cur.skill_id, next, mode);
    cfg = sealSecrets(next, secretsOf(cur.skill_id), mode === "user" ? withoutCredentials(cur.skill_id, cfg) : cfg);
  }
  // per-user mode never keeps a shared login (no silent fallback)
  if (mode === "user") cfg = withoutCredentials(cur.skill_id, cfg);
  const modeChanged = mode !== cur.credential_mode;
  const status = patch.status === "disabled" ? "disabled" : patch.config || modeChanged ? "new" : patch.status === "enabled" ? "new" : cur.status;
  run(
    "UPDATE skill_instances SET name = ?, description = ?, config = ?, status = ?, credential_mode = ?, status_message = ?, updated_at = ? WHERE id = ?",
    patch.name ?? cur.name, patch.description ?? cur.description, json(cfg), status, mode, modeChanged ? null : cur.status_message, now(), id,
  );
  await closeInstancePools(cur);
  return instanceById(projectId, id);
}

export async function deleteInstance(projectId: string, id: string) {
  const cur = instanceById(projectId, id);
  await closeInstancePools(cur);
  run("DELETE FROM skill_instances WHERE id = ?", id);
}

/**
 * Test a candidate configuration without saving anything (imports, user sign-in). Uses a throw-away
 * connection id and closes it afterwards.
 */
export async function verifyConfig(skillId: string, alias: string, config: Record<string, unknown>) {
  const id = `verify-${newId("v")}`;
  const handler = datasourceHandler(skillId);
  try {
    return await handler.testConnection({ id, alias, config });
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  } finally {
    try {
      await handler.close?.(id);
    } catch {
      /* ignore */
    }
  }
}

export async function testInstance(projectId: string, id: string, userId?: string | null) {
  const r = instanceById(projectId, id);
  const res = await datasourceHandler(r.skill_id).testConnection(runtimeInstance(r, userId));
  if (r.credential_mode === "user") {
    run("UPDATE user_source_credentials SET status = ?, status_message = ?, updated_at = ? WHERE instance_id = ? AND user_id = ?", res.ok ? "ok" : "error", res.message, now(), id, userId);
    if (res.ok && r.status !== "disabled") run("UPDATE skill_instances SET status = 'ok', status_message = 'Per-user sign-in: each member uses their own account' WHERE id = ?", id);
  } else {
    run("UPDATE skill_instances SET status = ?, status_message = ?, updated_at = ? WHERE id = ?", res.ok ? (r.status === "disabled" ? "disabled" : "ok") : "error", res.message, now(), id);
  }
  return res;
}

export async function introspectInstance(projectId: string, id: string, userId?: string | null): Promise<SchemaSnapshot> {
  const r = instanceById(projectId, id);
  const snap = await datasourceHandler(r.skill_id).introspect(runtimeInstance(r, userId));
  snap.capturedAt = now();
  const exists = get("SELECT 1 FROM datasource_schemas WHERE instance_id = ?", id);
  if (exists) run("UPDATE datasource_schemas SET snapshot = ?, captured_at = ? WHERE instance_id = ?", json(snap), now(), id);
  else run("INSERT INTO datasource_schemas (instance_id, snapshot, annotations, captured_at) VALUES (?,?,?,?)", id, json(snap), "{}", now());
  return snap;
}

/* ───────── pages follow the project's data source settings ───────── */

const CREDENTIAL_NAME = /(auth|token|secret|passw|pwd|cookie|session|api[-_]?key|credential|login)/i;

/**
 * Settings a dataset request may not carry: every connection or login setting of the data source (host, base URL,
 * user, password, token, …) and credential-like headers. A page uses the project's data source as configured;
 * it cannot point it elsewhere or bring its own account.
 */
export function connectionOverrides(skillId: string, request: Record<string, unknown>): string[] {
  const props = Object.keys(((getSkill(skillId)?.manifest.configSchema as JsonSchema | undefined)?.properties ?? {}) as Record<string, unknown>);
  const blocked = new Set([...props, ...credentialsOf(skillId), ...secretsOf(skillId)].filter((k) => k !== "headers"));
  const out: string[] = [];
  for (const k of Object.keys(request)) {
    if (blocked.has(k) || (CREDENTIAL_NAME.test(k) && k !== "headers")) out.push(k);
  }
  const headers = request.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const h of Object.keys(headers as Record<string, unknown>)) if (CREDENTIAL_NAME.test(h)) out.push(`headers.${h}`);
  }
  return out;
}

export function overrideMessage(alias: string, keys: string[]) {
  return `Dataset requests use the project's '${alias}' data source settings; remove ${keys.map((k) => `'${k}'`).join(", ")} (connections and logins are configured in the project, and logins are personal).`;
}

/** One-time move of logins stored in shared settings to the personal login of whoever entered them. */
export function personalizeStoredLogins(log: (m: string) => void = () => undefined) {
  for (const r of all<InstanceRow>("SELECT * FROM skill_instances")) {
    const mode = modeFor(r.skill_id);
    if (!getSkill(r.skill_id) || mode === (r.credential_mode ?? "shared")) continue;
    if (mode === "shared") continue;
    const cfg = parse<Record<string, unknown>>(r.config, {});
    const login = personalLogin(r.skill_id, cfg);
    // the person who last saved the settings typed the login; fall back to the project creator
    const owner =
      get<{ actor_id: string }>("SELECT actor_id FROM audit_log WHERE target = ? AND action IN ('source.create','source.update') AND actor_id IS NOT NULL ORDER BY id DESC LIMIT 1", r.id)?.actor_id ??
      get<{ created_by: string }>("SELECT created_by FROM projects WHERE id = ?", r.project_id)?.created_by;
    if (owner && Object.keys(login).length && get("SELECT 1 FROM users WHERE id = ?", owner)) {
      // values stay sealed; they move as they are
      run(
        "INSERT INTO user_source_credentials (instance_id, user_id, config, status, status_message, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(instance_id, user_id) DO NOTHING",
        r.id, owner, json(login), "new", "Moved from the data source settings: logins are personal", now(),
      );
    }
    run("UPDATE skill_instances SET config = ?, credential_mode = 'user', status = 'new', status_message = ?, updated_at = ? WHERE id = ?", json(withoutCredentials(r.skill_id, cfg)), "Logins are personal: each member signs in with their own account", now(), r.id);
    log(`data source ${r.alias} (${r.id}): login moved to ${owner ?? "nobody"}; now per-user`);
  }
}

/* ───────── per-user sign-in ───────── */

/** The calling user's sign-in state for every per-user data source of a project (values masked). */
export function myCredentials(projectId: string, userId: string) {
  return listInstances(projectId)
    .filter((r) => r.credential_mode === "user")
    .map((r) => {
      const c = get<{ config: string; status: string; status_message: string | null; updated_at: string }>("SELECT * FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", r.id, userId);
      const values = c ? maskSecrets(parse(c.config, {}), secretsOf(r.skill_id)) : {};
      return { sourceId: r.id, alias: r.alias, name: r.name, skill: r.skill_id, fields: credentialFields(r.skill_id), systemLogin: r.system_login === 1, systemLoginSupported: !!systemLoginFields(r.skill_id), values, set: !!c, status: c?.status ?? null, statusMessage: c?.status_message ?? null, updatedAt: c?.updated_at ?? null };
    });
}

/** Save the calling user's login for a per-user data source, only after a successful connection test. */
export async function setMyCredentials(projectId: string, id: string, userId: string, values: Record<string, unknown>) {
  const r = instanceById(projectId, id);
  if (r.credential_mode !== "user") throw badRequest(`Data source '${r.alias}' uses a shared account`);
  const keys = credentialsOf(r.skill_id);
  const unknown = Object.keys(values).filter((k) => !keys.includes(k));
  if (unknown.length) throw badRequest(`Only these fields can be set: ${keys.join(", ")}`);
  const prev = get<{ config: string }>("SELECT config FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", id, userId);
  // fields left empty keep their stored value (secrets through sealSecrets, login ids by merging the old row)
  const given = Object.fromEntries(keys.filter((k) => values[k] !== undefined && values[k] !== "").map((k) => [k, values[k]]));
  const sealed = { ...(prev ? parse<Record<string, unknown>>(prev.config, {}) : {}), ...sealSecrets(given, secretsOf(r.skill_id), prev ? parse(prev.config, {}) : undefined) };
  const candidate = { ...withoutCredentials(r.skill_id, openSecrets(parse(r.config, {}), secretsOf(r.skill_id))), ...openSecrets(sealed, secretsOf(r.skill_id)) };
  const test = await verifyConfig(r.skill_id, r.alias, candidate);
  if (!test.ok) return { ok: false, saved: false, message: test.message };
  run(
    "INSERT INTO user_source_credentials (instance_id, user_id, config, status, status_message, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(instance_id, user_id) DO UPDATE SET config = excluded.config, status = excluded.status, status_message = excluded.status_message, updated_at = excluded.updated_at",
    id, userId, json(sealed), "ok", test.message, now(),
  );
  try {
    await datasourceHandler(r.skill_id).close?.(runtimeId(id, userId));
  } catch {
    /* ignore */
  }
  invalidateInstanceCache(id);
  return { ok: true, saved: true, message: test.message };
}

/**
 * Live check of the calling user's logins for every per-user data source of a project: missing logins and
 * failed connection tests come back as `ok: false`, so the app can ask for them before opening the project.
 */
export async function checkMyCredentials(projectId: string, userId: string) {
  const out: { sourceId: string; alias: string; name: string; skill: string; fields: ReturnType<typeof credentialFields>; systemLogin: boolean; systemLoginSupported: boolean; set: boolean; ok: boolean; message: string }[] = [];
  for (const r of listInstances(projectId)) {
    if (r.credential_mode !== "user" || r.status === "disabled") continue;
    const fields = credentialFields(r.skill_id);
    const systemLogin = r.system_login === 1;
    const systemLoginSupported = !!systemLoginFields(r.skill_id);
    const c = get<{ config: string }>("SELECT config FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", r.id, userId);
    if (!c) {
      out.push({ sourceId: r.id, alias: r.alias, name: r.name, skill: r.skill_id, fields, systemLogin, systemLoginSupported, set: false, ok: false, message: "Not signed in" });
      continue;
    }
    let res: { ok: boolean; message: string };
    try {
      res = await datasourceHandler(r.skill_id).testConnection(runtimeInstance(r, userId));
    } catch (e) {
      res = { ok: false, message: (e as Error).message };
    }
    run("UPDATE user_source_credentials SET status = ?, status_message = ?, updated_at = ? WHERE instance_id = ? AND user_id = ?", res.ok ? "ok" : "error", res.message, now(), r.id, userId);
    if (!res.ok) invalidateInstanceCache(r.id);
    out.push({ sourceId: r.id, alias: r.alias, name: r.name, skill: r.skill_id, fields, systemLogin, systemLoginSupported, set: true, ok: res.ok, message: res.message });
  }
  return out;
}

/**
 * Sign a member in to a data source with their AI BI account: the login id is tried as the full e-mail and
 * then as the part before the @, with the given password; the first combination that connects is saved.
 */
export async function applySystemLogin(r: InstanceRow, user: { id: string; login: string; email: string | null }, password: string) {
  const keys = systemLoginFields(r.skill_id);
  // any member may try their AI BI account when the source has login name and password fields; the admin
  // option only decides whether this happens automatically at AI BI sign-in
  if (!keys || r.credential_mode !== "user") return { ok: false, saved: false, message: "This data source cannot take an AI BI account" };
  const shared = withoutCredentials(r.skill_id, openSecrets(parse(r.config, {}), secretsOf(r.skill_id)));
  let last = "";
  for (const loginName of systemLoginCandidates(user.login, user.email)) {
    const values = { [keys.loginKey]: loginName, [keys.passwordKey]: password };
    const test = await verifyConfig(r.skill_id, r.alias, { ...shared, ...values });
    if (test.ok) {
      storeLogin(r.id, r.skill_id, user.id, values, "ok", test.message);
      try {
        await datasourceHandler(r.skill_id).close?.(runtimeId(r.id, user.id));
      } catch {
        /* ignore */
      }
      invalidateInstanceCache(r.id);
      return { ok: true, saved: true, message: test.message, loginName };
    }
    last = test.message;
  }
  return { ok: false, saved: false, message: last };
}

/** At AI BI sign-in: refresh the member's login for every data source that uses AI BI accounts. */
export async function syncSystemLogins(user: { id: string; login: string; email: string | null }, password: string) {
  const rows = all<InstanceRow>(
    `SELECT i.* FROM skill_instances i JOIN project_members m ON m.project_id = i.project_id AND m.user_id = ?
     JOIN projects p ON p.id = i.project_id AND p.archived = 0
     WHERE i.system_login = 1 AND i.credential_mode = 'user' AND i.status <> 'disabled'`,
    user.id,
  );
  await Promise.allSettled(rows.map((r) => applySystemLogin(r, user, password)));
  return rows.length;
}

/** The project sign-in page: use the AI BI account after checking the AI BI password itself. */
export async function signInWithSystemLogin(projectId: string, id: string, user: { id: string; login: string; email: string | null }, password: string) {
  const r = instanceById(projectId, id);
  const u = get<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = ?", user.id);
  if (!u?.password_hash) throw badRequest("Your AI BI account has no password (single sign-on); sign in to this data source with its own account");
  if (!verifyPassword(password, u.password_hash)) throw new HttpError(401, "Wrong AI BI password");
  return applySystemLogin(r, user, password);
}

/** Sign out of every per-user data source of a project: the user's stored logins are removed. */
export async function clearAllMyCredentials(projectId: string, userId: string) {
  let n = 0;
  for (const r of listInstances(projectId)) {
    // logins that come from the AI BI account are not something to sign out of
    if (r.system_login === 1) continue;
    if (!get("SELECT 1 FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", r.id, userId)) continue;
    await clearCredentials(projectId, r.id, userId);
    n++;
  }
  return n;
}

export async function clearCredentials(projectId: string, id: string, userId: string) {
  const r = instanceById(projectId, id);
  run("DELETE FROM user_source_credentials WHERE instance_id = ? AND user_id = ?", id, userId);
  try {
    await datasourceHandler(r.skill_id).close?.(runtimeId(id, userId));
  } catch {
    /* ignore */
  }
  invalidateInstanceCache(id);
}

/** Admin view: which members have signed in to a per-user data source (no values). */
export function credentialStatus(projectId: string, id: string) {
  instanceById(projectId, id);
  return all<{ user_id: string; login: string; email: string | null; display_name: string | null; role: string; status: string | null; status_message: string | null; updated_at: string | null }>(
    `SELECT m.user_id, u.login, u.email, u.display_name, m.role, c.status, c.status_message, c.updated_at
     FROM project_members m JOIN users u ON u.id = m.user_id
     LEFT JOIN user_source_credentials c ON c.instance_id = ? AND c.user_id = m.user_id
     WHERE m.project_id = ? ORDER BY u.login`,
    id,
    projectId,
  ).map((x) => ({ userId: x.user_id, login: x.login, email: x.email, name: x.display_name, role: x.role, set: x.status !== null, status: x.status, statusMessage: x.status_message, updatedAt: x.updated_at }));
}

export function schemaOf(instanceId: string): { snapshot: SchemaSnapshot | null; annotations: Annotations; capturedAt: string | null } {
  const r = get<{ snapshot: string | null; annotations: string; captured_at: string | null }>("SELECT * FROM datasource_schemas WHERE instance_id = ?", instanceId);
  return { snapshot: parse<SchemaSnapshot | null>(r?.snapshot, null), annotations: parse<Annotations>(r?.annotations, {}), capturedAt: r?.captured_at ?? null };
}

export function setAnnotations(instanceId: string, a: Annotations) {
  const exists = get("SELECT 1 FROM datasource_schemas WHERE instance_id = ?", instanceId);
  if (exists) run("UPDATE datasource_schemas SET annotations = ? WHERE instance_id = ?", json(a), instanceId);
  else run("INSERT INTO datasource_schemas (instance_id, snapshot, annotations, captured_at) VALUES (?,?,?,?)", instanceId, null, json(a), null);
}

/** Ensure a snapshot exists (introspect lazily). */
export async function ensureSchema(projectId: string, alias: string, userId?: string | null) {
  const inst = instanceByAlias(projectId, alias);
  let s = schemaOf(inst.id);
  if (!s.snapshot) {
    await introspectInstance(projectId, inst.id, userId);
    s = schemaOf(inst.id);
  }
  return { inst, ...s };
}

/**
 * Compact, annotated text rendering of a schema for the AI:
 *   schema.table (≈rows) — description
 *     col type [pk] — description
 */
export function schemaText(snapshot: SchemaSnapshot | null, annotations: Annotations, opts: { search?: string; maxChars?: number } = {}): string {
  if (!snapshot) return "(schema not introspected yet)";
  const maxChars = opts.maxChars ?? 24_000;
  const search = opts.search?.toLowerCase();
  const lines: string[] = [];
  if (annotations.glossary) lines.push(`Glossary: ${annotations.glossary}`);
  for (const s of snapshot.schemas) {
    for (const t of s.tables) {
      const key = `${s.name}.${t.name}`;
      const ann = annotations.tables?.[key] ?? annotations.tables?.[t.name];
      if (ann?.hidden) continue;
      const qualified = s.name && s.name !== snapshot.defaultSchema && s.name !== "main" ? key : snapshot.dialect === "mssql" || snapshot.dialect === "oracle" ? key : t.name;
      const hay = `${key} ${ann?.description ?? ""} ${t.comment ?? ""} ${t.columns.map((c) => c.name).join(" ")}`.toLowerCase();
      if (search && !search.split(/\s+/).every((w) => hay.includes(w))) continue;
      const desc = ann?.description ?? t.comment;
      lines.push(`${qualified}${t.kind === "view" ? " (view)" : ""}${t.rowEstimate !== undefined ? ` ≈${t.rowEstimate} rows` : ""}${desc ? ` — ${desc}` : ""}`);
      for (const c of t.columns) {
        const cd = ann?.columns?.[c.name] ?? c.comment;
        lines.push(`  ${c.name} ${c.type}${c.pk ? " pk" : ""}${cd ? ` — ${cd}` : ""}`);
      }
      for (const fk of t.foreignKeys ?? []) lines.push(`  fk ${fk.columns.join(",")} → ${fk.refSchema && fk.refSchema !== s.name ? fk.refSchema + "." : ""}${fk.refTable}(${fk.refColumns.join(",")})`);
    }
  }
  for (const e of snapshot.endpoints ?? []) {
    const hay = `${e.path} ${e.description ?? ""}`.toLowerCase();
    if (search && !search.split(/\s+/).every((w) => hay.includes(w))) continue;
    lines.push(`${e.method} ${e.path}${e.description ? ` — ${e.description}` : ""}${e.params && Object.keys(e.params).length ? ` params: ${Object.keys(e.params).join(", ")}` : ""}${e.sample !== undefined ? `\n  sample: ${JSON.stringify(e.sample).slice(0, 400)}` : ""}`);
  }
  let out = lines.join("\n");
  if (out.length > maxChars) out = out.slice(0, maxChars) + `\n… (truncated; call introspect_schema with a search term to see more)`;
  return out || (search ? `(no tables match '${opts.search}')` : "(empty schema)");
}
