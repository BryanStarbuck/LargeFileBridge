// The security model (security.mdx §1, §5, §6). One allow decision, read LIVE from config.access on
// every request; the first-run Security Setup page writes it once. All normalization lives here so
// the enforced list is canonical no matter how the operator typed it.
import type {
  SecurityAccess,
  SecurityConfigPublic,
  SecuritySetupInput,
  SecuritySetupResult,
} from "@lfb/shared";
import { getAppConfig, updateAppConfig } from "../store-model/config.service.js";

export const APP_NAME = "Large File Bridge";

/** Thrown for a bad/refused security write; the router maps `.status` to an HTTP code. */
export class SecurityError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
    this.name = "SecurityError";
  }
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Trim, strip a leading @, lowercase, validate; drop invalid/empty. De-duped, order preserved. */
export function normalizeDomains(input: string[]): string[] {
  const out: string[] = [];
  for (const raw of input ?? []) {
    const d = String(raw).trim().replace(/^@+/, "").toLowerCase();
    if (d && DOMAIN_RE.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Trim, lowercase, validate email; drop invalid/empty. De-duped, order preserved. */
export function normalizeEmails(input: string[]): string[] {
  const out: string[] = [];
  for (const raw of input ?? []) {
    const e = String(raw).trim().toLowerCase();
    if (e && EMAIL_RE.test(e) && !out.includes(e)) out.push(e);
  }
  return out;
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
}

/** Explicit ops/dev override only — never a silent default that would breach default-deny (§2). */
function envDomains(): string[] {
  return normalizeDomains((process.env.AUTH_ALLOWED_DOMAINS || "").split(","));
}

// ── The one allow decision (security.mdx §1) — read LIVE, fail closed ────────
export function allowListed(email: string | null): boolean {
  if (!email) return false;
  const a = getAppConfig().access;
  const e = email.toLowerCase();
  if (a.allow_companies && a.allowed_domains.map((d) => d.toLowerCase()).includes(domainOf(e))) {
    return true;
  }
  if (a.allow_individuals && a.allowed_emails.map((x) => x.toLowerCase()).includes(e)) {
    return true;
  }
  return false;
}

export function securityConfigured(): boolean {
  return getAppConfig().access.configured === true;
}

/** Coarse OIDC pre-filter for OpenAuthFederated (security.mdx §6.1) — boot-captured. */
export function oafAllowedDomains(): string[] {
  const a = getAppConfig().access;
  const set = new Set<string>();
  if (a.allow_companies) for (const d of a.allowed_domains) set.add(d.toLowerCase());
  if (a.allow_individuals) for (const e of a.allowed_emails) set.add(domainOf(e));
  for (const d of envDomains()) set.add(d);
  return [...set].filter(Boolean);
}

// ── Public / admin views ─────────────────────────────────────────────────────
export function getPublicSecurityConfig(): SecurityConfigPublic {
  return { configured: securityConfigured(), appName: APP_NAME };
}

export function getSecurityAccess(): SecurityAccess {
  const a = getAppConfig().access;
  return {
    allowCompanies: a.allow_companies,
    allowedDomains: a.allowed_domains,
    allowIndividuals: a.allow_individuals,
    allowedEmails: a.allowed_emails,
  };
}

/**
 * Normalize a setup/PATCH body into a stored access block. Coerces an enabled-but-empty switch OFF
 * (§5) and enforces the non-empty invariant — an install that allows NOBODY is refused (§8.2).
 */
function normalizeInput(input: SecuritySetupInput): {
  allow_companies: boolean;
  allowed_domains: string[];
  allow_individuals: boolean;
  allowed_emails: string[];
} {
  const domains = normalizeDomains(input.domains);
  const emails = normalizeEmails(input.emails);
  const allow_companies = Boolean(input.allowCompanies) && domains.length > 0;
  const allow_individuals = Boolean(input.allowIndividuals) && emails.length > 0;
  if (!allow_companies && !allow_individuals) {
    throw new SecurityError(
      "Allow at least one company domain or individual account (an empty allow-list locks everyone out).",
      400,
      "empty_allow_list",
    );
  }
  return {
    allow_companies,
    allowed_domains: allow_companies ? domains : [],
    allow_individuals,
    allowed_emails: allow_individuals ? emails : [],
  };
}

/** First-run write — refused (409) once already configured (§8.1). */
export async function completeSetup(input: SecuritySetupInput): Promise<SecuritySetupResult> {
  if (securityConfigured()) {
    throw new SecurityError("Security is already configured.", 409, "already_configured");
  }
  const next = normalizeInput(input);
  await updateAppConfig((c) => {
    c.access.configured = true;
    c.access.allow_companies = next.allow_companies;
    c.access.allowed_domains = next.allowed_domains;
    c.access.allow_individuals = next.allow_individuals;
    c.access.allowed_emails = next.allowed_emails;
    return c;
  });
  // The router hot-swaps OAF's OIDC pre-filter (rebuildAuthFrontend) right after this write, so a new
  // company domain takes effect on the next sign-in with no restart (§6.3).
  return { configured: true, restartRecommended: false };
}

/** Admin return-visit edit (§7.3) — keeps `configured:true`, same normalization + invariant. */
export async function updateSecurity(input: SecuritySetupInput): Promise<SecurityAccess> {
  const next = normalizeInput(input);
  await updateAppConfig((c) => {
    c.access.configured = true;
    c.access.allow_companies = next.allow_companies;
    c.access.allowed_domains = next.allowed_domains;
    c.access.allow_individuals = next.allow_individuals;
    c.access.allowed_emails = next.allowed_emails;
    return c;
  });
  return getSecurityAccess();
}
