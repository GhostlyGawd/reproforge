import { createStartRepositoryReproductionHandler } from "@/app/api/v2/repository-handlers";
import {
  authorizeRepositoryApi,
  repositoryOperations,
} from "@/app/api/v2/repository-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = createStartRepositoryReproductionHandler({
  authorize: authorizeRepositoryApi,
  operations: repositoryOperations,
});
