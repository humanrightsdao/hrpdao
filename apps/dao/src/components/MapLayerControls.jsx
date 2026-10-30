// src/components/MapLayerControls.jsx
//
// Collapsible "Layers" button for the map: one compact button (with the Live
// count and the violations count) that opens a small panel with the "Live"
// and "Danger zones" switches and a one-row legend. Port of dossier's
// MapLayerControls, restyled for the DAO theme and without the H3 switches
// (this app keeps its own H3 GRID button in the card header).
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Layers, MapPin, X } from "lucide-react";
import { CONFLICT_STATUS } from "../config/conflictZones";

const LEGEND = Object.values(CONFLICT_STATUS).sort((a, b) => b.rank - a.rank);

const ToggleRow = ({ label, badge, checked, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={onChange}
    className="flex items-center gap-3 justify-between w-full text-left"
  >
    <span className="font-mono text-[11px] uppercase tracking-wider text-parchmentDim">
      {label}
      {badge != null && (
        <span className="ml-1.5 normal-case tracking-normal text-sealBright">
          {badge}
        </span>
      )}
    </span>
    <span
      className={`relative w-8 h-5 rounded-full transition-colors shrink-0 ${
        checked ? "bg-verdigris" : "bg-white/10"
      }`}
    >
      <span
        className={`absolute top-[2px] left-[2px] w-4 h-4 bg-white rounded-full shadow transition-transform ${
          checked ? "translate-x-3" : "translate-x-0"
        }`}
      />
    </span>
  </button>
);

export default function MapLayerControls({
  showLive,
  onToggleLive,
  liveCount,
  violationsCount = null,
  showDangerZones,
  onToggleDangerZones,
  className = "absolute top-2 right-2 z-20",
}) {
  const { t, i18n } = useTranslation();
  const tf = (key, fallback) => {
    const full = `dao.mapLayers.${key}`;
    return i18n.exists(full) ? t(full) : fallback;
  };
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const label = tf("map_layers", "Layers");
  const title = [
    label,
    showLive && liveCount > 0 ? `${tf("live_layer", "Live")}: ${liveCount}` : null,
    violationsCount != null
      ? `${t("dao.violationsMap.title")}: ${violationsCount}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`${className} flex flex-col items-end gap-1 max-w-[calc(100%-1rem)] max-h-[calc(100%-1rem)]`}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={label}
        title={title}
        className="h-9 min-w-9 sm:h-8 sm:min-w-8 inline-flex items-center justify-center gap-1.5 px-2 rounded-lg bg-surface/90 border border-hairlineStrong text-parchmentDim shadow-sm backdrop-blur hover:text-parchment"
      >
        {open ? <X size={16} /> : <Layers size={16} />}
        {!open && showLive && liveCount > 0 && (
          <span className="font-mono text-[12px] font-semibold text-sealBright">
            {liveCount}
          </span>
        )}
        {!open && violationsCount != null && (
          <span className="inline-flex items-center gap-0.5 font-mono text-[12px] font-semibold text-parchment">
            <MapPin size={12} />
            {violationsCount}
          </span>
        )}
      </button>

      {open && (
        <div className="bg-surface/95 border border-hairlineStrong rounded-lg shadow-lg backdrop-blur flex flex-col gap-1.5 px-3 py-2 overflow-y-auto min-h-0">
          <ToggleRow
            label={tf("live_layer", "Live")}
            badge={liveCount > 0 ? liveCount : null}
            checked={showLive}
            onChange={onToggleLive}
          />
          <ToggleRow
            label={tf("danger_zones", "Danger zones")}
            checked={showDangerZones}
            onChange={onToggleDangerZones}
          />
          {showDangerZones && (
            <div className="flex flex-row flex-nowrap items-center gap-2 pl-0.5 whitespace-nowrap">
              {LEGEND.map((status) => (
                <div
                  key={status.key}
                  className="flex items-center gap-1 text-[9px] leading-none text-parchmentDim"
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
        </div>
      )}
    </div>
  );
}
