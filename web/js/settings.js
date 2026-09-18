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
    const c = Panel.client;
    const connected = $("status").classList.contains("connected");
    $("connInfo").textContent = c.demo
      ? "Demo-modus: nepdata, er gaan geen echte lampen aan of uit"
      : `${connected ? "Verbonden met" : "Niet verbonden met"} ${c.hassUrl()}`;
    $("connInfo").style.color = c.demo ? "var(--text_dim)" : connected ? "var(--ok)" : "var(--warn)";
    $("logout").innerHTML = icon("logout") + (c.demo ? "Demo verlaten" : "Uitloggen");
  }

  Panel.on("status", () => !$("settings").hidden && render()); /* the connection line follows */
  $("gear").addEventListener("click", () => {
    render();
    Panel.openOverlay($("settings"));
  });
  $("settingsClose").innerHTML = icon("close");
  $("settingsClose").addEventListener("click", () => Panel.closeOverlay($("settings")));
  $("settings").addEventListener("click", (e) => {
    if (e.target === $("settings")) return Panel.closeOverlay($("settings"));
    const theme = e.target.closest("[data-theme]");
    const mode = e.target.closest("[data-mode]");
    const time = e.target.closest("[data-time]");
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
