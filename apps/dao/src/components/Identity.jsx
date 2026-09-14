import { useEffect, useState } from "react";
import { resolveIdentity } from "../lib/identity";
import { truncAddr } from "../lib/format";

export function useIdentity(address) {
  const [identity, setIdentity] = useState(() =>
    address ? { source: null, display: truncAddr(address), loading: true } : null,
  );

  useEffect(() => {
    if (!address) {
      setIdentity(null);
      return;
    }
    let cancelled = false;
    setIdentity({ source: null, display: truncAddr(address), loading: true });
    resolveIdentity(address).then((r) => {
      if (!cancelled) setIdentity({ ...r, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, [address]);

  return identity;
}

const SOURCE_BADGE = {
  lens: { label: "Social", color: "#3B7DFF" },
  nostr: { label: "Social", color: "#3B7DFF" },
  ens: { label: "ENS", color: "#8FCBA8" },
};

// Drop-in replacement for truncAddr() anywhere "someone" is shown —
// a proposal author, the Business Card, etc. While the lookup is in
// progress, it shows a shortened address without flicker.
// CHANGED: avatar now rendered as a hexagon (clip-path-hexagon, same
// shape dossier-app uses for its own Lens avatars) instead of a plain
// circle — every place this component is used (proposals, the
// Business Card, ProposalDetailPage) picks this up automatically.
export default function Identity({ address, size = 32, showBadge = true, className = "" }) {
  const identity = useIdentity(address);
  if (!identity) return null;

  const badge = identity.source ? SOURCE_BADGE[identity.source] : null;

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {identity.avatar && (
        <span
          className="clip-path-hexagon shrink-0 bg-gradient-to-br from-sealBright to-sealDeep p-[1.5px]"
          style={{ width: size, height: size * 1.1 }}
        >
          <span className="clip-path-hexagon block w-full h-full overflow-hidden bg-surface">
            <img src={identity.avatar} alt="" className="w-full h-full object-cover" />
          </span>
        </span>
      )}
      <span className={identity.source ? "text-parchment" : "font-mono text-parchmentDim"}>
        {identity.display}
      </span>
      {showBadge && badge && (
        <span
          className="status-stamp !py-[0.1em] !text-[11px]"
          style={{ "--stamp-color": badge.color }}
        >
          {badge.label}
        </span>
      )}
    </span>
  );
}
