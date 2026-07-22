import { auth0Middleware } from "@/auth/auth0-client";
import { applyWebSecurityHeaders } from "@/http/web-security-headers";

export async function proxy(request: Request): Promise<Response> {
  const response = await auth0Middleware(request);
  return applyWebSecurityHeaders(response, {
    development: process.env.NODE_ENV !== "production",
    secureTransport: new URL(request.url).protocol === "https:",
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
