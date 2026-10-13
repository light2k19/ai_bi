import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { defineServerSkill, type AuthIdentity } from "@aibi/skill-sdk";

interface ProviderCfg {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string;
  allowedDomains?: string[];
}
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const discoveryCache = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

async function discover(issuer: string): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && Date.now() - hit.at < 3600_000) return hit.doc;
  const r = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error(`OIDC discovery failed for ${issuer}: HTTP ${r.status}`);
  const doc = (await r.json()) as Discovery;
  discoveryCache.set(issuer, { doc, at: Date.now() });
  return doc;
}

function providerById(settings: Record<string, unknown>, id: string): ProviderCfg {
  const p = ((settings.providers as ProviderCfg[] | undefined) ?? []).find((x) => x.id === id);
  if (!p) throw new Error(`unknown OIDC provider '${id}'`);
  return p;
}

const b64url = (b: Buffer) => b.toString("base64url");

export default defineServerSkill({
  auth: {
    providers(settings) {
      return ((settings.providers as ProviderCfg[] | undefined) ?? []).map((p) => ({ id: p.id, label: p.label, kind: "redirect" as const }));
    },
    async start(provider, settings, redirectUri) {
      const p = providerById(settings, provider);
      const d = await discover(p.issuer);
      const verifier = b64url(crypto.randomBytes(32));
      const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
      const state = b64url(crypto.randomBytes(16));
      const nonce = b64url(crypto.randomBytes(16));
      const url = new URL(d.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", p.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", p.scopes ?? "openid email profile");
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      return { url: url.toString(), state: { state, nonce, verifier } };
    },
    async callback(provider, settings, redirectUri, query, saved): Promise<AuthIdentity> {
      const p = providerById(settings, provider);
      if (!query.code || query.state !== saved.state) throw new Error("invalid OIDC state");
      const d = await discover(p.issuer);
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: query.code,
        redirect_uri: redirectUri,
        client_id: p.clientId,
        code_verifier: saved.verifier,
      });
      if (p.clientSecret) body.set("client_secret", p.clientSecret);
      const r = await fetch(d.token_endpoint, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
      if (!r.ok) throw new Error(`token exchange failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      const tok = (await r.json()) as { id_token?: string };
      if (!tok.id_token) throw new Error("provider returned no id_token");
      let jwks = jwksCache.get(d.jwks_uri);
      if (!jwks) jwksCache.set(d.jwks_uri, (jwks = createRemoteJWKSet(new URL(d.jwks_uri))));
      const { payload } = await jwtVerify(tok.id_token, jwks, { issuer: d.issuer, audience: p.clientId });
      if (payload.nonce !== saved.nonce) throw new Error("invalid OIDC nonce");
      const email = String(payload.email ?? payload.preferred_username ?? payload.upn ?? "").toLowerCase();
      if (!email) throw new Error("the identity token has no email claim; add the 'email' scope");
      if (p.allowedDomains?.length && !p.allowedDomains.some((dom) => email.endsWith(`@${dom.toLowerCase()}`))) {
        throw new Error(`email domain is not allowed for ${p.label}`);
      }
      return { externalId: `${provider}:${String(payload.sub)}`, email, displayName: payload.name ? String(payload.name) : undefined };
    },
  },
});
