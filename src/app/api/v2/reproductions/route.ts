import { defaultCaseService } from "@/application/default-case-service";
import { createStartReproductionHandler } from "../handlers";

export const runtime = "nodejs";

export const POST = createStartReproductionHandler(defaultCaseService);

