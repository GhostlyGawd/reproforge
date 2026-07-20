import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("presents the server-side account and GitHub authorization boundary", async ({
  page,
}) => {
  await page.goto("/repositories");

  await expect(
    page.getByRole("heading", { name: "Connect the code you want to reproduce." }),
  ).toBeVisible();
  await expect(page.getByText("Server-side session")).toBeVisible();
  await expect(page.getByText("Read-only GitHub App")).toBeVisible();
  await expect(page.getByText("Immutable source")).toBeVisible();
  await expect(page.locator("[data-session-state]")).toHaveAttribute(
    "data-session-state",
    /^(signed-out|unconfigured)$/,
  );

  const browserStorage = await page.evaluate(() => ({
    cookie: document.cookie,
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(browserStorage.local).toEqual({});
  expect(
    Object.keys(browserStorage.session).every((key) =>
      key.startsWith("__next_debug_channel:"),
    ),
  ).toBe(true);
  expect(JSON.stringify(browserStorage.session)).not.toMatch(
    /access_token|refresh_token|id_token|primary-access-token|private-refresh-token/i,
  );
  expect(browserStorage.cookie).not.toMatch(/access|refresh|id.?token/i);
  expect(await page.content()).not.toMatch(
    /primary-access-token|secondary-access-token|private-refresh-token/,
  );
});

test("keeps repository authorization accessible and responsive", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/repositories");

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
