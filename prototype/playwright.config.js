import { defineConfig, devices } from "@playwright/test";

/**
 * The real server, a fake Gmail. webServer boots backend/server.js on a port of its own so an
 * e2e run never collides with the dev server on 3456 and never sees its session cookie.
 *
 * GOOGLE_CLIENT_ID is set here because run.mjs and the server both refuse to start without one,
 * and the value is irrelevant: /api/config is intercepted before the page ever sees it.
 */
export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? "list" : [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3457",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node backend/server.js",
    url: "http://127.0.0.1:3457/api/config",
    reuseExistingServer: false,
    env: { PORT: "3457", GOOGLE_CLIENT_ID: "e2e-placeholder.apps.googleusercontent.com" },
    stdout: "ignore",
    stderr: "pipe",
  },
});
