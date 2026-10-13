import type { PageBundle } from "@aibi/page-spec";
import { config } from "../config";
import { randomToken, signToken, verifyToken } from "../lib/crypto";
import { TtlCache } from "../lib/cache";
import { getSkill } from "../skills/registry";
import type { User } from "./access";

/**
 * Render tokens let a headless browser load a page without a session cookie.
 * - mode "page": may only run the stored datasets of one page version (any viewer may get one)
 * - mode "draft": may run ad-hoc queries for an unsaved draft (issued to builders only)
 */
export interface RenderClaims extends Record<string, unknown> {
  projectId: string;
  userId: string;
  mode: "page" | "draft";
  pageId?: string;
  versionNo?: number;
  draftKey?: string;
  filters?: Record<string, unknown>;
}

const drafts = new TtlCache<PageBundle>(200);

export function createRenderToken(claims: Omit<RenderClaims, "draftKey">, draft?: PageBundle): string {
  let draftKey: string | undefined;
  if (draft) {
    draftKey = randomToken(16);
    drafts.set(draftKey, draft, 10 * 60_000);
  }
  return signToken({ ...claims, draftKey }, 10 * 60);
}

export function readRenderToken(token: string): (RenderClaims & { draft?: PageBundle }) | null {
  const c = verifyToken<RenderClaims>(token);
  if (!c) return null;
  return { ...c, draft: c.draftKey ? drafts.get(c.draftKey) : undefined };
}

/** The runtime renders standalone (top-level page) for PDF export and screenshots. */
/**
 * URL of the standalone runtime for a render token. "public" for links a user's browser opens; "internal"
 * for the headless browser on the server, which reaches the runtime and the API through local addresses.
 */
export const renderUrl = (token: string, where: "public" | "internal" = "public") => {
  const [rt, api] = where === "internal" ? [config.internalRuntimeUrl, config.internalApiUrl] : [config.runtimeOrigin, config.publicApiUrl];
  return `${rt.replace(/\/$/, "")}/index.html?token=${encodeURIComponent(token)}&api=${encodeURIComponent(api)}`;
};

export function browserAvailable(): boolean {
  const s = getSkill("export-pdf");
  return Boolean(s?.server?.tools?.screenshot);
}

/** PNG data URL of a draft rendered with live data, or null when no browser is available. */
export async function screenshotDraft(projectId: string, user: User, draft: PageBundle): Promise<string | null> {
  const s = getSkill("export-pdf");
  const shot = s?.server?.tools?.screenshot;
  if (!shot) return null;
  const token = createRenderToken({ projectId, userId: user.id, mode: "draft" }, draft);
  try {
    return (await shot({ url: renderUrl(token, "internal"), width: 1280, height: 900 }, null as never)) as string;
  } catch {
    return null;
  }
}
