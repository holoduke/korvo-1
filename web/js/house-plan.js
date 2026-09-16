/* The house as the Start page draws it (js/house3d.js): a plan in metres.
 * x runs along the front of the house, left to right as seen from the street;
 * z runs from the front (negative) to the back; y is height above the ground
 * floor. The main block's rooms are the PANEL_AREAS rooms per floor (the floor
 * label is the PANEL_FLOORS label), so the drawing can later light a room up
 * with its lamps. The measurements are an approximation of the real house:
 * adjust them here, nothing else refers to them. */
window.HOUSE_PLAN = {
  /* The main block: footprint, and each floor's height above the ground floor
   * plus the storey height (the attic sits under the roof). */
  main: { x: -4.2, z: -5.5, w: 8.4, d: 11.0 },
  levels: [
    { floor: "0", y: 0, h: 2.8 },
    { floor: "1", y: 2.8, h: 2.7 },
    { floor: "2", y: 5.5, h: 0 },
  ],
  /* A gable roof with the ridge along the front (attic rooms front and back),
   * eaves over the front and back walls, and a dormer on the back slope. */
  roof: { eavesY: 5.5, ridgeY: 8.9, overhang: 0.35, dormer: { x: -1.6, w: 3.2, topY: 7.7, frontZ: 4.3 } },
  /* The garage, against the right side, flush with the front. */
  garage: { x: 4.2, z: -5.5, w: 3.4, d: 6.5, h: 2.9 },
  /* Rooms per floor: name (as in PANEL_AREAS), and the rectangle they take. */
  rooms: {
    0: [
      { name: "Gang", x: -4.2, z: -5.5, w: 2.0, d: 4.0 },
      { name: "Zitkamer", x: -2.2, z: -5.5, w: 6.4, d: 4.0 },
      { name: "Gameroom", x: -4.2, z: -1.5, w: 4.2, d: 3.5 },
      { name: "Zitk. achter", x: 0, z: -1.5, w: 4.2, d: 3.5 },
      { name: "Keuken", x: -4.2, z: 2.0, w: 4.2, d: 3.5 },
      { name: "Eetkamer", x: 0, z: 2.0, w: 4.2, d: 3.5 },
    ],
    1: [
      { name: "Valerie", x: -4.2, z: -5.5, w: 3.6, d: 3.7 },
      { name: "Naomi", x: -0.6, z: -5.5, w: 4.8, d: 3.7 },
      { name: "Gang", x: -4.2, z: -1.8, w: 3.6, d: 3.0 },
      { name: "Badkamer", x: -0.6, z: -1.8, w: 4.8, d: 3.0 },
      { name: "Gillis en Ilse", x: -4.2, z: 1.2, w: 8.4, d: 4.3 },
    ],
    2: [
      { name: "Voorkamer", x: -4.2, z: -5.5, w: 8.4, d: 3.9 },
      { name: "Gang", x: -4.2, z: -1.6, w: 3.4, d: 3.2 },
      { name: "Babykamer", x: -0.8, z: -1.6, w: 5.0, d: 3.2 },
      { name: "Achterkamer", x: -4.2, z: 1.6, w: 8.4, d: 3.9 },
    ],
  },
  /* Windows and doors, drawn on the walls: face front/back (along x) or
   * left/right (along z); a is the position along that face, y the sill. */
  openings: [
    { face: "front", a: -3.7, y: 0, w: 1.0, h: 2.2 } /* front door */,
    { face: "front", a: -1.6, y: 0.7, w: 5.0, h: 1.7 },
    { face: "front", a: -3.6, y: 3.7, w: 2.4, h: 1.3 },
    { face: "front", a: 0.6, y: 3.7, w: 3.0, h: 1.3 },
    { face: "back", a: -3.6, y: 0, w: 7.2, h: 2.4 } /* garden doors */,
    { face: "back", a: -3.4, y: 3.7, w: 3.0, h: 1.3 },
    { face: "back", a: 0.8, y: 3.7, w: 2.8, h: 1.3 },
    { face: "left", a: 2.6, y: 0.9, w: 1.4, h: 1.2 },
    { face: "left", a: 2.6, y: 3.7, w: 1.4, h: 1.2 },
    { face: "garage", a: 4.6, y: 0, w: 2.6, h: 2.2 } /* garage door */,
  ],
};
