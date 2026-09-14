import { useEffect } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Fingerprint, CheckCircle2, AlertTriangle } from "lucide-react";
import { CONTRACTS } from "../hooks/useDao";
import { truncAddr } from "../lib/format";

// ── TEMPLATE ──────────────────────────────────────────────
// HumanityGate/PassportAdapter are fully on-chain — this needs a
// separate read call (previewHumanityScore/minHumanityScore) that
// doesn't currently exist as a standalone function in useDao.js (it's
// baked into shieldEligibility/councilEligibility).
// We show the same information already available from the hook.
export default function VerificationPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();

  useEffect(() => {
    dao.refreshTokenStatus?.();
  }, [dao.account]);

  const shieldElig = dao.shieldEligibility?.();
  const councilElig = dao.councilEligibility?.();
  const verified = dao.hasShield || dao.hasCouncil;

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.verification.membership")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-8 flex items-center gap-3">
        <Fingerprint size={26} className="text-verdigrisBright" />
        {t("dao.verification.title")}
      </h1>

      {!dao.isConnected ? (
        <p className="font-mono text-sm text-parchmentDim">
          {t("dao.verification.connectPrompt")}
        </p>
      ) : (
        <>
          <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6 flex items-start gap-4">
            {verified ? (
              <CheckCircle2 size={28} className="text-verdigrisBright shrink-0" />
            ) : (
              <AlertTriangle size={28} className="text-gold shrink-0" />
            )}
            <div>
              <div className="font-display text-lg text-parchment">
                {verified ? t("dao.verification.verified") : t("dao.verification.notVerified")}
              </div>
              <p className="text-parchmentDim text-sm mt-1">
                {verified
                  ? t("dao.verification.verifiedDesc")
                  : t("dao.verification.notVerifiedDesc")}
              </p>
            </div>
          </div>

          {!verified && (shieldElig?.reason || councilElig?.reason) && (
            <div className="rounded-xl border border-gold/30 bg-gold/5 p-4 mb-6 font-mono text-xs text-gold">
              {shieldElig?.reason || councilElig?.reason}
            </div>
          )}

          <a
            href={`https://passport.human.tech`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity"
          >
            {t("dao.verification.getVerified")}
          </a>

          <div className="mt-8 pt-6 border-t border-hairline flex items-center justify-between">
            <span className="text-sm text-parchment">HumanityGate</span>
            <span className="font-mono text-xs text-parchmentDim">{truncAddr(CONTRACTS.humanityGate)}</span>
          </div>
        </>
      )}
    </div>
  );
}
