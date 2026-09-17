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
    { side: "front", x: 2.4, w: 2.5, topY: 9.0, setback: 1.2 },
    { side: "back", x: 1.25, w: 3.25, topY: 9.0, setback: 1.2 },
  ],
  /* Single-storey, flat roof at 3.0 m: the garage block beside the house, set
   * back from the front and running 4.4 m past the back wall, and the rear
   * extension across the back of the main block. */
  flat: [
    { name: "garage", x: 5.6, z: 4.95, w: 3.75, d: 12.45, h: 3.0 },
    /* joined: one space with the room behind the main block's back wall, so
     * no floor or side lines where the two meet (the ceiling line stays). */
    { name: "aanbouw", x: 0, z: 13.0, w: 5.6, d: 1.9, h: 3.0, joined: true },
  ],
  /* Rooms per floor: name (as in PANEL_AREAS), and the rectangle they take. */
  rooms: {
    0: [
      { name: "Zitkamer", x: 0, z: 0, w: 5.6, d: 3.6 },
      { name: "Gang", x: 0, z: 3.6, w: 5.6, d: 3.45 },
      { name: "Keuken", x: 0, z: 7.05, w: 5.6, d: 3.45 },
      { name: "Eetkamer", x: 0, z: 10.5, w: 5.6, d: 4.4 },
      { name: "Garage", x: 5.6, z: 4.95, w: 3.75, d: 7.75 },
      /* The garage block's part behind the garage wall, open to the big room:
       * the back sitting room (the Gameroom's lamps are in here too). */
      { name: "Zitk. achter", x: 5.6, z: 12.7, w: 3.75, d: 4.7 },
    ],
    1: [
      { name: "Valerie", x: 0, z: 0, w: 2.85, d: 3.7 },
      { name: "Naomi", x: 2.85, z: 0, w: 2.75, d: 3.7 },
      { name: "Gang", x: 0, z: 3.7, w: 2.85, d: 5.0 },
      { name: "Badkamer", x: 2.85, z: 3.7, w: 2.75, d: 5.0 },
      { name: "Gillis en Ilse", x: 0, z: 8.7, w: 5.6, d: 4.3 },
    ],
    2: [
      { name: "Voorkamer", x: 0, z: 1.44, w: 5.6, d: 4.1 },
      { name: "Gang", x: 0, z: 5.54, w: 2.4, d: 3.2 },
      { name: "Babykamer", x: 2.4, z: 5.54, w: 3.2, d: 3.2 },
      { name: "Achterkamer", x: 0, z: 8.74, w: 5.6, d: 2.8 },
    ],
  },
  /* Inner walls of the ground floor, drawn as walls (floor line, ceiling line
   * and their ends), each in a vertical plane like the openings: plane "z" runs
   * along the front (at = its z), plane "x" along the side (at = its x); a is
   * where it starts, w its length, h its height. */
  walls: [
    { plane: "z", at: 3.6, a: 0, w: 5.6, h: 3.0 } /* sitting room | hall */,
    { plane: "z", at: 7.05, a: 0, w: 5.6, h: 3.0 } /* hall | kitchen */,
    { plane: "x", at: 3.9, a: 5.75, w: 1.3, h: 3.0 } /* the toilet */,
    { plane: "z", at: 5.75, a: 3.9, w: 1.7, h: 3.0 },
    { plane: "z", at: 12.7, a: 5.6, w: 3.75, h: 3.0 } /* garage | back sitting room */,
  ],
  /* Windows and doors, as rectangles on a wall: plane "z" is a wall along the
   * front (at = its z), plane "x" a side wall (at = its x); a is where the
   * opening starts along that wall, y its sill. Read off the plans and the
   * elevations: no openings in the side walls but the front door. A key names
   * an opening the page can light up (house3d's highlight). */
  openings: [
    /* front wall: the sitting room's large window and a smaller one */
    { plane: "z", at: 0, a: 0.45, w: 2.4, y: 0.3, h: 2.3 },
    { plane: "z", at: 0, a: 3.6, w: 1.4, y: 0.7, h: 1.7 },
    { plane: "z", at: 0, a: 0.5, w: 1.5, y: 3.75, h: 1.35 },
    { plane: "z", at: 0, a: 3.0, w: 0.9, y: 3.75, h: 1.35 },
    { plane: "z", at: 0, a: 4.2, w: 0.9, y: 3.75, h: 1.35 },
    /* the front door: in the side wall, in the recess before the garage door */
    { key: "voordeur", plane: "x", at: 5.6, a: 3.95, w: 1.0, y: 0, h: 2.4 },
    { key: "garagedeur", plane: "z", at: 4.95, a: 6.0, w: 2.6, y: 0, h: 2.3 },
    /* inside: the wide sliding-door openings in the two hall walls, the door
     * from the big room into the garage, and the open passage into the back
     * sitting room */
    { plane: "z", at: 3.6, a: 1.65, w: 1.6, y: 0, h: 2.4 },
    { plane: "z", at: 7.05, a: 1.65, w: 1.6, y: 0, h: 2.4 },
    { plane: "x", at: 5.6, a: 10.3, w: 0.95, y: 0, h: 2.3 },
    { plane: "x", at: 5.6, a: 12.9, w: 1.9, y: 0, h: 2.6 },
    /* back */
    { plane: "z", at: 13.0, a: 1.15, w: 1.5, y: 3.75, h: 1.35 },
    { plane: "z", at: 13.0, a: 3.25, w: 1.5, y: 3.75, h: 1.35 },
    { key: "tuindeuren", plane: "z", at: 14.9, a: 1.1, w: 3.7, y: 0, h: 2.4 },
    { key: "schuifpui", plane: "z", at: 17.4, a: 5.85, w: 2.55, y: 0, h: 2.4 },
    { plane: "z", at: 17.4, a: 7.1, w: 0.02, y: 0, h: 2.4 } /* its mullion */,
  ],
};
