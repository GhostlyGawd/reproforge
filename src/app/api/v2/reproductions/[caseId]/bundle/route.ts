import { defaultCaseService } from "@/application/default-case-service";
import { createExportBundleHandler } from "../../../handlers";

export const runtime = "nodejs";

export const GET = createExportBundleHandler(defaultCaseService);

