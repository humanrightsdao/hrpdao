import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import SignerBadge, { useForumSigner } from "./SignerBadge";
import { tDaoMessage } from "../lib/daoMessages";

const CATEGORIES = [
  { id: "tech", labelKey: "dao.forum.catTech" },
  { id: "org", labelKey: "dao.forum.catOrg" },
  { id: "policy", labelKey: "dao.forum.catPolicy" },
  { id: "general", labelKey: "dao.forum.catGeneral" },
];

export default function NewThreadModal({ onClose, onCreate, onCreated }) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("general");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signerInfo = useForumSigner();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    setError(null);
    const res = await onCreate({ title: title.trim(), category, body: body.trim() });
    setBusy(false);
    if (res.success) onCreated();
    else setError(tDaoMessage(t, res.error));
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg rounded-2xl border border-hairline bg-surface p-6 sm:p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-display text-xl text-parchment">{t("dao.newThread.title")}</h2>
          <button onClick={onClose} className="text-parchmentDim hover:text-parchment">
            <X size={20} />
          </button>
        </div>

        {/* ── Who the post will be published as ─────────────── */}
        <SignerBadge signerInfo={signerInfo} />

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
              {t("dao.newThread.category")}
            </label>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  type="button"
                  key={c.id}
                  onClick={() => setCategory(c.id)}
                  className={`font-mono text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    category === c.id
                      ? "border-verdigris text-verdigrisBright bg-verdigris/10"
                      : "border-hairline text-parchmentDim"
                  }`}
                >
                  {t(c.labelKey)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
              {t("dao.newThread.titleLabel")}
            </label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              required
              placeholder={t("dao.newThread.titlePlaceholder")}
              className="w-full bg-surface2 border border-hairline rounded-xl px-4 py-2.5 text-sm text-parchment focus:outline-none focus:border-verdigris"
            />
          </div>

          <div>
            <label className="block font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
              {t("dao.newThread.bodyLabel")}
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              required
              rows={5}
              placeholder={t("dao.newThread.bodyPlaceholder")}
              className="w-full bg-surface2 border border-hairline rounded-xl px-4 py-2.5 text-sm text-parchment resize-none focus:outline-none focus:border-verdigris"
            />
          </div>

          {error && <p className="font-mono text-xs text-sealBright">{error}</p>}

          <button
            type="submit"
            disabled={busy || !title.trim() || !body.trim()}
            className="w-full px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {busy ? t("dao.newThread.posting") : t("dao.newThread.post")}
          </button>
        </form>
      </div>
    </div>
  );
}
