import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import CardPreview from "../components/CardPreview";
import { usePrivyWalletSync } from "../hooks/usePrivyWalletSync";
import { resolveAddressFromPublicId } from "../lib/identity";

// Public page that the QR code from the Business Card links to.
// Originally designed as pure view-only (see the file's original
// comment: offline scanning, no wallet needed) — but CardPreview also
// offers actually SENDING a tip here, which is a real signed
// transaction and needs a genuinely connected wallet.
//
// ⚠️ This route sits OUTSIDE <Layout>, which is the ONLY other place
// usePrivyWalletSync() gets mounted (once, at the app root). Without
// it here too, wagmi's useAccount().isConnected never flips true after
// a fresh Privy login on THIS route — CardPreview's own connect
// button would retry-and-fail forever, then fall back to a
// logout+re-login cycle that immediately errors with "Attempted to
// log in, but user is already logged in" (Privy is correctly
// authenticated the whole time; it's wagmi's connector that was never
// populated). Mounting it here — once, since this route never nests
// under Layout — closes that gap without double-mounting it anywhere
// (see the hook's own comments for why a second concurrent instance
// on the SAME route would reintroduce the very race it was built to
// fix).
export default function CardPublicPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const loggingOutRef = usePrivyWalletSync();

  // The :id route param is no longer necessarily a raw address — it can
  // now be an ENS name, a Lens handle, or one of our own base58 "public
  // codes" (see identity.js's buildPublicCardId/resolveAddressFromPublicId
  // and publicId.js) — deliberately, so the link/QR a visitor sees never
  // has to show a raw "0x..." address that invites sending funds to it
  // directly, bypassing TipJar's split. Old links/QR codes printed with a
  // real address before this feature existed still resolve fine — that's
  // the first branch resolveAddressFromPublicId() checks.
  const [address, setAddress] = useState(null); // null = resolving, false = not found

  useEffect(() => {
    let cancelled = false;
    setAddress(null);
    resolveAddressFromPublicId(id).then((resolved) => {
      if (!cancelled) setAddress(resolved || false);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="min-h-screen bg-ink flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl border border-hairline bg-surface p-8 relative overflow-hidden">
        <div className="gradient-orb w-56 h-56 bg-verdigris/20 -top-16 -right-16" aria-hidden />
        {address === null ? (
          <div className="flex items-center justify-center gap-2 text-parchmentDim py-6">
            <Loader2 size={18} className="animate-spin" />
            <span className="font-mono text-sm">{t("dao.card.checkingRegistry")}</span>
          </div>
        ) : address === false ? (
          <p className="text-center font-mono text-sm text-sealBright">
            {t("dao.card.invalidAddress")}
          </p>
        ) : (
          <CardPreview address={address} loggingOutRef={loggingOutRef} />
        )}
      </div>
    </div>
  );
}
