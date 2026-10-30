// src/components/MapLayerControls.jsx
//
// The on-map panel with the "Live" and "Danger zones" switches (plus a small
// legend for the zones), shared by the violations map, the country map and the
// login-page map. Anything passed as `children` (e.g. the H3 grid switch) is
// rendered under the two switches.
import React, { useState, useEffect, useRef } from "react";
import { Layers, MapPin, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CONFLICT_STATUS } from "../config/conflictZones";

const LEGEND = Object.values(CONFLICT_STATUS).sort((a, b) => b.rank - a.rank);

// A labelled on/off switch.
export const ToggleRow = ({ label, badge, checked, onChange, compact }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={onChange}
    className={`flex items-center gap-3 justify-between w-full text-left `}
  >
    <span
      className={`${compact ? "text-[10px]" : "text-[14px]"} font-medium text-slate-400 dark:text-white/40 uppercase tracking-wider`}
    >
      {label}
      {badge != null && (
        <span className="ml-1.5 normal-case tracking-normal text-red-500 dark:text-red-400">
          {badge}
        </span>
      )}
    </span>
    <span
      className={`relative ${compact ? "w-6 h-3.5" : "w-8 h-5"} rounded-full transition-colors shrink-0 ${
        checked
          ? "bg-blue-600 dark:bg-[#1a3f7a]"
          : "bg-slate-300 dark:bg-white/[0.08]"
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] ${compact ? "w-[10px] h-[10px]" : "w-[16px] h-[16px]"} bg-white rounded-full shadow transition-transform ${
          checked
            ? compact
              ? "translate-x-[10px]"
              : "translate-x-[12px]"
            : "translate-x-0"
        }`}
      />
    </span>
  </button>
);

// Wide, non-compact maps start with the panel open; phones and small cards
// start collapsed so the map itself stays visible.
const startsOpen = () => {
  return false;
};

const MapLayerControls = ({
  showLive,
  onToggleLive,
  liveCount,
  violationsCount = null,
  showDangerZones,
  onToggleDangerZones,
  compact = false,
  defaultOpen,
  className = "absolute top-2 right-2 z-20",
  children,
}) => {
  const { t } = useTranslation();
  const tf = (key, fallback) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };

  const [open, setOpen] = useState(() =>
    defaultOpen ?? startsOpen(),
  );
  const rootRef = useRef(null);

  // Escape closes the panel.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const label = tf("map_layers", "Layers");
  const btnSize = compact ? "h-7 min-w-7" : "h-10 min-w-10 sm:h-8 sm:min-w-8";

  return (
    <div
      ref={rootRef}
      className={`${className} flex flex-col items-end gap-1 max-w-[calc(100%-1rem)] max-h-[calc(100%-1rem)]`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        title={[
          label,
          showLive && liveCount > 0
            ? `${tf("live_layer", "Live")}: ${liveCount}`
            : null,
          violationsCount != null
            ? `${tf("violations", "Violations")}: ${violationsCount}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ")}
        className={`${btnSize} inline-flex items-center justify-center gap-1 px-2 rounded-lg bg-white/90 dark:bg-[#000d1f]/90 border border-slate-200 dark:border-white/[0.1] text-slate-600 dark:text-white/70 shadow-sm backdrop-blur`}
      >
        {open ? (
          <X className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} />
        ) : (
          <Layers className={compact ? "w-3.5 h-3.5" : "w-4 h-4"} />
        )}
        {!open && showLive && liveCount > 0 && (
          <span
            className={`${compact ? "text-[10px]" : "text-[12px]"} font-semibold text-red-500 dark:text-red-400`}
          >
            {liveCount}
          </span>
        )}
        {!open && violationsCount != null && (
          <span
            className={`inline-flex items-center gap-0.5 ${compact ? "text-[10px]" : "text-[12px]"} font-semibold text-slate-600 dark:text-white/70`}
          >
            <MapPin className={compact ? "w-2.5 h-2.5" : "w-3 h-3"} />
            {violationsCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`bg-white/95 dark:bg-[#000d1f]/95 border border-slate-200 dark:border-white/[0.1] rounded-lg shadow-lg backdrop-blur flex flex-col items-stretch overflow-y-auto min-h-0 ${
            compact
              ? "px-2 py-1 gap-1 max-h-[130px]"
              : "px-3 py-1.5 gap-1.5 max-h-[min(60vh,420px)]"
          }`}
        >
          <ToggleRow
            compact={compact}
            label={tf("live_layer", "Live")}
            badge={liveCount > 0 ? liveCount : null}
            checked={showLive}
            onChange={onToggleLive}
          />
          <ToggleRow
            compact={compact}
            label={tf("danger_zones", "Danger zones")}
            checked={showDangerZones}
            onChange={onToggleDangerZones}
          />

          {showDangerZones && (
            <div
              className="flex flex-row flex-nowrap items-center gap-2 pl-0.5 whitespace-nowrap"
            >
              {LEGEND.map((status) => (
                <div
                  key={status.key}
                  title={tf(status.labelKey, status.label)}
                  className="flex items-center gap-1 text-[9px] leading-none text-slate-600 dark:text-white/50"
                >
                  <span
                    className="w-2 h-2 rounded-sm border shrink-0"
                    style={{
                      backgroundColor: status.color,
                      borderColor: status.color,
                      opacity: 0.4 + status.fillOpacity,
                    }}
                  />
                  {tf(status.labelKey, status.label)}
                </div>
              ))}
            </div>
          )}

          {children}
        </div>
      )}
    </div>
  );
};

export default MapLayerControls;
