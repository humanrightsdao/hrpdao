import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";

// ─── Design tokens (aligned with AboutPage.jsx / DocsPage.jsx) ────────────
const headingCls = "font-display text-sm uppercase tracking-widest text-parchmentDim mb-3 mt-8 first:mt-0";
const subHeadingCls = "font-display text-[13px] text-parchment mb-2 mt-5";
const pCls = "text-parchmentDim text-sm leading-relaxed";
const liCls = "text-parchmentDim text-sm leading-relaxed";
const strongCls = "text-parchment font-medium";
const highlightBox =
  "mt-10 p-6 bg-verdigris/[0.06] rounded-2xl border border-verdigris/20";

export default function PrivacyPage() {
  const { t } = useTranslation();

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.common.brandLine")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-2 flex items-center gap-3">
        <ShieldCheck size={26} className="text-verdigrisBright" />
        {t("dao.privacy.title")}
      </h1>
      <p className="text-parchmentDim text-xs font-mono mb-6">
        {t("dao.privacy.lastUpdated")}: 28.08.2026
      </p>

      <p className="text-parchment text-[15px] leading-relaxed">
        <strong>Human Rights Policy DAO</strong> {t("dao.privacy.intro")}
      </p>

      <h2 className={headingCls}>1. {t("dao.privacy.dataWeCollect")}</h2>

      <h3 className={subHeadingCls}>1.1. {t("dao.privacy.voluntaryData")}</h3>
      <p className={pCls}>{t("dao.privacy.voluntaryDataDescription")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.privacy.dataEmail")}</li>
        <li className={liCls}>{t("dao.privacy.dataWallet")}</li>
        <li className={liCls}>{t("dao.privacy.dataProfile")}</li>
        <li className={liCls}>{t("dao.privacy.dataLocation")}</li>
        <li className={liCls}>{t("dao.privacy.dataContent")}</li>
      </ul>

      <h3 className={subHeadingCls}>1.2. {t("dao.privacy.technicalData")}</h3>
      <p className={pCls}>{t("dao.privacy.technicalDataDescription")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.privacy.technicalIp")}</li>
        <li className={liCls}>{t("dao.privacy.technicalUserAgent")}</li>
        <li className={liCls}>{t("dao.privacy.technicalTimestamp")}</li>
        <li className={liCls}>{t("dao.privacy.technicalCaptcha")}</li>
        <li className={liCls}>{t("dao.privacy.technicalCookies")}</li>
      </ul>

      <h2 className={headingCls}>2. {t("dao.privacy.dataWeDontCollect")}</h2>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.privacy.dontPreciseLocation")}</li>
        <li className={liCls}>{t("dao.privacy.dontPaymentCards")}</li>
        <li className={liCls}>{t("dao.privacy.dontPassport")}</li>
      </ul>

      <h2 className={headingCls}>3. {t("dao.privacy.purposeOfUse")}</h2>
      <p className={pCls}>{t("dao.privacy.purposeDescription")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.privacy.purposeAccess")}</li>
        <li className={liCls}>{t("dao.privacy.purposeGovernance")}</li>
        <li className={liCls}>{t("dao.privacy.purposeModeration")}</li>
        <li className={liCls}>{t("dao.privacy.purposeSupport")}</li>
        <li className={liCls}>{t("dao.privacy.purposeAnalytics")}</li>
      </ul>

      <h2 className={headingCls}>4. {t("dao.privacy.legalBasisGdpr")}</h2>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>
          <span className={strongCls}>{t("dao.privacy.basisConsent")}</span> —{" "}
          {t("dao.privacy.basisConsentDescription")}
        </li>
        <li className={liCls}>
          <span className={strongCls}>{t("dao.privacy.basisContract")}</span> —{" "}
          {t("dao.privacy.basisContractDescription")}
        </li>
        <li className={liCls}>
          <span className={strongCls}>{t("dao.privacy.basisLegitimateInterest")}</span> —{" "}
          {t("dao.privacy.basisInterestDescription")}
        </li>
      </ul>

      <h2 className={headingCls}>5. {t("dao.privacy.blockchainData")}</h2>
      <p className={pCls}>{t("dao.privacy.blockchainIntro")}</p>

      <h3 className={subHeadingCls}>5.1. {t("dao.privacy.blockchainImmutableTitle")}</h3>
      <p className={pCls}>{t("dao.privacy.blockchainImmutableDescription")}</p>

      <h3 className={subHeadingCls}>5.2. {t("dao.privacy.blockchainOffchainTitle")}</h3>
      <p className={pCls}>{t("dao.privacy.blockchainOffchainDescription")}</p>

      <h3 className={subHeadingCls}>5.3. {t("dao.privacy.blockchainControlTitle")}</h3>
      <p className={pCls}>{t("dao.privacy.blockchainControlDescription")}</p>

      <h3 className={subHeadingCls}>5.4. {t("dao.privacy.thirdPartyIdentityTitle")}</h3>
      <p className={pCls}>{t("dao.privacy.thirdPartyIdentityDescription")}</p>

      <h3 className={subHeadingCls}>5.5. {t("dao.privacy.crossAppTitle")}</h3>
      <p className={pCls}>{t("dao.privacy.crossAppDescription")}</p>

      <h2 className={headingCls}>6. {t("dao.privacy.storageDeletion")}</h2>
      <p className={pCls}>{t("dao.privacy.storageContent")}</p>
      <p className={`${pCls} mt-2`}>{t("dao.privacy.deletionAccount")}</p>

      <h2 className={headingCls}>7. {t("dao.privacy.thirdPartySharing")}</h2>
      <p className={pCls}>{t("dao.privacy.sharingDescription")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>
          <span className={strongCls}>Privy</span> — {t("dao.privacy.sharingPrivy")}
        </li>
        <li className={liCls}>
          <span className={strongCls}>Cloudflare</span> — {t("dao.privacy.sharingCloudflare")}
        </li>
        <li className={liCls}>
          <span className={strongCls}>Google Gemini API</span> — {t("dao.privacy.sharingGemini")}
        </li>
        <li className={liCls}>
          <span className={strongCls}>Human Passport</span> — {t("dao.privacy.sharingHumanPassport")}
        </li>
      </ul>
      <p className={`${pCls} mt-4 font-medium text-parchment`}>{t("dao.privacy.noSelling")}</p>

      <h2 className={headingCls}>8. {t("dao.privacy.yourRightsGdpr")}</h2>
      <p className={pCls}>{t("dao.privacy.rightsDescription")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.privacy.rightAccess")}</li>
        <li className={liCls}>{t("dao.privacy.rightCorrection")}</li>
        <li className={liCls}>{t("dao.privacy.rightDeletion")}</li>
        <li className={liCls}>{t("dao.privacy.rightRestriction")}</li>
        <li className={liCls}>{t("dao.privacy.rightPortability")}</li>
        <li className={liCls}>{t("dao.privacy.rightObjection")}</li>
      </ul>
      <p className={`${pCls} mt-4`}>{t("dao.privacy.rightsContact")}</p>

      <h2 className={headingCls}>9. {t("dao.privacy.internationalTransfers")}</h2>
      <p className={pCls}>{t("dao.privacy.transfersDescription")}</p>
      <p className={`${pCls} mt-2`}>{t("dao.privacy.transfersMechanisms")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.privacy.mechanismScc")}</li>
        <li className={liCls}>{t("dao.privacy.mechanismAdequacy")}</li>
      </ul>

      <h2 className={headingCls}>10. {t("dao.privacy.security")}</h2>
      <p className={pCls}>{t("dao.privacy.securityDescription")}</p>

      <h2 className={headingCls}>11. {t("dao.privacy.changes")}</h2>
      <p className={pCls}>{t("dao.privacy.changesDescription")}</p>

      <h2 className={headingCls}>12. {t("dao.privacy.contact")}</h2>
      <p className={pCls}>{t("dao.privacy.contactDescription")}</p>

      <div className={highlightBox}>
        <p className="font-semibold text-parchment text-sm m-0">
          {t("dao.privacy.acceptance")}
        </p>
      </div>
    </div>
  );
}
