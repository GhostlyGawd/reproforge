import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: [["list"]],
  testDir: "./e2e",
  use: {
    baseURL: "http://127.0.0.1:3129",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3129",
    reuseExistingServer: false,
    timeout: 120_000,
    url: "http://127.0.0.1:3129",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
