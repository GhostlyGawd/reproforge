import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("renders the actual ChatGPT widget with proof and bundle controls", async ({ page }) => {
  await page.goto("/widget-preview");

  await expect(page).toHaveTitle(/ReproForge proof/);
  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible();
  await expect(page.getByText(/^case \/ /)).toBeVisible();
  await expect(page.getByText("3 / 3 matched")).toBeVisible();
  await expect(page.getByText("Control clear")).toBeVisible();
  await expect(page.getByText("100% repeatable")).toBeVisible();
  await expect(page.getByText("REPRO.md", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh proof" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export bundle" })).toBeVisible();
});

test("has no automatically detectable widget accessibility violations", async ({
  page,
}) => {
  await page.goto("/widget-preview");
  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

test("keeps the proof card legible in a narrow ChatGPT container", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto("/widget-preview");

  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible();
  const hasNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth,
  );
  expect(hasNoHorizontalOverflow).toBe(true);
});

test("remains usable at 200 percent zoom", async ({ page }) => {
  await page.setViewportSize({ width: 780, height: 900 });
  await page.goto("/widget-preview");
  await page.evaluate(() => {
    document.documentElement.style.zoom = "2";
  });

  await expect(page.getByRole("heading", { name: "Verified reproduction" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export bundle" })).toBeVisible();
  const hasNoHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
  );
  expect(hasNoHorizontalOverflow).toBe(true);
});

test("provides visible keyboard focus for widget actions", async ({ page }) => {
  await page.goto("/widget-preview");

  await page.keyboard.press("Tab");
  const refresh = page.getByRole("button", { name: "Refresh proof" });
  await expect(refresh).toBeFocused();
  const outlineWidth = await refresh.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).outlineWidth),
  );
  expect(outlineWidth).toBeGreaterThanOrEqual(3);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Export bundle" })).toBeFocused();
});
