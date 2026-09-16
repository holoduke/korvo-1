/* Product photos of the devices, kept in Home Assistant's www folder and not in
 * this repository (they are the manufacturers' pictures): /config/www/apparaten/
 * holds the files and photos.json, which maps a device's label slug to its file,
 * e.g. {"wasmachine": "wasmachine.png"}. A device without a photo keeps its icon.
 *
 * Panel.photoUrl(label) gives a device's picture once the picture itself has
 * loaded, so a view never shows a broken image; "photos" is emitted for each one
 * that arrives, which is when a view fills its place in. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const BASE = "/local/apparaten/";
  const urls = new Map(); /* label slug -> URL of a picture that has loaded */
  let asked = false;

  Panel.photoUrl = (label) => urls.get(Util.slug(label || "")) || null;

  async function load() {
    if (asked || Panel.client.demo) return; /* the demo has no www folder */
    asked = true;
    let index;
    try {
      const res = await fetch(`${BASE}photos.json`, { cache: "no-cache" });
      index = res.ok ? await res.json() : {};
    } catch (e) {
      return; /* no photos: icons stay */
    }
    for (const [slug, file] of Object.entries(index)) {
      const url = BASE + encodeURIComponent(file);
      const img = new Image();
      img.onload = () => {
        urls.set(slug, url);
        Panel.emit("photos", slug);
      };
      img.src = url;
    }
  }

  Panel.on("start", load);
})();
