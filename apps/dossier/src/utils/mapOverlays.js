// src/utils/mapOverlays.js
//
// Leaflet builders for the three shared map overlays:
//   • conflict "danger zones" — curated hexagons (config/conflictZones.js)
//   • live alert pins         — fresh serious violations of this platform
//   • live events             — external events (GDACS disasters, ACLED conflict)
//
// Each builder returns an (unattached) L.LayerGroup; the caller adds it to a
// map and removes it again. Used through hooks/useMapOverlays.js so that the
// violations map, the country map and the login-page map all look the same.
//
// All text coming from outside (feeds) is escaped before it enters popup HTML,
// and only links to known sources are ever used in an href.

import L from "leaflet";
import { h3CellsToLeafletPolygons } from "./h3Utils";
import { buildConflictZoneCells } from "./conflictZones";
import {
  EVENT_SOURCES,
  escapeHtml,
  getEventLevel,
  getEventType,
  isConflictEvent,
  isMinorEvent,
  isSafeSourceUrl,
} from "./liveEvents";
import { getPopupTheme } from "./mapPopupTheme";

export const DANGER_PANE = "dangerPane";

// Static, so computed once.
const CONFLICT_CELLS = buildConflictZoneCells();

/**
 * Own pane for the danger-zone hexagons: above the basemap and the plain H3
 * grid (overlayPane, z-index 400) but below the markers (600), so markers
 * stay clickable on top of a zone.
 */
export const ensureDangerPane = (map) => {
  if (!map.getPane(DANGER_PANE)) {
    map.createPane(DANGER_PANE).style.zIndex = "410";
  }
};

/** @param {(key: string, fallback: string) => string} tf  i18n with fallback */
export const buildConflictZonesLayer = ({ tf }) => {
  const cellByIndex = new Map(CONFLICT_CELLS.map((c) => [c.index, c]));
  const polygons = h3CellsToLeafletPolygons(CONFLICT_CELLS.map((c) => c.index));
  const theme = getPopupTheme();
  const group = L.layerGroup();

  polygons.forEach(({ index, latLngs }) => {
    const cell = cellByIndex.get(index);
    if (!cell) return;
    const { zone, status } = cell;
    const name = tf(`conflict_zone_${zone.id}`, zone.name);

    const polygon = L.polygon(latLngs, {
      pane: DANGER_PANE,
      color: status.color,
      weight: 1,
      opacity: 0.7,
      fillColor: status.color,
      fillOpacity: status.fillOpacity,
      interactive: true,
    });

    polygon.bindTooltip(escapeHtml(name), { sticky: true });
    polygon.bindPopup(`
      <div class="p-2 min-w-[170px]" style="${theme.wrapper}">
        <div class="font-bold text-[13px] mb-0.5" style="color:${theme.title};">${escapeHtml(name)}</div>
        <div class="text-[12px] font-semibold" style="color:${status.color};">${escapeHtml(tf(status.labelKey, status.label))}</div>
        <div class="text-[10px] mt-0.5" style="color:${theme.label};">
          ${escapeHtml(tf("conflict_zone_reviewed", "Reviewed"))}: ${escapeHtml(new Date(zone.reviewed).toLocaleDateString())}
        </div>
      </div>
    `);

    polygon.on("mouseover", () =>
      polygon.setStyle({ fillOpacity: Math.min(status.fillOpacity + 0.2, 1) }),
    );
    polygon.on("mouseout", () =>
      polygon.setStyle({ fillOpacity: status.fillOpacity }),
    );

    group.addLayer(polygon);
  });

  return group;
};

/**
 * Pulsing pins for fresh serious violations.
 * @param {object} o
 * @param {Array} o.alerts  result of getLiveAlerts()
 * @param {(v: object) => string} o.getTypeLabel  violation → "Category → Type"
 * @param {((id: string) => void) | null} o.onViewDetails  null = no button
 */
export const buildLiveAlertsLayer = ({ alerts, tf, getTypeLabel, onViewDetails }) => {
  const theme = getPopupTheme();
  const group = L.layerGroup();

  alerts.forEach((violation) => {
    const marker = L.marker(
      [parseFloat(violation.latitude), parseFloat(violation.longitude)],
      {
        icon: L.divIcon({
          html: '<span class="live-alert-pin"><span class="live-alert-pin__ring"></span><span class="live-alert-pin__dot"></span></span>',
          className: "live-alert-icon",
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        zIndexOffset: 1000,
        riseOnHover: true,
      },
    );

    marker.bindPopup(`
      <div class="p-2 min-w-[180px]" style="${theme.wrapper}">
        <div class="text-[10px] font-bold uppercase tracking-wider mb-0.5" style="color:#ef4444;">
          ● ${escapeHtml(tf("live_alert_label", "New serious violation"))}
        </div>
        <h3 class="font-bold text-[13px] mb-0.5" style="color:${theme.title};">${escapeHtml(getTypeLabel(violation))}</h3>
        <div class="text-[11px]" style="color:${theme.body};">
          ${escapeHtml(new Date(violation.alertTime).toLocaleString())}
        </div>
        ${
          onViewDetails
            ? `<button type="button" data-alert-details class="mt-1.5 w-full py-1 rounded transition-colors text-[11px]" style="${theme.button}">${escapeHtml(tf("view_details", "View details"))}</button>`
            : ""
        }
      </div>
    `);

    if (onViewDetails) {
      marker.on("popupopen", (e) => {
        e.popup
          .getElement()
          ?.querySelector("[data-alert-details]")
          ?.addEventListener("click", () => onViewDetails(violation.id), {
            once: true,
          });
      });
    }

    group.addLayer(marker);
  });

  return group;
};

/**
 * External events: natural hazards (GDACS) as round badges, conflict events
 * (ACLED) as diamonds, both ringed in the severity colour. Minor events are
 * small and dim.
 */
// Minor (green-level) events would clutter the world view, so they are drawn
// in their own layer that the map shows only from this zoom level on
// (roughly: a country or part of a continent).
export const MINOR_EVENTS_MIN_ZOOM = 5;

// `only`: "all" (default) | "major" (orange/red) | "minor" (green).
export const buildLiveEventsLayer = ({ events, tf, only = "all" }) => {
  const theme = getPopupTheme();
  const group = L.layerGroup();

  events.forEach((event) => {
    const lat = Number(event.lat);
    const lng = Number(event.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const type = getEventType(event.type);
    const level = getEventLevel(event.level);
    const conflict = isConflictEvent(event);
    const minor = isMinorEvent(event);
    if (only === "major" && minor) return;
    if (only === "minor" && !minor) return;
    const typeLabel = tf(`event_type_${type.key}`, type.label);
    const sourceLabel = EVENT_SOURCES[event.source] || event.source;
    const size = minor ? 18 : 24;

    const marker = L.marker([lat, lng], {
      icon: L.divIcon({
        html: `<span class="live-event-pin${conflict ? " live-event-pin--conflict" : ""}${minor ? " live-event-pin--minor" : ""}" style="--event-color:${level.color}"><span class="live-event-pin__glyph">${type.emoji}</span></span>`,
        className: "live-event-icon",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      }),
      zIndexOffset: minor ? 300 : 500,
      riseOnHover: true,
    });

    const link = isSafeSourceUrl(event.link)
      ? ` · <a href="${escapeHtml(event.link)}" target="_blank" rel="noopener noreferrer" class="underline">${escapeHtml(tf("event_open_source", "Open source"))} ↗</a>`
      : "";

    // Natural hazards show the alert level; conflict events show the number
    // of fatalities instead (an "alert level" makes no sense there).
    const headline = conflict
      ? `${tf("event_fatalities", "Fatalities")}: ${Number(event.fatalities) || 0}`
      : tf(`event_level_${level.key}`, level.label);
    const place = [event.location, event.country].filter(Boolean).join(", ");
    const date = event.time
      ? conflict
        ? new Date(event.time).toLocaleDateString()
        : new Date(event.time).toLocaleString()
      : "";

    marker.bindPopup(`
      <div class="p-2 min-w-[190px] max-w-[270px]" style="${theme.wrapper}">
        <div class="text-[10px] font-bold uppercase tracking-wider mb-0.5" style="color:${level.color};">
          ● ${escapeHtml(headline)}
        </div>
        <h3 class="font-bold text-[13px] mb-0.5" style="color:${theme.title};">${type.emoji} ${escapeHtml(typeLabel)}</h3>
        <div class="text-[11px] space-y-0.5" style="color:${theme.body};">
          ${event.title && event.title !== typeLabel ? `<div>${escapeHtml(event.title)}</div>` : ""}
          ${place ? `<div>${escapeHtml(place)}</div>` : ""}
          ${event.severity ? `<div>${escapeHtml(event.severity)}</div>` : ""}
          ${event.actors ? `<div>${escapeHtml(event.actors)}</div>` : ""}
          ${event.notes ? `<div class="opacity-80">${escapeHtml(event.notes)}</div>` : ""}
          ${date ? `<div>${escapeHtml(date)}</div>` : ""}
        </div>
        <div class="mt-1 text-[10px]" style="color:${theme.label};">
          ${escapeHtml(tf("event_source", "Source"))}: ${escapeHtml(sourceLabel)}${link}
        </div>
      </div>
    `);

    group.addLayer(marker);
  });

  return group;
};
