import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("turns the trusted issue into a verified reproduction", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/ReproForge/);
  await expect(
    page.getByRole("heading", { name: "Turn a bug report into proof" }),
  ).toBeVisible();
  await expect(page.getByText(/Offline sample · GPT-5\.6 (available|not configured)/)).toBeVisible();
  await expect(page.getByText("6 tool calls · 3 clean runs")).toBeVisible();
  await expect(page.getByText("oracle-cli-spaces v1 · exit 1 + ENOENT")).toBeVisible();
  await expect(page.getByText(/^case \/ case_[0-9a-f-]+$/)).toBeVisible();

  await page.getByRole("button", { name: "Run trusted sample" }).click();

  await expect(
    page.getByRole("heading", { name: "Verified reproduction" }),
  ).toBeVisible();
  await expect(page.getByText("3 / 3 candidate runs matched")).toBeVisible();
  await expect(page.getByText("Negative control passed")).toBeVisible();
  await expect(page.getByText("ENOENT", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download Repro Bundle" })).toHaveAttribute(
    "href",
    "/api/sample/bundle",
  );
});

test("has no automatically detectable accessibility violations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Run trusted sample" }).click();
  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("keeps the complete proof legible on a mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Run trusted sample" }).click();

  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download Repro Bundle" })).toBeVisible();
  const hasNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(hasNoHorizontalOverflow).toBe(true);
});

test("downloads a content-addressed bundle payload", async ({ request }) => {
  const response = await request.get("/api/sample/bundle");

  expect(response.ok()).toBe(true);
  expect(response.headers()["content-disposition"]).toContain(
    "reproforge-sample-bundle.json",
  );

  const payload = (await response.json()) as {
    bundle: { bundleHash: string; summary: { status: string } };
    files: Record<string, string>;
  };
  expect(payload.bundle.summary.status).toBe("VERIFIED");
  expect(payload.bundle.bundleHash).toMatch(/^[a-f0-9]{64}$/);
  expect(Object.keys(payload.files)).toContain("REPRO.md");
});

test("returns a deterministic investigation plan from the offline API", async ({ request }) => {
  const response = await request.post("/api/investigate", {
    data: {
      issue: "The CLI fails when the configuration path contains spaces.",
      maxToolCalls: 2,
      mode: "offline",
      repository: "fixture://cli-spaces",
    },
  });

  expect(response.ok()).toBe(true);
  const plan = (await response.json()) as {
    experiments: unknown[];
    mode: string;
    model: string;
  };
  expect(plan).toMatchObject({ mode: "offline", model: "offline-fixture-v1" });
  expect(plan.experiments).toHaveLength(1);
});

test("starts, polls, reads, and exports through REST v2", async ({ request }) => {
  const idempotencyKey = `playwright-${Date.now()}-${Math.random()}`;
  const start = await request.post("/api/v2/reproductions", {
    data: { sampleId: "cli-spaces" },
    headers: { "Idempotency-Key": idempotencyKey },
  });
  expect(start.status()).toBe(201);
  const startBody = (await start.json()) as {
    data: {
      snapshot: { case: { id: string }; job: { id: string; state: string } };
    };
    error: null;
    schemaVersion: string;
  };

  expect(startBody).toMatchObject({
    data: { snapshot: { job: { state: "SUCCEEDED" } } },
    error: null,
    schemaVersion: "2.0",
  });
  const caseId = startBody.data.snapshot.case.id;
  const jobId = startBody.data.snapshot.job.id;

  const retry = await request.post("/api/v2/reproductions", {
    data: { sampleId: "cli-spaces" },
    headers: { "Idempotency-Key": idempotencyKey },
  });
  expect(retry.status()).toBe(200);
  await expect(retry.json()).resolves.toMatchObject({
    data: { reused: true, snapshot: { case: { id: caseId } } },
  });

  const [reproduction, job, bundle] = await Promise.all([
    request.get(`/api/v2/reproductions/${caseId}`),
    request.get(`/api/v2/jobs/${jobId}`),
    request.get(`/api/v2/reproductions/${caseId}/bundle`),
  ]);
  expect(reproduction.ok()).toBe(true);
  expect(job.ok()).toBe(true);
  expect(bundle.ok()).toBe(true);
  await expect(job.json()).resolves.toMatchObject({
    data: { job: { id: jobId, state: "SUCCEEDED" } },
  });
  await expect(bundle.json()).resolves.toMatchObject({
    data: { bundle: { caseId, schemaVersion: "1.1" }, caseId },
  });
});

test("cancels an in-flight investigation without losing the issue", async ({ page }) => {
  await page.goto("/");
  const issue = page.getByLabel("Issue, error, or unexpected behavior");
  const originalIssue = await issue.inputValue();

  await page.getByRole("button", { name: "Run trusted sample" }).click();
  await page.getByRole("button", { name: "Cancel investigation" }).click();

  await expect(page.getByRole("heading", { name: "Investigation cancelled" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run trusted sample" })).toBeVisible();
  await expect(issue).toHaveValue(originalIssue);
});

test("starts the investigation using only the keyboard with visible focus", async ({ page }) => {
  await page.goto("/");
  const issue = page.getByLabel("Issue, error, or unexpected behavior");
  const start = page.getByRole("button", { name: "Run trusted sample" });

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Repositories" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(issue).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(start).toBeFocused();
  const outlineWidth = await start.evaluate((element) => getComputedStyle(element).outlineWidth);
  expect(Number.parseFloat(outlineWidth)).toBeGreaterThanOrEqual(3);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible();
});

test("completes without animated delay when reduced motion is requested", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await page.getByRole("button", { name: "Run trusted sample" }).click();
  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible({
    timeout: 1_000,
  });
});
