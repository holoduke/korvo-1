/* Helpers shared by the panel's modules: Dutch formatting, HTML escaping,
 * Home Assistant state values, and two interaction patterns (a second tap to
 * confirm, a control that shows as pending until Home Assistant reports back). */
(function () {
  "use strict";

  const pad2 = (n) => String(n).padStart(2, "0");
  const DAYS_SHORT = ["zo", "ma", "di", "wo", "do", "vr", "za"];
  const DAYS_LONG = ["zondag", "maandag", "dinsdag", "woensdag", "donderdag", "vrijdag", "zaterdag"];
  const MONTHS = ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  const PLACES = { home: "Thuis", not_home: "Weg" };

  const Util = {
    DAYS_SHORT,
    DAYS_LONG,
    MONTHS,

    emitter() {
      const map = {};
      return {
        on(ev, cb) {
          (map[ev] = map[ev] || []).push(cb);
        },
        emit(ev, ...args) {
          (map[ev] || []).forEach((cb) => cb(...args));
        },
      };
    },

    esc: (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]),
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    /* "14:05" */
    hm: (d) => pad2(d.getHours()) + ":" + pad2(d.getMinutes()),
    /* 1234.5 -> "1.235" or, with digits = 1, "1.234,5"; "--" when not a number. */
    fmt: (n, digits = 0) =>
      Number.isFinite(n) ? n.toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "--",
    /* A state value that carries information (not unknown, unavailable or empty). */
    known: (v) => v !== undefined && v !== null && !["", "unknown", "unavailable", "none"].includes(String(v).toLowerCase()),
    /* The Date in a timestamp state, or null. */
    dateOf(state) {
      const t = Util.known(state) ? Date.parse(state) : NaN;
      return Number.isFinite(t) ? new Date(t) : null;
    },
    /* Seconds -> ["2:05", "uur"] or ["42", "min"]. */
    duration(sec) {
      if (!Number.isFinite(sec) || sec < 0) return ["--", ""];
      const m = Math.round(sec / 60);
      if (m >= 60) return [`${Math.floor(m / 60)}:${pad2(m % 60)}`, "uur"];
      return [String(m), "min"];
    },
    /* "14:05" today, "12-9 14:05" on another day. */
    stamp(ms) {
      const d = new Date(ms);
      return new Date().toDateString() === d.toDateString() ? Util.hm(d) : `${d.getDate()}-${d.getMonth() + 1} ${Util.hm(d)}`;
    },
    /* "vandaag 14:05", "gisteren 14:05", "di 14:05" or "9 dagen geleden". */
    ago(ms) {
      if (!ms) return "nog niet gedaan";
      const d = new Date(ms);
      const days = Math.round((new Date(new Date().toDateString()) - new Date(d.toDateString())) / 86400e3);
      if (days === 0) return `vandaag ${Util.hm(d)}`;
      if (days === 1) return `gisteren ${Util.hm(d)}`;
      if (days < 7) return `${DAYS_SHORT[d.getDay()]} ${Util.hm(d)}`;
      return `${days} dagen geleden`;
    },
    /* A moment ahead: "vandaag 14:05", "morgen 14:05" or "wo 14:05". */
    soon(date) {
      const d = new Date(date);
      const days = Math.round((new Date(d.toDateString()) - new Date(new Date().toDateString())) / 86400e3);
      return `${days === 0 ? "vandaag" : days === 1 ? "morgen" : DAYS_SHORT[d.getDay()]} ${Util.hm(d)}`;
    },
    /* "zojuist", "12 min geleden", then as ago(). */
    since(ms) {
      const minutes = Math.floor((Date.now() - ms) / 60e3);
      if (minutes < 1) return "zojuist";
      if (minutes < 60) return `${minutes} min geleden`;
      return Util.ago(ms);
    },
    /* A device tracker's state in words: Thuis, Weg or the zone's own name. */
    place: (state) => PLACES[state] || state,
    /* URL part for a name: "Zitk. achter" -> "zitk-achter". */
    slug: (label) => label.toLowerCase().replace(/\./g, "").trim().replace(/\s+/g, "-"),
    batteryColour: (v) => (!Number.isFinite(v) ? "var(--text)" : v < 20 ? "var(--bad)" : v < 40 ? "var(--warn)" : "var(--ok)"),

    /* Fades the right edge of a sideways scroller ("overflowing") while more
     * content hides there. `also` are elements whose size changes that too. */
    watchOverflow(el, ...also) {
      const mark = () => el.classList.toggle("overflowing", el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
      const ro = new ResizeObserver(mark);
      [el, ...also].forEach((node) => ro.observe(node));
      el.addEventListener("scroll", mark, { passive: true });
      mark();
    },

    /* Moves a value from `from` to `to` over `ms`, easing out, on animation frames:
     * step(value) each frame, done() at the end. Returns {cancel}. The page and
     * floor tracks glide this way instead of by a CSS transition: on iPad Safari
     * a transition on a layer that wide first rendered all of it, which held back
     * the glide's first frame by about 230 ms (a swipe looked like a jump). */
    glide(from, to, ms, step, done, v0) {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches || from === to) {
        step(to);
        if (done) done();
        return { cancel() {} };
      }
      let raf = 0;
      const t0 = performance.now();
      /* Released by a finger (v0 its speed, px/ms): a critically damped spring
       * that sets off at that speed and eases to rest, as a page does on iOS and
       * Android, in about the time the finger would have needed for the rest of
       * the way (within bounds: a slow drag still finishes, a flick still eases).
       * Without a speed: the ease-out over ms. */
      const A = from - to;
      const spring = Number.isFinite(v0);
      const dur = spring ? Math.min(450, Math.max(160, Math.abs(A) / Math.max(Math.abs(v0), 1.2))) : ms;
      const w = 6 / dur;
      const B = spring ? v0 + w * A : 0;
      const frame = (now) => {
        const t = now - t0;
        if (spring) {
          const e = Math.exp(-w * t);
          const x = to + (A + B * t) * e;
          const v = (B - w * (A + B * t)) * e;
          if (t < dur * 3 && (Math.abs(x - to) > 0.4 || Math.abs(v) > 0.02)) {
            step(x);
            raf = requestAnimationFrame(frame);
          } else {
            step(to);
            if (done) done();
          }
          return;
        }
        const p = Math.min(1, Math.max(0, t / ms));
        step(from + (to - from) * (1 - Math.pow(1 - p, 3)));
        if (p < 1) raf = requestAnimationFrame(frame);
        else if (done) done();
      };
      raf = requestAnimationFrame(frame);
      return { cancel: () => cancelAnimationFrame(raf) };
    },

    /* Second-tap confirmation. tap(key, needed) is true when the action may run:
     * a key that needs confirming is armed by the first tap for `ms`. `changed`
     * runs when a key arms or its time runs out, to redraw the labels. */
    confirmer(ms, changed) {
      const timers = new Map();
      return {
        armed: (key) => timers.has(key),
        tap(key, needed) {
          if (needed && !timers.has(key)) {
            timers.set(key, setTimeout(() => (timers.delete(key), changed()), ms));
            changed();
            return false;
          }
          clearTimeout(timers.get(key));
          timers.delete(key);
          return true;
        },
      };
    },

    /* Controls waiting for Home Assistant. mark(key, read, wait) remembers read()'s
     * value (a string, or an array compared item by item); the key settles once
     * read() returns something else, or after `wait` (default `ms`), when
     * `changed` runs.
     * settle() forgets the settled keys and returns those that ran out of time
     * without a change (a command that did not land). */
    pendingSet(ms, changed) {
      const items = new Map();
      const same = (a, b) => (Array.isArray(a) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b);
      return {
        has: (key) => items.has(key),
        any: () => items.size > 0,
        mark(key, read, wait = ms) {
          items.set(key, { read, value: read(), until: Date.now() + wait });
          setTimeout(changed, wait + 50);
        },
        drop: (key) => items.delete(key),
        settle() {
          const expired = [];
          for (const [key, p] of items) {
            const changed = !same(p.read(), p.value);
            if (!changed && Date.now() <= p.until) continue;
            items.delete(key);
            if (!changed) expired.push(key);
          }
          return expired;
        },
      };
    },
  };

  window.Util = Util;
})();
