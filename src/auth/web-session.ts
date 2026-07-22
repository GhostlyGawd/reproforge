import { createHash } from "node:crypto";

import { z } from "zod";

const opaqueId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:|-]*$/);

export type WebIdentity = {
  email: string | null;
  issuer: string;
  name: string | null;
  picture: string | null;
  subject: string;
  tenantId: string;
};

export type WebAccountView = {
  displayName: string;
  email: string | null;
  picture: string | null;
  signedIn: true;
};

export type WebSessionFailureReason =
  | "invalid_issuer"
  | "invalid_session"
  | "invalid_subject"
  | "invalid_tenant";

export class WebSessionError extends Error {
  readonly code = "INVALID_WEB_SESSION" as const;

  constructor(readonly reason: WebSessionFailureReason = "invalid_session") {
    super(`The authenticated web session is unavailable: ${reason}`);
    this.name = "WebSessionError";
  }
}

export function deriveWebTenantId(subject: string): string {
  const parsed = opaqueId.safeParse(subject);
  if (!parsed.success) throw new WebSessionError("invalid_subject");
  return `tenant_${createHash("sha256").update(parsed.data, "utf8").digest("hex")}`;
}

function optionalString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function optionalHttpsUrl(value: unknown): string | null {
  const normalized = optionalString(value, 2048);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function httpsIssuer(value: unknown): string | null {
  const parsed = z.url().safeParse(value);
  if (!parsed.success) return null;
  const url = new URL(parsed.data);
  return url.protocol === "https:" ? url.toString() : null;
}

export function resolveWebIdentity(
  session: unknown,
  tenantClaim: string,
  configuredIssuer?: string,
): WebIdentity {
  if (
    typeof session !== "object" ||
    session === null ||
    !("user" in session) ||
    typeof session.user !== "object" ||
    session.user === null
  ) {
    throw new WebSessionError("invalid_session");
  }
  const user = session.user as Record<string, unknown>;
  const subject = opaqueId.safeParse(user.sub);
  const sessionIssuer = httpsIssuer(user.iss);
  const trustedIssuer =
    configuredIssuer === undefined ? null : httpsIssuer(configuredIssuer);
  if (
    (user.iss !== undefined && !sessionIssuer) ||
    (configuredIssuer !== undefined && !trustedIssuer) ||
    (sessionIssuer && trustedIssuer && sessionIssuer !== trustedIssuer)
  )
    throw new WebSessionError("invalid_issuer");
  const issuer = sessionIssuer ?? trustedIssuer;
  if (!issuer) throw new WebSessionError("invalid_issuer");
  if (!subject.success) throw new WebSessionError("invalid_subject");
  const rawTenantId = user[tenantClaim];
  const tenantId =
    rawTenantId === undefined
      ? deriveWebTenantId(subject.data)
      : opaqueId.safeParse(rawTenantId).data;
  if (!tenantId) throw new WebSessionError("invalid_tenant");
  return {
    email: optionalString(user.email, 320),
    issuer,
    name: optionalString(user.name, 160),
    picture: optionalHttpsUrl(user.picture),
    subject: subject.data,
    tenantId,
  };
}

export function projectWebAccount(identity: WebIdentity): WebAccountView {
  return {
    displayName: identity.name ?? identity.email ?? "ReproForge user",
    email: identity.email,
    picture: identity.picture,
    signedIn: true,
  };
}
