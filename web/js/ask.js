/* "Vraag het huis": a line at the foot of the Start section. The question goes
 * to Home Assistant's conversation agent "Thuis" (the thuispaneel integration,
 * a language model with a snapshot of the house), the answer shows in a
 * bubble for a while. On a secure origin (https) a microphone button appears:
 * the browser's own speech recognition (Dutch) fills the line and sends it, and
 * an answer to a spoken question is spoken back. */
(function () {
  "use strict";
  const Panel = window.Panel;
  const { $ } = Panel;
  const ANSWER_MS = 25000;
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const canListen = window.isSecureContext && !!Recognition;

  let form = null;
  let input = null;
  let bubble = null;
  let hideTimer = 0;
  let conversationId = null;
  let spoken = false; /* the question came by voice: speak the answer */
  let busy = false;

  const html = () =>
    `<form class="house-ask" data-ask>` +
    `<button type="button" class="ask-mic" data-ask-mic aria-label="Spreek een vraag in" ${canListen ? "" : "hidden"}>${icon("mic")}</button>` +
    `<input type="text" class="ask-input" data-ask-input placeholder="Vraag het huis…" autocomplete="off" enterkeyhint="send" maxlength="200">` +
    `<button type="submit" class="ask-send" aria-label="Vraag">${icon("arrow-right")}</button>` +
    `</form><div class="ask-answer" data-ask-answer hidden></div>`;

  function show(text, tone) {
    clearTimeout(hideTimer);
    bubble.textContent = text;
    bubble.dataset.tone = tone || "";
    bubble.hidden = false;
    hideTimer = setTimeout(() => (bubble.hidden = true), ANSWER_MS);
  }
  function speak(text) {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = /[a-z]/i.test(text) && /\b(the|is|are|and)\b/i.test(text) && !/\b(de|het|een|is)\b/.test(text) ? "en-US" : "nl-NL";
    u.rate = 1.0;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }
  async function ask(question) {
    const q = question.trim();
    if (!q || busy) return;
    busy = true;
    form.classList.add("busy");
    show("…", "dim");
    try {
      const r = await Panel.client.converse(q, conversationId);
      conversationId = r.conversation_id || conversationId;
      const speech = (((r.response || {}).speech || {}).plain || {}).speech || "Geen antwoord.";
      const error = (r.response || {}).response_type === "error";
      show(speech, error ? "bad" : "");
      if (spoken && !error) speak(speech);
    } catch (e) {
      show(`Het huis antwoordt niet: ${(e && e.message) || e}`, "bad");
    } finally {
      busy = false;
      spoken = false;
      form.classList.remove("busy");
    }
  }

  function listen() {
    if (!canListen) return;
    const rec = new Recognition();
    rec.lang = "nl-NL";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    form.classList.add("listening");
    rec.onresult = (e) => {
      const text = [...e.results].map((r) => r[0].transcript).join(" ");
      input.value = text;
      if (e.results[e.results.length - 1].isFinal) {
        spoken = true;
        ask(text);
        input.value = "";
      }
    };
    rec.onerror = (e) => show(e.error === "not-allowed" ? "Geef de browser toegang tot de microfoon." : `Niet verstaan (${e.error}).`, "bad");
    rec.onend = () => form.classList.remove("listening");
    try {
      rec.start();
    } catch (e) {
      form.classList.remove("listening");
    }
  }

  Panel.on("start", () => {
    const house = document.querySelector(".start-page .house");
    if (!house) return;
    house.insertAdjacentHTML("beforeend", html());
    form = house.querySelector("[data-ask]");
    input = house.querySelector("[data-ask-input]");
    bubble = house.querySelector("[data-ask-answer]");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = input.value;
      input.value = "";
      input.blur();
      ask(q);
    });
    house.querySelector("[data-ask-mic]").addEventListener("click", listen);
    /* typing in the line must not swipe the sections */
    ["pointerdown", "touchstart"].forEach((ev) => form.addEventListener(ev, (e) => e.stopPropagation(), { passive: true }));
  });
})();
