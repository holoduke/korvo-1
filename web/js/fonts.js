/* The web fonts load without holding up the first paint: their stylesheet
 * comes in as media="print" and switches to all screens once it is there
 * (here rather than in an onload attribute, which the page's CSP forbids). */
(function () {
  "use strict";
  const link = document.getElementById("webFonts");
  if (!link) return;
  const use = () => (link.media = "all");
  if (link.sheet) use();
  else link.addEventListener("load", use, { once: true });
})();
