// src/pages/TermsOfService.jsx
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

// ─── Design tokens (aligned with SettingsPage.jsx / Onboarding.jsx) ────────
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
// IMPORTANT: the previous version relied on the "prose" / "dark:prose-invert"
// classes (the @tailwindcss/typography plugin). If this plugin isn't
// wired up in tailwind.config.js, these classes generate NO CSS at all —
// all the text stays the browser's default black color. In light theme
// this happens to look fine (black on white), but in dark theme it's
// black on a dark-blue background, i.e. the text is practically invisible.
// So below the colors are set directly, via Tailwind's arbitrary-selector
// utilities ([&_h2]:..., [&_p]:...), which always work regardless of
// whether the typography plugin is installed.
const docColors =
  "[&_h2]:text-slate-800 dark:[&_h2]:text-white/70 " +
  "[&_h3]:text-slate-800 dark:[&_h3]:text-white/65 " +
  "[&_p]:text-slate-700 dark:[&_p]:text-white/45 [&_p]:leading-relaxed " +
  "[&_li]:text-slate-700 dark:[&_li]:text-white/45 [&_li]:leading-relaxed " +
  "[&_strong]:text-slate-900 dark:[&_strong]:text-white/85 [&_strong]:font-semibold";

export default function TermsOfService() {
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
          <h1 className={`text-3xl ${headingText}`}>
            {t("terms_of_service_title")}
          </h1>
          <p className={`text-[14px] ${subText} mt-2`}>
            {t("terms_last_updated")}: 18 {t("january")} 2026
          </p>
        </div>

        <div className={`max-w-none ${docColors}`}>
          <p className="text-[16px] text-slate-800 dark:text-white/60 leading-relaxed">
            <strong>Human Rights Policy DAO</strong> («{t("terms_platform")}
            », «{t("terms_we")}», «{t("terms_us")}») — {t("terms_description")}
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            1. {t("terms_nature_of_platform")}
          </h2>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            1.1. {t("terms_technical_provider")}
          </h3>
          <p>{t("terms_technical_provider_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            1.2. {t("terms_user_responsibility")}
          </h3>
          <p>{t("terms_user_responsibility_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            1.3. {t("terms_not_official")}
          </h3>
          <p>{t("terms_not_official_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            1.4. {t("terms_lens_nature")}
          </h3>
          <p>{t("terms_lens_nature_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            2. {t("terms_prohibited_content")}
          </h2>
          <p>{t("terms_prohibited_content_description")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("terms_prohibited_law_violation")}</li>
            <li>{t("terms_prohibited_personal_data")}</li>
            <li>{t("terms_prohibited_false_information")}</li>
            <li>{t("terms_prohibited_intellectual_property")}</li>
            <li>{t("terms_prohibited_child_exploitation")}</li>
            <li>{t("terms_prohibited_spam")}</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            3. {t("terms_disclaimer")}
          </h2>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            3.1. {t("terms_as_is")}
          </h3>
          <p>{t("terms_as_is_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            3.2. {t("terms_limitation_of_liability")}
          </h3>
          <p>{t("terms_limitation_1")}</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("terms_limitation_2")}</li>
            <li>{t("terms_limitation_3")}</li>
            <li>{t("terms_limitation_4")}</li>
            <li>{t("terms_limitation_5")}</li>
          </ul>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            3.3. {t("terms_damages_exclusion")}
          </h3>
          <p>{t("terms_damages_exclusion_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            4. {t("terms_license_grant")}
          </h2>
          <p>{t("terms_license_grant_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            5. {t("terms_moderation_deletion")}
          </h2>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            5.1. {t("terms_right_to_remove")}
          </h3>
          <p>{t("terms_right_to_remove_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            5.2. {t("terms_no_notification")}
          </h3>
          <p>{t("terms_no_notification_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            6. {t("terms_evidence_obligations")}
          </h2>
          <p>{t("terms_evidence_obligations_description")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("terms_evidence_lawful")}</li>
            <li>{t("terms_evidence_privacy")}</li>
            <li>{t("terms_evidence_criminal")}</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            7. {t("terms_access_termination")}
          </h2>
          <p>{t("terms_access_termination_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            8. {t("terms_changes")}
          </h2>
          <p>{t("terms_changes_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            9. {t("terms_governing_law_disputes")}
          </h2>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            9.1. {t("terms_governing_law")}
          </h3>
          <p>{t("terms_governing_law_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            9.2. {t("terms_dispute_resolution")}
          </h3>
          <p>{t("terms_dispute_resolution_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            10. {t("terms_contact")}
          </h2>
          <p>{t("terms_contact_description")}</p>

          <div className={highlightBox}>
            <p className="font-semibold text-slate-900 dark:text-white/80 m-0">
              {t("terms_acceptance")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
