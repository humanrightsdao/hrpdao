// src/utils/h3Utils.js
import {
  cellToBoundary,
  latLngToCell,
  getRes0Cells,
  cellToChildren,
  cellToParent,
  polygonToCells,
  getResolution,
} from "h3-js";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

// Detail level for grouping violations
export const H3_RESOLUTION = 6;

// Global grid level (2 = ~5k cells, 3 = ~41k)
export const GRID_RESOLUTION = 3;

// ─────────────────────────────────────────────
// Hexagon levels for the UI switch (country map, violations map)
// ─────────────────────────────────────────────
// "Level 3" is GRID_RESOLUTION (the original behavior, the most detailed
// hexagons). Levels 2/1/0 are coarser (bigger), each next one being 1 H3
// resolution lower. Centralized here so CountryPage.jsx and
// ViolationsMap.jsx don't keep two separate copies of this mapping.
export const HEX_LEVELS = [3, 2, 1, 0];

export const LEVEL_RESOLUTIONS = {
  3: GRID_RESOLUTION,
  2: Math.max(GRID_RESOLUTION - 1, 0),
  1: Math.max(GRID_RESOLUTION - 2, 0),
  0: Math.max(GRID_RESOLUTION - 3, 0),
};

export const getResolutionForLevel = (level) =>
  LEVEL_RESOLUTIONS[level] ?? GRID_RESOLUTION;

// ─────────────────────────────────────────────
// 1. Grouping violations by H3 index
// ─────────────────────────────────────────────

export const groupViolationsByH3 = (violations, resolution = H3_RESOLUTION) => {
  const h3Map = new Map();

  violations.forEach((violation) => {
    if (!violation.latitude || !violation.longitude) return;

    const lat = parseFloat(violation.latitude);
    const lng = parseFloat(violation.longitude);

    if (isNaN(lat) || isNaN(lng)) return;

    try {
      const h3Index = latLngToCell(lat, lng, resolution);

      if (!h3Map.has(h3Index)) {
        h3Map.set(h3Index, {
          count: 0,
          violations: [],
          // Severity (severityLevel 1–3) from config/violationTypes.js:
          // 1 = infraction, 2 = misdemeanor, 3 = felony
          severities: {
            felony: 0,
            misdemeanor: 0,
            infraction: 0,
          },
        });
      }

      const h3Data = h3Map.get(h3Index);
      h3Data.count++;
      h3Data.violations.push(violation);

      if (violation.severity_level === 3) {
        h3Data.severities.felony++;
      } else if (violation.severity_level === 2) {
        h3Data.severities.misdemeanor++;
      } else {
        h3Data.severities.infraction++;
      }
    } catch (error) {
      console.error(
        "Error processing H3 cell for violation:",
        violation.id,
        error,
      );
    }
  });

  return h3Map;
};

// ─────────────────────────────────────────────
// 2. Hexagon colors and opacity
// ─────────────────────────────────────────────

export const getHexagonColor = (count, severities) => {
  const hasFelony = severities?.felony > 0;
  const hasMisdemeanor = severities?.misdemeanor > 0;

  if (count >= 10) return "#f97316";
  if (count >= 5) return "#fb923c";
  if (count >= 2) return "#fbbf24";
  if (count === 1) return "#fde68a";

  // Red only if the cell has at least one felony
  if (hasFelony) return "#dc2626";
  if (hasMisdemeanor) return "#f97316";

  return "#fde68a";
};

export const getHexagonOpacity = (count) => {
  if (count >= 20) return 0.9;
  if (count >= 10) return 0.8;
  if (count >= 5) return 0.7;
  if (count >= 2) return 0.6;
  return 0.5;
};

// ─────────────────────────────────────────────
// 2.5. Correct conversion of an H3 cell boundary to a Leaflet polygon
// ─────────────────────────────────────────────
// PROBLEM: cellToBoundary() returns only the cell's vertices (6, sometimes
// 5 for pentagons). The true boundary of an H3 cell is a great-circle arc,
// not a straight line. For small cells (resolution 3+) the difference is
// negligible, but for huge resolution 0-1 cells (hundreds to thousands of
// km per edge), connecting vertices with straight lines on a flat lat/lng
// projection produced curved "diagonal bands" on the map that crossed the
// whole screen. Additionally, when a cell boundary passes near the
// antimeridian (180/-180), adjacent vertices can have longitudes like +179
// and -179, and a straight line between them incorrectly "jumped" across
// the entire map.
//
// SOLUTION: 1) increase point density along each edge via spherical
// interpolation (slerp) — the coarser the resolution, the more
// intermediate points; 2) "unwrap" longitudes sequentially, so there are
// no jumps across ±180°.

// Number of extra points per edge depending on resolution.
const EDGE_SUBDIVISIONS_BY_RESOLUTION = {
  0: 24,
  1: 12,
  2: 6,
  3: 2,
};

const getEdgeSubdivisions = (resolution) =>
  EDGE_SUBDIVISIONS_BY_RESOLUTION[resolution] ?? 0;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

// Spherical linear interpolation (slerp) between two [lat, lng] points in
// degrees — returns a point ALONG the great-circle arc (not a straight
// line on the plane), t from 0 to 1.
const slerp = (a, b, t) => {
  const lat1 = toRad(a[0]);
  const lng1 = toRad(a[1]);
  const lat2 = toRad(b[0]);
  const lng2 = toRad(b[1]);

  const v1 = [
    Math.cos(lat1) * Math.cos(lng1),
    Math.cos(lat1) * Math.sin(lng1),
    Math.sin(lat1),
  ];
  const v2 = [
    Math.cos(lat2) * Math.cos(lng2),
    Math.cos(lat2) * Math.sin(lng2),
    Math.sin(lat2),
  ];

  const dot = Math.max(
    -1,
    Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]),
  );
  const theta = Math.acos(dot);

  if (theta === 0) return a;

  const sinTheta = Math.sin(theta);
  const w1 = Math.sin((1 - t) * theta) / sinTheta;
  const w2 = Math.sin(t * theta) / sinTheta;

  const v = [
    w1 * v1[0] + w2 * v2[0],
    w1 * v1[1] + w2 * v2[1],
    w1 * v1[2] + w2 * v2[2],
  ];

  return [toDeg(Math.asin(v[2])), toDeg(Math.atan2(v[1], v[0]))];
};

// Adds intermediate points along each edge (of the closed vertex ring)
// via slerp — aligning it to the actual great-circle arc.
const densifyH3Boundary = (boundary, resolution) => {
  const subdivisions = getEdgeSubdivisions(resolution);
  const ring = [...boundary, boundary[0]]; // closed ring

  if (subdivisions <= 0) return ring;

  const dense = [];
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    dense.push(a);
    for (let s = 1; s <= subdivisions; s++) {
      dense.push(slerp(a, b, s / (subdivisions + 1)));
    }
  }
  dense.push(ring[ring.length - 1]);
  return dense;
};

// Sequentially "unwraps" longitudes to avoid jumps across the
// antimeridian (±180°): each subsequent point is adjusted by ±360° until
// the difference from the previous one is within [-180, 180].
const unwrapAntimeridian = (points) => {
  const result = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prevLng = result[i - 1][1];
    let lng = points[i][1];
    while (lng - prevLng > 180) lng -= 360;
    while (lng - prevLng < -180) lng += 360;
    result.push([points[i][0], lng]);
  }
  return result;
};

// Single entry point: H3 index → ready-to-use (closed, smoothed, no
// antimeridian gaps) array of [lat, lng] for L.polygon.
const h3IndexToLeafletLatLngs = (h3Index) => {
  const boundary = cellToBoundary(h3Index);
  const resolution = getResolution(h3Index);
  const densified = densifyH3Boundary(boundary, resolution);
  return unwrapAntimeridian(densified);
};

// ─────────────────────────────────────────────
// 3. Converting an H3 Map → polygons for Leaflet
// ─────────────────────────────────────────────

export const getHexagonPolygons = (h3Map) => {
  const polygons = [];

  h3Map.forEach((data, h3Index) => {
    try {
      const latLngs = h3IndexToLeafletLatLngs(h3Index);

      polygons.push({
        index: h3Index,
        latLngs,
        count: data.count,
        severities: data.severities,
        violations: data.violations,
      });
    } catch (error) {
      console.error("Error processing H3 cell:", error);
    }
  });

  return polygons;
};

// ─────────────────────────────────────────────
// 4. H3 statistics
// ─────────────────────────────────────────────

export const getH3Statistics = (h3Map) => {
  let totalHexagons = h3Map.size;
  let maxViolations = 0;
  let hexagonsWithViolations = 0;
  let totalViolations = 0;

  h3Map.forEach((data) => {
    maxViolations = Math.max(maxViolations, data.count);
    if (data.count > 0) {
      hexagonsWithViolations++;
      totalViolations += data.count;
    }
  });

  return {
    totalHexagons,
    maxViolations,
    hexagonsWithViolations,
    averageViolations:
      hexagonsWithViolations > 0 ? totalViolations / hexagonsWithViolations : 0,
  };
};

// ─────────────────────────────────────────────
// 5. Global grid — all cells at a given resolution
// ─────────────────────────────────────────────

export const getAllH3Cells = (resolution = GRID_RESOLUTION) => {
  try {
    // The 122 base resolution-0 cells cover the entire planet
    const res0Cells = getRes0Cells();
    const allCells = [];

    res0Cells.forEach((cell) => {
      const children = cellToChildren(cell, resolution);
      allCells.push(...children);
    });

    return allCells;
  } catch (error) {
    console.error("Error generating global H3 grid:", error);
    return [];
  }
};

/**
 * Generates H3 cells only within the map's visible area (viewport).
 * Significantly more efficient at higher resolutions.
 *
 * @param {object} bounds - Leaflet bounds object (map.getBounds())
 * @param {number} resolution - H3 resolution
 * @returns {string[]} array of H3 indices within the viewport
 */
export const getViewportH3Cells = (bounds, resolution = GRID_RESOLUTION) => {
  try {
    const BUFFER = 2; // buffer degrees around the edges

    const north = Math.min(bounds.getNorth() + BUFFER, 85);
    const south = Math.max(bounds.getSouth() - BUFFER, -85);
    const east = Math.min(bounds.getEast() + BUFFER, 180);
    const west = Math.max(bounds.getWest() - BUFFER, -180);

    const viewportPolygon = [
      [north, west],
      [north, east],
      [south, east],
      [south, west],
      [north, west],
    ];

    const cells = polygonToCells(viewportPolygon, resolution, false); // false = intersect mode
    return cells;
  } catch (error) {
    console.error("Error generating viewport H3 cells:", error);
    return [];
  }
};

/**
 * Converts an array of H3 indices into polygons for Leaflet.
 * Used together with getAllH3Cells or getViewportH3Cells.
 *
 * @param {string[]} cells - array of H3 indices
 * @param {Map} violationMap - result of groupViolationsByH3 (optional)
 * @returns {Array} array of { index, latLngs, count, severities, violations } objects
 */
export const h3CellsToLeafletPolygons = (cells, violationMap = null) => {
  const polygons = [];

  cells.forEach((h3Index) => {
    try {
      const latLngs = h3IndexToLeafletLatLngs(h3Index);

      // If violation data is available — enrich the polygon
      const cellData = violationMap ? violationMap.get(h3Index) : null;

      polygons.push({
        index: h3Index,
        latLngs,
        count: cellData?.count ?? 0,
        severities: cellData?.severities ?? {
          felony: 0,
          misdemeanor: 0,
          infraction: 0,
        },
        violations: cellData?.violations ?? [],
      });
    } catch (error) {
      console.error("Error converting H3 cell to polygon:", h3Index, error);
    }
  });

  return polygons;
};

/**
 * Returns Leaflet Polygon styles (color, fillColor, opacity, weight) based
 * on the count and severity of violations in the cell.
 *
 * @param {number} count - number of violations
 * @param {object} severities - { felony, misdemeanor, infraction }
 * @param {boolean} isEmpty - true if the cell has no violations (grid)
 * @returns {object} Leaflet pathOptions
 */
export const getH3CellStyle = (count, severities, isEmpty = false) => {
  if (isEmpty || count === 0) {
    // Empty cell — thin grid line
    // UPDATED: fillOpacity increased from 0.04 to 0.08 for better visibility
    return {
      color: "#6366f1", // indigo outline
      weight: 0.5,
      opacity: 0.35,
      fillColor: "#6366f1",
      fillOpacity: 0.08, // WAS 0.04 — increased for visibility
    };
  }

  const fillColor = getHexagonColor(count, severities);
  const fillOpacity = getHexagonOpacity(count);

  return {
    color: fillColor,
    weight: 1,
    opacity: 0.8,
    fillColor,
    fillOpacity,
  };
};

// ─────────────────────────────────────────────
// 6. Helper for getting the H3 cell at a given coordinate
// ─────────────────────────────────────────────

// Returns the H3 cell index for a specific point (user's coordinates)
export const getH3CellForLocation = (
  lat,
  lng,
  resolution = GRID_RESOLUTION,
) => {
  if (!lat || !lng || isNaN(lat) || isNaN(lng)) return null;
  return latLngToCell(lat, lng, resolution);
};

// ─────────────────────────────────────────────
// 7. Moving between grid levels (parent/children)
// ─────────────────────────────────────────────
// To support multiple hexagon levels on the map (0/1/2/3). Cells at
// different resolutions have different indices, so any comparison/
// filtering of "the same" cell at another level requires an explicit
// conversion via h3-js cellToParent/cellToChildren.

/**
 * Returns the index of the parent cell at a coarser (lower) resolution.
 * Used, e.g., to show "your location" (the user's cell is always stored
 * at GRID_RESOLUTION) at coarser grid levels.
 *
 * @param {string} h3Index - the source H3 index
 * @param {number} resolution - the target (coarser) resolution
 * @returns {string|null}
 */
export const getH3Parent = (h3Index, resolution) => {
  if (!h3Index) return null;
  try {
    return cellToParent(h3Index, resolution);
  } catch (error) {
    console.error("Error getting H3 parent cell:", h3Index, resolution, error);
    return null;
  }
};

/**
 * Returns an array of child cells at a more detailed (higher) resolution.
 * Used, e.g., to convert a selected coarse hexagon (level 0/1/2) into a
 * list of GRID_RESOLUTION (level 3) cells, where posts/violations are
 * actually stored, and to filter the feed by them.
 *
 * @param {string} h3Index - the source (coarser) H3 index
 * @param {number} resolution - the target (more detailed) resolution
 * @returns {string[]}
 */
export const getH3ChildrenAtResolution = (h3Index, resolution) => {
  if (!h3Index) return [];
  try {
    return cellToChildren(h3Index, resolution);
  } catch (error) {
    console.error(
      "Error getting H3 children cells:",
      h3Index,
      resolution,
      error,
    );
    return [];
  }
};
