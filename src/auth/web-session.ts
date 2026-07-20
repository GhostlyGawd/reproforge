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

export class WebSessionError extends Error {
  readonly code = "INVALID_WEB_SESSION" as const;

  constructor() {
    super("The authenticated web session is unavailable");
    this.name = "WebSessionError";
  }
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

export function resolveWebIdentity(
  session: unknown,
  tenantClaim: string,
): WebIdentity {
  if (
    typeof session !== "object" ||
    session === null ||
    !("user" in session) ||
    typeof session.user !== "object" ||
    session.user === null
  ) {
    throw new WebSessionError();
  }
  const user = session.user as Record<string, unknown>;
  const issuer = z.url().safeParse(user.iss);
  const subject = opaqueId.safeParse(user.sub);
  const tenantId = opaqueId.safeParse(user[tenantClaim]);
  if (
    !issuer.success ||
    new URL(issuer.data).protocol !== "https:" ||
    !subject.success ||
    !tenantId.success
  ) {
    throw new WebSessionError();
  }
  return {
    email: optionalString(user.email, 320),
    issuer: issuer.data,
    name: optionalString(user.name, 160),
    picture: optionalHttpsUrl(user.picture),
    subject: subject.data,
    tenantId: tenantId.data,
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
