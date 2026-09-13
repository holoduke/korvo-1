/* The boot splash: the "T-1000 Automation" title across the width, the
 * connection status and a loader, gone once the first states are in. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { $ } = Panel;
  const bootAt = performance.now();

  const TEXT = {
    connecting: "Verbinden met Home Assistant",
    connected: "Lampen en sensoren laden",
    disconnected: "Geen verbinding, opnieuw proberen",
    "auth-error": "Opnieuw inloggen",
  };
  const PROGRESS = { connecting: 40, connected: 80 };

  Panel.on("status", (s) => {
    if (!$("splash")) return; /* removed after the first successful load */
    $("splashStatus").textContent = TEXT[s] || "";
    if (PROGRESS[s]) $("splashFill").style.width = PROGRESS[s] + "%";
  });
  Panel.on("loaded", () => {
    const splash = $("splash");
    if (!splash) return;
    $("splashFill").style.width = "100%";
    /* Short minimum so the loader reads as intentional, not a flash. */
    setTimeout(() => {
      splash.classList.add("gone");
      setTimeout(() => splash.remove(), 520);
      Panel.wake();
    }, Math.max(350, 1100 - (performance.now() - bootAt)));
  });

  /* The title spans the width: its size comes from its measured width at a
   * reference size. If that would make it taller than MAX_H of the screen, it
   * keeps that height and wider letter spacing fills the rest. Again once the
   * web font has loaded (its metrics differ) and on resize or rotation. */
  const SPACING = 0.32; /* em, as in saver.css */
  const MAX_H = 0.08; /* of the viewport height */
  function fitTitle() {
    const title = $("splashTitle");
    if (!title || !$("splash")) return;
    const target = title.parentElement.clientWidth - parseFloat(getComputedStyle(title.parentElement).paddingLeft) * 2;
    const chars = title.textContent.length;
    title.style.fontSize = "100px";
    title.style.letterSpacing = "0";
    title.style.marginRight = "0";
    const perPx = title.getBoundingClientRect().width / 100; /* glyph width per px of font size */
    let size = target / (perPx + chars * SPACING);
    let spacing = SPACING;
    const cap = window.innerHeight * MAX_H;
    if (size > cap) {
      size = cap;
      spacing = Math.max(SPACING, (target / size - perPx) / chars);
    }
    title.style.fontSize = size.toFixed(2) + "px";
    title.style.letterSpacing = spacing.toFixed(4) + "em";
    title.style.marginRight = (-spacing).toFixed(4) + "em";
  }
  window.addEventListener("resize", fitTitle);

  Panel.on("start", () => {
    $("splashFill").style.width = "15%";
    fitTitle();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitTitle);
  });
})();
