import { z } from "zod";

export const SKILL_TYPES = ["auth", "datasource", "filter", "transform", "visual", "export", "script", "theme"] as const;
export type SkillType = (typeof SKILL_TYPES)[number];

export const ToolDef = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string(),
  /** JSON schema of the input */
  input_schema: z.record(z.unknown()),
  /** server handler export name */
  handler: z.string(),
  /** generation = builder AI only; runtime = viewer AI too; both */
  scope: z.enum(["generation", "runtime", "both"]).default("generation"),
});
export type ToolDef = z.infer<typeof ToolDef>;

export const SkillManifest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  type: z.enum(SKILL_TYPES),
  name: z.string(),
  description: z.string(),
  author: z.string().optional(),
  license: z.string().optional(),
  engines: z.object({ aibi: z.string() }).default({ aibi: ">=0.1.0" }),
  scope: z.enum(["project", "system"]).default("project"),
  multiInstance: z.boolean().default(false),
  /** JSON schema for instance configuration (datasource / auth) */
  configSchema: z.record(z.unknown()).optional(),
  /** config keys stored encrypted and never returned to clients */
  secrets: z.array(z.string()).default([]),
  /**
   * config keys that identify the account (login id, password, token). They are never exported, are asked
   * for (and verified) on import, and can be set per AI BI user when a data source uses per-user sign-in.
   */
  userCredentials: z.array(z.string()).default([]),
  /** enabled automatically for new projects */
  defaultEnabled: z.boolean().default(false),
  /** type-specific capabilities; visual skills list widgets here, filter skills filters, etc. */
  capabilities: z.record(z.unknown()).default({}),
  tools: z.array(ToolDef).default([]),
  /** server entry relative to the skill folder */
  server: z.string().optional(),
  /** client entry relative to the skill folder (bundled for built-ins, ESM URL for uploaded skills) */
  client: z.string().optional(),
  dependencies: z
    .object({ skills: z.record(z.string()).default({}), modules: z.record(z.string()).default({}) })
    .default({ skills: {}, modules: {} }),
  permissions: z.array(z.string()).default([]),
  /** file with instructions for the AI */
  ai: z.object({ instructions: z.string().default("SKILL.md") }).default({ instructions: "SKILL.md" }),
});
export type SkillManifest = z.infer<typeof SkillManifest>;
