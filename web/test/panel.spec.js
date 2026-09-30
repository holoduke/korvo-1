/* The panel in demo mode (?demo: a fake Home Assistant in ha-demo.js), on
 * every screen in playwright.config.js, served under the production CSP.
 * Run: cd web/test && npm i && npx playwright test */
const { test, expect } = require("@playwright/test");

/* Collects what should never happen: script errors, CSP refusals, failed requests for our own files. */
function watch(page) {
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const text = m.text();
    if (m.type() === "error" || /Content Security Policy|Refused to/i.test(text)) problems.push(`console: ${text}`);
  });
  page.on("response", (r) => {
    const url = new URL(r.url());
    if (url.hostname === "localhost" && r.status() >= 400) problems.push(`${r.status()} ${url.pathname}`);
  });
  return problems;
}

async function open(page, hash = "") {
  await page.goto(`index.html?demo${hash ? "#" + hash : ""}`);
  await page.waitForFunction(() => window.Panel && window.Panel.client && document.querySelector("#tabbar [data-tab]"));
  await page.waitForTimeout(1200); /* the house and the first states settle */
}

/* The first element matching selector that is on screen and not covered, as a locator. */
async function onScreen(page, selector) {
  const found = await page.evaluate((sel) => {
    document.querySelectorAll("[data-test-pick]").forEach((el) => el.removeAttribute("data-test-pick"));
    const el = [...document.querySelectorAll(sel)].find((b) => {
      const r = b.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
      return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    });
    if (el) el.setAttribute("data-test-pick", "");
    return !!el;
  }, selector);
  if (!found) throw new Error(`nothing on screen matches ${selector}`);
  return page.locator("[data-test-pick]");
}

const slugs = (page) => page.evaluate(() => window.PANEL_CONFIG.sections.map((s) => Util.slug(s.name)));

test("every section renders without errors, placeholders or sideways scroll", async ({ page }) => {
  const problems = watch(page);
  await open(page);
  for (const slug of await slugs(page)) {
    await page.evaluate((h) => Panel.goHash("#" + h, false), slug);
    await page.waitForTimeout(700);
    const report = await page.evaluate(() => {
      const page = document.querySelector(".section.active, [data-section].active") || document.body;
      const text = document.body.innerText;
      return {
        placeholder: (text.match(/[^\n]*\b(undefined|NaN|null)\b[^\n]*|\[object Object\]/) || [""])[0].slice(0, 120),
        overflow: document.scrollingElement.scrollWidth - window.innerWidth,
        hash: location.hash,
        empty: !page.innerText.trim(),
      };
    });
    expect.soft(report.hash, `route of ${slug}`).toContain(slug);
    expect.soft(report.placeholder, `placeholder text on ${slug}`).toBe("");
    expect.soft(report.overflow, `sideways scroll on ${slug}`).toBeLessThanOrEqual(1);
  }
  expect(problems).toEqual([]);
});

test("a lamp switches from its power button", async ({ page }) => {
  const problems = watch(page);
  await open(page, "verlichting");
  const power = await onScreen(page, ".tile.lamp [data-power]");
  const id = await power.getAttribute("data-power");
  const before = await page.evaluate((i) => Panel.st(i).state, id);
  await power.click();
  await expect.poll(() => page.evaluate((i) => Panel.st(i).state, id)).not.toBe(before);
  expect(problems).toEqual([]);
});

test("a scene becomes the active one", async ({ page }) => {
  const problems = watch(page);
  await open(page, "verlichting");
  const scene = await onScreen(page, "[data-scene]:not(.active)");
  const key = await scene.getAttribute("data-scene");
  await scene.click();
  await expect(page.locator(`[data-scene="${key}"]`).first()).toHaveClass(/\bactive\b/, { timeout: 5000 });
  expect(problems).toEqual([]);
});

test("the heating target steps and shows as pending", async ({ page }) => {
  const problems = watch(page);
  await open(page);
  const widget = page.locator("[data-house-heat]");
  test.skip(!(await widget.isVisible()), "no thermostat beside the house on this screen");
  const target = widget.locator("[data-hh-target]");
  const before = await target.innerText();
  await widget.locator('[data-heat-step="1"]').click();
  await expect(widget).toHaveClass(/\bpending\b/);
  await expect(target).not.toHaveText(before);
  expect(problems).toEqual([]);
});

test("settings open with the health list and close again", async ({ page }) => {
  const problems = watch(page);
  await open(page);
  await page.locator("#gear").click();
  const settings = page.locator("#settings");
  await expect(settings).toBeVisible();
  await expect(settings).not.toContainText(/undefined|NaN/);
  await page.locator("#settingsClose").click();
  await expect(settings).toBeHidden();
  expect(problems).toEqual([]);
});

test("the hash of a floor survives a reload", async ({ page }) => {
  await open(page, "verlichting");
  const hash = await page.evaluate(() => location.hash);
  await page.reload();
  await page.waitForFunction(() => window.Panel && document.querySelector("#tabbar [data-tab]"));
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => location.hash)).toBe(hash);
});
