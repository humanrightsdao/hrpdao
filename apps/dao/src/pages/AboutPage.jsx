import { useTranslation } from "react-i18next";
import { Info, ExternalLink } from "lucide-react";

// ─── Design tokens (aligned with DocsPage.jsx / VerificationPage.jsx) ──────
// Same rationale as elsewhere in this app: no @tailwindcss/typography
// plugin is wired up here, so headings/paragraphs get their color
// directly via Tailwind utility classes instead of a "prose" wrapper.
const headingCls = "font-display text-sm uppercase tracking-widest text-parchmentDim mb-3 mt-8 first:mt-0";
const pCls = "text-parchmentDim text-sm leading-relaxed";
const liCls = "text-parchmentDim text-sm leading-relaxed";
const highlightBox =
  "mt-10 p-6 bg-verdigris/[0.06] rounded-2xl border border-verdigris/20";

const DOSSIER_APP_URL = import.meta.env.VITE_DOSSIER_APP_URL || "http://localhost:5173";

export default function AboutPage() {
  const { t } = useTranslation();

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.common.brandLine")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-2 flex items-center gap-3">
        <Info size={26} className="text-verdigrisBright" />
        {t("dao.about.title")}
      </h1>
      <p className="text-parchmentDim text-sm mb-6">{t("dao.about.subtitle")}</p>

      <p className="text-parchment text-[15px] leading-relaxed">
        <strong>Human Rights Policy DAO</strong> — {t("dao.about.intro")}
      </p>

      <h2 className={headingCls}>1. {t("dao.about.missionTitle")}</h2>
      <p className={pCls}>{t("dao.about.missionDescription")}</p>

      <h2 className={headingCls}>2. {t("dao.about.whatWeDoTitle")}</h2>
      <p className={pCls}>{t("dao.about.whatWeDoDescription")}:</p>
      <ul className="list-disc pl-5 mt-2 space-y-1.5">
        <li className={liCls}>{t("dao.about.featureProposals")}</li>
        <li className={liCls}>{t("dao.about.featureTreasury")}</li>
        <li className={liCls}>{t("dao.about.featureModeration")}</li>
        <li className={liCls}>{t("dao.about.featureVerification")}</li>
        <li className={liCls}>{t("dao.about.featureForum")}</li>
        <li className={liCls}>{t("dao.about.featureAtticus")}</li>
      </ul>

      <h2 className={headingCls}>3. {t("dao.about.decentralizedTitle")}</h2>
      <p className={pCls}>{t("dao.about.decentralizedDescription")}</p>

      <h2 className={headingCls}>4. {t("dao.about.governanceTitle")}</h2>
      <p className={pCls}>{t("dao.about.governanceDescription")}</p>

      <h2 className={headingCls}>5. {t("dao.about.dossierTitle")}</h2>
      <p className={pCls}>{t("dao.about.dossierDescription")}</p>
      <a
        href={DOSSIER_APP_URL}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 mt-3 font-mono text-xs text-verdigris hover:text-verdigrisBright"
      >
        {t("dao.common.viewOnDossier")} <ExternalLink size={12} />
      </a>

      <h2 className={headingCls}>6. {t("dao.about.independenceTitle")}</h2>
      <p className={pCls}>{t("dao.about.independenceDescription")}</p>

      <h2 className={headingCls}>7. {t("dao.about.contactTitle")}</h2>
      <p className={pCls}>{t("dao.about.contactDescription")}</p>

      <div className={highlightBox}>
        <p className="font-semibold text-parchment text-sm m-0">
          {t("dao.about.subtitle")}
        </p>
      </div>
    </div>
  );
}
