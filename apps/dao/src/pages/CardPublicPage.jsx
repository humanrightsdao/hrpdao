import { useParams } from "react-router-dom";
import CardPreview from "../components/CardPreview";
import { usePrivyWalletSync } from "../hooks/usePrivyWalletSync";

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
  const { address } = useParams();
  const loggingOutRef = usePrivyWalletSync();

  return (
    <div className="min-h-screen bg-ink flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl border border-hairline bg-surface p-8 relative overflow-hidden">
        <div className="gradient-orb w-56 h-56 bg-verdigris/20 -top-16 -right-16" aria-hidden />
        <CardPreview address={address} loggingOutRef={loggingOutRef} />
      </div>
    </div>
  );
}
