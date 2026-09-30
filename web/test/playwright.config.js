/* The panel on the screens it lives on: the wall tablet, an iPad either way
 * round, a phone upright and on its side — Chromium and WebKit (Safari). */
const { defineConfig, devices } = require("@playwright/test");

const PORT = 8790;
module.exports = defineConfig({
  testDir: ".",
  timeout: 60000,
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}/`, trace: "retain-on-failure" },
  webServer: { command: `node serve.js`, env: { PORT: String(PORT) }, port: PORT, reuseExistingServer: true },
  projects: [
    { name: "wall", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "ipad", use: { ...devices["iPad Pro 11"] } },
    { name: "ipad-landscape", use: { ...devices["iPad Pro 11 landscape"] } },
    { name: "phone", use: { ...devices["iPhone 14"] } },
    { name: "phone-landscape", use: { ...devices["iPhone 14 landscape"] } },
  ],
});
