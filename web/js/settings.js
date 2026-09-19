/* Settings (the gear): theme, screensaver mode and delay, the connection. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { cfg, $ } = Panel;

  function render() {
    $("themeList").innerHTML = cfg.themes
      .map(
        (t, i) =>
          `<button class="theme-card${i === Panel.prefs.theme ? " selected" : ""}" data-theme="${i}" style="background:${t.bg};color:${t.text}">` +
          `<span class="tc-dots"><i style="background:${t.tile}"></i><i style="background:${t.tile_on}"></i><i style="background:${t.scene_on}"></i><i style="background:${t.accent}"></i></span>` +
          `<span class="tc-name"${t.font ? ` style="font-family:'${t.font}'"` : ""}>${t.name}</span></button>`
      )
      .join("");
    const seg = (el, labels, sel, key) =>
      ($(el).innerHTML = labels.map((l, i) => `<button class="${i === sel ? "selected" : ""}" data-${key}="${i}">${l}</button>`).join(""));
    seg("saverMode", ["Scherm uit", "Het oog", "Huis"], Panel.prefs.saverMode, "mode");
    seg("saverTime", Panel.SAVER_LABELS, Panel.prefs.saverIdx, "time");
    seg("soundMode", ["Stil", "Klik bij tikken"], Panel.prefs.sound ? 1 : 0, "sound");
    const c = Panel.client;
    const connected = $("status").classList.contains("connected");
    $("connInfo").textContent = c.demo
      ? "Demo-modus: nepdata, er gaan geen echte lampen aan of uit"
      : `${connected ? "Verbonden met" : "Niet verbonden met"} ${c.hassUrl()}`;
    $("connInfo").style.color = c.demo ? "var(--text_dim)" : connected ? "var(--ok)" : "var(--warn)";
    $("logout").innerHTML = icon("logout") + (c.demo ? "Demo verlaten" : "Uitloggen");
  }

  Panel.on("status", () => !$("settings").hidden && render()); /* the connection line follows */
  /* The health page: each link in the chain with its state, refreshed each
   * minute and on every change while the dialog is open. */
  function renderHealth() {
    const c = Panel.client;
    const st = (id) => (Panel.st(id) || {}).state;
    const h = cfg.health || {};
    const lights = [...new Set(cfg.tabs.flatMap((t) => [...t.lights, ...t.devices].map((d) => d.id).filter((id) => id.startsWith("light."))))];
    const gone = lights.filter((id) => st(id) === "unavailable").length;
    const robots = [...(cfg.vacuum ? [{ label: cfg.vacuum.label, id: cfg.vacuum.vacuum }] : []), ...(cfg.tuyaVacuums || []).map((r) => ({ label: r.label, id: r.entities.vacuum }))];
    const connected = $("status").classList.contains("connected");
    const log = Panel.connectionLog ? Panel.connectionLog() : [];
    const faults = window.Diag ? window.Diag.errors() : [];
    const rows = [
      ["Home Assistant", connected ? `verbonden${c.latency && c.latency() != null ? ` · ${c.latency()} ms` : ""}${c.connectedSince && c.connectedSince() ? ` · sinds ${Util.hm(new Date(c.connectedSince()))}` : ""}` : "geen verbinding", connected ? "ok" : "bad"],
      ["Zigbee", !h.zigbee || st(h.zigbee) === undefined ? "onbekend" : st(h.zigbee) === "on" ? `bridge online · ${gone ? `${gone} van ${lights.length} lampen niet bereikbaar` : "alle lampen bereikbaar"}` : "bridge offline", !h.zigbee || st(h.zigbee) === undefined ? "dim" : st(h.zigbee) !== "on" ? "bad" : gone > lights.length * 0.4 ? "bad" : gone ? "warn" : "ok"],
      ["Internet", !h.internet || st(h.internet) === undefined ? "onbekend" : st(h.internet) === "on" ? "verbonden" : "weg", !h.internet || st(h.internet) === undefined ? "dim" : st(h.internet) === "on" ? "ok" : "bad"],
      ...robots.map((r) => [r.label, st(r.id) === "unavailable" ? "niet bereikbaar" : st(r.id) === undefined ? "onbekend" : "bereikbaar", st(r.id) === "unavailable" ? "warn" : st(r.id) === undefined ? "dim" : "ok"]),
      ["Paneel", `versie ${(document.querySelector('meta[name="panel-version"]') || {}).content || "?"} · aan sinds ${Util.hm(bootedAt)}`, "dim"],
      /* What happened since the page loaded: each time the connection went and
       * came back, and the script errors, newest first, each with its time. A
       * problem seen in the morning can then be read back without a refresh. */
      ["Verbinding", log.length ? log.slice(0, 8).map((e) => `${Util.hm(new Date(e.t))} ${e.up ? "terug" : "weg"}`).join(" · ") : "niet weggeweest sinds de start", log.length ? "warn" : "dim"],
      ...(faults.length ? faults.slice(0, 5).map((e) => ["Scriptfout", `${Util.hm(new Date(e.t))} ${e.text}`, "bad"]) : [["Scriptfouten", "geen", "dim"]]),
    ];
    $("health").innerHTML = rows.map(([k, v, tone]) => `<div class="health-row"><i class="hud-dot ${tone}"></i><span class="health-k">${k}</span><span class="health-v">${Util.esc(v)}</span></div>`).join("");
  }
  const bootedAt = new Date();
  const healthIds = () => [(cfg.health || {}).zigbee, (cfg.health || {}).internet].filter(Boolean);
  Panel.track(healthIds(), () => !$("settings").hidden && renderHealth());
  Panel.on("minute", () => !$("settings").hidden && renderHealth());
  Panel.on("status", () => !$("settings").hidden && renderHealth());

  $("gear").addEventListener("click", () => {
    render();
    renderHealth();
    Panel.openOverlay($("settings"));
  });
  $("settingsClose").innerHTML = icon("close");
  $("settingsClose").addEventListener("click", () => Panel.closeOverlay($("settings")));
  $("settings").addEventListener("click", (e) => {
    if (e.target === $("settings")) return Panel.closeOverlay($("settings"));
    const theme = e.target.closest("[data-theme]");
    const mode = e.target.closest("[data-mode]");
    const time = e.target.closest("[data-time]");
    const sound = e.target.closest("[data-sound]");
    if (sound) {
      Panel.setPref("sound", sound.dataset.sound === "1");
      if (Panel.prefs.sound) Panel.sound.tap();
    }
    if (theme) {
      Panel.setPref("theme", +theme.dataset.theme);
      Panel.applyTheme(+theme.dataset.theme);
    }
    if (mode) Panel.setPref("saverMode", +mode.dataset.mode);
    if (time) Panel.setPref("saverIdx", +time.dataset.time);
    if (theme || mode || time) render();
  });
  $("logout").addEventListener("click", () => Panel.client.logout());
})();
