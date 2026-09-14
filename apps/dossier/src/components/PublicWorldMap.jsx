// src/components/PublicWorldMap.jsx
//
// Read-only "Earth" violations map shown on the login/registration
// screen (App.jsx), before the person has connected a wallet or
// logged in. All violation posts are public Lens data, so this needs
// no session — it reuses useLensViolations().fetchViolations(), which
// already falls back to the public `lensClient` when there's no
// sessionClient.
//
// Deliberately minimal compared to ViolationsMap.jsx (the full map
// page): fixed world view only (no per-country zoom/filter, no H3
// hexagon grid, no fullscreen toggle), and popups only show the
// violation type / date / country — no "View details" button, since
// this screen has nothing to navigate to yet.
import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useLensViolations from "../hooks/useLensViolations";
import { useCountry } from "../hooks/useCountry";
import { getSeverityInfo, VIOLATION_CATEGORIES } from "../config/violationTypes";

import L from "leaflet";
import "leaflet/dist/leaflet.css";

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

const PublicWorldMap = () => {
  const { t, i18n } = useTranslation();
  const tf = (key, fallback) => {
    const val = t(key);
    return val && val !== key ? val : fallback;
  };

  const { fetchViolations } = useLensViolations();
  const { getTranslatedCountryName } = useCountry(i18n.language || "uk");

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const getViolationTypeLabel = (violation) => {
    const category = VIOLATION_CATEGORIES.find(
      (c) => c.id === violation.category_id,
    );
    const type = category?.types.find(
      (t2) => t2.id === violation.violation_type_id,
    );
    if (!category || !type) {
      return violation.violation_type_id || t("unspecified") || "—";
    }
    return `${t(category.labelKey) || category.label} → ${
      t(type.labelKey) || type.label
    }`;
  };

  // Init map once. Previously this used a fixed center/zoom (worldView)
  // which only fit the whole planet in a container with a very specific
  // aspect ratio — in this card (much wider than tall) it cropped most
  // of the map (see screenshot: only a strip through Africa/Europe was
  // visible, poles and edges cut off). fitBounds() instead computes
  // whatever zoom level actually fits the whole world in the container
  // we're given, so the full map is visible by default regardless of
  // the card's width. Zoom controls are now on (bottom-right, like the
  // full ViolationsMap.jsx page) so people can zoom into a country
  // they're interested in; scroll-to-zoom is enabled only while the
  // cursor is actually over the map, so the widget doesn't hijack page
  // scrolling the rest of the time.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const map = L.map(mapContainerRef.current, {
      minZoom: 1,
      maxZoom: 9,
      zoomControl: false,
      scrollWheelZoom: false,
      dragging: true,
      worldCopyJump: false,
    });
    mapRef.current = map;

    L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      {
        attribution:
          '&copy; <a href="https://www.esri.com">Esri</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 16,
        maxNativeZoom: 16,
        noWrap: true,
      },
    ).addTo(map);

    L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 16,
        maxNativeZoom: 16,
        noWrap: true,
        pane: "overlayPane",
      },
    ).addTo(map);

    L.control.zoom({ position: "bottomright" }).addTo(map);

    const panBounds = L.latLngBounds(L.latLng(-90, -180), L.latLng(90, 180));
    map.setMaxBounds(panBounds);
    map.on("drag", () => map.panInsideBounds(panBounds, { animate: false }));

    // Slightly cropped at the poles (like most web maps) so the
    // populated landmasses fill the card instead of leaving big empty
    // strips of ocean/ice top and bottom.
    const worldBounds = L.latLngBounds([-58, -175], [78, 175]);
    const fitWorld = () => {
      map.invalidateSize();
      map.fitBounds(worldBounds, { animate: false });
    };
    // Run once after layout has actually sized the container...
    requestAnimationFrame(fitWorld);

    // ...and again whenever the card is resized (column width changes
    // at a breakpoint, sidebar collapses, etc.) — otherwise the fitted
    // zoom from mount would leave the map cropped/off-center after a
    // resize, the same problem this fix is for in the first place.
    const resizeObserver = new ResizeObserver(() => fitWorld());
    resizeObserver.observe(mapContainerRef.current);

    // Only capture the scroll wheel while the pointer is over the map,
    // so visitors can still scroll the page normally everywhere else.
    const enableScrollZoom = () => map.scrollWheelZoom.enable();
    const disableScrollZoom = () => map.scrollWheelZoom.disable();
    mapContainerRef.current.addEventListener("mouseenter", enableScrollZoom);
    mapContainerRef.current.addEventListener("mouseleave", disableScrollZoom);

    return () => {
      resizeObserver.disconnect();
      mapContainerRef.current?.removeEventListener(
        "mouseenter",
        enableScrollZoom,
      );
      mapContainerRef.current?.removeEventListener(
        "mouseleave",
        disableScrollZoom,
      );
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Load public violations once and drop pins for all of them —
  // Earth-only, no country/date filters, no H3 grid.
  const violationsRef = useRef([]);
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError("");
      try {
        const result = await fetchViolations({});
        if (!result.success) throw new Error(result.error);
        if (!cancelled) {
          violationsRef.current = result.violations || [];
          renderMarkers(violationsRef.current);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If someone switches language with the manual selector after the
  // markers are already on the map, re-render the (already-fetched)
  // popups so the country names in them follow the new language too.
  useEffect(() => {
    if (violationsRef.current.length) renderMarkers(violationsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language]);

  const renderMarkers = (violations) => {
    if (!mapRef.current) return;

    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    const isDark = document.documentElement.classList.contains("dark");
    const wrapperStyle = isDark
      ? "background:#000d1f;border-radius:8px;border:1px solid rgba(255,255,255,0.07);"
      : "background:#ffffff;border-radius:8px;border:1px solid rgba(0,0,0,0.08);";
    const titleColor = isDark ? "rgba(255,255,255,0.85)" : "#374151";
    const bodyColor = isDark ? "rgba(255,255,255,0.45)" : "#6b7280";
    const labelColor = isDark ? "rgba(255,255,255,0.35)" : "#9ca3af";

    violations.forEach((violation) => {
      if (!violation.latitude || !violation.longitude) return;

      const markerColor = getSeverityInfo(violation.severity_level).color;
      const icon = L.divIcon({
        html: `
          <div class="w-5 h-5 flex items-center justify-center">
            <svg class="w-5 h-5" viewBox="0 0 24 24" fill="${markerColor}">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
          </div>
        `,
        className: "violation-marker",
        iconSize: [20, 20],
        iconAnchor: [10, 20],
      });

      const marker = L.marker(
        [parseFloat(violation.latitude), parseFloat(violation.longitude)],
        { icon },
      ).addTo(mapRef.current);

      // No "View details" button, no navigation — this is a preview
      // widget on the login screen, not the full violations map.
      const popupContent = `
        <div class="p-2 min-w-[160px]" style="${wrapperStyle}">
          <h3 class="font-bold text-[12px] mb-0.5" style="color:${titleColor};">${getViolationTypeLabel(violation)}</h3>
          <div class="text-[11px] space-y-0.5" style="color:${bodyColor};">
            ${violation.violation_date ? `<div><strong style="color:${labelColor};">${t("date") || "Date"}:</strong> ${new Date(violation.violation_date).toLocaleDateString()}</div>` : ""}
            <div><strong style="color:${labelColor};">${t("country") || "Country"}:</strong> ${getTranslatedCountryName(violation.country_code)}</div>
          </div>
        </div>
      `;

      marker.bindPopup(popupContent);
      markersRef.current.push(marker);
    });
  };

  return (
    <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl overflow-hidden">
      <div className="px-4 pt-3.5 pb-2">
        <h3 className="text-[13px] font-medium text-slate-700 dark:text-white/50">
          {tf("violations_map_title", "Violations around the world")}
        </h3>
      </div>
      <div className="relative w-full h-[200px]">
        <div ref={mapContainerRef} className="w-full h-full" />
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/70 dark:bg-[#000d1f]/70">
            <div className="w-6 h-6 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
          </div>
        )}
        {!loading && error && (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-slate-500 dark:text-white/30 px-4 text-center">
            {tf("map_load_error", "Couldn't load the map right now.")}
          </div>
        )}
      </div>
    </div>
  );
};

export default PublicWorldMap;
