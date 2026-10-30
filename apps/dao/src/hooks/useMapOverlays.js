// src/hooks/useMapOverlays.js
//
// Puts the shared overlays on an existing Leaflet map:
//   • conflict danger zones (curated hexagons)
//   • live alert pins (fresh serious violations)
//   • live events (GDACS disasters, ACLED conflict events)
// and credits the external sources in the map's attribution.
//
// Used by the violations map, the country map and the login-page map, so all
// three look and behave the same.
//
// `mapRef`      ref to the Leaflet map (may be null until it is created).
// `mapVersion`  anything that CHANGES whenever the map instance is created or
//               re-created (e.g. a counter, or a `ready` boolean) — it tells
//               the hook to draw the layers on the new instance.
// `violations`  moderated violations (source of the alert pins).

import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import useLiveEvents from "./useLiveEvents";
import { getLiveAlerts } from "../lib/liveAlerts";
import { EVENT_SOURCES, isMinorEvent } from "../lib/liveEvents";
import {
  ensureDangerPane,
  buildConflictZonesLayer,
  buildLiveAlertsLayer,
  buildLiveEventsLayer,
  MINOR_EVENTS_MIN_ZOOM,
} from "../lib/mapOverlays";

const useMapOverlays = ({
  mapRef,
  mapVersion,
  violations,
  showLive = true,
  showDangerZones = true,
  onViewDetails = null,
  getViolationTypeLabel,
  eventsUrl,
}) => {
  const { t, i18n } = useTranslation();
  // The overlay modules use flat keys (as in dossier); in this app they live
  // under `dao.mapLayers.*`. A missing translation falls back to English.
  const tf = useCallback(
    (key, fallback) => {
      const full = `dao.mapLayers.${key}`;
      return i18n.exists(full) ? t(full) : fallback;
    },
    [t, i18n],
  );

  const { events } = useLiveEvents({ url: eventsUrl });

  // "Now" for the live-alert window; ticks every minute so a pin disappears
  // on its own once it is older than the window.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const liveAlerts = useMemo(
    () => getLiveAlerts(violations, { now: nowTick }),
    [violations, nowTick],
  );

  // Callbacks from the page are usually not memoised; read them through a ref
  // so that a new function identity doesn't rebuild the layers.
  const latest = useRef({});
  useEffect(() => {
    latest.current = { onViewDetails, getViolationTypeLabel };
  });

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showDangerZones) return undefined;
    ensureDangerPane(map);
    const layer = buildConflictZonesLayer({ tf }).addTo(map);
    return () => layer.remove();
  }, [mapRef, mapVersion, showDangerZones, tf]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showLive || liveAlerts.length === 0) return undefined;
    const layer = buildLiveAlertsLayer({
      alerts: liveAlerts,
      tf,
      getTypeLabel: (v) =>
        latest.current.getViolationTypeLabel
          ? latest.current.getViolationTypeLabel(v)
          : v.violation_type_id || "",
      onViewDetails: latest.current.onViewDetails
        ? (id) => latest.current.onViewDetails?.(id)
        : null,
    }).addTo(map);
    return () => layer.remove();
  }, [mapRef, mapVersion, showLive, liveAlerts, tf]);

  // Orange / red events are always shown.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showLive || events.length === 0) return undefined;
    const layer = buildLiveEventsLayer({ events, tf, only: "major" }).addTo(map);
    return () => layer.remove();
  }, [mapRef, mapVersion, showLive, events, tf]);

  // Green (minor) events only appear once the map is zoomed in.
  const [minorVisible, setMinorVisible] = useState(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showLive || events.length === 0) return undefined;
    const layer = buildLiveEventsLayer({ events, tf, only: "minor" });
    const sync = () => {
      const show = map.getZoom() >= MINOR_EVENTS_MIN_ZOOM;
      if (show && !map.hasLayer(layer)) layer.addTo(map);
      if (!show && map.hasLayer(layer)) layer.remove();
      setMinorVisible(show);
    };
    sync();
    map.on("zoomend", sync);
    return () => {
      map.off("zoomend", sync);
      layer.remove();
    };
  }, [mapRef, mapVersion, showLive, events, tf]);

  // Credit the external sources that are actually on the map (ACLED's terms
  // require it).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !showLive || !map.attributionControl) return undefined;
    const names = [...new Set(events.map((e) => e.source))]
      .map((id) => EVENT_SOURCES[id])
      .filter(Boolean);
    if (names.length === 0) return undefined;
    const text = `Events: ${names.join(", ")}`;
    map.attributionControl.addAttribution(text);
    return () => map.attributionControl?.removeAttribution(text);
  }, [mapRef, mapVersion, showLive, events]);

  // The badge counts what is currently on the map.
  const visibleEvents = minorVisible
    ? events.length
    : events.filter((e) => !isMinorEvent(e)).length;

  return {
    liveAlerts,
    events,
    liveCount: liveAlerts.length + visibleEvents,
  };
};

export default useMapOverlays;
