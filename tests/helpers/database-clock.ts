const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

// PGlite evaluates CURRENT_TIMESTAMP with the host clock. Keep integration-test
// clocks safely ahead of it while retaining exact, deterministic offsets inside
// each scenario. This prevents a long-lived fixed fixture date from expiring.
const databaseClockEpoch = Date.now() + DAY_IN_MILLISECONDS;

export function databaseClockAt(offsetMilliseconds = 0): string {
  return new Date(databaseClockEpoch + offsetMilliseconds).toISOString();
}
