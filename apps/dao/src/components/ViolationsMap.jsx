// src/components/ViolationsMap.jsx
//
// REPLACES ViolationsMapTemplate.jsx (the mockup this was built from —
// see its header comment for the intended reference: dossier-app's
// CountryPage.jsx map). Same Leaflet + H3 grid engine as dossier's own
// country map (utils/h3Utils.js was ported verbatim into src/lib/), but
// deliberately without: country selection (always world view — "Planet
// Earth" scope, matching the DAO's whole-ecosystem vantage point),
// ratings, and the map collapse/expand toggle. Every OTHER piece of the
// original map's functionality is kept: H3 grid on/off, the 4 hexagon
// detail levels, clicking a cell to highlight it, zoom/pan, and full
// marker popups — just without wiring a cell selection into any feed
// filter, since this page's feed (DossierFeed.jsx) is the general
// unified feed, not violations specifically.
//
// Interaction is display-only otherwise: no create/edit/delete, no
// voting/report actions — the popup's only action button opens the
// violation on dossier itself, in a new tab.
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Maximize2, MapPin, Layers, ExternalLink } from "lucide-react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { fetchAllViolations } from "../lib/dossierViolations";
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../lib/moderationCheck";
import { getSeverityInfo, VIOLATION_CATEGORIES } from "../config/violationTypes";
import {
  getViewportH3Cells,
  h3CellsToLeafletPolygons,
  groupViolationsByH3,
  getH3CellStyle,
  HEX_LEVELS,
  LEVEL_RESOLUTIONS,
} from "../lib/h3Utils";

const DOSSIER_APP_URL =
  import.meta.env.VITE_DOSSIER_APP_URL || "http://localhost:5173";

const worldView = { center: [20, 0], zoom: 2 };

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

function getViolationTypeLabel(violation, t) {
  const category = VIOLATION_CATEGORIES.find(
    (c) => c.id === violation.category_id,
  );
  const type = category?.types.find((vt) => vt.id === violation.violation_type_id);
  if (!category || !type) return violation.violation_type_id || t("dao.violationsMap.unspecified");
  return `${category.label} → ${type.label}`;
}

export default function ViolationsMap() {
  const { t } = useTranslation();
  const [violations, setViolations] = useState([]);
  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState("");
  const [showH3Grid, setShowH3Grid] = useState(false);
  const [hexLevel, setHexLevel] = useState(3);
  const [selectedH3Cell, setSelectedH3Cell] = useState(null);
  const h3Resolution = LEVEL_RESOLUTIONS[hexLevel];

  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const markersRef = useRef([]);
  const mapCounterRef = useRef(null);
  const h3LayerRef = useRef(null);
  const renderH3GridRef = useRef(() => {});

  const destroyMapInstance = () => {
    if (h3LayerRef.current) {
      h3LayerRef.current.remove();
      h3LayerRef.current = null;
    }
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
  };

  const loadViolations = useCallback(async () => {
    setMapLoading(true);
    setMapError("");
    try {
      const all = await fetchAllViolations();
      const [modActions, shieldTotalSupply] = await Promise.all([
        fetchAllModActions(),
        fetchShieldTotalSupply(),
      ]);

      const valid = all.filter((v) => {
        if (
          !(v.latitude && v.longitude && !isNaN(v.latitude) && !isNaN(v.longitude))
        )
          return false;
        if (computeModerationState(modActions, v.lens_post_id).hidden)
          return false;
        if (v.author?.owner_address) {
          const banState = computeBanState(
            modActions,
            v.author.owner_address,
            shieldTotalSupply,
          );
          if (banState.banned) return false;
        }
        return true;
      });
      setViolations(valid);
    } catch (err) {
      console.error("Error loading violations:", err);
      setMapError(err.message || "Error loading violations");
    } finally {
      setMapLoading(false);
    }
  }, []);

  useEffect(() => {
    loadViolations();
  }, [loadViolations]);

  // ── Map init (world view only — no country-specific center/zoom) ──
  const initMap = useCallback(() => {
    if (!mapContainerRef.current) return;
    if (mapRef.current) destroyMapInstance();

    mapRef.current = L.map(mapContainerRef.current, {
      center: worldView.center,
      zoom: worldView.zoom,
      zoomControl: false,
      scrollWheelZoom: true,
      dragging: true,
      minZoom: 0,
      worldCopyJump: false,
    });

    // Esri "World Dark Gray Base" — free, no API key required, keeps the
    // dark aesthetic. Replaces CARTO's basemaps.cartocdn.com/dark_all,
    // which now requires a paid API key for XYZ tile access.
    L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      {
        attribution:
          '&copy; <a href="https://www.esri.com">Esri</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 16,
        maxNativeZoom: 16,
        noWrap: true,
      },
    ).addTo(mapRef.current);

    // Optional reference layer with country borders / labels, matching
    // Esri's "World Dark Gray Reference" companion tileset.
    L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 16,
        maxNativeZoom: 16,
        noWrap: true,
        pane: "overlayPane",
      },
    ).addTo(mapRef.current);

    L.control.zoom({ position: "bottomright" }).addTo(mapRef.current);

    const bounds = L.latLngBounds(L.latLng(-90, -180), L.latLng(90, 180));
    mapRef.current.setMaxBounds(bounds);
    mapRef.current.on("drag", () => {
      mapRef.current.panInsideBounds(bounds, { animate: false });
    });

    // Counter control — clicking it opens dossier's own dedicated
    // violations map in a new tab (this app has no such page of its own).
    const CounterControl = L.Control.extend({
      onAdd: function () {
        const container = L.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control leaflet-control-custom",
        );
        Object.assign(container.style, {
          backgroundColor: "#12161c",
          color: "#F4F2ED",
          padding: "6px 10px",
          borderRadius: "6px",
          boxShadow: "0 1px 5px rgba(0,0,0,0.4)",
          cursor: "pointer",
          fontSize: "12px",
          fontWeight: "500",
          display: "flex",
          alignItems: "center",
          gap: "6px",
        });
        container.innerHTML = `<span>${t("dao.violationsMap.violationsOnMap", { count: violations.length })}</span>`;
        container.onclick = () => {
          window.open(`${DOSSIER_APP_URL}/violations-map`, "_blank", "noreferrer");
        };
        mapCounterRef.current = container;
        return container;
      },
    });
    new CounterControl({ position: "bottomleft" }).addTo(mapRef.current);

    if (showH3Grid) setTimeout(() => renderH3GridRef.current(), 50);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [violations.length]);

  const updateMapMarkers = useCallback(() => {
    if (!mapRef.current || !violations.length) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    violations.forEach((violation) => {
      if (!violation.latitude || !violation.longitude) return;
      const markerColor = getSeverityInfo(violation.severity_level).color;

      const icon = L.divIcon({
        html: `<div class="relative group"><div class="w-6 h-6 flex items-center justify-center cursor-pointer hover:scale-110 transition-transform"><svg class="w-6 h-6" viewBox="0 0 24 24" fill="${markerColor}"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg></div></div>`,
        className: "violation-marker",
        iconSize: [24, 24],
        iconAnchor: [12, 24],
      });

      const dateLine = violation.violation_date
        ? `<div><strong>${t("dao.violationsMap.popupDate")}:</strong> ${new Date(violation.violation_date).toLocaleDateString()}</div>`
        : "";
      const popupContent = `<div class="p-2 min-w-[170px]"><h3 class="font-bold text-gray-700 text-[13px] mb-0.5">${getViolationTypeLabel(violation, t)}</h3><div class="text-[11px] text-gray-500 space-y-0.5">${dateLine}<div><strong>${t("dao.violationsMap.popupCountry")}:</strong> ${violation.country_code || "—"}</div></div><a href="${DOSSIER_APP_URL}/violations/${violation.id}" target="_blank" rel="noreferrer" class="mt-1.5 flex items-center justify-center gap-1 w-full py-1 rounded transition-colors text-[11px] bg-[#8B1A2A] hover:bg-[#9B2232] text-white no-underline">${t("dao.common.viewOnDossier")} ↗</a></div>`;

      const marker = L.marker(
        [parseFloat(violation.latitude), parseFloat(violation.longitude)],
        { icon },
      ).addTo(mapRef.current);
      marker.bindPopup(popupContent);
      markersRef.current.push(marker);
    });

    if (mapCounterRef.current) {
      mapCounterRef.current.querySelector("span").textContent =
        t("dao.violationsMap.violationsOnMap", { count: violations.length });
    }
  }, [violations]);

  const renderH3Grid = useCallback(() => {
    if (!mapRef.current) return;
    if (h3LayerRef.current) {
      h3LayerRef.current.remove();
      h3LayerRef.current = null;
    }
    if (!showH3Grid) return;

    const violationMap = groupViolationsByH3(violations, h3Resolution);
    const bounds = mapRef.current.getBounds();
    const cells = getViewportH3Cells(bounds, h3Resolution);
    const polygons = h3CellsToLeafletPolygons(cells, violationMap);
    const layerGroup = L.layerGroup();

    polygons.forEach(({ index, latLngs, count, severities }) => {
      const isSelectedCell = index === selectedH3Cell;
      let style = getH3CellStyle(0, severities, true);
      if (isSelectedCell) {
        style = {
          ...style,
          color: "#f59e0b",
          weight: 3,
          fillColor: "#fbbf24",
          fillOpacity: 0.5,
        };
      }

      const polygon = L.polygon(latLngs, { ...style, interactive: true });

      if (count > 0) {
        const severityLabels = [];
        if (severities.felony > 0)
          severityLabels.push(`🔴 ${t("dao.violationsMap.felony")}: ${severities.felony}`);
        if (severities.misdemeanor > 0)
          severityLabels.push(`🟠 ${t("dao.violationsMap.misdemeanor")}: ${severities.misdemeanor}`);
        if (severities.infraction > 0)
          severityLabels.push(`🟡 ${t("dao.violationsMap.infraction")}: ${severities.infraction}`);
        polygon.bindPopup(
          `<div class="p-2 min-w-[150px]"><div class="font-bold text-gray-700 text-[13px] mb-0.5">${t("dao.violationsMap.violationsInArea", { count })}</div><div class="text-[11px] text-gray-500 space-y-0.5">${severityLabels.map((l) => `<div>${l}</div>`).join("")}</div></div>`,
        );
      }

      polygon.on("mouseover", () => {
        if (!isSelectedCell)
          polygon.setStyle({ fillOpacity: Math.min(style.fillOpacity + 0.2, 1) });
      });
      polygon.on("mouseout", () => polygon.setStyle({ fillOpacity: style.fillOpacity }));
      polygon.on("click", () => {
        setSelectedH3Cell((prev) => (prev === index ? null : index));
      });
      layerGroup.addLayer(polygon);
    });

    layerGroup.addTo(mapRef.current);
    h3LayerRef.current = layerGroup;
  }, [showH3Grid, h3Resolution, violations, selectedH3Cell]);

  useEffect(() => {
    renderH3GridRef.current = renderH3Grid;
  }, [renderH3Grid]);

  useEffect(() => {
    if (!mapLoading) initMap();
    return () => destroyMapInstance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoading]);

  useEffect(() => {
    updateMapMarkers();
  }, [updateMapMarkers]);

  useEffect(() => {
    renderH3Grid();
  }, [renderH3Grid]);

  useEffect(() => {
    if (mapRef.current) {
      mapRef.current.on("moveend", renderH3Grid);
      return () => mapRef.current?.off("moveend", renderH3Grid);
    }
  }, [renderH3Grid]);

  return (
    <div className="relative rounded-2xl overflow-hidden border border-hairline bg-surface">
      <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-hairline">
        <div className="flex items-center gap-2">
          <MapPin size={16} className="text-verdigrisBright" />
          <span className="font-display text-sm text-parchment">{t("dao.violationsMap.title")}</span>
          <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-surface2 text-parchmentDim">
            {t("dao.violationsMap.scopeBadge")}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowH3Grid((v) => !v)}
            className={`flex items-center gap-1.5 font-mono text-[12px] px-2.5 py-1.5 rounded-full border transition-colors ${
              showH3Grid
                ? "border-verdigris text-verdigrisBright bg-verdigris/10"
                : "border-hairline text-parchmentDim"
            }`}
          >
            <Layers size={12} />
            H3 GRID
          </button>
          {showH3Grid && (
            <div className="hidden sm:flex items-center gap-1">
              {HEX_LEVELS.map((level) => (
                <button
                  key={level}
                  onClick={() => setHexLevel(level)}
                  title={t("dao.violationsMap.level", { level })}
                  className={`w-6 h-6 flex items-center justify-center rounded-md text-[11px] font-semibold border transition-colors ${
                    hexLevel === level
                      ? "bg-verdigris border-verdigris text-white"
                      : "border-hairline text-parchmentDim hover:border-verdigris"
                  }`}
                >
                  {level}
                </button>
              ))}
            </div>
          )}
          <a
            href={`${DOSSIER_APP_URL}/violations-map`}
            target="_blank"
            rel="noreferrer"
            className="text-parchmentDim hover:text-parchment"
            title={t("dao.violationsMap.openFullMap")}
          >
            <Maximize2 size={15} />
          </a>
        </div>
      </div>

      <div className="relative h-72 sm:h-96">
        {mapError && (
          <div className="absolute inset-0 z-50 flex items-center justify-center p-4 bg-surface">
            <div className="text-center p-4 border border-seal/30 rounded-xl">
              <p className="text-sm text-parchmentDim mb-3">{mapError}</p>
              <button
                onClick={loadViolations}
                className="px-3 py-1.5 text-xs bg-seal/20 border border-seal/30 text-parchment rounded-lg hover:bg-seal/30 transition-colors"
              >
                {t("try_again")}
              </button>
            </div>
          </div>
        )}

        {mapLoading && (
          <div className="absolute inset-0 z-40 bg-surface/90 flex items-center justify-center">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-verdigris/50 border-t-verdigrisBright rounded-full animate-spin mx-auto" />
              <p className="mt-2 text-xs text-parchmentDim">{t("dao.violationsMap.loadingMap")}</p>
            </div>
          </div>
        )}

        <style>{`
          .leaflet-control-attribution {
            font-size: 9px;
            line-height: 1.1;
            padding: 1px 4px;
            max-width: 60vw;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
          }
          @media (max-width: 480px) {
            .leaflet-control-attribution {
              max-width: 40vw;
              font-size: 8px;
            }
          }
        `}</style>

        <div ref={mapContainerRef} className="h-full w-full z-10" />
      </div>

      {selectedH3Cell && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-hairline bg-surface2/40">
          <span className="text-[11px] text-parchmentDim">
            {t("dao.violationsMap.hexagonSelected", { level: hexLevel })}
          </span>
          <button
            onClick={() => setSelectedH3Cell(null)}
            className="text-[11px] text-parchmentDim hover:text-parchment underline"
          >
            {t("dao.violationsMap.reset")}
          </button>
        </div>
      )}
    </div>
  );
}
