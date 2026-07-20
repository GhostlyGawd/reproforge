import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("discloses account export, retention, and deletion boundaries", async ({
  page,
}) => {
  await page.goto("/account");

  await expect(
    page.getByRole("heading", { name: "Your evidence, on your terms." }),
  ).toBeVisible();
  await expect(page.getByText("30-day customer data")).toBeVisible();
  await expect(page.getByText("Verifiable export")).toBeVisible();
  await expect(page.getByText("Provider-first deletion")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Export before you erase." }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Download account export" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete account data" })).toBeDisabled();
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    /^(signed-out|unconfigured)$/,
  );
  expect(await page.content()).not.toMatch(
    /primary-access-token|private-refresh-token|github_pat_/i,
  );
});

test("keeps account data policy accessible and responsive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/account");

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

test("does not expose account exports without a web session", async ({
  request,
}) => {
  const response = await request.get("/api/account/export", {
    headers: { "Idempotency-Key": "playwright-account-export" },
  });

  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    data: null,
    error: { code: "AUTHENTICATION_REQUIRED" },
    schemaVersion: "1.0",
  });
});
