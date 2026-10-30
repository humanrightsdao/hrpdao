// src/utils/conflictZones.js
//
// Turns the curated list in config/conflictZones.js into H3 cells.
// Pure logic (no Leaflet, no React).

import { latLngToCell, gridDisk } from "h3-js";
import { CONFLICT_ZONES, CONFLICT_STATUS } from "../config/conflictZones";

/**
 * @returns {Array<{ index: string, zone: object, status: object }>}
 *   One entry per hexagon. If zones overlap, the more severe status wins.
 *   Sorted from the least to the most severe, so the most severe cells are
 *   drawn last (on top).
 */
export const buildConflictZoneCells = (zones = CONFLICT_ZONES) => {
  const cells = new Map();

  for (const zone of zones) {
    const status = CONFLICT_STATUS[zone.status];
    if (!status) continue;

    for (const [lat, lng, k = 0] of zone.seeds) {
      let origin;
      try {
        origin = latLngToCell(lat, lng, zone.resolution);
      } catch {
        continue;
      }
      for (const index of gridDisk(origin, k)) {
        const previous = cells.get(index);
        if (!previous || status.rank > previous.status.rank) {
          cells.set(index, { index, zone, status });
        }
      }
    }
  }

  return [...cells.values()].sort((a, b) => a.status.rank - b.status.rank);
};
