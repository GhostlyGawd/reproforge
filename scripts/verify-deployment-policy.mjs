import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];

const [policy, packageJson, environmentExample, runtimeSource, operations] =
  await Promise.all([
    readFile(join(root, "docs", "deployment-policy.json"), "utf8").then(JSON.parse),
    readFile(join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(join(root, ".env.example"), "utf8"),
    readFile(join(root, "src", "config", "runtime.ts"), "utf8"),
    readFile(join(root, "docs", "operations.md"), "utf8"),
  ]);

const migrationDirectory = join(
  root,
  "src",
  "infrastructure",
  "postgres",
  "migrations",
);
const migrations = (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort()
  .map((name) => name.slice(0, -4));
const current = migrations.at(-1);
const previous = migrations.at(-2);

if (policy.schemaVersion !== "1.0") failures.push("unsupported policy schema");
if (policy.applicationVersion !== packageJson.version) {
  failures.push("application version does not match package.json");
}
if (policy.database?.currentMigration !== current) {
  failures.push("current migration does not match the migration directory");
}
if (policy.database?.previousMigration !== previous) {
  failures.push("previous migration is not the immediate compatibility floor");
}
if (policy.database?.destructiveRollbackAllowed !== false) {
  failures.push("destructive database rollback must remain disabled");
}
if (
  policy.database?.rollbackStrategy !==
  "application-rollback-with-forward-database"
) {
  failures.push("rollback strategy changed without policy review");
}

const latestSql = current
  ? await readFile(join(migrationDirectory, `${current}.sql`), "utf8")
  : "";
const destructiveLatestMigration = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+COLUMN\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\s+COLUMN\b[\s\S]{0,80}\bTYPE\b/i,
].some((pattern) => pattern.test(latestSql));
if (destructiveLatestMigration) {
  failures.push("latest migration violates the expand/contract rollback window");
}

for (const variable of policy.killSwitches ?? []) {
  if (!environmentExample.includes(`${variable}=`)) {
    failures.push(`${variable} is missing from .env.example`);
  }
  if (!runtimeSource.includes(`\"${variable}\"`)) {
    failures.push(`${variable} is missing from the runtime parser`);
  }
}

for (const anchor of [
  "alert-dependency-readiness-unavailable",
  "alert-runner-unavailable",
  "alert-queued-job-age-high",
  "alert-outbox-lag-high",
  "alert-expired-leases-present",
  "alert-outbox-dead-present",
  "alert-deletion-failure-present",
  "alert-sandbox-quarantine-present",
]) {
  const heading = anchor
    .split("-")
    .map((word, index) =>
      index === 0 ? `${word[0]?.toUpperCase()}${word.slice(1)}:` : word,
    )
    .join(" ");
  if (!operations.toLowerCase().includes(heading.toLowerCase())) {
    failures.push(`operations runbook is missing ${anchor}`);
  }
}

if (failures.length > 0) {
  console.error(failures.sort().join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Verified deployment policy ${policy.schemaVersion} for ${current} with rollback floor ${previous}.`,
  );
}
