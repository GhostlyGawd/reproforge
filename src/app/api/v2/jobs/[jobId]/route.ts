import { defaultCaseService } from "@/application/default-case-service";
import { createGetJobHandler } from "../../handlers";

export const runtime = "nodejs";

export const GET = createGetJobHandler(defaultCaseService);
