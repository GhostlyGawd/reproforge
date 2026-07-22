export type WebSecurityHeaderOptions = {
  development: boolean;
  secureTransport: boolean;
};

function contentSecurityPolicy(options: WebSecurityHeaderOptions): string {
  const scriptDevelopment = options.development ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    `script-src 'self' 'unsafe-inline'${scriptDevelopment}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "media-src 'none'",
    "manifest-src 'self'",
    "worker-src 'self'",
    ...(options.secureTransport ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function applyWebSecurityHeaders(
  response: Response,
  options: WebSecurityHeaderOptions,
): Response {
  response.headers.set(
    "Content-Security-Policy",
    contentSecurityPolicy(options),
  );
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  response.headers.set("Origin-Agent-Cluster", "?1");
  response.headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-DNS-Prefetch-Control", "off");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Permitted-Cross-Domain-Policies", "none");
  if (options.secureTransport) {
    response.headers.set(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains",
    );
  }
  return response;
}
