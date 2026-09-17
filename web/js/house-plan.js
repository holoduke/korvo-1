/* The house as the Start page draws it (js/house3d.js): a plan in metres,
 * taken from the builder's drawings (plans, elevations and sections, 2025).
 * x runs along the front of the house from the wall shared with the
 * neighbour (x = 0) to the garage side; z runs from the front wall (0) to the
 * back; y is height above the ground floor.
 *
 * The two-storey main block carries a gable roof with the ridge along the
 * street, with a dormer on each slope; single-storey blocks with flat roofs
 * stand beside and behind it: the garage, which runs on past the back of the
 * house, and the rear extension. Rooms are the PANEL_AREAS rooms per floor
 * (floor = the PANEL_FLOORS label), so the drawing can later light a room up
 * with its lamps; which room sits where is read off the plans as well as it
 * can be. Adjust here, nothing else refers to these numbers. */
window.HOUSE_PLAN = {
  main: { x: 0, z: 0, w: 5.6, d: 13.0 },
  levels: [
    { floor: "0", y: 0, h: 3.0 },
    { floor: "1", y: 3.0, h: 3.0 },
    { floor: "2", y: 6.0, h: 0 },
  ],
  /* Gutter at 6.2 m, ridge at 10.45 m (section B-B), eaves over the front and
   * back walls. A dormer on each slope, its flat top at 9.0 m. */
  roof: { eavesY: 6.2, ridgeY: 10.45, overhang: 0.3 },
  dormers: [
    { side: "front", x: 1.65, w: 2.3, topY: 9.0, setback: 1.2 },
    { side: "back", x: 1.05, w: 3.5, topY: 9.0, setback: 1.2 },
  ],
  /* Single-storey, flat roof at 3.0 m: the garage beside the house, set back
   * from the front and running 4.4 m past the back wall, and the rear
   * extension across the back of the main block. */
  flat: [
    { name: "garage", x: 5.6, z: 4.95, w: 4.2, d: 12.45, h: 3.0 },
    { name: "aanbouw", x: 0, z: 13.0, w: 5.6, d: 1.9, h: 3.0 },
  ],
  /* Rooms per floor: name (as in PANEL_AREAS), and the rectangle they take. */
  rooms: {
    0: [
      { name: "Zitkamer", x: 0, z: 0, w: 5.6, d: 3.0 },
      { name: "Gang", x: 0, z: 3.0, w: 5.6, d: 2.9 },
      { name: "Keuken", x: 0, z: 5.9, w: 5.6, d: 3.6 },
      { name: "Eetkamer", x: 0, z: 9.5, w: 5.6, d: 5.4 },
      { name: "Garage", x: 5.6, z: 4.95, w: 4.2, d: 5.55 },
      /* One room behind the garage, to the garden: the back sitting room (the
       * Gameroom's lamps are in here too). */
      { name: "Zitk. achter", x: 5.6, z: 10.5, w: 4.2, d: 6.9 },
    ],
    1: [
      { name: "Valerie", x: 0, z: 0, w: 2.4, d: 4.46 },
      { name: "Naomi", x: 2.4, z: 0, w: 3.2, d: 4.46 },
      { name: "Gang", x: 0, z: 4.46, w: 2.4, d: 3.14 },
      { name: "Badkamer", x: 2.4, z: 4.46, w: 3.2, d: 3.14 },
      { name: "Gillis en Ilse", x: 0, z: 7.6, w: 5.6, d: 5.4 },
    ],
    2: [
      { name: "Voorkamer", x: 0, z: 1.44, w: 5.6, d: 4.1 },
      { name: "Gang", x: 0, z: 5.54, w: 2.4, d: 3.2 },
      { name: "Babykamer", x: 2.4, z: 5.54, w: 3.2, d: 3.2 },
      { name: "Achterkamer", x: 0, z: 8.74, w: 5.6, d: 2.8 },
    ],
  },
  /* Windows and doors, as rectangles on a wall: plane "z" is a wall along the
   * front (at = its z), plane "x" a side wall (at = its x); a is where the
   * opening starts along that wall, y its sill. */
  openings: [
    /* front; the front door is in the side wall, in the recess before the garage */
    { plane: "x", at: 5.6, a: 3.6, w: 1.0, y: 0, h: 2.3 } /* front door */,
    { plane: "z", at: 0, a: 0.8, w: 2.6, y: 0.7, h: 1.7 },
    { plane: "z", at: 0, a: 4.0, w: 0.9, y: 0.7, h: 1.7 },
    { plane: "z", at: 0, a: 0.4, w: 0.8, y: 3.9, h: 1.3 },
    { plane: "z", at: 0, a: 1.5, w: 0.8, y: 3.9, h: 1.3 },
    { plane: "z", at: 0, a: 3.3, w: 0.8, y: 3.9, h: 1.3 },
    { plane: "z", at: 0, a: 4.5, w: 0.8, y: 3.9, h: 1.3 },
    { plane: "z", at: 4.95, a: 6.2, w: 3.0, y: 0, h: 2.3 } /* garage door */,
    /* back */
    { plane: "z", at: 13.0, a: 0.5, w: 1.2, y: 3.9, h: 1.3 },
    { plane: "z", at: 13.0, a: 3.9, w: 1.2, y: 3.9, h: 1.3 },
    { plane: "z", at: 14.9, a: 0.5, w: 4.6, y: 0, h: 2.4 } /* garden doors */,
    { plane: "z", at: 17.4, a: 6.4, w: 2.6, y: 0.9, h: 1.3 } /* back room window */,
    /* garage side */
    { plane: "x", at: 9.8, a: 13.2, w: 1.5, y: 0.9, h: 1.3 },
  ],
};
