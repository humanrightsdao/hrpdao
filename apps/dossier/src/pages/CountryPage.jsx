// src/pages/CountryPage.jsx
import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Globe,
  TrendingUp,
  Shield,
  MessageSquare,
  Scale,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Map,
  Users,
} from "lucide-react";
import Layout from "../components/Layout";
import { useCountry } from "../hooks/useCountry";
import CountryFeed from "../components/CountryFeed";
import useUserInfo from "../hooks/useUserInfo";
import { useUserStats } from "../hooks/useUserStats";
import CreatePostModal from "../components/CreatePostModal";
import useCountryRatings from "../hooks/useCountryRatings";
import useLensViolations from "../hooks/useLensViolations";
import { getSeverityInfo, VIOLATION_CATEGORIES } from "../config/violationTypes";
// ADDED: the violations map on the country page never checked
// sanctions/bans either — the same gap as in ViolationsMap.jsx.
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";

import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { countryViewConfigs, worldView } from "../utils/mapConfig";

import {
  getViewportH3Cells,
  h3CellsToLeafletPolygons,
  groupViolationsByH3,
  getH3CellStyle,
  getH3Parent,
  getH3ChildrenAtResolution,
  GRID_RESOLUTION,
  HEX_LEVELS,
  LEVEL_RESOLUTIONS,
} from "../utils/h3Utils";

// ── Hexagon grid levels ──────────────────────────────────────
// "Level 3" is the same level of detail as before (GRID_RESOLUTION
// from h3Utils.js). Levels 2/1/0 are coarser (bigger) hexagons, each next
// one being 1 lower in H3 resolution. If GRID_RESOLUTION ever changes in
// h3Utils.js, this map adapts automatically.
// ── Hexagon grid levels ──────────────────────────────────────
// HEX_LEVELS/LEVEL_RESOLUTIONS are now centralized in utils/h3Utils.js
// (shared with ViolationsMap.jsx, so as not to keep two copies of the mapping).
//
// POSTS on Lens are tied to an H3 cell at GRID_RESOLUTION level (level 3)
// via a tag (metadata.tags). So for coarser levels (2/1/0), the selected
// hexagon is converted into a list of its child cells at level 3
// (getH3ChildrenAtResolution), and the feed is queried by them.
// CHANGED: previously this required a separate request for EACH child
// cell (up to 343 requests for level 0). Now getLensCountryPosts accepts
// the entire array of cells at once — the Lens tags.oneOf filter itself
// does an OR-match across multiple tags in a SINGLE request
// (useLensPosts.js), with normal cursor pagination. MAX_HEX_FEED_CELLS
// remains only as a safety ceiling in case Lens ever limits the array
// size in oneOf (343 is the theoretical max fan-out from level 0, plus margin).
//
// Longer term, an even better approach: when creating a post, add a tag
// for EVERY level (h3_res0/1/2/3, computed once via getH3Parent), rather
// than just for level 3 — then the filter at any level becomes a single
// precise tags.oneOf with ONE value, as it currently is at level 3,
// without needing an array of hundreds of tags. This requires changing
// createLensPost (and probably CreatePostModal.jsx) — I can prepare this
// separately if needed.
const MAX_HEX_FEED_CELLS = 400;
// ──────────────────────────────────────────────────────────────────

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png",
});

export default function CountryPage() {
  const { t, i18n } = useTranslation();
  // ADDED: i18next returns the KEY ITSELF for missing keys (e.g. "hex_level"),
  // rather than an empty string/undefined — so the usual pattern
  // `t("key") || "fallback"` doesn't work (t() returns the truthy
  // "hex_level", and the fallback is never shown — exactly what was seen
  // in the screenshot: "(hex_level 0)"). tf() explicitly checks whether
  // the translation matches the key, and in that case uses the fallback.
  const tf = (key, fallback) => {
    const val = t(key);
    return val && val !== key ? val : fallback;
  };
  // ADDED: in the map popup we show the TYPE of violation (category → type),
  // rather than the description/title (violation.title).
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
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedCountry, setSelectedCountry] = useState("");
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);
  const [showRatings, setShowRatings] = useState(false);
  const [isMapCollapsed, setIsMapCollapsed] = useState(false);
  const navigate = useNavigate();
  const {
    userInfo,
    loading: userInfoLoading,
    error: userInfoError,
  } = useUserInfo();

  // FIXED: previously this also separately called
  // useLensProfile(lensWalletAddress), even though useUserInfo() ALREADY
  // makes the same request to Lens (fetchLensAccountData) internally. Two
  // identical GraphQL requests firing simultaneously while this page
  // mounted (plus a bunch of other requests alongside) overloaded the
  // testnet endpoint — the call inside useUserInfo specifically kept
  // falling into a retry loop and got exhausted, which left
  // userInfo/avatarUrl as null and the avatar in the Navbar (which also
  // pulls data from useUserInfo()) failed to appear specifically on this
  // page. userInfo already contains all the same data: userInfo.country
  // and userInfo.h3Cell.
  const lensWalletAddress = localStorage.getItem("lens_wallet_address");
  // useMemo with stable primitive dependencies — so that the
  // useEffect(..., [lensProfile]) below doesn't catch a new object (and,
  // as a result, an infinite effect loop) on every render.
  const lensProfile = useMemo(
    () =>
      userInfo ? { country: userInfo.country, h3Index: userInfo.h3Cell } : null,
    [userInfo?.country, userInfo?.h3Cell],
  );
  const lensProfileLoading = userInfoLoading;
  const lensProfileError = userInfoError;

  useEffect(() => {
    if (!userInfo) return;
    if (userInfo.authMethod === "lens" && !userInfo.hasAcceptedTerms) {
      navigate("/create-lens-account");
    }
  }, [userInfo]);

  const {
    getAllCountries,
    detectLocation,
    getTranslatedCountryName,
    loading: countryLoading,
    error: countryError,
    detectionStatus,
    resetDetection,
  } = useCountry(i18n.language);

  const {
    ratingsData,
    loading: ratingsLoading,
    error: ratingsError,
    getAverageRatings,
    resetRatings,
  } = useCountryRatings();

  const { fetchViolations } = useLensViolations();

  // Global user count — shown in the "Global view" indicator below when
  // "Planet Earth" is selected (manually or via auto-detect fallback).
  // Loaded once on mount, same as it used to be in Navbar.jsx.
  const {
    totalUsers,
    isApproximate,
    loading: statsLoading,
    loadStats,
  } = useUserStats();
  useEffect(() => {
    loadStats();
  }, []);
  const getStatsTooltip = () => {
    if (statsLoading) return t("loading_stats") || "Loading...";
    return `${totalUsers ?? 0}${isApproximate ? "+" : ""} ${t("total_users") || "users"}`;
  };

  const [violations, setViolations] = useState([]);
  const [filteredViolations, setFilteredViolations] = useState([]);
  const [mapLoading, setMapLoading] = useState(true);
  const [mapError, setMapError] = useState("");

  const mapRef = useRef(null);
  const mapContainerRef = useRef(null);
  const markersRef = useRef([]);
  const mapCounterRef = useRef(null);
  const geoButtonRef = useRef(null);
  // Always holds the latest handleAutoDetectCountry, so the plain-DOM
  // Leaflet control (added once in initMap, outside React's render
  // cycle) never calls a stale closure.
  const handleAutoDetectCountryRef = useRef(() => {});
  const h3LayerRef = useRef(null);

  // ADDED: the single point for destroying the Leaflet map. IMPORTANT to
  // call this BEFORE React removes the map's DOM container (collapsing
  // the map via the "collapse" button, unmounting the component) —
  // otherwise any "in-flight" Leaflet animation (fitBounds/setView, which
  // runs via an internal requestAnimationFrame) tries to read
  // _leaflet_pos from an already-removed DOM node on the next frame and crashes with
  // "Cannot read properties of undefined (reading '_leaflet_pos')".
  // mapRef.current.remove() correctly cancels Leaflet's internal
  // animations/timers, so calling it SYNCHRONOUSLY before the state
  // setter that hides the container fully eliminates this race.
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

  const [showH3Grid, setShowH3Grid] = useState(false);
  const [selectedH3Cell, setSelectedH3Cell] = useState(null);
  const [userH3Cell, setUserH3Cell] = useState(null);
  // ADDED: the selected hexagon level (3 — the former default behavior,
  // 2/1/0 — new, coarser levels). h3Resolution is now a derived value.
  const [hexLevel, setHexLevel] = useState(3);
  const h3Resolution = LEVEL_RESOLUTIONS[hexLevel];

  // ADDED: userH3Cell always comes from the blockchain at level 3
  // (GRID_RESOLUTION). For levels 2/1/0, we convert it into the parent
  // cell at the corresponding resolution, so that the "your location"
  // highlight works at any selected level.
  const userH3CellForLevel = useMemo(() => {
    if (!userH3Cell) return null;
    if (h3Resolution === GRID_RESOLUTION) return userH3Cell;
    return getH3Parent(userH3Cell, h3Resolution);
  }, [userH3Cell, h3Resolution]);

  // ADDED: the level GRID_RESOLUTION (3) cells that actually filter the
  // post feed on the backend. At level 3 this is the selected hexagon
  // itself. At coarser levels (2/1/0) — all of its child cells at level
  // 3. If there are too many of them (see MAX_HEX_FEED_CELLS), feed
  // filtering is turned off — null, and CountryFeed shows the regular
  // (not hexagon-filtered) feed, while leaving the grid on the map active.
  const h3FeedCells = useMemo(() => {
    if (!selectedH3Cell) return null;
    if (h3Resolution === GRID_RESOLUTION) return [selectedH3Cell];
    const children = getH3ChildrenAtResolution(selectedH3Cell, GRID_RESOLUTION);
    if (!children.length || children.length > MAX_HEX_FEED_CELLS) return null;
    return children;
  }, [selectedH3Cell, h3Resolution]);

  // ADDED: apply the country from the blockchain once, so as not to
  // override the user's subsequent manual selection in the <select> if
  // lensProfile/refetch fires again later.
  const countryInitializedRef = useRef(false);
  // FIXED: previously countryInitializedRef was set to true once for
  // the component's entire life-cycle and never reset. If after a
  // logout/login with a different wallet CountryPage does NOT unmount
  // (SPA navigation stays on the same route), the ref kept being "true"
  // from the previous user's session — so setSelectedCountry below simply
  // wasn't called, and the previous user's country stayed on screen until
  // the next full page reload (which recreated useRef(false) from
  // scratch). We tie "initial-ness" to a specific wallet: as soon as
  // lensWalletAddress changes — we reset the flag, so the effect below
  // picks up the new user's country again.
  const initializedForWalletRef = useRef(null);
  useEffect(() => {
    if (initializedForWalletRef.current !== lensWalletAddress) {
      initializedForWalletRef.current = lensWalletAddress;
      countryInitializedRef.current = false;
    }
  }, [lensWalletAddress]);

  // FIXED: previously country was NEVER taken from userInfo/blockchain —
  // only h3Cell had that effect. Now both values (country, h3Index) come
  // from lensProfile (blockchain).
  useEffect(() => {
    if (!lensProfile) return;

    // userInfo (from useUserInfo) already contains the full profile —
    // with avatarUrl, name, bio, etc., unlike lensProfile (now just
    // {country, h3Index}).
    setUserProfile(userInfo);

    if (lensProfile.h3Index) {
      setUserH3Cell(lensProfile.h3Index);
    }

    if (!countryInitializedRef.current) {
      countryInitializedRef.current = true;
      // "EARTH" can now be a deliberate user record (the default when
      // onboarding is skipped, or an explicit choice of "Planet Earth"),
      // not just the hook's fallback for "no attribute" — both cases are
      // indistinguishable and both mean the same thing: the user decided
      // it that way. So we trust the blockchain record as final and do
      // NOT override it with geolocation. Geo-detection remains available
      // only as a manual action (the pin button below) or a step of
      // onboarding itself.
      setSelectedCountry(lensProfile.country || "EARTH");
    }
  }, [lensProfile]);

  // If there's no wallet in localStorage — there's nothing to load onto
  // the page, redirect to home (previously loadUserProfile did this).
  useEffect(() => {
    if (!lensWalletAddress) {
      navigate("/");
    }
  }, [lensWalletAddress, navigate]);

  // Keep the loading/error page states synchronized with the status of
  // loading the profile from the blockchain.
  useEffect(() => {
    setLoading(lensProfileLoading);
    if (lensProfileError) setError(lensProfileError);
  }, [lensProfileLoading, lensProfileError]);

  useEffect(() => {
    if (selectedCountry && selectedCountry !== "EARTH") {
      getAverageRatings(selectedCountry);
    } else {
      resetRatings();
    }
  }, [selectedCountry]);

  const loadViolations = useCallback(async () => {
    setMapLoading(true);
    setMapError("");
    try {
      const result = await fetchViolations({});
      if (!result.success) throw new Error(result.error);

      // ADDED: posts hidden by a moderator, and posts from a banned
      // author, should not appear on the map.
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
    } catch (err) {
      console.error("Error loading violations:", err);
      setMapError(
        err.message || t("load_violations_error") || "Error loading violations",
      );
    } finally {
      setMapLoading(false);
    }
  }, [t, fetchViolations]);

  const initMap = useCallback(() => {
    if (!mapContainerRef.current) return;
    if (mapRef.current) {
      destroyMapInstance();
    }

    let initialView = worldView;
    if (
      selectedCountry &&
      selectedCountry !== "EARTH" &&
      selectedCountry !== ""
    ) {
      const countryConfig = countryViewConfigs[selectedCountry];
      if (countryConfig) {
        initialView = countryConfig;
      }
    } else if (lensProfile?.country && lensProfile.country !== "EARTH") {
      const userCountryConfig = countryViewConfigs[lensProfile.country];
      if (userCountryConfig) initialView = userCountryConfig;
    }

    mapRef.current = L.map(mapContainerRef.current, {
      center: initialView.center,
      zoom: initialView.zoom,
      zoomControl: false,
      scrollWheelZoom: true,
      dragging: true,
      minZoom: 0,
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

    L.control.zoom({ position: "bottomright" }).addTo(mapRef.current);

    const southWest = L.latLng(-90, -180);
    const northEast = L.latLng(90, 180);
    const bounds = L.latLngBounds(southWest, northEast);
    mapRef.current.setMaxBounds(bounds);
    mapRef.current.on("drag", function () {
      mapRef.current.panInsideBounds(bounds, { animate: false });
    });

    const CounterControl = L.Control.extend({
      onAdd: function () {
        const container = L.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control leaflet-control-custom",
        );
        container.style.backgroundColor = "white";
        container.style.padding = "6px 10px";
        container.style.borderRadius = "4px";
        container.style.boxShadow = "0 1px 5px rgba(0,0,0,0.4)";
        container.style.cursor = "pointer";
        container.style.fontSize = "12px";
        container.style.fontWeight = "500";
        container.style.display = "flex";
        container.style.alignItems = "center";
        container.style.gap = "4px";

        const counterText = `${filteredViolations.length} ${t("violations_on_map") || "violations on map"}`;
        container.innerHTML = `<span style="font-size:14px;">${counterText}</span><svg style="width:12px;height:12px;color:#3b82f6;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>`;
        container.onclick = () => {
          navigate("/violations-map");
        };
        container.onmouseenter = () => {
          container.style.backgroundColor = "#f3f4f6";
        };
        container.onmouseleave = () => {
          container.style.backgroundColor = "white";
        };
        mapCounterRef.current = container;
        return container;
      },
    });

    // Duplicate of the "Geo button" next to the country select above —
    // same handler (handleAutoDetectCountry), just also reachable
    // directly on the map itself. The icon/spinner swap on click is
    // done imperatively via geoButtonRef in the countryLoading effect
    // below, since this is a plain Leaflet DOM control, not React.
    const geoIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;

    const GeoControl = L.Control.extend({
      onAdd: function () {
        const container = L.DomUtil.create(
          "div",
          "leaflet-bar leaflet-control leaflet-control-geo",
        );
        container.style.backgroundColor = "white";
        container.style.padding = "0";
        container.style.borderRadius = "50%";
        container.style.boxShadow = "0 1px 5px rgba(0,0,0,0.4)";
        container.style.cursor = "pointer";
        container.style.width = "36px";
        container.style.height = "36px";
        container.style.display = "flex";
        container.style.alignItems = "center";
        container.style.justifyContent = "center";
        container.style.margin = "10px";

        const button = L.DomUtil.create(
          "button",
          "map-geo-button",
          container,
        );
        button.innerHTML = geoIconSvg;
        button.style.background = "none";
        button.style.border = "none";
        button.style.padding = "0";
        button.style.color = "#2563eb";
        button.style.display = "flex";
        button.style.alignItems = "center";
        button.style.justifyContent = "center";
        button.style.width = "100%";
        button.style.height = "100%";
        button.title = t("detect_location") || "Detect location";
        button.onclick = (e) => {
          e.stopPropagation();
          handleAutoDetectCountryRef.current();
        };
        button.onmouseenter = () => {
          container.style.backgroundColor = "#eff6ff";
        };
        button.onmouseleave = () => {
          container.style.backgroundColor = "white";
        };
        geoButtonRef.current = button;
        return container;
      },
    });

    new CounterControl({ position: "bottomleft" }).addTo(mapRef.current);
    new GeoControl({ position: "topleft" }).addTo(mapRef.current);
    if (showH3Grid) {
      setTimeout(() => renderH3GridRef.current(), 50);
    }
  }, [selectedCountry, lensProfile, filteredViolations.length, t, navigate]);

  const updateMapMarkers = useCallback(() => {
    if (!mapRef.current || !violations.length) return;
    markersRef.current.forEach((marker) => marker.remove());
    markersRef.current = [];

    // ADDED: a hybrid approach to displaying violations on the map.
    // Previously the map drew ONLY the selected country's violations
    // (filteredViolations) — when the user zoomed out to see a wider
    // context, neighboring countries looked "empty", even though data for
    // them actually exists. Now we always draw ALL loaded violations
    // (violations), but violations outside the selected country are
    // muted (smaller, semi-transparent, no "View details" button in the
    // popup), so the focus on the selected country remains clear. The
    // zoom and map counter (below) deliberately still count only
    // filteredViolations — this doesn't interfere with the new context layer.
    const isCountryFocused =
      selectedCountry && selectedCountry !== "EARTH" && selectedCountry !== "";

    violations.forEach((violation) => {
      if (!violation.latitude || !violation.longitude) return;
      const markerColor = getSeverityInfo(violation.severity_level).color;
      const isInFocusCountry =
        !isCountryFocused || violation.country_code === selectedCountry;

      const icon = isInFocusCountry
        ? L.divIcon({
            html: `<div class="relative group"><div class="w-6 h-6 flex items-center justify-center cursor-pointer hover:scale-110 transition-transform"><svg class="w-6 h-6" viewBox="0 0 24 24" fill="${markerColor}"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg></div></div>`,
            className: "violation-marker",
            iconSize: [24, 24],
            iconAnchor: [12, 24],
          })
        : // A muted marker for countries outside the focus: smaller,
          // semi-transparent, no hover animation — so it doesn't visually
          // compete with the selected country's markers, but remains
          // visible for context.
          L.divIcon({
            html: `<div class="w-4 h-4 flex items-center justify-center cursor-pointer opacity-45 hover:opacity-80 transition-opacity"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="${markerColor}"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg></div>`,
            className: "violation-marker violation-marker-context",
            iconSize: [16, 16],
            iconAnchor: [8, 16],
          });

      // CHANGED: "inactive" (context, outside the selected country)
      // markers now get the SAME full popup (title, date, country, "View
      // details" button) as active ones — previously they had a
      // simplified version without the date and button. The difference
      // between active and context markers now remains only in the
      // marker's appearance (smaller, dimmer) above, not in the popup's
      // contents.
      // The button is now red (light theme) / maroon (dark theme) instead
      // of blue.
      const popupContent = `<div class="p-2 min-w-[160px]"><h3 class="font-bold text-gray-700 dark:text-white/80 text-[13px] mb-0.5 truncate">${getViolationTypeLabel(violation)}</h3><div class="text-[11px] text-gray-500 dark:text-white/40 space-y-0.5">${violation.violation_date ? `<div><strong>${t("date") || "Date"}:</strong> ${new Date(violation.violation_date).toLocaleDateString()}</div>` : ""}<div><strong>${t("country") || "Country"}:</strong> ${getTranslatedCountryName(violation.country_code)}</div></div><button onclick="window.dispatchEvent(new CustomEvent('viewViolationDetails', { detail: '${violation.id}' }))" class="mt-1.5 w-full py-1 rounded transition-colors text-[11px] bg-[#8B1A2A] hover:bg-[#8B1A2A] text-white dark:bg-[#2B000A] dark:hover:bg-[#3a0010] dark:text-[#e8a0b0] dark:border dark:border-[#8B1A2A]/40">${t("view_details") || "View details"}</button></div>`;

      const marker = L.marker(
        [parseFloat(violation.latitude), parseFloat(violation.longitude)],
        { icon },
      ).addTo(mapRef.current);
      marker.bindPopup(popupContent);
      markersRef.current.push(marker);
    });

    if (filteredViolations.length > 0) {
      const bounds = L.latLngBounds(
        filteredViolations.map((v) => [
          parseFloat(v.latitude),
          parseFloat(v.longitude),
        ]),
      );
      // SAFEGUARD: if the map ends up in a transitional/stale state
      // (e.g. during HMR in dev mode), don't let a Leaflet animation crash
      // the entire render — just quietly skip this frame instead of crashing.
      try {
        if (filteredViolations.length === 1) {
          const v = filteredViolations[0];
          mapRef.current.setView(
            [parseFloat(v.latitude), parseFloat(v.longitude)],
            12,
          );
        } else {
          mapRef.current.fitBounds(bounds, { maxZoom: 10, minZoom: 2 });
        }
      } catch (err) {
        console.error("Error adjusting map view:", err);
      }
    }

    if (mapCounterRef.current) {
      const counterText = `${filteredViolations.length} ${t("violations_on_map") || "violations on map"}`;
      mapCounterRef.current.querySelector("span").textContent = counterText;
    }
  }, [
    filteredViolations,
    violations,
    selectedCountry,
    t,
    getTranslatedCountryName,
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
    const layerGroup = L.layerGroup();

    polygons.forEach(({ index, latLngs, count, severities }) => {
      const isUserCell = index === userH3CellForLevel;
      const isSelectedCell = index === selectedH3Cell;
      // CHANGED: the grid is no longer colored by the count/severity of
      // violations in a cell (isEmpty forced true) — violations are
      // already visible as separate markers on the map, colored hexagons
      // duplicated this information. The highlight of the selected
      // hexagon and "your location" below remains unchanged.
      let style = getH3CellStyle(0, severities, true);

      if (isUserCell)
        style = {
          ...style,
          color: "#6366f1",
          weight: 3,
          fillColor: "#6366f1",
          fillOpacity: 0.35,
          dashArray: null,
        };
      if (isSelectedCell)
        style = {
          ...style,
          color: "#f59e0b",
          weight: 3,
          fillColor: "#fbbf24",
          fillOpacity: 0.5,
        };

      const polygon = L.polygon(latLngs, { ...style, interactive: true });

      if (count > 0) {
        const severityLabels = [];
        if (severities.felony > 0)
          severityLabels.push(`🔴 Felony: ${severities.felony}`);
        if (severities.misdemeanor > 0)
          severityLabels.push(`🟠 Misdemeanor: ${severities.misdemeanor}`);
        if (severities.infraction > 0)
          severityLabels.push(`🟡 Infraction: ${severities.infraction}`);
        polygon.bindPopup(
          `<div class="p-2 min-w-[150px]"><div class="font-bold text-gray-700 text-[13px] mb-0.5">Violations in area: ${count}</div><div class="text-[11px] text-gray-500 space-y-0.5">${severityLabels.map((l) => `<div>${l}</div>`).join("")}</div>${isUserCell ? `<div class="mt-1 text-[10px] text-indigo-600 font-semibold">📍 Your location</div>` : ""}<div class="mt-1 text-[10px] text-gray-400 truncate">H3: ${index}</div></div>`,
        );
      }

      polygon.on("mouseover", () => {
        if (!isSelectedCell)
          polygon.setStyle({
            fillOpacity: Math.min(style.fillOpacity + 0.2, 1),
          });
      });
      polygon.on("mouseout", () => {
        polygon.setStyle({ fillOpacity: style.fillOpacity });
      });
      polygon.on("click", () => {
        setSelectedH3Cell((prev) => (prev === index ? null : index));
      });
      layerGroup.addLayer(polygon);
    });

    layerGroup.addTo(mapRef.current);
    h3LayerRef.current = layerGroup;
  }, [
    mapRef,
    showH3Grid,
    h3Resolution,
    filteredViolations,
    userH3CellForLevel,
    selectedH3Cell,
  ]);

  const renderH3GridRef = useRef(renderH3Grid);
  useEffect(() => {
    renderH3GridRef.current = renderH3Grid;
  }, [renderH3Grid]);

  useEffect(() => {
    if (!mapRef.current) return;
    renderH3Grid();
    const onMoveEnd = () => renderH3GridRef.current();
    mapRef.current.on("moveend", onMoveEnd);
    mapRef.current.on("zoomend", onMoveEnd);
    return () => {
      if (mapRef.current) {
        mapRef.current.off("moveend", onMoveEnd);
        mapRef.current.off("zoomend", onMoveEnd);
      }
    };
  }, [showH3Grid, filteredViolations, renderH3Grid]);

  const filterViolationsByCountry = useCallback(() => {
    if (!selectedCountry || selectedCountry === "EARTH") {
      setFilteredViolations(violations);
      return;
    }
    setFilteredViolations(
      violations.filter((v) => v.country_code === selectedCountry),
    );
  }, [selectedCountry, violations]);

  const handleAutoDetectCountry = async () => {
    try {
      resetDetection();
      const detected = await detectLocation();
      if (detected && detected.code) setSelectedCountry(detected.code);
    } catch (error) {
      console.error("Country detection error:", error);
      if (!selectedCountry) setSelectedCountry("EARTH");
    }
  };
  handleAutoDetectCountryRef.current = handleAutoDetectCountry;

  const handleCountryChange = async (e) => {
    setSelectedCountry(e.target.value);
  };

  const handleLogout = async () => {
    try {
      localStorage.removeItem("lens_wallet_address");
      localStorage.removeItem("lens_account_address");
      navigate("/");
    } catch (error) {
      console.error(t("logout_error"), error);
      alert(t("logout_failed"));
    }
  };

  const toggleMapCollapse = () => {
    if (!isMapCollapsed) {
      // Collapsing — destroy the map BEFORE React removes its container
      // from the DOM (see the comment on destroyMapInstance).
      destroyMapInstance();
    }
    setIsMapCollapsed((prev) => !prev);
  };

  // Keep the on-map geo-detect button (plain Leaflet DOM control) in
  // sync with countryLoading — same disabled+spinner behavior as the
  // "Geo button" next to the country select.
  useEffect(() => {
    const button = geoButtonRef.current;
    if (!button) return;
    const geoIconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"></path><circle cx="12" cy="10" r="3"></circle></svg>`;
    const geoSpinnerSvg = `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;border:2px solid #93c5fd;border-top-color:#2563eb;animation:map-geo-spin 0.8s linear infinite;"></span>`;
    button.innerHTML = countryLoading ? geoSpinnerSvg : geoIconSvg;
    button.disabled = countryLoading;
    button.style.cursor = countryLoading ? "not-allowed" : "pointer";
    button.style.opacity = countryLoading ? "0.6" : "1";
  }, [countryLoading, isMapCollapsed]);

  useEffect(() => {
    loadViolations();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!mapLoading && !mapError && !isMapCollapsed) initMap();
  }, [mapLoading, mapError, selectedCountry, initMap, isMapCollapsed]);
  useEffect(() => {
    if (mapRef.current && filteredViolations.length >= 0 && !isMapCollapsed)
      updateMapMarkers();
  }, [filteredViolations, updateMapMarkers, isMapCollapsed]);
  useEffect(() => {
    if (violations.length > 0) filterViolationsByCountry();
  }, [selectedCountry, violations, filterViolationsByCountry]);

  // FIXED: changing the country in the selector (manually, via the geo
  // button, or the initial value from the blockchain) didn't reset the
  // active hexagon filter. selectedH3Cell remained set, and CountryFeed
  // (filterByH3={!!selectedH3Cell}) kept filtering the feed by the old
  // hexagon instead of the new country.
  useEffect(() => {
    setSelectedH3Cell(null);
  }, [selectedCountry]);

  // ADDED: H3 cell indices differ at each resolution level, so when
  // switching levels the previously selected hexagon loses meaning — we
  // reset the feed's hexagon filter.
  useEffect(() => {
    setSelectedH3Cell(null);
  }, [hexLevel]);

  useEffect(() => {
    const handleViewDetails = (event) => {
      navigate(`/violations/${event.detail}`);
    };
    window.addEventListener("viewViolationDetails", handleViewDetails);
    return () =>
      window.removeEventListener("viewViolationDetails", handleViewDetails);
  }, [navigate]);

  useEffect(() => {
    return () => {
      destroyMapInstance();
    };
  }, []);

  const countryOptions = getAllCountries();

  // FIXED: previously getDefaultCountryName() FOUND the actually
  // selected country in countryOptions and returned ITS name for the
  // value="" option — meaning that as soon as a country was selected, TWO
  // items with the same text appeared in the list: the real one (with the
  // actual country code/"EARTH") and this "empty" one (value=""). If the
  // user happened to click the duplicate, handleCountryChange would set
  // selectedCountry = "" (neither a country code nor "EARTH") — a state
  // that some code-based filters didn't expect, which broke correct
  // filtering of the feed/counters after a repeated selection. Now the
  // label is static and doesn't depend on the selection.
  const getDefaultCountryName = () =>
    t("user_country_default") || "User country";

  const shouldFilterByCountry =
    selectedCountry && selectedCountry !== "EARTH" && selectedCountry !== "";

  const getAverageRatingValue = () => {
    if (!ratingsData || !ratingsData.averageRatings || ratingsLoading) return 0;
    const { averageRatings } = ratingsData;
    const values = [
      averageRatings.human_rights || 0,
      averageRatings.economic_freedom || 0,
      averageRatings.political_freedom || 0,
      averageRatings.freedom_of_speech || 0,
    ];
    return values.reduce((acc, val) => acc + val, 0) / values.length;
  };

  // ── Adaptive theme helpers ──────────────────────────────────────
  const cardBg = "bg-white dark:bg-[#000d1f]";
  const cardBorder = "border border-slate-300 dark:border-white/[0.07]";
  const subText = "text-slate-600 dark:text-white/30";
  const bodyText = "text-slate-600 dark:text-white/40";
  const inlineBg =
    "bg-slate-100 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.06]";
  // ────────────────────────────────────────────────────────────────

  const AverageRatingsDisplay = () => {
    if (!selectedCountry || selectedCountry === "EARTH") return null;

    if (ratingsLoading) {
      return (
        <div className={`${cardBg} ${cardBorder} rounded-xl p-4 mb-2`}>
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3 mb-3 last:mb-0">
              <div className="w-6 h-6 rounded-lg bg-slate-100 dark:bg-white/[0.03] animate-pulse" />
              <div className="h-2 bg-slate-100 dark:bg-white/[0.05] rounded flex-1 animate-pulse" />
              <div className="w-24 h-[3px] bg-slate-100 dark:bg-white/[0.04] rounded animate-pulse" />
            </div>
          ))}
        </div>
      );
    }

    if (ratingsError) {
      return (
        <div className="bg-red-50 dark:bg-[#1a0505] border border-red-200 dark:border-red-800/30 rounded-xl p-4 mb-2">
          <p className="text-[12px] text-red-600 dark:text-red-400/70 mb-2">
            ⚠️ {t("ratings_load_error") || "Error loading ratings"}
          </p>
          <button
            onClick={() => getAverageRatings(selectedCountry)}
            className="text-[11px] px-3 py-1.5 bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/70 dark:hover:bg-[#3d0012] rounded-lg transition-colors"
          >
            {t("retry") || "Try again"}
          </button>
        </div>
      );
    }

    if (!ratingsData || !ratingsData.averageRatings) {
      return (
        <div className={`${cardBg} ${cardBorder} rounded-xl p-6 mb-2`}>
          <div className="flex flex-col items-center text-center">
            <p className="text-[15px] font-medium text-slate-600 dark:text-white/60 mb-1">
              {t("country_ratings") || "Country ratings"}
            </p>
            <p className={`text-[13px] ${subText} mb-4`}>
              {getTranslatedCountryName(selectedCountry) || selectedCountry}
            </p>
            <div className="w-12 h-[2px] bg-slate-200 dark:bg-white/[0.06] rounded-full mb-4" />
            <p className={`text-[14px] ${subText} opacity-80 mb-5`}>
              {t("no_ratings_available") ||
                "There are no ratings for this country yet"}
            </p>
            <button
              onClick={() => navigate("/profile")}
              className="px-5 py-2.5 text-[13px] bg-blue-50 dark:bg-[#001a38] border border-blue-300 dark:border-blue-500/20 text-blue-600 dark:text-blue-400/70 rounded-xl hover:bg-blue-100 dark:hover:bg-[#002050] hover:border-blue-400 dark:hover:border-blue-500/40 transition-all duration-200 inline-flex items-center gap-2"
            >
              {t("go_to_profile_to_rate") || "Go to your profile to rate"}
            </button>
          </div>
        </div>
      );
    }

    const { averageRatings, totalRatings } = ratingsData;
    const ratingCategories = [
      {
        type: "human_rights",
        title: t("human_rights_level") || "Human rights compliance level",
        icon: Shield,
        value: averageRatings.human_rights || 0,
      },
      {
        type: "economic_freedom",
        title: t("economic_freedom_level") || "Economic freedom level",
        icon: TrendingUp,
        value: averageRatings.economic_freedom || 0,
      },
      {
        type: "political_freedom",
        title: t("political_freedom_level") || "Political freedom level",
        icon: Scale,
        value: averageRatings.political_freedom || 0,
      },
      {
        type: "freedom_of_speech",
        title: t("freedom_of_speech_level") || "Freedom of speech level",
        icon: MessageSquare,
        value: averageRatings.freedom_of_speech || 0,
      },
    ];

    return (
      <div className={`${cardBg} ${cardBorder} rounded-xl p-4 mb-2`}>
        <p className="font-cinzel text-[9px] text-slate-600 dark:text-white/20 tracking-[0.12em] uppercase mb-3">
          {t("country_ratings") || "Country metrics"}
        </p>
        <div className="space-y-3">
          {ratingCategories.map((rating) => {
            const Icon = rating.icon;
            return (
              <div key={rating.type} className="flex items-center gap-3">
                <div
                  className={`w-6 h-6 rounded-lg ${inlineBg} flex items-center justify-center flex-shrink-0`}
                >
                  <Icon className="w-3 h-3 text-blue-500 dark:text-blue-400/50" />
                </div>
                <span className={`text-[14px] ${bodyText} flex-1 truncate`}>
                  {rating.title}
                </span>
                <div className="w-24 h-[6px] bg-slate-200 dark:bg-white/[0.06] rounded-full flex-shrink-0">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-700 dark:from-blue-900 to-blue-500"
                    style={{ width: `${(rating.value / 10) * 100}%` }}
                  />
                </div>
                <span className="text-[14px] font-medium text-slate-500 dark:text-white/55 w-7 text-right flex-shrink-0">
                  {rating.value.toFixed(1)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── chevron SVG for select (adapts to light/dark) ─────────────────
  // In light mode arrow is dark, in dark mode it's white/25
  const selectChevronLight = `url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22rgba(71%2C85%2C105%2C0.7)%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%2F%3E%3C%2Fsvg%3E')`;
  const selectChevronDark = `url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2212%22%20height%3D%2212%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%20stroke%3D%22rgba(255%2C255%2C255%2C0.25)%22%20stroke-width%3D%222%22%3E%3Cpolyline%20points%3D%226%209%2012%2015%2018%209%22%2F%3E%3C%2Fsvg%3E')`;
  const isDark = document.documentElement.classList.contains("dark");

  return (
    <Layout
      userProfile={userProfile}
      onLogout={handleLogout}
      loading={loading}
      error={error}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      <div className="h-full">
        {showCreatePostModal ? (
          <div className="h-full">
            <CreatePostModal
              onClose={() => setShowCreatePostModal(false)}
              userCountry={selectedCountry || lensProfile?.country || "EARTH"}
            />
          </div>
        ) : (
          <div className="h-full space-y-4">
            {/* Country selector row */}
            <div className="flex items-center gap-2 mb-2">
              {/* Country select */}
              <div className="flex-1 relative">
                <select
                  value={selectedCountry}
                  onChange={handleCountryChange}
                  disabled={countryLoading}
                  className="w-full h-10 px-3
                    bg-white dark:bg-[#000d1f]
                    border border-slate-300 dark:border-white/[0.1]
                    rounded-[9px]
                    text-slate-700 dark:text-white/75
                    text-[16px] font-['Inter']
                    focus:outline-none focus:border-blue-400 dark:focus:border-blue-500/40
                    focus:ring-1 focus:ring-blue-300/40 dark:focus:ring-blue-500/20
                    transition-all disabled:opacity-50 appearance-none"
                  style={{
                    backgroundImage: isDark
                      ? selectChevronDark
                      : selectChevronLight,
                    backgroundPosition: "right 10px center",
                    backgroundRepeat: "no-repeat",
                    paddingRight: "30px",
                  }}
                >
                  {/* FIXED: this placeholder only renders while
                      selectedCountry hasn't been set yet (a brief moment
                      before initialization). As soon as there's a real
                      value ("EARTH" or a country code), we don't render
                      this option at all — otherwise it would duplicate in
                      the list the same item as the actually selected
                      country. */}
                  {!selectedCountry && (
                    <option value="" className="bg-white dark:bg-[#000d1f]">
                      {getDefaultCountryName()}
                    </option>
                  )}
                  {countryOptions.map((country) => (
                    <option
                      key={country.code}
                      value={country.code}
                      className="bg-white dark:bg-[#000d1f]"
                    >
                      {country.name}
                    </option>
                  ))}
                </select>

                {detectionStatus === "success" && (
                  <div
                    className="absolute right-8 top-1/2 -translate-y-1/2 pointer-events-none group"
                    title={
                      t("location_auto_detected") || "Automatically detected"
                    }
                  >
                    <CheckCircle className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
                    <div className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-20" />
                  </div>
                )}
              </div>

              {/* Map collapse/expand toggle — replaces the old geo-detect
                  button here. Location detection is still available via
                  the duplicate button on the map itself; this is now the
                  single control for showing/hiding the map. */}
              <button
                onClick={toggleMapCollapse}
                className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-[9px]
                  bg-blue-50 dark:bg-[#000d1f]
                  border border-blue-200 dark:border-blue-400/20
                  hover:border-blue-400 dark:hover:border-blue-400/40
                  hover:bg-blue-100 dark:hover:bg-[#002050]
                  transition-colors"
                title={
                  isMapCollapsed
                    ? t("expand_map") || "Expand map"
                    : t("collapse_map") || "Collapse map"
                }
              >
                {isMapCollapsed ? (
                  <Maximize2 className="w-5 h-5 text-blue-600 dark:text-blue-400/70" />
                ) : (
                  <Minimize2 className="w-5 h-5 text-blue-600 dark:text-blue-400/70" />
                )}
              </button>

              {/* Rating toggle */}
              <div className="flex-1">
                {selectedCountry && selectedCountry !== "EARTH" ? (
                  <button
                    onClick={() => setShowRatings(!showRatings)}
                    className={`w-full h-10 px-3 rounded-[9px] border text-left flex items-center justify-between transition-all ${
                      showRatings
                        ? "bg-blue-50 dark:bg-[#001a38] border-blue-300 dark:border-blue-500/30"
                        : "bg-white dark:bg-[#000d1f] border-slate-300 dark:border-white/[0.08] hover:border-slate-300 dark:hover:border-white/[0.14]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] text-slate-600 dark:text-white/30">
                        {t("ratings_short") || "Rating"}
                      </span>
                      {ratingsData?.averageRatings ? (
                        <div className="text-[16px] font-medium text-slate-700 dark:text-white/80">
                          {getAverageRatingValue().toFixed(1)}
                          <span className="text-slate-600 dark:text-white/30 text-[12px]">
                            {" "}
                            / 10
                          </span>
                        </div>
                      ) : (
                        <div className="text-[13px] text-slate-600 dark:text-white/30">
                          {t("rate") || "Rate"}
                        </div>
                      )}
                    </div>
                    {showRatings ? (
                      <ChevronUp className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400/50" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 text-slate-500 dark:text-white/20" />
                    )}
                  </button>
                ) : (
                  <div className="w-full h-10 px-3 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-[9px] flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Globe className="w-3.5 h-3.5 text-blue-400 dark:text-blue-400/40" />
                      <span className="text-[15px] text-slate-600 dark:text-white/40">
                        {t("global_view") || "Global view"}
                      </span>
                    </div>
                    {/* Total users worldwide — shown right here because this
                        is the exact moment "Planet Earth" is the active
                        scope, whether picked manually or by auto-detect
                        fallback, so the number has context instead of
                        floating in the navbar unrelated to what's on screen. */}
                    <div
                      className="flex items-center gap-1.5 cursor-default"
                      title={getStatsTooltip()}
                    >
                      <Users className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
                      {!statsLoading ? (
                        <span className="text-[13px] font-medium text-slate-600 dark:text-white/60">
                          {totalUsers ?? "0"}
                          {isApproximate ? "+" : ""}
                        </span>
                      ) : (
                        <div className="w-6 h-3 rounded-full bg-slate-200 dark:bg-white/[0.05] animate-pulse"></div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Location error */}
              {countryError && (
                <div className="absolute top-full left-0 right-0 mt-1 p-2 bg-red-50 dark:bg-[#1a0505] border border-red-200 dark:border-red-800/40 rounded-lg">
                  <p className="text-[11px] text-red-600 dark:text-red-400/80">
                    ⚠️ {countryError}
                  </p>
                </div>
              )}
            </div>

            {/* Ratings panel */}
            {showRatings && selectedCountry && selectedCountry !== "EARTH" && (
              <AverageRatingsDisplay />
            )}

            {/* Map */}
            {!isMapCollapsed && (
              <div
                className={`${cardBg} ${cardBorder} rounded-xl overflow-hidden mb-2`}
              >
                <div className="relative">
                  {/* H3 Grid toggle + hexagon level switcher */}
                  <div className="absolute top-2 right-2 z-20 bg-white/90 dark:bg-[#000d1f]/90 border border-slate-300 dark:border-white/[0.1] rounded-lg px-3 py-1.5 flex flex-col items-stretch gap-1.5">
                    <label className="flex items-center gap-2 cursor-pointer justify-between">
                      <span className="text-[14px] font-medium text-slate-600 dark:text-white/40 uppercase tracking-wider">
                        H3 Grid
                      </span>
                      <div
                        onClick={() => setShowH3Grid(!showH3Grid)}
                        className={`relative w-8 h-5 rounded-full transition-colors ${showH3Grid ? "bg-blue-600 dark:bg-[#1a3f7a]" : "bg-slate-300 dark:bg-white/[0.08]"}`}
                      >
                        <span
                          className={`absolute top-[2px] left-[2px] w-[16px] h-[16px] bg-white rounded-full shadow transition-transform ${showH3Grid ? "translate-x-[12px]" : "translate-x-0"}`}
                        />
                      </div>
                    </label>

                    {/* ADDED: switch for hexagon levels 3/2/1/0. Visible only
                        when the grid is enabled. Level 3 — the previous
                        behavior, 2/1/0 — new, coarser detail levels. */}
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

                  {mapError && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center p-4">
                      <div className="text-center p-4 bg-slate-50 dark:bg-[#0a0f1a] border border-red-200 dark:border-red-800/30 rounded-xl">
                        <p className="text-sm text-red-600 dark:text-red-400/70 mb-3">
                          {mapError}
                        </p>
                        <button
                          onClick={loadViolations}
                          className="px-3 py-1.5 text-xs bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/70 dark:hover:bg-[#3d0012] rounded-lg transition-colors"
                        >
                          {t("try_again") || "Try again"}
                        </button>
                      </div>
                    </div>
                  )}

                  {mapLoading && (
                    <div className="absolute inset-0 z-40 bg-white/80 dark:bg-[#000d1f]/80 flex items-center justify-center">
                      <div className="text-center">
                        <div className="w-8 h-8 border-2 border-blue-600/50 border-t-blue-400 rounded-full animate-spin mx-auto" />
                        <p className="mt-2 text-xs text-slate-600 dark:text-white/30">
                          {t("loading_map") || "Loading map..."}
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Spinner keyframes for the on-map geo-detect button
                      (map-geo-spin) — the button itself is plain Leaflet
                      DOM, added imperatively in initMap, so it can't rely
                      on Tailwind's animate-spin class scoping. */}
                  <style>{`
                    @keyframes map-geo-spin {
                      to { transform: rotate(360deg); }
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
                    ref={mapContainerRef}
                    className="h-[200px] w-full z-10"
                  />
                </div>
              </div>
            )}

            {/* Selected hexagon indicator */}
            {selectedH3Cell && (
              <div
                className={`flex items-center justify-between px-3 py-2 rounded-xl mb-2 ${
                  h3FeedCells
                    ? "bg-[#8B1A2A]/10 border border-[#8B1A2A]/25 dark:bg-[#2B000A]/50 dark:border-[#2B000A]/50"
                    : "bg-slate-100 border border-slate-200 dark:bg-white/[0.04] dark:border-white/[0.08]"
                }`}
              >
                <div
                  className={`flex items-center gap-2 text-[11px] flex-wrap ${
                    h3FeedCells
                      ? "text-[#8B1A2A] dark:text-[#e8a0b0]/75"
                      : "text-slate-500 dark:text-white/40"
                  }`}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" />
                  </svg>
                  {h3FeedCells
                    ? tf(
                        "filtered_by_hexagon",
                        "Filtered by hexagon",
                      )
                    : tf(
                        "hex_feed_filter_disabled_title",
                        "Feed shown without a hexagon filter",
                      )}
                  <span className="text-slate-500 dark:text-white/30">
                    ({tf("hex_level", "level")} {hexLevel})
                  </span>
                  {selectedH3Cell === userH3CellForLevel && (
                    <span className="text-blue-400/60">
                      ({tf("your_location", "your location")})
                    </span>
                  )}
                  {/* ADDED: the Lens API allows a maximum of 10 values in
                      a single tag-filter request, so levels 0/1 (up to 343
                      / 49 child cells) are split into several parallel
                      requests (10 each). Faster than sequential waves, but
                      still noticeably slower than a single level 2/3 request. */}
                  {h3FeedCells && h3FeedCells.length > 10 && (
                    <span className="text-slate-400 dark:text-white/25">
                      —{" "}
                      {tf(
                        "hex_feed_filter_slow",
                        "filtering may take a few seconds",
                      )}
                    </span>
                  )}
                  {!h3FeedCells && (
                    <span className="w-full text-[10px] text-slate-400 dark:text-white/30">
                      {tf(
                        "hex_feed_filter_disabled",
                        `The level ${hexLevel} hexagon covers too many smaller areas to quickly filter the feed. Choose level 1–3 to see only posts from this area.`,
                      )}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setSelectedH3Cell(null)}
                  className="text-[10px] text-slate-600 dark:text-white/25 hover:text-slate-600 dark:hover:text-white/50 underline transition-colors"
                >
                  {t("reset") || "Reset"}
                </button>
              </div>
            )}

            {/* Feed */}
            <div>
              <CountryFeed
                countryCode={selectedCountry}
                filterByCountry={shouldFilterByCountry}
                compactMode={true}
                h3Cells={h3FeedCells}
                filterByH3={!!h3FeedCells}
              />
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
