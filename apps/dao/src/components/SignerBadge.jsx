import { useEffect, useState } from "react";
import { CheckCircle2 } from "lucide-react";
import { getPubkeyProfile, npubFromHex } from "../lib/nostrLookup";
import { useNostrIdentity } from "../hooks/useNostrIdentity";

// ⚠️ Deliberately does NOT check for a NIP-07 extension (Alby, nos2x)
// — dossier's useNostrIdentity.jsx never does either, it always
// derives the key from the connected wallet. Prioritizing NIP-07 here
// used to pop Alby's own unlock/sign screen on every forum post AND
// derive a DIFFERENT pubkey than Dossier's (whatever key that
// extension happens to hold), breaking the "same identity in both
// apps" guarantee for anyone with such an extension installed. Always
// deriving from the wallet is what keeps the two apps in sync.
export function useForumSigner() {
  const { getSignerPubkey, deriving, error } = useNostrIdentity();
  const [signerInfo, setSignerInfo] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pubkey = await getSignerPubkey();
      if (!pubkey) return;
      const profile = await getPubkeyProfile(pubkey);
      if (!cancelled) {
        setSignerInfo({
          pubkey,
          name: profile?.name || null,
          npub: npubFromHex(pubkey),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getSignerPubkey]);

  return { ...signerInfo, deriving, error };
}

// Shows which identity a forum post will be published under. Derived
// from the same wallet as the DAO account (and the same derivation
// Dossier uses) — the same identity across both apps, no NIP-07
// extension involved.
export default function SignerBadge({ signerInfo, compact = false }) {
  if (!signerInfo) return null;
  if (signerInfo.deriving) {
    return (
      <div
        className={`flex items-center gap-2 rounded-xl border border-hairline ${
          compact ? "px-3 py-2 mb-3" : "px-3 py-2.5 mb-5"
        }`}
      >
        <span className="font-mono text-[12px] text-parchmentDim">
          Confirm the signature request to link your forum identity…
        </span>
      </div>
    );
  }
  if (!signerInfo.npub) return null;

  return (
    <div
      className={`flex items-center gap-2 rounded-xl border border-hairline ${
        compact ? "px-3 py-2 mb-3" : "px-3 py-2.5 mb-5"
      }`}
    >
      <CheckCircle2 size={14} className="text-verdigrisBright shrink-0" />
      <span className="font-mono text-[12px] text-parchmentDim leading-snug">
        Will be published as{" "}
        <span className="text-parchment">
          {signerInfo.name || `${signerInfo.npub.slice(0, 12)}…`}
        </span>{" "}
        — derived from your DAO wallet, same identity as Dossier.
      </span>
    </div>
  );
}
