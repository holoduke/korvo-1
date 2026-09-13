/* A scene's colours as a round swatch: the colours its lights take in the
 * scene's stored states (colour, colour temperature and brightness), the most
 * common first, as a pie of up to four. A scene that only switches lights off
 * gets a dark swatch with a power sign. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const MAX_COLOURS = 4;
  const byte = (v) => Math.round(Util.clamp(v, 0, 255));

  /* Colour temperature in kelvin -> [r, g, b] (Tanner Helland's fit of the black-body curve). */
  function kelvinRgb(kelvin) {
    const t = kelvin / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [r, g, b].map(byte);
  }

  /* CIE 1931 xy at full brightness -> sRGB [r, g, b]. */
  function xyRgb([x, y]) {
    const X = x / y;
    const Z = (1 - x - y) / y;
    const linear = [X * 1.656492 - 0.354851 - Z * 0.255038, -X * 0.707196 + 1.655397 + Z * 0.036152, X * 0.051713 - 0.121364 + Z * 1.01153].map((c) => Math.max(0, c));
    const max = Math.max(...linear, 1e-6);
    return linear.map((c) => {
      const v = c / max;
      return byte(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
    });
  }

  /* Hue (degrees) and saturation (%) -> [r, g, b] at half lightness. */
  function hsRgb([hue, saturation]) {
    const c = saturation / 100;
    const h = (((hue % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((h % 2) - 1));
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    const m = 0.5 - c / 2;
    return [r, g, b].map((v) => byte((v + m) * 255));
  }

  function baseColour(v) {
    if (Array.isArray(v.rgb_color)) return v.rgb_color.slice(0, 3).map(byte);
    if (Array.isArray(v.hs_color)) return hsRgb(v.hs_color);
    if (Array.isArray(v.xy_color)) return xyRgb(v.xy_color);
    return kelvinRgb(v.color_temp_kelvin || (v.color_temp ? 1e6 / v.color_temp : 2700));
  }

  /* entities: a scene's stored states ({entity id: state or {state, ...}}).
   * Returns the swatch's markup, or null when the scene has no lights. */
  Panel.sceneSwatch = function (entities) {
    const groups = new Map(); /* quantised colour -> {rgb, lights, level} */
    let lights = 0;
    for (const [id, stored] of Object.entries(entities)) {
      if (!id.startsWith("light.")) continue;
      lights++;
      const v = typeof stored === "string" ? { state: stored } : stored || {};
      if (v.state !== "on") continue;
      const rgb = baseColour(v);
      const key = rgb.map((c) => Math.round(c / 32)).join(",");
      const group = groups.get(key) || { rgb, lights: 0, level: 0 };
      group.lights++;
      group.level += typeof v.brightness === "number" ? v.brightness / 255 : 1;
      groups.set(key, group);
    }
    if (!lights) return null;
    if (!groups.size) return `<span class="swatch scene-lead off">${icon("power")}</span>`;

    const top = [...groups.values()].sort((a, b) => b.lights - a.lights).slice(0, MAX_COLOURS);
    const total = top.reduce((sum, g) => sum + g.lights, 0);
    /* Dimmer scenes read darker, but never so dark that the colour is lost. */
    const css = (g) => `rgb(${g.rgb.map((c) => byte(c * (0.45 + 0.55 * (g.level / g.lights)))).join(" ")})`;
    let at = 0;
    const stops = top.map((g) => {
      const from = at;
      at += (g.lights / total) * 100;
      return `${css(g)} ${from.toFixed(1)}% ${at.toFixed(1)}%`;
    });
    const background = top.length === 1 ? css(top[0]) : `conic-gradient(${stops.join(", ")})`;
    return `<span class="swatch scene-lead" style="background:${background}"></span>`;
  };
})();
