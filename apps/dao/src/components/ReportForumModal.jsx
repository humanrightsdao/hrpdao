import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X, Flag } from "lucide-react";
import { FORUM_REPORT_CATEGORIES } from "../hooks/useForum";
import { tDaoMessage } from "../lib/daoMessages";

const CATEGORY_LABEL_KEYS = {
  hate_speech: "categoryHateSpeech",
  violence_incitement: "categoryViolenceIncitement",
  harassment: "categoryHarassment",
  csam_or_minors: "categoryCsamOrMinors",
  misinformation: "categoryMisinformation",
  spam: "categorySpam",
  other: "categoryOther",
};

// Reports a single thread or reply — see useForum.js's reportPost() for
// the actual NIP-56 (kind:1984) event this publishes.
export default function ReportForumModal({ targetEventId, targetPubkey, onClose, onReport }) {
  const { t } = useTranslation();
  const [category, setCategory] = useState("spam");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await onReport(targetEventId, targetPubkey, { category, description: description.trim() });
    setBusy(false);
    if (res.success) setDone(true);
    else setError(tDaoMessage(t, res.error));
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-hairline bg-surface p-6 sm:p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-display text-xl text-parchment flex items-center gap-2">
            <Flag size={18} className="text-sealBright" />
            {t("dao.forumReport.title")}
          </h2>
          <button onClick={onClose} className="text-parchmentDim hover:text-parchment">
            <X size={20} />
          </button>
        </div>

        {done ? (
          <div className="text-center py-4">
            <p className="text-parchment text-sm mb-6">{t("dao.forumReport.sent")}</p>
            <button
              onClick={onClose}
              className="w-full px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity"
            >
              {t("dao.forumReport.close")}
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
                {t("dao.forumReport.category")}
              </label>
              <div className="flex flex-wrap gap-2">
                {FORUM_REPORT_CATEGORIES.map((c) => (
                  <button
                    type="button"
                    key={c.value}
                    onClick={() => setCategory(c.value)}
                    className={`font-mono text-xs px-3 py-1.5 rounded-full border transition-colors ${
                      category === c.value
                        ? "border-sealBright text-sealBright bg-sealBright/10"
                        : "border-hairline text-parchmentDim"
                    }`}
                  >
                    {t(`dao.forumReport.${CATEGORY_LABEL_KEYS[c.value]}`)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
                {t("dao.forumReport.descriptionLabel")}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder={t("dao.forumReport.descriptionPlaceholder")}
                className="w-full bg-surface2 border border-hairline rounded-xl px-4 py-2.5 text-sm text-parchment resize-none focus:outline-none focus:border-sealBright"
              />
            </div>

            {error && <p className="font-mono text-xs text-sealBright">{error}</p>}

            <button
              type="submit"
              disabled={busy}
              className="w-full px-5 py-2.5 rounded-full bg-gradient-to-r from-seal to-sealDeep text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              {busy ? t("dao.forumReport.sending") : t("dao.forumReport.submit")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
