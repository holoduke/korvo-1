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

test("a robot that cannot find its place and drives home says so", async ({ page }) => {
  await open(page);
  const vac = await page.evaluate(() => window.PANEL_CONFIG.vacuum);
  test.skip(!vac, "no vacuum configured");
  /* the sequence the Xiaomi robot went through on 2026-10-01, three times */
  const steps = [
    [vac.vacuum, "cleaning"], [vac.status, "sweeping"], [vac.status, "relocation"],
    [vac.vacuum, "idle"], [vac.status, "go charging"], [vac.vacuum, "returning"], [vac.vacuum, "docked"],
  ];
  for (const [id, state] of steps) {
    await page.evaluate(([i, s]) => Panel.client.simulate(i, s), [id, state]);
    await page.waitForTimeout(150);
  }
  await expect(page.locator("#toast")).toContainText("vindt zijn plek op de kaart niet");
});

test("a robot sent home from the panel raises no alarm", async ({ page }) => {
  await open(page, "schoonmaak");
  const vac = await page.evaluate(() => window.PANEL_CONFIG.vacuum);
  test.skip(!vac, "no vacuum configured");
  for (const [id, state] of [[vac.vacuum, "cleaning"], [vac.status, "relocation"]]) {
    await page.evaluate(([i, s]) => Panel.client.simulate(i, s), [id, state]);
  }
  await page.waitForTimeout(300);
  await page.locator('#track > .page:not(.away) [data-vac="dock"]:not([hidden])').first().click(); /* scrolled to on a phone */
  for (const state of ["returning", "docked"]) {
    await page.evaluate(([i, s]) => Panel.client.simulate(i, s), [vac.vacuum, state]);
    await page.waitForTimeout(150);
  }
  await expect(page.locator("#toast")).not.toContainText("plek op de kaart");
});

test("a device's card on Energie opens its use per day, hour and month", async ({ page }) => {
  const problems = watch(page);
  await open(page, "energie");
  await page.locator("#track > .page:not(.away) .dc-card[data-usage]").first().click();
  const box = page.locator("#usage");
  await expect(box).toBeVisible();
  await expect(page.locator("#usageSum")).toContainText("kWh");
  await expect(page.locator("#usageSum")).toContainText("gemiddeld per dag");
  for (const range of ["0", "2", "3"]) {
    await page.locator(`[data-usage-range="${range}"]`).click();
    await expect(page.locator(`[data-usage-range="${range}"]`)).toHaveClass(/active/);
    await expect(page.locator("#usageSum")).toContainText("kWh");
  }
  await expect(box).not.toContainText(/undefined|NaN/);
  await page.locator("#usageClose").click();
  await expect(box).toBeHidden();
  expect(problems).toEqual([]);
});

test("the washer in Apparaten opens the same chart", async ({ page }) => {
  const problems = watch(page);
  await open(page, "apparaten");
  const washer = await page.evaluate(() => window.PANEL_CONFIG.appliances.findIndex((a) => a.kind === "washer"));
  test.skip(washer < 0, "no washer configured");
  await page.locator(`#track > .page:not(.away) [data-pick="${washer}"]`).first().click();
  await page.locator("#track > .page:not(.away) .ap-usage .usage-open").click();
  await expect(page.locator("#usage")).toBeVisible();
  await expect(page.locator("#usageTitle")).toHaveText(/Wasmachine/);
  expect(problems).toEqual([]);
});

test("a running washer whose power sensor says 0 W shows an estimate from its counter", async ({ page }) => {
  const problems = watch(page);
  await open(page, "energie");
  const w = await page.evaluate(() => (window.PANEL_CONFIG.energy || []).find((d) => d.kind === "washer"));
  test.skip(!w, "no washer on Energie");
  /* as over SmartThings: running, power stuck at 0 W, only the kWh counter moves */
  await page.evaluate((e) => {
    Panel.client.simulate(e.machine, "run");
    Panel.client.simulate(e.power, "0");
  }, w.entities);
  const card = page.locator(`#track > .page:not(.away) .dc-card[data-usage]`).filter({ hasText: w.label }).first();
  await expect(card).toContainText("geschat uit de kWh-teller");
  await expect(card.locator(".dc-value b")).not.toHaveText(/^0$|--/);
  expect(problems).toEqual([]);
});

test("Energie counts the estimated heat pump, lights and WTW, marked as estimates", async ({ page }) => {
  const problems = watch(page);
  await open(page, "energie");
  const est = await page.evaluate(() => (window.PANEL_CONFIG.energy || []).filter((d) => d.kind === "estimate" || d.kind === "heatpump").map((d) => d.label));
  test.skip(!est.length, "no estimated devices on Energie");
  const now = page.locator("#track > .page:not(.away) .en-now .en-legend");
  for (const label of est) await expect(now).toContainText(new RegExp(`${label} ≈ \\d`));
  const hp = page.locator("#track > .page:not(.away) .dc-card").filter({ hasText: "Warmtepomp" }).first();
  await expect(hp).toContainText("stroom");
  await expect(hp).toContainText(/COP ≈ \d/);
  expect(problems).toEqual([]);
});

test("a washer the LAN says runs shows how far it is, even when SmartThings is stuck on stop", async ({ page }) => {
  const problems = watch(page);
  await open(page, "apparaten");
  const at = await page.evaluate(() => window.PANEL_CONFIG.appliances.findIndex((a) => a.kind === "washer"));
  const w = await page.evaluate((n) => window.PANEL_CONFIG.appliances[n], at);
  test.skip(!w || !w.entities.running, "no washer read over the LAN");
  await page.locator(`#track > .page:not(.away) [data-pick="${at}"]`).first().click();
  const finish = new Date(Date.now() + 47 * 60000).toISOString();
  await page.evaluate(([e, at]) => {
    Panel.client.simulate(e.machine, "stop"); /* SmartThings frozen */
    Panel.client.simulate(e.running, "on");
    Panel.client.simulate(e.progress, "42");
    Panel.client.simulate(e.finish, at);
  }, [w.entities, finish]);
  const card = page.locator("#track > .page:not(.away) .ap-card").first();
  await expect(card).toContainText("42%");
  await expect(card).toContainText("klaar om");
  expect(problems).toEqual([]);
});

test("the WTW in Apparaten shows its stand and air, and switches the stand", async ({ page }) => {
  const problems = watch(page);
  await open(page, "apparaten");
  const i = await page.evaluate(() => window.PANEL_CONFIG.appliances.findIndex((a) => a.kind === "ventilation"));
  test.skip(i < 0, "no WTW configured");
  await page.locator(`#track > .page:not(.away) [data-pick="${i}"]`).first().click();
  const card = page.locator("#track > .page:not(.away) .ap-card");
  await expect(card).toContainText("Automatisch");
  await expect(card.locator(".wtw-x")).toContainText("rendement");
  await expect(card.locator(".wtw-x")).toContainText("13,5°");
  await card.locator('[data-appl$="|stand|CNT2"]').click();
  await expect(card).toContainText("Continu II");
  await expect(card.locator(".ap-big")).toHaveText("60");
  await card.locator('[data-appl$="|stand|MAN3x2"]').click();
  await expect(card).toContainText("Boost 30 min");
  /* the box's error, the real fans and its settings */
  await expect(card.locator(".ap-note.warn")).toContainText("43.23.01");
  await expect(card).toContainText("1.217 / 1.229 tpm");
  await card.locator('[data-appl$="|bypassmode|Dicht"]').click();
  await expect(card.locator('[data-appl$="|bypassmode|Dicht"]')).toHaveClass(/active/);
  await expect(card).not.toContainText("NightBoost koelt");
  await card.locator('[data-appl$="|toggle|nightboost"]').click();
  await expect(card).toContainText("NightBoost koelt");
  await card.locator('[data-appl$="|nightboosttemp|1"]').click();
  await expect(card).toContainText("25°");
  await card.locator('[data-appl$="|level|level1|1"]').click();
  await expect(card).toContainText("20%");
  await card.locator('[data-appl$="|filterinterval|270"]').click();
  await expect(card.locator('[data-appl$="|filterinterval|270"]')).toHaveClass(/active/);
  await expect(card).not.toContainText(/undefined|NaN/);
  expect(problems).toEqual([]);
});

test("the solar panels show on Energie and in Apparaten, and sleep after dark", async ({ page }) => {
  const problems = watch(page);
  await open(page, "energie");
  const sun = await page.evaluate(() => (window.PANEL_CONFIG.energy || []).find((d) => d.kind === "solar"));
  test.skip(!sun, "no solar panels configured");
  const panel = page.locator("#track > .page:not(.away) .en-solar");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("Levert");
  await expect(panel).toContainText("640 W");
  await expect(panel).toContainText("Opgewekt vandaag");
  await expect(panel).toContainText("3,40 kWh");
  await expect(panel).toContainText("305,2 V");
  /* the house's own use: what the grid gives plus what the panels make */
  await expect(page.locator("#track > .page:not(.away) .en-now")).toContainText("Verbruik huis nu");
  await expect(page.locator("#track > .page:not(.away) .en-now .en-big b")).toHaveText("2,41");
  await expect(page.locator("#track > .page:not(.away) .en-solar-row")).toBeVisible();
  await panel.locator(".usage-open").click();
  await expect(page.locator("#usage")).toBeVisible();
  await expect(page.locator("#usageTitle")).toHaveText("Zonnepanelen");
  await page.locator("#usageClose").click();
  /* after dark the inverter and its stick are off: asleep, not broken */
  await page.evaluate((e) => Panel.client.simulate(e.power, "unavailable"), sun.entities);
  await expect(panel).toContainText("Slaapt, geen zon");
  await expect(panel).toContainText("0 W");
  await expect(panel).not.toContainText(/undefined|NaN/);

  await page.evaluate(() => Panel.goHash("#apparaten", false));
  const i = await page.evaluate(() => window.PANEL_CONFIG.appliances.findIndex((a) => a.kind === "solar"));
  await page.locator(`#track > .page:not(.away) [data-pick="${i}"]`).first().click();
  const card = page.locator("#track > .page:not(.away) .ap-card");
  await expect(card).toContainText("Slaapt, geen zon");
  await page.evaluate((e) => Panel.client.simulate(e.power, "640"), sun.entities);
  await expect(card).toContainText("Levert");
  await expect(card.locator(".ap-big")).toHaveText("640");
  await expect(card).toContainText("String 1");
  await expect(card).toContainText("259 kWh");
  await expect(card).not.toContainText(/undefined|NaN/);
  expect(problems).toEqual([]);
});

test("paused music keeps its card beside the house for a while", async ({ page }) => {
  const problems = watch(page);
  await open(page);
  const play = page.locator('[data-aq="play"]').first();
  test.skip(!(await play.count()), "no music card on this screen");
  await expect(play).toHaveAttribute("aria-label", "Pauze");
  await page.evaluate(() => window.PANEL_CONFIG.media.forEach((m) => Panel.client.simulate(m.id, "paused")));
  /* paused a moment ago: still there to resume, now offering play */
  await expect(page.locator('[data-aq="play"]').first()).toHaveAttribute("aria-label", "Speel");
  expect(problems).toEqual([]);
});

test("switching every appliance off asks for a second tap, visibly", async ({ page }) => {
  const problems = watch(page);
  await open(page, "apparaten");
  const btn = page.locator("#track > .page:not(.away) [data-alloff]").first();
  await btn.click();
  await expect(btn).toHaveClass(/\barmed\b/);
  await expect(btn.locator(".txt")).toBeVisible();
  await expect(btn.locator(".txt")).toHaveText("Nogmaals tikken");
  expect(problems).toEqual([]);
});

test("beside the house the energy opens Energie, the WTW boosts, and a floor's lights switch off", async ({ page }) => {
  const problems = watch(page);
  await open(page);
  const energy = page.locator("[data-house-energy]");
  const wtw = page.locator("[data-house-wtw]");
  const lights = page.locator("[data-house-lights]");
  test.skip(!(await energy.isVisible()) && !(await lights.isVisible()), "no quick looks beside the house on this screen");
  /* nothing in one column runs over another */
  const boxes = await page.$$eval(".house-quick, [data-house-heat], [data-house-cover]", (els) =>
    els.filter((e) => e.offsetParent && !e.hidden).map((e) => e.getBoundingClientRect().toJSON())
  );
  for (const a of boxes) for (const b of boxes) if (a !== b && a.left < b.right && b.left < a.right) expect(a.bottom <= b.top + 1 || b.bottom <= a.top + 1).toBe(true);
  if (await lights.isVisible()) {
    const floor = lights.locator("[data-ql-floor].on").first();
    await expect(floor).toBeVisible({ timeout: 5000 });
    const fi = await floor.getAttribute("data-ql-floor");
    await floor.click();
    await expect(lights.locator(`[data-ql-floor="${fi}"] [data-ql-n]`)).toHaveText("uit", { timeout: 5000 });
  }
  if (await wtw.isVisible()) {
    await expect(wtw.locator("[data-qw-now] b")).not.toHaveText("–");
    const boost = wtw.locator('[data-qw-mode="MAN3x2"]');
    if (await boost.isVisible()) {
      await boost.click();
      await expect(boost).toHaveClass(/active/, { timeout: 5000 });
      await expect(wtw.locator("[data-qw-stand]")).toContainText("nog 30 min");
      await expect(wtw.locator("[data-qw-now] b")).toHaveText("100");
      await wtw.locator('[data-qw-mode="AUTO"]').click();
      await expect(wtw.locator('[data-qw-mode="AUTO"]')).toHaveClass(/active/, { timeout: 5000 });
    }
  }
  if (await energy.isVisible()) {
    await expect(energy.locator("[data-qe-now] b")).not.toHaveText("–");
    await energy.click();
    await expect(page.locator("#track > .page:not(.away) .en-now")).toBeVisible();
  }
  if (await wtw.isVisible()) {
    await page.goto(page.url().split("#")[0]);
    await expect(wtw).toBeVisible();
    await wtw.locator("[data-qw-open]").click();
    await expect(page.locator('#track > .page:not(.away) .ap-card[data-kind="ventilation"]')).toBeVisible();
  }
  expect(problems).toEqual([]);
});
