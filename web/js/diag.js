/* Remote diagnostics. Each time the panel connects to Home Assistant it fires
 * a "panel_client" event that describes this device and how the layout came
 * out: version, viewport, browser, home-screen mode, the floor rail's geometry
 * and any script errors. An admin can watch it in HA (Developer tools > Events,
 * listen to "panel_client"), which is how a layout problem on the wall tablet
 * is diagnosed without a debugger attached. Loaded first so it sees errors
 * thrown by the scripts after it. */
(function () {
  "use strict";
  const errors = [];
  window.addEventListener("error", (e) => errors.push(`${e.message} @ ${(e.filename || "").split("/").pop()}:${e.lineno}`));
  window.addEventListener("unhandledrejection", (e) => errors.push("unhandled: " + ((e.reason && e.reason.message) || e.reason)));

  function box(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
  }

  function report() {
    const Panel = window.Panel;
    if (!Panel || !Panel.client || !Panel.client.fireEvent) return;
    const meta = document.querySelector('meta[name="panel-version"]');
    const track = document.getElementById("track");
    Panel.client
      .fireEvent("panel_client", {
        version: meta ? meta.content : null,
        ua: navigator.userAgent,
        viewport: [innerWidth, innerHeight],
        screen: [screen.width, screen.height],
        dpr: devicePixelRatio,
        standalone: !!navigator.standalone || matchMedia("(display-mode: fullscreen), (display-mode: standalone)").matches,
        hash: location.hash,
        section: Panel.section,
        floor: Panel.floor,
        page: box(document.querySelector(".floors-page")),
        rail: box(document.querySelector(".rail")),
        railButtons: [...document.querySelectorAll(".rail-btn")].map((b) => ({ floor: b.dataset.floor, ...box(b) })),
        track: track ? track.style.transform : null,
        supports: {
          overflowClip: CSS.supports("overflow", "clip"),
          dvh: CSS.supports("height", "100dvh"),
          colorMix: CSS.supports("color", "color-mix(in srgb, red 50%, blue)"),
        },
        errors: errors.slice(-10),
      })
      .catch(() => {}); /* not an admin, or the socket just dropped */
  }

  window.addEventListener("load", () => {
    const Panel = window.Panel;
    if (!Panel || !Panel.client || Panel.client.demo) return;
    /* After the first render; again after every reconnect. */
    Panel.client.on("status", (s) => s === "connected" && setTimeout(report, 1500));
    const dot = document.getElementById("status");
    if (dot && dot.classList.contains("connected")) setTimeout(report, 1500);
  });
})();
