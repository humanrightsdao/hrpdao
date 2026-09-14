// src/pages/PrivacyPage.jsx
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

export default function PrivacyPage() {
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
            {t("privacy_policy_title")}
          </h1>
          <p className={`text-[14px] ${subText} mt-2`}>
            {t("privacy_last_updated")}: 28 {t("august")} 2026
          </p>
        </div>

        <div className={`max-w-none ${docColors}`}>
          <p className="text-[16px] text-slate-800 dark:text-white/60 leading-relaxed">
            <strong>Human Rights Policy DAO</strong> («{t("privacy_we")}», «
            {t("privacy_platform")}») {t("privacy_respects")}
          </p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            1. {t("privacy_data_we_collect")}
          </h2>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            1.1. {t("privacy_voluntary_data")}
          </h3>
          <p>{t("privacy_voluntary_data_description")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("privacy_data_email")}</li>
            <li>{t("privacy_data_username")}</li>
            <li>{t("privacy_data_avatar")}</li>
            <li>{t("privacy_data_country")}</li>
            <li>{t("privacy_data_bio")}</li>
            <li>{t("privacy_data_content")}</li>
            <li>{t("privacy_data_geolocation")}</li>
          </ul>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            1.2. {t("privacy_technical_data")}
          </h3>
          <p>{t("privacy_technical_data_description")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("privacy_technical_ip")}</li>
            <li>{t("privacy_technical_user_agent")}</li>
            <li>{t("privacy_technical_timestamp")}</li>
            <li>{t("privacy_technical_cookies")}</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            2. {t("privacy_data_we_dont_collect")}
          </h2>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("privacy_dont_precise_location")}</li>
            <li>{t("privacy_dont_payment_cards")}</li>
            <li>{t("privacy_dont_passport")}</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            3. {t("privacy_purpose_of_use")}
          </h2>
          <p>{t("privacy_purpose_description")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("privacy_purpose_access")}</li>
            <li>{t("privacy_purpose_display")}</li>
            <li>{t("privacy_purpose_moderation")}</li>
            <li>{t("privacy_purpose_support")}</li>
            <li>{t("privacy_purpose_analytics")}</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            4. {t("privacy_legal_basis_gdpr")}
          </h2>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>
              <strong>{t("privacy_basis_consent")}</strong> —{" "}
              {t("privacy_basis_consent_description")}
            </li>
            <li>
              <strong>{t("privacy_basis_contract")}</strong> —{" "}
              {t("privacy_basis_contract_description")}
            </li>
            <li>
              <strong>{t("privacy_basis_legitimate_interest")}</strong> —{" "}
              {t("privacy_basis_interest_description")}
            </li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            5. {t("privacy_blockchain_data")}
          </h2>
          <p>{t("privacy_blockchain_intro")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            5.1. {t("privacy_blockchain_immutable_title")}
          </h3>
          <p>{t("privacy_blockchain_immutable_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            5.2. {t("privacy_blockchain_offchain_title")}
          </h3>
          <p>{t("privacy_blockchain_offchain_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            5.3. {t("privacy_blockchain_control_title")}
          </h3>
          <p>{t("privacy_blockchain_control_description")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            5.4. {t("privacy_nostr_identity_title")}
          </h3>
          <p>{t("privacy_nostr_identity_intro")}</p>
          <p>{t("privacy_nostr_identity_derivation")}</p>
          <p>{t("privacy_nostr_identity_autolink")}</p>
          <p>{t("privacy_nostr_identity_control")}</p>

          <h3 className="text-xl font-semibold mt-6 mb-3">
            5.5. {t("privacy_cross_app_title")}
          </h3>
          <p>{t("privacy_cross_app_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            6. {t("privacy_ai_title")}
          </h2>
          <p>{t("privacy_ai_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            7. {t("privacy_tips_title")}
          </h2>
          <p>{t("privacy_tips_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            8. {t("privacy_storage_deletion")}
          </h2>
          <p>{t("privacy_storage_content")}</p>
          <p>{t("privacy_deletion_account")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            9. {t("privacy_third_party_sharing")}
          </h2>
          <p>{t("privacy_sharing_description")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>
              <strong>Privy</strong> — {t("privacy_sharing_privy_description")}
            </li>
            <li>
              <strong>Supabase</strong> — {t("privacy_sharing_supabase")}
            </li>
            <li>
              <strong>{t("privacy_sharing_gemini")}</strong> —{" "}
              {t("privacy_sharing_gemini_description")}
            </li>
            <li>
              <strong>{t("privacy_sharing_hosting")}</strong> —{" "}
              {t("privacy_sharing_hosting_description")}
            </li>
          </ul>
          <p className="mt-4 font-semibold">{t("privacy_no_selling")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            10. {t("privacy_your_rights_gdpr")}
          </h2>
          <p>{t("privacy_rights_description")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("privacy_right_access")}</li>
            <li>{t("privacy_right_correction")}</li>
            <li>{t("privacy_right_deletion")}</li>
            <li>{t("privacy_right_restriction")}</li>
            <li>{t("privacy_right_portability")}</li>
            <li>{t("privacy_right_objection")}</li>
          </ul>
          <p className="mt-4">{t("privacy_rights_contact")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            11. {t("privacy_international_transfers")}
          </h2>
          <p>{t("privacy_transfers_description")}</p>
          <p>{t("privacy_transfers_mechanisms")}:</p>
          <ul className="list-disc pl-6 mt-2 space-y-2">
            <li>{t("privacy_mechanism_scc")}</li>
            <li>{t("privacy_mechanism_adequacy")}</li>
          </ul>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            12. {t("privacy_security")}
          </h2>
          <p>{t("privacy_security_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            13. {t("privacy_changes")}
          </h2>
          <p>{t("privacy_changes_description")}</p>

          <h2 className="text-2xl font-bold mt-8 mb-4">
            14. {t("privacy_contact")}
          </h2>
          <p>{t("privacy_contact_description")}</p>

          <div className={highlightBox}>
            <p className="font-semibold text-slate-900 dark:text-white/80 m-0">
              {t("privacy_acceptance")}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
