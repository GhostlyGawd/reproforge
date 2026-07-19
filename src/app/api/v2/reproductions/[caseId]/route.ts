import { defaultCaseService } from "@/application/default-case-service";
import { createGetReproductionHandler } from "../../handlers";

export const runtime = "nodejs";

export const GET = createGetReproductionHandler(defaultCaseService);

