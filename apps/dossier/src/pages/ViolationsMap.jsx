// src/pages/ViolationsMap.jsx
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Filter,
  Globe,
  Calendar,
  AlertCircle,
  ChevronDown,
  Maximize2,
  Minimize2,
} from "lucide-react";
import Layout from "../components/Layout";
import useLensViolations from "../hooks/useLensViolations";
import useUserInfo from "../hooks/useUserInfo";
import { countryViewConfigs, worldView } from "../utils/mapConfig";
import { useCountry } from "../hooks/useCountry";
import CreatePostModal from "../components/CreatePostModal";
import {
  getSeverityInfo,
  VIOLATION_CATEGORIES,
} from "../config/violationTypes";
// ADDED: the violations map never checked sanctions/bans at all — no
// marker was filtered.
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";

// Leaflet import for map
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import {
  getViewportH3Cells,
  h3CellsToLeafletPolygons,
  groupViolationsByH3,
  getH3CellStyle,
  HEX_LEVELS,
  LEVEL_RESOLUTIONS,
} from "../utils/h3Utils";

// Fix for Leaflet icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

const ViolationsMap = () => {
  const { t } = useTranslation();
  // See the comment in CountryPage.jsx: i18next returns the key itself
  // for a missing translation, so `t(key) || fallback` doesn't work for
  // keys without a translation. tf() falls back correctly in that case.
  const tf = (key, fallback) => {
    const val = t(key);
    return val && val !== key ? val : fallback;
  };
  // ADDED: in the map popup we show the TYPE of violation (category → type),
  // rather than the description/title (violation.title), as before.
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

  const navigate = useNavigate();
  const { userInfo, loading: userLoading } = useUserInfo();
  const { getTranslatedCountryName } = useCountry(
    localStorage.getItem("i18nextLng") || "uk",
  );
  const { fetchViolations } = useLensViolations();

  const [violations, setViolations] = useState([]);
  const [filteredViolations, setFilteredViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // State for create post modal
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);

  // Filters
  const [countryFilter, setCountryFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Map
  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const mapWrapperRef = useRef(null);
  const markersRef = useRef([]);

  // Fullscreen state
  const [isMapFullscreen, setIsMapFullscreen] = useState(false);

  // H3 Grid state
  const [showH3Grid, setShowH3Grid] = useState(false);
  // ADDED: switch for hexagon levels 3/2/1/0 (like on the country map).
  // 3 — original behavior (GRID_RESOLUTION), 2/1/0 — coarser levels.
  const [hexLevel, setHexLevel] = useState(3);
  const h3Resolution = LEVEL_RESOLUTIONS[hexLevel];
  const h3LayerRef = useRef(null);

  // Statistics
  const [stats, setStats] = useState({
    total: 0,
    countries: 0,
    lastUpdated: null,
  });

  // Load violations
  const loadViolations = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const result = await fetchViolations({});

      if (!result.success) throw new Error(result.error);

      // ADDED: posts hidden by a moderator, and posts from a banned
      // author, should not appear on the map — previously no marker was
      // checked against this at all.
      const [modActions, shieldTotalSupply] = await Promise.all([
        fetchAllModActions(),
        fetchShieldTotalSupply(),
      ]);

      const validViolations = result.violations.filter((v) => {
        if (!(v.latitude && v.longitude && !isNaN(v.latitude) && !isNaN(v.longitude))) {
          return false;
        }
        if (computeModerationState(modActions, v.lens_post_id).hidden) {
          return false;
        }
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

      setViolations(validViolations);
      setFilteredViolations(validViolations);

      const countries = new Set(validViolations.map((v) => v.country_code))
        .size;
      setStats({
        total: validViolations.length,
        countries,
        lastUpdated: new Date().toISOString(),
      });
    } catch (err) {
      console.error("Error loading violations:", err);
      setError(
        err.message || t("load_violations_error") || "Error loading violations",
      );
    } finally {
      setLoading(false);
    }
  }, [t, fetchViolations]);

  // Initialize map
  const initMap = useCallback(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    let initialView = worldView;

    if (countryFilter !== "all") {
      const countryConfig = countryViewConfigs[countryFilter];
      if (countryConfig) {
        initialView = countryConfig;
      }
    } else if (userInfo?.country && userInfo.country !== "EARTH") {
      const userCountryConfig = countryViewConfigs[userInfo.country];
      if (userCountryConfig) {
        initialView = userCountryConfig;
      }
    }

    mapRef.current = L.map(mapContainerRef.current, {
      center: initialView.center,
      zoom: initialView.zoom,
      zoomControl: false,
      scrollWheelZoom: true,
      dragging: true,
      worldCopyJump: false,
    });

    // Esri "World Light Gray Base" — free, no API key required.
    // Replaces CARTO's basemaps.cartocdn.com/light_all, which now
    // requires a paid API key for XYZ tile access.
    L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      {
        attribution:
          '&copy; <a href="https://www.esri.com">Esri</a>, &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        maxZoom: 16,
        maxNativeZoom: 16,
        noWrap: true,
      },
    ).addTo(mapRef.current);

    // Reference layer with country borders / labels, matching Esri's
    // "World Light Gray Reference" companion tileset.
    L.tileLayer(
      "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
      {
        maxZoom: 16,
        maxNativeZoom: 16,
        noWrap: true,
        pane: "overlayPane",
      },
    ).addTo(mapRef.current);

    L.control
      .zoom({
        position: "bottomright",
      })
      .addTo(mapRef.current);

    const southWest = L.latLng(-90, -180);
    const northEast = L.latLng(90, 180);
    const bounds = L.latLngBounds(southWest, northEast);
    mapRef.current.setMaxBounds(bounds);
    mapRef.current.on("drag", function () {
      mapRef.current.panInsideBounds(bounds, { animate: false });
    });
  }, [countryFilter, userInfo]);

  // ADDED: pulled out separately so ONLY the date filter (without the
  // country filter) is applied for the hybrid context layer on the map —
  // unlike country, date is a deliberate content filter set by the user,
  // so violations hidden by date should NOT "show through" as context.
  const applyDateFilter = useCallback(
    (list) => {
      if (!dateFrom && !dateTo) return list;
      return list.filter((v) => {
        if (!v.violation_date) return false;
        const violationDate = new Date(v.violation_date);
        const fromDate = dateFrom ? new Date(dateFrom) : null;
        const toDate = dateTo ? new Date(dateTo) : null;
        if (violationDate > new Date()) return false;
        let valid = true;
        if (fromDate) valid = valid && violationDate >= fromDate;
        if (toDate) valid = valid && violationDate <= toDate;
        return valid;
      });
    },
    [dateFrom, dateTo],
  );

  // ADDED: hybrid approach (like on the country map) — the base set for
  // markers on the map is ALL violations that passed the date filter, but
  // WITHOUT the country filter. filteredViolations (below) remains
  // country+date-filtered and still drives the counter/zoom/H3 grid.
  const dateFilteredViolations = useMemo(
    () => applyDateFilter(violations),
    [violations, applyDateFilter],
  );

  // Update map markers
  const updateMapMarkers = useCallback(() => {
    if (!mapRef.current || !dateFilteredViolations.length) {
      return;
    }

    markersRef.current.forEach((marker) => {
      marker.remove();
    });
    markersRef.current = [];

    const isCountryFocused = countryFilter && countryFilter !== "all";
    // ADDED: popups now match the current theme (light/dark) —
    // previously they always had a dark appearance regardless of the
    // site's theme, unlike the country map (CountryPage.jsx).
    const isDark = document.documentElement.classList.contains("dark");

    dateFilteredViolations.forEach((violation) => {
      if (!violation.latitude || !violation.longitude) return;

      const markerColor = getSeverityInfo(violation.severity_level).color;
      const isInFocusCountry =
        !isCountryFocused || violation.country_code === countryFilter;

      const icon = isInFocusCountry
        ? L.divIcon({
            html: `
          <div class="relative group">
            <div class="w-6 h-6 flex items-center justify-center cursor-pointer hover:scale-110 transition-transform">
              <svg class="w-6 h-6" viewBox="0 0 24 24" fill="${markerColor}">
                <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
              </svg>
            </div>
          </div>
        `,
            className: "violation-marker",
            iconSize: [24, 24],
            iconAnchor: [12, 24],
          })
        : // ADDED: a muted marker for violations outside the selected country —
          // smaller, semi-transparent, no hover animation. Provides context
          // (neighboring countries are visible) without visually competing with the focus.
          L.divIcon({
            html: `
          <div class="w-4 h-4 flex items-center justify-center cursor-pointer opacity-45 hover:opacity-80 transition-opacity">
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="${markerColor}">
              <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
            </svg>
          </div>
        `,
            className: "violation-marker violation-marker-context",
            iconSize: [16, 16],
            iconAnchor: [8, 16],
          });

      const marker = L.marker(
        [parseFloat(violation.latitude), parseFloat(violation.longitude)],
        {
          icon,
        },
      ).addTo(mapRef.current);

      // CHANGED: 1) the popup now matches the current theme (light/dark);
      // 2) "inactive" (context) markers now get the SAME full popup
      // (date, country, "View details" button) as active ones — previously
      // they had a simplified version without the date and button. The
      // difference now is only in the marker's appearance above (smaller,
      // dimmer). 3) the button is now red (light theme) / maroon (dark theme).
      const wrapperStyle = isDark
        ? "background:#000d1f;border-radius:8px;border:1px solid rgba(255,255,255,0.07);"
        : "background:#ffffff;border-radius:8px;border:1px solid rgba(0,0,0,0.08);";
      const titleColor = isDark ? "rgba(255,255,255,0.85)" : "#374151"; // gray-700
      const bodyColor = isDark ? "rgba(255,255,255,0.45)" : "#6b7280"; // gray-500
      const labelColor = isDark ? "rgba(255,255,255,0.35)" : "#9ca3af"; // gray-400
      const buttonStyle = isDark
        ? "background:#2B000A;border:1px solid rgba(180,30,60,0.3);color:rgba(232,160,176,0.7);"
        : "background:#8B1A2A;border:1px solid #8B1A2A;color:#ffffff;"; // red-600

      const popupContent = `
        <div class="p-2 min-w-[170px]" style="${wrapperStyle}">
          <h3 class="font-bold text-[13px] mb-0.5 truncate" style="color:${titleColor};">${getViolationTypeLabel(violation)}</h3>
          <div class="text-[11px] space-y-0.5" style="color:${bodyColor};">
            ${violation.violation_date ? `<div><strong style="color:${labelColor};">${t("date") || "Date"}:</strong> ${new Date(violation.violation_date).toLocaleDateString()}</div>` : ""}
            <div><strong style="color:${labelColor};">${t("country") || "Country"}:</strong> ${getTranslatedCountryName(violation.country_code)}</div>
          </div>
          <button
            id="view-details-${violation.id}"
            class="mt-1.5 w-full py-1 rounded transition-colors text-[11px]"
            style="${buttonStyle}"
          >
            ${t("view_details") || "View details"}
          </button>
        </div>
      `;

      marker.bindPopup(popupContent);
      markersRef.current.push(marker);

      marker.on("popupopen", () => {
        setTimeout(() => {
          const button = document.getElementById(
            `view-details-${violation.id}`,
          );
          if (button) {
            button.addEventListener("click", () => {
              navigate(`/violations/${violation.id}`);
            });
          }
        }, 100);
      });
    });

    if (filteredViolations.length > 0) {
      const bounds = L.latLngBounds(
        filteredViolations.map((v) => [
          parseFloat(v.latitude),
          parseFloat(v.longitude),
        ]),
      );

      // SAFEGUARD: same as in CountryPage.jsx — don't let a Leaflet
      // animation crash the render if the map ends up in a
      // transitional/stale state.
      try {
        if (filteredViolations.length === 1) {
          const violation = filteredViolations[0];
          mapRef.current.setView(
            [parseFloat(violation.latitude), parseFloat(violation.longitude)],
            12,
          );
        } else {
          mapRef.current.fitBounds(bounds, { padding: [50, 50] });
        }
      } catch (err) {
        console.error("Error adjusting map view:", err);
      }
    }
  }, [
    dateFilteredViolations,
    filteredViolations,
    countryFilter,
    t,
    getTranslatedCountryName,
    navigate,
    getViolationTypeLabel,
  ]);

  const renderH3Grid = useCallback(() => {
    if (!mapRef.current) return;

    if (h3LayerRef.current) {
      h3LayerRef.current.remove();
      h3LayerRef.current = null;
    }

    if (!showH3Grid) return;

    const violationMap = groupViolationsByH3(filteredViolations, h3Resolution);
    const bounds = mapRef.current.getBounds();
    const cells = getViewportH3Cells(bounds, h3Resolution);
    const polygons = h3CellsToLeafletPolygons(cells, violationMap);
    // ADDED: the hexagon popup now also matches the current theme.
    const isDark = document.documentElement.classList.contains("dark");
    const wrapperStyle = isDark
      ? "background:#000d1f; border-radius:8px; border:1px solid rgba(255,255,255,0.07);"
      : "background:#ffffff; border-radius:8px; border:1px solid rgba(0,0,0,0.08);";
    const titleColor = isDark ? "rgba(255,255,255,0.85)" : "#374151";
    const bodyColor = isDark ? "rgba(255,255,255,0.45)" : "#6b7280";
    const labelColor = isDark ? "rgba(255,255,255,0.35)" : "#9ca3af";

    const layerGroup = L.layerGroup();

    polygons.forEach(({ index, latLngs, count, severities, violations }) => {
      // CHANGED: the grid is no longer colored by the count/severity of
      // violations — violations are already visible as separate markers on
      // the map. A cell always looks like an "empty" grid cell.
      const style = getH3CellStyle(0, severities, true);

      const polygon = L.polygon(latLngs, {
        ...style,
        interactive: true,
      });

      if (count > 0) {
        const severityLabels = [];
        if (severities.felony > 0)
          severityLabels.push(`🔴 Felony: ${severities.felony}`);
        if (severities.misdemeanor > 0)
          severityLabels.push(`🟠 Misdemeanor: ${severities.misdemeanor}`);
        if (severities.infraction > 0)
          severityLabels.push(`🟡 Infraction: ${severities.infraction}`);

        polygon.bindPopup(`
          <div class="p-2 min-w-[150px]" style="${wrapperStyle}">
            <div class="font-bold text-[13px] mb-0.5" style="color:${titleColor};">Violations in area: ${count}</div>
            <div class="text-[11px] space-y-0.5" style="color:${bodyColor};">
              ${severityLabels.map((l) => `<div>${l}</div>`).join("")}
            </div>
            <div class="mt-1 text-[10px] truncate" style="color:${labelColor};">
              H3: ${index}
            </div>
          </div>
        `);

        polygon.on("mouseover", () =>
          polygon.setStyle({
            fillOpacity: Math.min(style.fillOpacity + 0.2, 1),
          }),
        );
        polygon.on("mouseout", () =>
          polygon.setStyle({ fillOpacity: style.fillOpacity }),
        );
      }

      layerGroup.addLayer(polygon);
    });

    layerGroup.addTo(mapRef.current);
    h3LayerRef.current = layerGroup;
  }, [mapRef, showH3Grid, h3Resolution, filteredViolations]);

  // Filter violations
  const applyFilters = useCallback(() => {
    let filtered = [...violations];

    if (countryFilter && countryFilter !== "all") {
      filtered = filtered.filter((v) => v.country_code === countryFilter);
    }

    if (dateFrom || dateTo) {
      filtered = filtered.filter((v) => {
        if (!v.violation_date) return false;

        const violationDate = new Date(v.violation_date);
        const fromDate = dateFrom ? new Date(dateFrom) : null;
        const toDate = dateTo ? new Date(dateTo) : null;

        if (violationDate > new Date()) return false;

        let valid = true;
        if (fromDate) valid = valid && violationDate >= fromDate;
        if (toDate) valid = valid && violationDate <= toDate;

        return valid;
      });
    }

    setFilteredViolations(filtered);

    const countries = new Set(filtered.map((v) => v.country_code)).size;
    setStats((prev) => ({
      ...prev,
      total: filtered.length,
      countries,
    }));
  }, [violations, countryFilter, dateFrom, dateTo]);

  // Reset filters
  const resetFilters = () => {
    setCountryFilter("all");
    setDateFrom("");
    setDateTo("");
    setFilteredViolations(violations);

    setStats({
      total: violations.length,
      countries: new Set(violations.map((v) => v.country_code)).size,
      lastUpdated: new Date().toISOString(),
    });

    if (mapRef.current) {
      mapRef.current.setView(worldView.center, worldView.zoom);
    }
  };

  const renderH3GridRef = useRef(renderH3Grid);
  useEffect(() => {
    renderH3GridRef.current = renderH3Grid;
  }, [renderH3Grid]);

  useEffect(() => {
    loadViolations();
  }, [loadViolations]);

  useEffect(() => {
    if (!loading && !error && !mapRef.current) {
      initMap();

      setTimeout(() => {
        if (mapRef.current) {
          const handler = () => renderH3GridRef.current();
          mapRef.current.on("moveend", handler);
          mapRef.current.on("zoomend", handler);
          renderH3GridRef.current();
        }
      }, 300);
    }
  }, [loading, error, initMap]);

  useEffect(() => {
    if (mapRef.current && filteredViolations.length > 0) {
      updateMapMarkers();
    }
  }, [filteredViolations, updateMapMarkers]);

  useEffect(() => {
    if (violations.length > 0) {
      applyFilters();
    }
  }, [countryFilter, dateFrom, dateTo, violations, applyFilters]);

  useEffect(() => {
    if (mapRef.current) {
      renderH3Grid();
    }
  }, [showH3Grid, h3Resolution, filteredViolations, renderH3Grid]);

  useEffect(() => {
    return () => {
      if (h3LayerRef.current) {
        h3LayerRef.current.remove();
      }
      if (mapRef.current) {
        mapRef.current.off("moveend");
        mapRef.current.off("zoomend");
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Fullscreen: we try to use the browser's NATIVE Fullscreen API.
  // If it's unavailable or rejected by the environment (happens in some
  // dev/iframe environments due to Permissions Policy) — we fall back to a
  // CSS fallback (isCssFullscreenFallback), where we control the size
  // ourselves via className +
  // ResizeObserver.
  const [isCssFullscreenFallback, setIsCssFullscreenFallback] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFs = document.fullscreenElement === mapWrapperRef.current;
      setIsMapFullscreen(isFs);
      if (isFs) setIsCssFullscreenFallback(false);
      requestAnimationFrame(() => {
        if (mapRef.current) mapRef.current.invalidateSize({ animate: false });
      });
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  // Fallback mode: recompute the map size via ResizeObserver when the
  // native Fullscreen API didn't work and the container's size changes
  // through our own CSS classes.
  useEffect(() => {
    if (!mapContainerRef.current || typeof ResizeObserver === "undefined")
      return;
    const resizeObserver = new ResizeObserver(() => {
      if (mapRef.current) mapRef.current.invalidateSize({ animate: false });
    });
    resizeObserver.observe(mapContainerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Fallback: exit via Escape (native fullscreen supports Escape on its
  // own, and for the CSS fallback we handle it ourselves)
  useEffect(() => {
    if (!isCssFullscreenFallback) return;
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setIsMapFullscreen(false);
        setIsCssFullscreenFallback(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "";
    };
  }, [isCssFullscreenFallback]);

  const toggleMapFullscreen = () => {
    if (!mapWrapperRef.current) return;

    // If we're in CSS fallback mode — just turn it off
    if (isCssFullscreenFallback) {
      setIsMapFullscreen(false);
      setIsCssFullscreenFallback(false);
      return;
    }

    if (document.fullscreenElement) {
      document.exitFullscreen?.();
      return;
    }

    if (mapWrapperRef.current.requestFullscreen) {
      mapWrapperRef.current.requestFullscreen().catch(() => {
        // The native API rejected the request — falling back to CSS
        setIsMapFullscreen(true);
        setIsCssFullscreenFallback(true);
      });
    } else {
      // The native Fullscreen API isn't supported at all in this environment
      setIsMapFullscreen(true);
      setIsCssFullscreenFallback(true);
    }
  };

  const uniqueCountries = [...new Set(violations.map((v) => v.country_code))]
    .filter((code) => code && code.length === 2)
    .sort();

  if (userLoading) {
    return (
      <Layout
        userProfile={userInfo}
        onLogout={() => {}}
        loading={true}
        onCreatePost={() => setShowCreatePostModal(true)}
      >
        <div className="min-h-screen flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout
      userProfile={userInfo}
      onLogout={() => {
        localStorage.removeItem("token");
        localStorage.removeItem("web3_wallet_address");
        window.location.href = "/";
      }}
      loading={userLoading}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      {showCreatePostModal && userInfo && (
        <div className="h-full">
          <CreatePostModal
            onClose={() => setShowCreatePostModal(false)}
            userCountry={userInfo?.country || "EARTH"}
          />
        </div>
      )}

      {!showCreatePostModal && (
        <div>
          {/* Header and statistics */}
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5 pb-4 border-b border-slate-200 dark:border-white/[0.06]">
            <div>
              <h1 className="font-cinzel text-[19px] font-medium text-slate-900 dark:text-white/85 tracking-[0.04em] flex items-center gap-2">
                {t("violations_map") || "Human Rights Violations Map"}
              </h1>
            </div>

            {/* Statistics - compact style */}
            <div className="flex gap-4 flex-shrink-0">
              <div className="text-center">
                <div className="text-[19px] font-bold text-blue-400/80">
                  {stats.total}
                </div>
                <div className="text-[11px] text-slate-400 dark:text-white/40 uppercase tracking-wider">
                  {t("total_violations") || "Violations"}
                </div>
              </div>
              <div className="text-center">
                <div className="text-[19px] font-bold text-emerald-400/80">
                  {stats.countries}
                </div>
                <div className="text-[11px] text-slate-400 dark:text-white/40 uppercase tracking-wider">
                  {t("countries") || "Countries"}
                </div>
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="bg-white dark:bg-[#000d1f] border border-slate-200 dark:border-white/[0.07] rounded-xl p-3 mb-3">
            {/* Filters button for mobile */}
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="lg:hidden w-full flex items-center justify-between p-2 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.07] rounded-lg"
            >
              <div className="flex items-center gap-2">
                <Filter className="w-4 h-4 text-slate-400 dark:text-white/40" />
                <span className="font-medium text-[14px] text-slate-500 dark:text-white/40">
                  {t("filters") || "Filters"}
                </span>
              </div>
              <ChevronDown
                className={`w-4 h-4 text-slate-300 dark:text-white/40 transition-transform ${showFilters ? "rotate-180" : ""}`}
              />
            </button>

            {/* Filters panel */}
            <div
              className={`
                ${showFilters ? "block" : "hidden"}
                lg:block space-y-2
              `}
            >
              {/* Country, dates and actions on one line */}
              <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_auto] gap-2">
                {/* Country filter */}
                <div>
                  <select
                    value={countryFilter}
                    onChange={(e) => setCountryFilter(e.target.value)}
                    className="w-full h-[34px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-600 dark:text-white/45 font-['Inter'] outline-none focus:border-blue-400 dark:focus:border-blue-500/35 transition-all appearance-none"
                    style={{
                      backgroundImage: `url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22rgba(255%2C255%2C255%2C0.25)%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%2F%3E%3C%2Fsvg%3E')`,
                      backgroundPosition: "right 10px center",
                      backgroundRepeat: "no-repeat",
                      paddingRight: "30px",
                    }}
                  >
                    <option value="all" className="bg-white dark:bg-[#000d1f]">
                      {t("all_countries") || "All countries"}
                    </option>
                    {uniqueCountries.map((code) => (
                      <option
                        key={code}
                        value={code}
                        className="bg-white dark:bg-[#000d1f]"
                      >
                        {getTranslatedCountryName(code)} ({code})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Date filter */}
                <div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(e) => setDateFrom(e.target.value)}
                        max={new Date().toISOString().split("T")[0]}
                        className="w-full h-[34px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-500 dark:text-white/45 font-['Inter'] outline-none focus:border-blue-400 dark:focus:border-blue-500/35 transition-all [color-scheme:dark]"
                        placeholder={t("from_date") || "From"}
                      />
                    </div>
                    <div>
                      <input
                        type="date"
                        value={dateTo}
                        onChange={(e) => setDateTo(e.target.value)}
                        max={new Date().toISOString().split("T")[0]}
                        className="w-full h-[34px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-500 dark:text-white/45 font-['Inter'] outline-none focus:border-blue-400 dark:focus:border-blue-500/35 transition-all [color-scheme:dark]"
                        placeholder={t("to_date") || "To"}
                      />
                    </div>
                  </div>
                </div>

                {/* Reset filters */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={resetFilters}
                    className="h-[34px] px-3 bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.09] rounded-lg text-[14px] text-slate-500 dark:text-white/40 hover:text-slate-700 dark:hover:text-white/60 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-all flex-shrink-0 font-['Inter']"
                  >
                    {t("reset") || "Reset"}
                  </button>
                </div>
              </div>

              {/* Apply button */}
              <button
                onClick={() => setShowFilters(false)}
                className="lg:hidden w-full py-2 text-[16px] bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-[#e8a0b0]/80 dark:hover:bg-[#3d0012] rounded-lg transition-colors"
              >
                {t("apply_filters") || "Apply filters"}
              </button>
            </div>
          </div>

          {/* Map container */}
          {/* Pure-CSS rule for NATIVE fullscreen: the map's size is tied
              directly to the browser's actual state via the :fullscreen
              pseudo-class, rather than React state — so there can be no
              race condition/desync here. */}
          <style>{`
            .vm-map-wrapper:fullscreen {
              width: 100vw;
              height: 100vh;
            }
            .vm-map-wrapper:fullscreen .vm-map-canvas {
              height: 100vh !important;
            }
            /* Shrink the Leaflet attribution text on small screens
               so it doesn't overlap the bottom-left map controls. */
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
          <div
            ref={mapWrapperRef}
            className={`vm-map-wrapper bg-white dark:bg-[#000d1f] border border-slate-200 dark:border-white/[0.07] overflow-hidden mb-3 ${
              isCssFullscreenFallback
                ? "fixed inset-0 z-[9999] rounded-none border-0 mb-0"
                : isMapFullscreen
                  ? "rounded-none border-0 mb-0"
                  : "rounded-xl"
            }`}
          >
            <div className="relative h-full">
              {error && (
                <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
                  <div className="text-center p-4 bg-slate-50 dark:bg-[#0a0f1a] border border-red-200 dark:border-red-800/30 rounded-xl">
                    <AlertCircle className="w-8 h-8 text-red-400 dark:text-red-400/50 mx-auto mb-2" />
                    <p className="text-[16px] text-red-500 dark:text-red-400/70 mb-3">
                      {error}
                    </p>
                    <button
                      onClick={loadViolations}
                      className="px-3 py-1.5 text-[16px] bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/70 dark:hover:bg-[#3d0012] rounded-lg transition-colors"
                    >
                      {t("try_again") || "Try again"}
                    </button>
                  </div>
                </div>
              )}

              {loading && (
                <div className="absolute inset-0 z-40 bg-white/80 dark:bg-[#000d1f]/80 flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-8 h-8 border-2 border-blue-600/30 border-t-blue-400 rounded-full animate-spin mx-auto" />
                    <p className="mt-2 text-[14px] text-slate-400 dark:text-white/40">
                      {t("loading_map") || "Loading map..."}
                    </p>
                  </div>
                </div>
              )}

              <div
                ref={mapContainerRef}
                className={`vm-map-canvas w-full z-10 ${isCssFullscreenFallback ? "h-screen" : "h-[500px]"}`}
              />

              {/* Fullscreen toggle */}
              <button
                onClick={toggleMapFullscreen}
                className="absolute top-2 left-2 z-20 w-8 h-8 flex items-center justify-center bg-white/90 dark:bg-[#000d1f]/90 border border-slate-200 dark:border-white/[0.1] rounded-lg text-slate-500 dark:text-white/50 hover:text-slate-700 dark:hover:text-white/80 hover:bg-white dark:hover:bg-[#000d1f] transition-colors"
                title={
                  isMapFullscreen
                    ? t("exit_fullscreen") || "Exit fullscreen"
                    : t("fullscreen") || "Fullscreen"
                }
              >
                {isMapFullscreen ? (
                  <Minimize2 className="w-4 h-4" />
                ) : (
                  <Maximize2 className="w-4 h-4" />
                )}
              </button>

              {/* H3 Grid controls */}
              <div className="absolute top-2 right-2 z-20 bg-white/90 dark:bg-[#000d1f]/90 border border-slate-200 dark:border-white/[0.1] rounded-lg px-3 py-1.5 flex flex-col items-stretch gap-1.5">
                <label className="flex items-center gap-2 cursor-pointer justify-between">
                  <span className="text-[14px] font-medium text-slate-400 dark:text-white/40 uppercase tracking-wider">
                    H3 Grid
                  </span>
                  <div
                    onClick={() => setShowH3Grid(!showH3Grid)}
                    className={`relative w-8 h-5 rounded-full transition-colors ${
                      showH3Grid
                        ? "bg-blue-600 dark:bg-[#1a3f7a]"
                        : "bg-slate-300 dark:bg-white/[0.08]"
                    }`}
                  >
                    <span
                      className={`absolute top-[2px] left-[2px] w-[16px] h-[16px] bg-white rounded-full shadow transition-transform ${
                        showH3Grid ? "translate-x-[12px]" : "translate-x-0"
                      }`}
                    />
                  </div>
                </label>

                {/* ADDED: switch for hexagon levels 3/2/1/0, like on the
                    country map. Visible only when the grid is enabled. */}
                {showH3Grid && (
                  <div className="flex items-center gap-1 justify-center pt-0.5 border-t border-slate-200 dark:border-white/[0.06]">
                    {HEX_LEVELS.map((level) => (
                      <button
                        key={level}
                        type="button"
                        onClick={() => setHexLevel(level)}
                        title={`${tf("hex_level", "Level")} ${level}`}
                        className={`w-6 h-6 flex items-center justify-center rounded-md text-[11px] font-semibold border transition-colors ${
                          hexLevel === level
                            ? "bg-blue-600 border-blue-600 text-white dark:bg-[#1a3f7a] dark:border-[#1a3f7a]"
                            : "bg-white dark:bg-transparent border-slate-300 dark:border-white/[0.1] text-slate-600 dark:text-white/40 hover:border-blue-400 dark:hover:border-blue-400/40"
                        }`}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
};

export default ViolationsMap;
