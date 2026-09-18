/* Inline SVG icons standing in for the panel's LV_SYMBOL_* glyphs. Stroke icons
 * on a 24-unit grid, drawn in currentColor so tiles tint them like text. */
(function () {
  "use strict";
  const P = {
    power: '<path d="M12 3v8"/><path d="M6.4 6.6a8 8 0 1 0 11.2 0"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    "eye-off":
      '<path d="M10.6 5.1A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9"/><path d="M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/>',
    drop: '<path d="M12 2.7s6.5 7.1 6.5 11.8a6.5 6.5 0 0 1-13 0C5.5 9.8 12 2.7 12 2.7z"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r=".6"/><circle cx="3.5" cy="12" r=".6"/><circle cx="3.5" cy="18" r=".6"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-up": '<path d="m6 15 6-6 6 6"/>',
    gear:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    "arrow-up": '<path d="M12 19V5M5 12l7-7 7 7"/>',
    "arrow-down": '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    edit: '<path d="M4 20h4L18.5 9.5a1.5 1.5 0 0 0 0-2.1l-1.9-1.9a1.5 1.5 0 0 0-2.1 0L4 16v4z"/><path d="m13 7 4 4"/>',
    vacuum: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="9" r="2.5"/><path d="M7.5 15.5h9"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    washer: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M4 7.5h16"/><circle cx="12" cy="14" r="4.5"/><path d="M9.8 14.8c1-.8 2.4-.8 4.4 0" /><circle cx="7" cy="5.3" r=".5"/>',
    dryer: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M4 7.5h16"/><circle cx="12" cy="14" r="4.5"/><path d="M10.5 12.5c.8.6.8 1.4 0 2s-.8 1.4 0 2M13.5 12.5c.8.6.8 1.4 0 2s-.8 1.4 0 2"/>',
    dishwasher: '<rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M4 8h16M8 5.5h3"/><path d="M8 17c1.5-2 3-2.5 4-2.5s2.5.5 4 2.5"/><path d="M9 12.5v2M12 11.5v3M15 12.5v2"/>',
    oven: '<rect x="3.5" y="3" width="17" height="18" rx="2.5"/><path d="M3.5 8h17"/><rect x="7" y="11" width="10" height="7" rx="1.5"/><circle cx="7.5" cy="5.5" r=".6"/><circle cx="10.5" cy="5.5" r=".6"/>',
    hob: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="2.5"/><circle cx="15.5" cy="9.5" r="2.5"/><circle cx="8.5" cy="15.5" r="1.8"/><circle cx="15.5" cy="15.5" r="1.8"/>',
    filter: '<path d="M4 5h16l-6 7.5V19l-4-2v-4.5z"/>',
    fridge: '<rect x="5.5" y="2.5" width="13" height="19" rx="2.5"/><path d="M5.5 10h13M9 5.5v2.5M9 12.5v3.5"/>',
    unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    fan: '<circle cx="12" cy="12" r="2"/><path d="M12 10c0-4 1-7 4-7 2 0 3 2 1 4l-3 3M14 12c4 0 7 1 7 4 0 2-2 3-4 1l-3-3M12 14c0 4-1 7-4 7-2 0-3-2-1-4l3-3M10 12c-4 0-7-1-7-4 0-2 2-3 4-1l3 3"/>',
    flame: '<path d="M12 3c1 4 5 6 5 11a5 5 0 0 1-10 0c0-3 2-4 2-7 1.5 1 2 2.5 2 4 1-2 1-5 1-8z"/>',
    seat: '<path d="M8 3h5l-1 9h5a2 2 0 0 1 2 2v2H8zM8 16v5M17 16v5"/>',
    wheel: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M3.5 10H10M14 10h6.5M12 14v7"/>',
    shield: '<path d="M12 3 5 6v5c0 5 3 8.5 7 10 4-1.5 7-5 7-10V6z"/>',
    window: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
    lights: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16 7l3 3M14 9l2 2"/>',
    prev: '<path d="M18 5v14L8 12zM6 5v14"/>',
    next: '<path d="M6 5v14l10-7zM18 5v14"/>',
    car: '<path d="M3.5 16.5v-4l2-5h13l2 5v4z"/><path d="M3.5 12.5h17M6.5 16.5v2M17.5 16.5v2"/><circle cx="7.5" cy="14.5" r=".6"/><circle cx="16.5" cy="14.5" r=".6"/>',
    bike: '<circle cx="5.5" cy="16" r="3.5"/><circle cx="18.5" cy="16" r="3.5"/><path d="M5.5 16 9 9h6.5l3 7M9 9l3 7 3.5-7M7.5 6h3M14 6.5h2.5l-1 2.5"/>',
    play: '<path d="M7 4.5v15l12-7.5z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    dock: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M9.5 19.5v-5h5v5"/>',
    locate: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    expand: '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    person: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21v-1.5a7 7 0 0 1 14 0V21"/>',
    door: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18"/><circle cx="14.5" cy="12" r=".9"/>',
    motion: '<circle cx="13.5" cy="4.5" r="2"/><path d="M8 21l3-6 3 2.5V21M6.5 11.5 10 8.5l4 .5 2.5 3.5 3 1M11 15l-1-6.5"/>',
    thermometer: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 9v7"/>',
    air: '<path d="M3 8h10a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    battery: '<rect x="2.5" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/>',
    speaker: '<rect x="5.5" y="2.5" width="13" height="19" rx="2.5"/><circle cx="12" cy="14.5" r="3.5"/><circle cx="12" cy="7" r="1"/>',
    tv: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    mute: '<path d="M11 5 6 9H3v6h3l5 4z"/><path d="m16 9 5 6M21 9l-5 6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    wrench:'<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
    pc: '<rect x="3" y="4" width="18" height="12.5" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>',
    home: '<path d="M3 11.2 12 3.5l9 7.7"/><path d="M5.5 9.6V21h13V9.6"/><path d="M10 21v-6.5h4V21"/>',
    garage: '<path d="M3 10.5 12 4l9 6.5V21H3z"/><rect x="6.5" y="12.5" width="11" height="8.5"/><path d="M6.5 15.5h11M6.5 18.2h11"/>',
  };
  window.icon = function (name, cls) {
    const body = P[name] || P.power;
    return (
      '<svg class="ic ' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + "</svg>"
    );
  };
})();
