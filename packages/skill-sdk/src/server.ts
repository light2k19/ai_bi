import type { Catalogue, PageBundle } from "@aibi/page-spec";
import type { QueryResult } from "@aibi/transforms";

/* ───────────────────────── Data sources ───────────────────────── */

export interface ColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  pk?: boolean;
  comment?: string;
}
export interface TableInfo {
  name: string;
  kind: "table" | "view";
  rowEstimate?: number;
  comment?: string;
  columns: ColumnInfo[];
  foreignKeys?: { columns: string[]; refSchema?: string; refTable: string; refColumns: string[] }[];
}
export interface EndpointInfo {
  method: "GET" | "POST";
  path: string;
  description?: string;
  params?: Record<string, string>;
  sample?: unknown;
}
export interface SchemaSnapshot {
  dialect?: string;
  defaultSchema?: string;
  schemas: { name: string; tables: TableInfo[] }[];
  endpoints?: EndpointInfo[];
  capturedAt?: string;
}

export interface QueryLimits {
  maxRows: number;
  timeoutMs: number;
  maxBytes: number;
}

export interface DatasourceInstance {
  id: string;
  alias: string;
  /** decrypted configuration (server only) */
  config: Record<string, unknown>;
}

export interface DatasourceHandler {
  kind: "sql" | "http" | "other";
  /** SQL dialect for the guard and the AI */
  dialect?: "mysql" | "mssql" | "oracle" | "sqlite" | "postgres";
  testConnection(inst: DatasourceInstance): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }>;
  introspect(inst: DatasourceInstance): Promise<SchemaSnapshot>;
  /** Execute a read-only request. Params are already resolved (no bindings). */
  query(inst: DatasourceInstance, request: Record<string, unknown>, params: Record<string, unknown>, limits: QueryLimits): Promise<QueryResult>;
  explain?(inst: DatasourceInstance, request: Record<string, unknown>, params: Record<string, unknown>): Promise<string>;
  /** release pooled connections for an instance (config changed or disabled) */
  close?(instanceId: string): Promise<void>;
}

/* ───────────────────────── Auth ───────────────────────── */

export interface AuthIdentity {
  externalId: string;
  email: string | null;
  displayName?: string;
}
export interface AuthProviderInfo {
  id: string;
  label: string;
  kind: "password" | "redirect";
}
export interface AuthHandler {
  providers(settings: Record<string, unknown>): AuthProviderInfo[];
  /** password providers (e.g. a directory): the identity when the password is accepted, null otherwise */
  verifyPassword?(settings: Record<string, unknown>, login: string, password: string): Promise<AuthIdentity | null>;
  /** password providers: who a user id is, for adding members without their password */
  lookup?(settings: Record<string, unknown>, login: string): Promise<AuthIdentity | null>;
  /** can the provider be reached with these settings? */
  test?(settings: Record<string, unknown>): Promise<{ ok: boolean; message: string }>;
  /** redirect providers: build the authorization URL and state */
  start?(provider: string, settings: Record<string, unknown>, redirectUri: string): Promise<{ url: string; state: Record<string, string> }>;
  callback?(provider: string, settings: Record<string, unknown>, redirectUri: string, query: Record<string, string>, state: Record<string, string>): Promise<AuthIdentity>;
}

/* ───────────────────────── Export ───────────────────────── */

export interface ExportContext {
  bundle: PageBundle;
  /** computed datasets (after pipelines), keyed by id */
  datasets: Record<string, { columns: { name: string; type: string }[]; rows: Record<string, unknown>[] }>;
  filters: Record<string, unknown>;
  /** URL that renders the page for print (PDF) */
  renderUrl?: string;
  options: Record<string, unknown>;
}
export interface ExportHandler {
  formats: { id: string; label: string; mime: string; ext: string }[];
  export(format: string, ctx: ExportContext): Promise<{ body: Buffer | Uint8Array; mime: string; filename: string }>;
}

/* ───────────────────────── Tools & catalogue ───────────────────────── */

export interface ToolContext {
  projectId: string;
  userId: string;
  role: string;
  /** run a datasource request through the gateway (read-only, limits, audit) */
  query(alias: string, request: Record<string, unknown>, params: Record<string, unknown>, limits?: Partial<QueryLimits>): Promise<QueryResult>;
  introspect(alias: string): Promise<SchemaSnapshot | null>;
  catalogue: Catalogue;
}
export type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

export interface ServerSkillModule {
  datasource?: DatasourceHandler;
  auth?: AuthHandler;
  export?: ExportHandler;
  /** handlers for the tools listed in the manifest */
  tools?: Record<string, ToolHandler>;
  /** contribute to the catalogue dynamically (e.g. transforms from code) */
  catalogue?: () => Partial<Pick<Catalogue, "widgets" | "transforms" | "filters" | "scriptLibs">>;
  /** called once at server start */
  init?: (ctx: { dataDir: string; log: (msg: string) => void }) => Promise<void> | void;
}

export function defineServerSkill(m: ServerSkillModule): ServerSkillModule {
  return m;
}
