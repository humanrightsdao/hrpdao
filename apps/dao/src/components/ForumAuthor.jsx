import { useEffect, useState } from "react";
import { getPubkeyProfile, npubFromHex } from "../lib/nostrLookup";
import { useIdentity } from "./Identity";

// FIXED: "Forum shows a Nostr code instead of a name+avatar." The
// pubkey signing forum posts is a per-wallet signing key derived just
// for that purpose (see useNostrIdentity.jsx) — nobody ever publishes
// a Nostr profile (kind:0) for it, so looking IT up on relays (the old
// approach here) was never going to find a name/avatar; that pubkey
// was never "linked to an account". The account info that DOES exist
// is reachable by WALLET ADDRESS (Lens → Nostr wallet-link → ENS —
// see lib/identity.js), same as everywhere else in this app
// (Identity.jsx, the Business Card). useForum.js now tags each new
// thread/reply with the author's address, so this component resolves
// through that instead whenever it's present.
export default function ForumAuthor({ pubkey, address, size = 32, className = "" }) {
  if (address) {
    return <ResolvedByAddress address={address} size={size} className={className} />;
  }
  // Legacy fallback: posts published before the address tag existed
  // have no way back to an account — show what we always showed for
  // those, a shortened Nostr code.
  return <LegacyPubkeyDisplay pubkey={pubkey} size={size} className={className} />;
}

function ResolvedByAddress({ address, size, className }) {
  const identity = useIdentity(address);
  const display = identity?.display || "…";

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {identity?.avatar && (
        <span
          className="clip-path-hexagon shrink-0 bg-gradient-to-br from-sealBright to-sealDeep p-[1.5px]"
          style={{ width: size, height: size * 1.1 }}
        >
          <span className="clip-path-hexagon block w-full h-full overflow-hidden bg-surface">
            <img src={identity.avatar} alt="" className="w-full h-full object-cover" />
          </span>
        </span>
      )}
      <span className={identity?.source ? "text-parchment" : "font-mono text-parchmentDim"}>
        {display}
      </span>
    </span>
  );
}

function LegacyPubkeyDisplay({ pubkey, size, className }) {
  const [profile, setProfile] = useState(null);
  const npub = pubkey ? npubFromHex(pubkey) : "";
  const short = npub ? `${npub.slice(0, 9)}…${npub.slice(-4)}` : "";

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    getPubkeyProfile(pubkey).then((p) => {
      if (!cancelled) setProfile(p);
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      {profile?.avatar && (
        <span
          className="clip-path-hexagon shrink-0 bg-gradient-to-br from-sealBright to-sealDeep p-[1.5px]"
          style={{ width: size, height: size * 1.1 }}
        >
          <span className="clip-path-hexagon block w-full h-full overflow-hidden bg-surface">
            <img src={profile.avatar} alt="" className="w-full h-full object-cover" />
          </span>
        </span>
      )}
      <span className={profile?.name ? "text-parchment" : "font-mono text-parchmentDim"}>
        {profile?.name || short}
      </span>
    </span>
  );
}
