import { z } from "zod";

export const PACKAGE_SPEC = "aibi.package/1";

export const PackageModule = z.object({
  name: z.string(),
  version: z.string(),
  hash: z.string().optional(),
  integrity: z.string().optional(),
  bundled: z.boolean(),
  /** path inside the zip of the entry file when bundled */
  file: z.string().optional(),
  /** additional files of the module (transitive chunks), path inside the zip keyed by hash */
  files: z.record(z.string()).optional(),
  url: z.string().optional(),
  providesWidgets: z.array(z.string()).optional(),
});
export type PackageModule = z.infer<typeof PackageModule>;

export const PackageProjectRef = z.object({ id: z.string(), slug: z.string(), name: z.string() });
export type PackageProjectRef = z.infer<typeof PackageProjectRef>;

export const PackageManifest = z.object({
  spec: z.literal(PACKAGE_SPEC),
  name: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string().optional(),
  exportedAt: z.string(),
  exportedBy: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  app: z.object({ name: z.literal("ai-bi"), version: z.string(), minVersion: z.string().optional() }),
  /** "page" (default); project packages use ProjectPackageManifest */
  kind: z.literal("page").default("page"),
  /** the project the page was exported from; a page package is imported only into that project */
  project: PackageProjectRef.optional(),
  page: z.object({ id: z.string(), versionNo: z.number().int().optional(), file: z.literal("page.json") }),
  requires: z.object({
    skills: z.array(z.object({ id: z.string(), range: z.string() })),
    sources: z.array(
      z.object({
        alias: z.string(),
        skill: z.string().optional(),
        dialect: z.string().optional(),
        tables: z.array(z.string()).default([]),
        columns: z.record(z.array(z.string())).optional(),
      }),
    ),
    modules: z.array(PackageModule),
  }),
  contents: z.object({
    components: z.array(z.string()),
    scripts: z.array(z.string()),
    assets: z.array(z.string()),
  }),
  sampleData: z.boolean().default(false),
  checksums: z.literal("CHECKSUMS.json"),
});
export type PackageManifest = z.infer<typeof PackageManifest>;

/* ───────── project packages ───────── */

export const PROJECT_PACKAGE_SPEC = "aibi.project/1";

/**
 * A whole project: settings, enabled skills, data sources (no credentials), schema annotations and every
 * page with its components, scripts and assets. Files:
 *   manifest.json, project.json, skills.json, sources.json, pages/<pageId>/page.json (+ components/,
 *   scripts/, assets/, meta.json), modules/…, CHECKSUMS.json
 */
export const ProjectPackageManifest = z.object({
  spec: z.literal(PROJECT_PACKAGE_SPEC),
  kind: z.literal("project"),
  name: z.string(),
  version: z.string(),
  title: z.string(),
  description: z.string().optional(),
  exportedAt: z.string(),
  exportedBy: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  app: z.object({ name: z.literal("ai-bi"), version: z.string(), minVersion: z.string().optional() }),
  project: PackageProjectRef.extend({ description: z.string().nullable().optional() }),
  pages: z.array(z.object({ id: z.string(), title: z.string(), versionNo: z.number().int(), dir: z.string() })),
  sources: z.array(z.object({ alias: z.string(), name: z.string(), skill: z.string() })),
  requires: z.object({
    skills: z.array(z.object({ id: z.string(), range: z.string() })),
    modules: z.array(PackageModule),
  }),
  checksums: z.literal("CHECKSUMS.json"),
});
export type ProjectPackageManifest = z.infer<typeof ProjectPackageManifest>;
