// Picked up by: node scripts/run-client-tests.mjs (npm run test:moderation)
import { test } from "node:test";
import assert from "node:assert/strict";
import { cellToLatLng, getResolution } from "h3-js";
import { buildConflictZoneCells } from "../../src/utils/conflictZones.js";
import { CONFLICT_ZONES, CONFLICT_STATUS } from "../../src/config/conflictZones.js";
import {
  getLiveAlerts,
} from "../../src/utils/liveAlerts.js";

test("every curated zone is valid and unique", () => {
  const ids = new Set();
  for (const zone of CONFLICT_ZONES) {
    assert.ok(!ids.has(zone.id), `duplicate id ${zone.id}`);
    ids.add(zone.id);
    assert.ok(CONFLICT_STATUS[zone.status], `${zone.id}: unknown status`);
    assert.ok([3, 4, 5].includes(zone.resolution), `${zone.id}: resolution`);
    assert.match(zone.reviewed, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(zone.seeds.length > 0, `${zone.id}: no seeds`);
    for (const [lat, lng, k = 0] of zone.seeds) {
      assert.ok(Math.abs(lat) <= 90 && Math.abs(lng) <= 180, `${zone.id}: coords`);
      assert.ok(Number.isInteger(k) && k >= 0 && k <= 3, `${zone.id}: k`);
    }
  }
});

test("each zone yields several hexagons of its own resolution", () => {
  const cells = buildConflictZoneCells();
  for (const zone of CONFLICT_ZONES) {
    const own = cells.filter((c) => c.zone.id === zone.id);
    assert.ok(own.length >= 3, `${zone.id} has only ${own.length} hexagons`);
    for (const c of own) assert.equal(getResolution(c.index), zone.resolution);
  }
  assert.ok(cells.length < 400, "the layer stays small enough to draw");
});

test("a hexagon is never listed twice; the stronger status wins an overlap", () => {
  const cells = buildConflictZoneCells();
  assert.equal(new Set(cells.map((c) => c.index)).size, cells.length);

  const zones = [
    { id: "a", status: "tension", resolution: 3, seeds: [[50, 30]] },
    { id: "b", status: "war", resolution: 3, seeds: [[50, 30]] },
  ];
  const merged = buildConflictZoneCells(zones);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].zone.id, "b");
});

test("zones are where they should be (sanity check on a few well-known places)", () => {
  const cells = buildConflictZoneCells();
  const near = (id, lat, lng, maxDeg) =>
    cells
      .filter((c) => c.zone.id === id)
      .some((c) => {
        const [clat, clng] = cellToLatLng(c.index);
        return Math.abs(clat - lat) < maxDeg && Math.abs(clng - lng) < maxDeg;
      });
  assert.ok(near("gaza", 31.4, 34.4, 0.3));
  assert.ok(near("ukraine_front", 48.0, 37.5, 1.2));
  assert.ok(near("korean_dmz", 38.0, 127.0, 0.5));
  assert.ok(near("taiwan_strait", 24.5, 119.5, 1.5));
});

// ── live alerts (independent of the zones) ──────────────────────────────
const NOW = Date.parse("2026-10-27T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();
const daysAgo = (d) => new Date(NOW - d * 86400_000).toISOString();
const v = (over) => ({
  id: Math.random().toString(36),
  latitude: 50.45,
  longitude: 30.52,
  severity_level: 3,
  violation_date: hoursAgo(1),
  created_at: hoursAgo(1),
  ...over,
});

test("live alerts: felony only, inside the window, newest first", () => {
  const alerts = getLiveAlerts(
    [
      v({ id: "new", violation_date: hoursAgo(2), created_at: hoursAgo(2) }),
      v({ id: "newer", violation_date: hoursAgo(1), created_at: hoursAgo(1) }),
      v({ id: "minor", severity_level: 2 }),
      v({ id: "stale", violation_date: daysAgo(10), created_at: daysAgo(10) }),
      v({ id: "nocoords", latitude: null }),
    ],
    { now: NOW },
  );
  assert.deepEqual(alerts.map((a) => a.id), ["newer", "new"]);
});

test("live alerts: an old event published just now still alerts", () => {
  const alerts = getLiveAlerts(
    [v({ id: "late", violation_date: daysAgo(7), created_at: hoursAgo(3) })],
    { now: NOW },
  );
  assert.equal(alerts.length, 1);
});

test("live alerts: a bogus far-future date does not keep a pin alive", () => {
  const alerts = getLiveAlerts(
    [v({ id: "x", violation_date: daysAgo(-60), created_at: daysAgo(10) })],
    { now: NOW },
  );
  assert.equal(alerts.length, 0);
});
