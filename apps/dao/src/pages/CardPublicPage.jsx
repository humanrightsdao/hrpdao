import { useParams } from "react-router-dom";
import CardPreview from "../components/CardPreview";

// Public page that the QR code from the Business Card links to.
// Designed for an offline scenario: someone scans the code from a
// phone/printout and immediately sees that address's membership
// status — without connecting their own wallet or having MetaMask
// installed.
export default function CardPublicPage() {
  const { address } = useParams();

  return (
    <div className="min-h-screen bg-ink flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-3xl border border-hairline bg-surface p-8 relative overflow-hidden">
        <div className="gradient-orb w-56 h-56 bg-verdigris/20 -top-16 -right-16" aria-hidden />
        <CardPreview address={address} />
      </div>
    </div>
  );
}
