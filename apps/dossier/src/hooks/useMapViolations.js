// src/hooks/useMapViolations.js
//
// The single place that loads violations for MAP views: fetches them,
// drops the ones without usable coordinates, and applies moderation
// (posts hidden by a moderator, posts from a banned author).
//
// It was extracted from ViolationsMap.jsx so that every map (the current
// Leaflet one, a future globe page, …) gets exactly the same filtered data
// instead of each re-implementing the moderation rules.
//
// Optional auto-refresh (`refreshIntervalMs`) re-fetches quietly in the
// background — no loading overlay, and `violations` is only replaced when
// the set of visible violations actually changed.

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import useLensViolations from "./useLensViolations";
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";

const hasValidCoords = (v) =>
  Boolean(
    v.latitude &&
      v.longitude &&
      !isNaN(v.latitude) &&
      !isNaN(v.longitude),
  );

const useMapViolations = ({ refreshIntervalMs = 0 } = {}) => {
  const { t } = useTranslation();
  const { fetchViolations } = useLensViolations();

  const [violations, setViolations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const signatureRef = useRef("");
  const inFlightRef = useRef(false);
  const lastLoadRef = useRef(0);

  const load = useCallback(
    async ({ silent = false } = {}) => {
      // A background refresh never overlaps another request, but an
      // explicit (non-silent) load such as "Try again" always goes through.
      if (silent && inFlightRef.current) return;
      inFlightRef.current = true;

      if (!silent) {
        setLoading(true);
        setError("");
      }

      try {
        const result = await fetchViolations({});
        if (!result.success) throw new Error(result.error);

        // Posts hidden by a moderator, and posts from a banned author,
        // must not appear on the map.
        const [modActions, shieldTotalSupply] = await Promise.all([
          fetchAllModActions(),
          fetchShieldTotalSupply(),
        ]);

        const visible = result.violations.filter((v) => {
          if (!hasValidCoords(v)) return false;
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

        const signature = visible.map((v) => v.id).join("|");
        if (!silent || signature !== signatureRef.current) {
          signatureRef.current = signature;
          setViolations(visible);
        }
        lastLoadRef.current = Date.now();
      } catch (err) {
        if (silent) {
          // Keep showing the previous data; try again on the next tick.
          console.warn("Background refresh of violations failed:", err);
        } else {
          console.error("Error loading violations:", err);
          setError(
            err.message ||
              t("load_violations_error") ||
              "Error loading violations",
          );
        }
      } finally {
        inFlightRef.current = false;
        if (!silent) setLoading(false);
      }
    },
    [t, fetchViolations],
  );

  useEffect(() => {
    // Initial load (and reload when the language changes). It sets the
    // loading flag first, which is intentional here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    if (!refreshIntervalMs) return undefined;

    const refreshIfVisible = () => {
      if (!document.hidden) load({ silent: true });
    };
    // When the tab becomes visible again, refresh — but not if we've just
    // loaded, so quickly switching tabs doesn't hammer the network.
    const onVisibility = () => {
      if (
        !document.hidden &&
        Date.now() - lastLoadRef.current >= refreshIntervalMs / 2
      ) {
        load({ silent: true });
      }
    };

    const id = setInterval(refreshIfVisible, refreshIntervalMs);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, refreshIntervalMs]);

  const reload = useCallback(() => load(), [load]);

  return { violations, loading, error, reload };
};

export default useMapViolations;
