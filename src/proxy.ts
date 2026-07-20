import { auth0Middleware } from "@/auth/auth0-client";

export async function proxy(request: Request): Promise<Response> {
  return auth0Middleware(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
