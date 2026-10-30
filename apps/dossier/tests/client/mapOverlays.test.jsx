// Picked up by: node scripts/run-client-tests.mjs (npm run test:moderation)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConflictZonesLayer,
  buildLiveAlertsLayer,
  buildLiveEventsLayer,
} from "../../src/utils/mapOverlays.js";
import { CONFLICT_ZONES } from "../../src/config/conflictZones.js";

const tf = (key, fallback) => fallback;
const popupOf = (layer) => layer.getPopup().getContent();
const layersOf = (group) => group.getLayers();

const event = (over = {}) => ({
  id: "gdacs:EQ1",
  source: "gdacs",
  category: "natural",
  type: "EQ",
  level: "red",
  title: "Red earthquake alert in Turkey",
  country: "Turkey",
  location: "",
  severity: "Magnitude 6.1M",
  actors: "",
  notes: "",
  fatalities: null,
  lat: 38.2,
  lng: 37.1,
  time: Date.parse("2026-10-26T08:00:00Z"),
  link: "https://www.gdacs.org/report.aspx?eventtype=EQ&eventid=1",
  ...over,
});

test("conflict zones: one polygon per hexagon, covering every configured zone", () => {
  const group = buildConflictZonesLayer({ tf });
  const polygons = layersOf(group);
  assert.ok(polygons.length >= CONFLICT_ZONES.length * 3);
  assert.ok(polygons.every((p) => p.options.pane === "dangerPane"));
});

test("live events: hostile feed text is escaped in the popup", () => {
  const group = buildLiveEventsLayer({
    tf,
    events: [
      event({
        title: '<img src=x onerror="alert(1)">',
        country: "<script>alert(2)</script>",
        link: 'https://www.gdacs.org/"onmouseover="alert(3)',
      }),
    ],
  });
  const html = popupOf(layersOf(group)[0]);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;img src=x"));
  // the quote in the URL is escaped, so it cannot break out of the href attribute
  assert.ok(!html.includes('href="https://www.gdacs.org/"onmouseover'));
});

test("live events: unsafe links are not rendered, bad coordinates are skipped", () => {
  const group = buildLiveEventsLayer({
    tf,
    events: [
      event({ link: "javascript:alert(1)" }),
      event({ id: "x", lat: "abc" }),
    ],
  });
  assert.equal(layersOf(group).length, 1);
  assert.ok(!popupOf(layersOf(group)[0]).includes("<a "));
});

test("live events: conflict events are diamonds with fatalities; minor ones are dim", () => {
  const group = buildLiveEventsLayer({
    tf,
    events: [
      event({
        id: "acled:1",
        source: "acled",
        category: "conflict",
        type: "EXP",
        level: "orange",
        fatalities: 3,
        link: null,
        actors: "A / B",
      }),
      event({ id: "gdacs:VO2", type: "VO", level: "green" }),
    ],
  });
  const [conflict, minor] = layersOf(group);
  assert.match(conflict.options.icon.options.html, /live-event-pin--conflict/);
  assert.ok(popupOf(conflict).includes("Fatalities: 3"));
  assert.ok(popupOf(conflict).includes("ACLED"));
  assert.match(minor.options.icon.options.html, /live-event-pin--minor/);
  assert.doesNotMatch(minor.options.icon.options.html, /conflict/);
});

test("live alerts: the details button exists only when navigation is available", () => {
  const alerts = [
    {
      id: "v1",
      latitude: 50.4,
      longitude: 30.5,
      violation_type_id: "t",
      alertTime: Date.parse("2026-10-27T10:00:00Z"),
    },
  ];
  const getTypeLabel = () => "<b>Category → Type</b>";
  const withButton = buildLiveAlertsLayer({ alerts, tf, getTypeLabel, onViewDetails: () => {} });
  const without = buildLiveAlertsLayer({ alerts, tf, getTypeLabel, onViewDetails: null });
  assert.ok(popupOf(layersOf(withButton)[0]).includes("data-alert-details"));
  assert.ok(!popupOf(layersOf(without)[0]).includes("data-alert-details"));
  assert.ok(!popupOf(layersOf(without)[0]).includes("<b>Category"), "label is escaped");
});

test("live events: `only` splits major (orange/red) from minor (green) events", () => {
  const events = [
    { id: "a", source: "gdacs", category: "natural", type: "WF", level: "green", lat: 1, lng: 1 },
    { id: "b", source: "gdacs", category: "natural", type: "EQ", level: "red", lat: 2, lng: 2 },
    { id: "c", source: "gdacs", category: "natural", type: "FL", level: "orange", lat: 3, lng: 3 },
  ];
  const tf = (_k, f) => f;
  assert.equal(buildLiveEventsLayer({ events, tf, only: "minor" }).getLayers().length, 1);
  assert.equal(buildLiveEventsLayer({ events, tf, only: "major" }).getLayers().length, 2);
  assert.equal(buildLiveEventsLayer({ events, tf }).getLayers().length, 3);
});
