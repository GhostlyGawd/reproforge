import { World, setWorldConstructor } from "@cucumber/cucumber";

import type { FailureOracle } from "@/domain/oracle";
import type { MinimizationInput, MinimizationResult } from "@/domain/minimization";
import type { RunResult } from "@/domain/run";
import type { VerificationSummary } from "@/domain/verification";
import type { SampleCaseResult } from "@/application/sample-case";
import type {
  CaseOperations,
  CaseService,
} from "@/application/case-service";
import type { StartResult } from "@/application/reproduction-contracts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PGlite } from "@electric-sql/pglite";
import type {
  ArtifactDescriptor,
  DurableReproductionRecord,
  DurableReservationResult,
  LeaseRecoverySummary,
  QueueMessage,
} from "@/application/ports/production";
import type { PostgresDatabase } from "@/infrastructure/postgres/database";
import type {
  PostgresDurableReproductionRepository,
  PostgresUnitOfWork,
} from "@/infrastructure/postgres/repositories";
import type { ContentAddressedArtifactStore } from "@/infrastructure/artifacts/content-addressed-store";
import type {
  PostgresTenantDataRetention,
  RetentionDeletionResult,
} from "@/infrastructure/retention/postgres-tenant-data-retention";
import type { MemoryPrivateBlobClient } from "../../tests/helpers/memory-private-blob-client";
import type { HealthReport, HealthService } from "@/application/health";
import type { TenantBackupArchive } from "@/application/tenant-backup";
import type { PostgresTenantBackupService } from "@/infrastructure/backup/postgres-tenant-backup";
import type { VerifiedBackupFixture } from "../../tests/helpers/tenant-backup-fixture";

export class ReproForgeWorld extends World {
  candidates: RunResult[] = [];
  control?: RunResult;
  executionBlocked = false;
  minimizationInput?: MinimizationInput;
  minimization?: MinimizationResult;
  oracle?: FailureOracle;
  summary?: VerificationSummary;
  sample?: SampleCaseResult;
  caseService?: CaseService;
  serviceErrorCode?: string;
  serviceStarts: StartResult[] = [];
  trustedExecutionCount = 0;
  previousOpenAIKey?: string;
  openAIKeyWasChanged = false;
  mcpClient?: Client;
  mcpServer?: McpServer;
  mcpStarts: Array<Record<string, unknown>> = [];
  mcpTools: Array<Record<string, unknown>> = [];
  mcpWidget?: Record<string, unknown>;
  durableDatabase?: PGlite;
  durablePostgres?: PostgresDatabase;
  durableRepository?: PostgresDurableReproductionRepository;
  durableUnitOfWork?: PostgresUnitOfWork;
  durableRecord?: DurableReproductionRecord;
  durableRead?: DurableReproductionRecord | null;
  durableStarts: DurableReservationResult[] = [];
  durableErrorCode?: string;
  durableArtifactStore?: ContentAddressedArtifactStore;
  durableBlobClient?: MemoryPrivateBlobClient;
  durableArtifactDescriptor?: ArtifactDescriptor;
  durableArtifactRead?: { bytes: Uint8Array; descriptor: ArtifactDescriptor } | null;
  durableQueueExecutions = 0;
  durableQueueOutcomes: string[] = [];
  durableRecoverySummaries: LeaseRecoverySummary[] = [];
  durableTrustedCaseService?: CaseOperations;
  durableTrustedClockMs = Date.parse("2026-07-20T20:00:00.000Z");
  durableTrustedMessages: QueueMessage[] = [];
  durableTrustedStarts: StartResult[] = [];
  durableRetention?: PostgresTenantDataRetention;
  durableRetentionResult?: RetentionDeletionResult | null;
  runtimeHealthService?: HealthService;
  runtimeHealthReport?: HealthReport;
  backupSourceDatabase?: PGlite;
  backupDestinationDatabase?: PGlite;
  backupDestinationBlobs?: MemoryPrivateBlobClient;
  backupDestinationService?: PostgresTenantBackupService;
  backupArchive?: TenantBackupArchive;
  backupFixture?: VerifiedBackupFixture;
}

setWorldConstructor(ReproForgeWorld);
