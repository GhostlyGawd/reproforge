import { createProtectedResourceMetadataHandler } from "@/auth/protected-resource";
import { getOAuthResourceConfig } from "@/config/oauth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = createProtectedResourceMetadataHandler(
  getOAuthResourceConfig,
);
