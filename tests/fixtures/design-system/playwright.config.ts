import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: [
    "viewer.spec.ts",
    "navigation-card.spec.ts",
    "select.spec.ts",
    "toast.spec.ts",
    "typing-dots.spec.ts",
    "split-button.spec.ts",
  ],
  outputDir: "../../../test-results/design-system",
  workers: 1,
  retries: 0,
  use: {
    baseURL: "http://localhost:1443",
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
  ],
  webServer: [
    {
      command: "bin/pnpm exec vite --port 1445 --strictPort",
      cwd: "../../..",
      url: "http://localhost:1445",
      reuseExistingServer: false,
    },
    {
      command: "bin/pnpm design:preview",
      cwd: "../../..",
      url: "http://localhost:1443/tests/fixtures/design-system.html",
      reuseExistingServer: false,
    },
    {
      command: "bin/pnpm exec vite preview --port 1444 --strictPort",
      cwd: "../../..",
      url: "http://localhost:1444",
      reuseExistingServer: false,
    },
  ],
});
