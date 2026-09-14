// src/pages/AboutPage.jsx
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// ─── Design tokens (aligned with PrivacyPage.jsx / TermsOfService.jsx) ─────
const pageBg = "bg-slate-50 dark:bg-[#0a0a0f]";
const cardBg = "bg-white dark:bg-[#000d1f]";
const cardBorder = "border border-slate-300 dark:border-white/[0.07]";
const subText = "text-slate-600 dark:text-white/45";
const headingText =
  "text-slate-900 dark:text-white/85 font-cinzel tracking-[0.04em]";
const linkBack =
  "text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/70 transition-colors";
const highlightBox =
  "mt-10 p-6 bg-[#8B1A2A]/[0.05] dark:bg-white/[0.03] rounded-xl border border-[#8B1A2A]/20 dark:border-white/[0.08]";
// Same reasoning as on PrivacyPage.jsx / TermsOfService.jsx: colors are set
// directly via Tailwind's arbitrary-selector utilities instead of relying
// on the "prose" typography plugin, which may not be wired up.
const docColors =
  "[&_h2]:text-slate-800 dark:[&_h2]:text-white/70 " +
  "[&_h3]:text-slate-800 dark:[&_h3]:text-white/65 " +
  "[&_p]:text-slate-700 dark:[&_p]:text-white/45 [&_p]:leading-relaxed " +
  "[&_li]:text-slate-700 dark:[&_li]:text-white/45 [&_li]:leading-relaxed " +
  "[&_strong]:text-slate-900 dark:[&_strong]:text-white/85 [&_strong]:font-semibold";

export default function AboutPage() {
  const { t } = useTranslation();

  return (
    <div className={`min-h-screen ${pageBg} p-4`}>
      <div
        className={`max-w-4xl mx-auto ${cardBg} ${cardBorder} rounded-xl shadow-lg p-6 md:p-8`}
      >
        <div className="mb-6">
          <Link
            to="/"
            className={`inline-flex items-center text-[14px] ${linkBack} mb-4`}
          >
            ← {t("back_to_home")}
          </Link>
          <h1 className={`text-3xl ${headingText}`}>{t("about_title")}</h1>
          <p className={`text-[14px] ${subText} mt-2`}>{t("about_subtitle")}</p>
        </div>

        <div className={`max-w-none ${docColors}`}>
          <p className="text-[16px] text-slate-800 dark:text-white/60 leading-relaxed">
            <strong>Human Rights Policy DAO</strong> — {t("about_intro")}
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">1. {t("about_mission_title")}</h2>
          <p>{t("about_mission_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">2. {t("about_what_we_do_title")}</h2>
          <p>{t("about_what_we_do_description")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("about_feature_reports")}</li>
            <li>{t("about_feature_map")}</li>
            <li>{t("about_feature_help_requests")}</li>
            <li>{t("about_feature_governance")}</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">3. {t("about_decentralized_title")}</h2>
          <p>{t("about_decentralized_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">4. {t("about_dao_title")}</h2>
          <p>{t("about_dao_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">5. {t("about_independence_title")}</h2>
          <p>{t("about_independence_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">6. {t("about_contact_title")}</h2>
          <p>{t("about_contact_description")}</p>

          <div className={highlightBox}>
            <p className="font-semibold text-slate-900 dark:text-white/80 m-0">
              {t("welcome_to_hrp_dao")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
