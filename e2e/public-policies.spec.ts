import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const pages = [
  ["/privacy", "Bounded inputs. Auditable retention."],
  ["/terms", "A narrow agreement for a bounded preview."],
  ["/support", "Bring evidence. Keep sensitive details private."],
  ["/security", "Untrusted source never gets ambient trust."],
] as const;

for (const [path, heading] of pages) {
  test(`${path} is public, accessible, and mobile-safe`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const response = await page.goto(path);

    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Policy navigation" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
}

test("the product surface makes every public policy discoverable", async ({ page }) => {
  await page.goto("/");
  const policies = page.getByRole("navigation", { name: "Product policies" });

  await expect(policies.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
  await expect(policies.getByRole("link", { name: "Terms" })).toHaveAttribute("href", "/terms");
  await expect(policies.getByRole("link", { name: "Support" })).toHaveAttribute("href", "/support");
  await expect(policies.getByRole("link", { name: "Security" })).toHaveAttribute("href", "/security");
});
