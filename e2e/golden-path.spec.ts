import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("turns the trusted issue into a verified reproduction", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle(/ReproForge/);
  await expect(
    page.getByRole("heading", { name: "Turn a bug report into proof" }),
  ).toBeVisible();

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
  await expect(issue).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(start).toBeFocused();
  const outlineWidth = await start.evaluate((element) => getComputedStyle(element).outlineWidth);
  expect(Number.parseFloat(outlineWidth)).toBeGreaterThanOrEqual(3);

  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible();
});
