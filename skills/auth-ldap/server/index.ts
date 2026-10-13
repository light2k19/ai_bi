import { Client } from "ldapts";
import { defineServerSkill, type AuthIdentity } from "@aibi/skill-sdk";

interface Cfg {
  url: string;
  baseDn: string;
  bindDn?: string;
  bindPassword?: string;
  upnSuffix?: string;
  loginAttribute: string;
  emailAttribute: string;
  nameAttribute: string;
  userFilter?: string;
  tlsRejectUnauthorized: boolean;
  autoCreateUsers: boolean;
}

function cfg(settings: Record<string, unknown>): Cfg {
  const s = settings as Partial<Cfg>;
  if (!s.url || !s.baseDn) throw new Error("Active Directory is not configured: server URL and base DN are required");
  return {
    url: s.url,
    baseDn: s.baseDn,
    bindDn: s.bindDn || undefined,
    bindPassword: s.bindPassword || undefined,
    upnSuffix: s.upnSuffix?.replace(/^@/, "") || undefined,
    loginAttribute: s.loginAttribute || "sAMAccountName",
    emailAttribute: s.emailAttribute || "mail",
    nameAttribute: s.nameAttribute || "displayName",
    userFilter: s.userFilter || undefined,
    tlsRejectUnauthorized: s.tlsRejectUnauthorized !== false,
    autoCreateUsers: s.autoCreateUsers === true,
  };
}

const client = (c: Cfg) => new Client({ url: c.url, timeout: 8000, connectTimeout: 5000, tlsOptions: { rejectUnauthorized: c.tlsRejectUnauthorized } });

/** RFC 4515 escaping so a typed user id can never change the filter. */
const esc = (v: string) => v.replace(/[\\*()\0]/g, (ch) => `\\${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);

const attr = (entry: Record<string, unknown>, name: string): string | undefined => {
  const v = entry[name] ?? entry[name.toLowerCase()];
  const first = Array.isArray(v) ? v[0] : v;
  return first === undefined || first === null ? undefined : String(first);
};

/** A user id is a plain account name or a UPN; never a DN or a filter. */
function normaliseLogin(login: string): string {
  const l = login.trim();
  if (!l || l.length > 200 || /[\s,=()*\\\0]/.test(l)) throw new Error("Enter a Windows user id such as jsmith or jsmith@corp.example.com");
  return l;
}

async function find(cl: Client, c: Cfg, login: string): Promise<Record<string, unknown> | null> {
  const id = esc(login);
  const who = `(|(${c.loginAttribute}=${id})(userPrincipalName=${id})${c.upnSuffix && !login.includes("@") ? `(userPrincipalName=${id}@${esc(c.upnSuffix)})` : ""})`;
  const filter = `(&(objectClass=user)${who}${c.userFilter ?? ""})`;
  const { searchEntries } = await cl.search(c.baseDn, { scope: "sub", filter, attributes: ["dn", c.loginAttribute, c.emailAttribute, c.nameAttribute, "userPrincipalName", "cn", "userAccountControl"], sizeLimit: 2 });
  if (searchEntries.length !== 1) return null;
  return searchEntries[0] as Record<string, unknown>;
}

function identity(c: Cfg, login: string, entry: Record<string, unknown> | null): AuthIdentity {
  const accountName = (entry && attr(entry, c.loginAttribute)) || login.replace(/@.*$/, "");
  const upn = entry ? attr(entry, "userPrincipalName") : undefined;
  const email = (entry && attr(entry, c.emailAttribute)) || upn || (login.includes("@") ? login : null);
  return { externalId: accountName.toLowerCase(), email: email ? email.toLowerCase() : null, displayName: (entry && (attr(entry, c.nameAttribute) || attr(entry, "cn"))) || undefined };
}

const disabledFlag = (entry: Record<string, unknown> | null) => entry && (Number(attr(entry, "userAccountControl") ?? 0) & 0x2) !== 0;

/** Bind with the service account, run `fn`, always unbind. */
async function withService<T>(c: Cfg, fn: (cl: Client) => Promise<T>): Promise<T> {
  if (!c.bindDn) throw new Error("Looking users up needs a service account (bind DN and password) in the Active Directory settings");
  const cl = client(c);
  try {
    await cl.bind(c.bindDn, c.bindPassword ?? "");
    return await fn(cl);
  } finally {
    await cl.unbind().catch(() => undefined);
  }
}

export default defineServerSkill({
  auth: {
    providers: () => [{ id: "ldap", label: "Active Directory", kind: "password" }],

    /** The directory checks the password: service-account lookup then a bind as the user, or a direct UPN bind. */
    async verifyPassword(settings, login, password) {
      const c = cfg(settings);
      const id = normaliseLogin(login);
      if (!password) return null;
      let entry: Record<string, unknown> | null = null;
      let bindAs = c.upnSuffix && !id.includes("@") ? `${id}@${c.upnSuffix}` : id;
      if (c.bindDn) {
        entry = await withService(c, (cl) => find(cl, c, id));
        if (!entry || disabledFlag(entry)) return null;
        bindAs = String(entry.dn);
      }
      const cl = client(c);
      try {
        try {
          await cl.bind(bindAs, password);
        } catch {
          return null;
        }
        if (!entry) entry = await find(cl, c, id).catch(() => null);
        if (disabledFlag(entry)) return null;
        return identity(c, id, entry);
      } finally {
        await cl.unbind().catch(() => undefined);
      }
    },

    /** Email and display name of a user id, for adding AD users as members. */
    async lookup(settings, login) {
      const c = cfg(settings);
      const id = normaliseLogin(login);
      const entry = await withService(c, (cl) => find(cl, c, id));
      return entry ? identity(c, id, entry) : null;
    },

    /** Connects and binds with the service account (or just connects when there is none). */
    async test(settings) {
      const c = cfg(settings);
      const cl = client(c);
      try {
        if (c.bindDn) {
          await cl.bind(c.bindDn, c.bindPassword ?? "");
          const { searchEntries } = await cl.search(c.baseDn, { scope: "base", attributes: ["dn"] });
          return { ok: true, message: `Connected to ${c.url}; service account accepted; base DN ${searchEntries.length ? "found" : "not readable"}` };
        }
        await cl.bind("", "").catch(() => undefined);
        return { ok: true, message: `Connected to ${c.url} (no service account: users bind directly as <id>@${c.upnSuffix ?? "…"})` };
      } catch (e) {
        return { ok: false, message: `Cannot use ${c.url}: ${(e as Error).message}` };
      } finally {
        await cl.unbind().catch(() => undefined);
      }
    },
  },
});
