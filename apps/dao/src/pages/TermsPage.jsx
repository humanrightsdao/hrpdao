import { useTranslation } from "react-i18next";
import { ScrollText } from "lucide-react";

// ─── Design tokens (aligned with PrivacyPage.jsx / AboutPage.jsx) ─────────
const headingCls = "font-display text-sm uppercase tracking-widest text-parchmentDim mb-3 mt-8 first:mt-0";
const subHeadingCls = "font-display text-[13px] text-parchment mb-2 mt-5";
const pCls = "text-parchmentDim text-sm leading-relaxed";
const liCls = "text-parchmentDim text-sm leading-relaxed";
const highlightBox =
  "mt-10 p-6 bg-verdigris/[0.06] rounded-2xl border border-verdigris/20";

export default function TermsPage() {
  const { t } = useTranslation();

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.common.brandLine")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-2 flex items-center gap-3">
        <ScrollText size={26} className="text-verdigrisBright" />
        {t("dao.terms.title")}
      </h1>
      <p className="text-parchmentDim text-xs font-mono mb-6">
        {t("dao.terms.lastUpdated")}: 28.08.2026
      </p>

      <p className="text-parchment text-[15px] leading-relaxed">
        <strong>Human Rights Policy DAO</strong> ({t("dao.terms.description")})
      </p>

      <h2 className={headingCls}>1. {t("dao.terms.natureOfPlatform")}</h2>

      <h3 className={subHeadingCls}>1.1. {t("dao.terms.technicalProvider")}</h3>
      <p className={pCls}>{t("dao.terms.technicalProviderDescription")}</p>

      <h3 className={subHeadingCls}>1.2. {t("dao.terms.userResponsibility")}</h3>
      <p className={pCls}>{t("dao.terms.userResponsibilityDescription")}</p>

      <h3 className={subHeadingCls}>1.3. {t("dao.terms.notOfficial")}</h3>
      <p className={pCls}>{t("dao.terms.notOfficialDescription")}</p>

      <h3 className={subHeadingCls}>1.4. {t("dao.terms.testnetNature")}</h3>
      <p className={pCls}>{t("dao.terms.testnetNatureDescription")}</p>

      <h2 className={headingCls}>2. {t("dao.terms.prohibitedContent")}</h2>
      <p className={pCls}>{t("dao.terms.prohibitedContentDescription")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.terms.prohibitedLawViolation")}</li>
        <li className={liCls}>{t("dao.terms.prohibitedPersonalData")}</li>
        <li className={liCls}>{t("dao.terms.prohibitedFalseInformation")}</li>
        <li className={liCls}>{t("dao.terms.prohibitedIntellectualProperty")}</li>
        <li className={liCls}>{t("dao.terms.prohibitedChildExploitation")}</li>
        <li className={liCls}>{t("dao.terms.prohibitedSybil")}</li>
      </ul>

      <h2 className={headingCls}>3. {t("dao.terms.disclaimer")}</h2>

      <h3 className={subHeadingCls}>3.1. {t("dao.terms.asIs")}</h3>
      <p className={pCls}>{t("dao.terms.asIsDescription")}</p>

      <h3 className={subHeadingCls}>3.2. {t("dao.terms.limitationOfLiability")}</h3>
      <p className={pCls}>{t("dao.terms.limitation1")}</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.terms.limitation2")}</li>
        <li className={liCls}>{t("dao.terms.limitation3")}</li>
        <li className={liCls}>{t("dao.terms.limitation4")}</li>
        <li className={liCls}>{t("dao.terms.limitation5")}</li>
      </ul>

      <h3 className={subHeadingCls}>3.3. {t("dao.terms.damagesExclusion")}</h3>
      <p className={pCls}>{t("dao.terms.damagesExclusionDescription")}</p>

      <h2 className={headingCls}>4. {t("dao.terms.licenseGrant")}</h2>
      <p className={pCls}>{t("dao.terms.licenseGrantDescription")}</p>

      <h2 className={headingCls}>5. {t("dao.terms.moderationDeletion")}</h2>

      <h3 className={subHeadingCls}>5.1. {t("dao.terms.rightToRemove")}</h3>
      <p className={pCls}>{t("dao.terms.rightToRemoveDescription")}</p>

      <h3 className={subHeadingCls}>5.2. {t("dao.terms.noNotification")}</h3>
      <p className={pCls}>{t("dao.terms.noNotificationDescription")}</p>

      <h2 className={headingCls}>6. {t("dao.terms.evidenceObligations")}</h2>
      <p className={pCls}>{t("dao.terms.evidenceObligationsDescription")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.terms.evidenceLawful")}</li>
        <li className={liCls}>{t("dao.terms.evidencePrivacy")}</li>
        <li className={liCls}>{t("dao.terms.evidenceCriminal")}</li>
      </ul>

      <h2 className={headingCls}>7. {t("dao.terms.accessTermination")}</h2>
      <p className={pCls}>{t("dao.terms.accessTerminationDescription")}</p>

      <h2 className={headingCls}>8. {t("dao.terms.changes")}</h2>
      <p className={pCls}>{t("dao.terms.changesDescription")}</p>

      <h2 className={headingCls}>9. {t("dao.terms.governingLawDisputes")}</h2>

      <h3 className={subHeadingCls}>9.1. {t("dao.terms.governingLaw")}</h3>
      <p className={pCls}>{t("dao.terms.governingLawDescription")}</p>

      <h3 className={subHeadingCls}>9.2. {t("dao.terms.disputeResolution")}</h3>
      <p className={pCls}>{t("dao.terms.disputeResolutionDescription")}</p>

      <h2 className={headingCls}>10. {t("dao.terms.contact")}</h2>
      <p className={pCls}>{t("dao.terms.contactDescription")}</p>

      <div className={highlightBox}>
        <p className="font-semibold text-parchment text-sm m-0">
          {t("dao.terms.acceptance")}
        </p>
      </div>
    </div>
  );
}
