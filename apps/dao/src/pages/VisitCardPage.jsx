import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { IdCard, Download } from "lucide-react";
import CardPreview from "../components/CardPreview";

export default function VisitCardPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const [qrDataUrl, setQrDataUrl] = useState(null);

  useEffect(() => {
    dao.refreshTokenStatus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  // The QR code leads to the public /card/:address page — anyone can
  // open it offline (by scanning the code from a phone/printout),
  // without connecting their own wallet, and see this address's
  // membership status.
  useEffect(() => {
    if (!dao.account) {
      setQrDataUrl(null);
      return;
    }
    const url = `${window.location.origin}/card/${dao.account}`;
    QRCode.toDataURL(url, {
      width: 320,
      margin: 1,
      color: { dark: "#0A0F16", light: "#F4F2ED" },
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [dao.account]);

  function downloadQR() {
    if (!qrDataUrl) return;
    const a = document.createElement("a");
    a.href = qrDataUrl;
    a.download = `hrp-dao-card-${dao.account?.slice(0, 8)}.png`;
    a.click();
  }

  if (!dao.isConnected) {
    return (
      <div className="fade-rise max-w-xl">
        <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
          {t("dao.nav.card")}
        </div>
        <h1 className="font-display font-semibold text-3xl text-parchment mb-6 flex items-center gap-3">
          <IdCard size={26} className="text-verdigrisBright" />
          {t("dao.nav.card")}
        </h1>
        <p className="font-mono text-sm text-parchmentDim">
          {t("dao.card.connectPrompt")}
        </p>
      </div>
    );
  }

  return (
    <div className="fade-rise max-w-3xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.nav.card")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-8 flex items-center gap-3">
        <IdCard size={26} className="text-verdigrisBright" />
        {t("dao.nav.card")}
      </h1>

      {/* ── QR + a preview of what the scanner will see, side by side ── */}
      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        <div className="rounded-2xl border border-hairline p-6 sm:p-8 text-center flex flex-col items-center justify-center">
          <p className="font-mono text-xs text-parchmentDim mb-4">
            {t("dao.card.qrHint")}
          </p>
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t("dao.card.qrAlt")}
              className="mx-auto rounded-xl border border-hairline"
              width={200}
              height={200}
            />
          ) : (
            <div className="w-[200px] h-[200px] mx-auto rounded-xl border border-hairline flex items-center justify-center font-mono text-xs text-parchmentDim">
              {t("dao.card.qrGenerating")}
            </div>
          )}
          <button
            onClick={downloadQR}
            disabled={!qrDataUrl}
            className="mt-4 inline-flex items-center gap-1.5 font-mono text-xs px-4 py-2 rounded-full border border-hairline text-parchmentDim hover:border-verdigris hover:text-verdigrisBright transition-colors disabled:opacity-40"
          >
            <Download size={13} />
            {t("dao.card.downloadPng")}
          </button>
        </div>

        <div className="rounded-2xl border border-hairline p-6 sm:p-8 relative overflow-hidden">
          <div className="gradient-orb w-40 h-40 bg-verdigris/15 -top-10 -right-10" aria-hidden />
          <CardPreview address={dao.account} showFooterNote={false} />
        </div>
      </div>
    </div>
  );
}
