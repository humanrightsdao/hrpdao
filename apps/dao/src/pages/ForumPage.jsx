import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Plus, MessageCircle, Loader2 } from "lucide-react";
import { useForum } from "../hooks/useForum";
import ForumAuthor from "../components/ForumAuthor";
import { fmtRelative } from "../lib/format";
import { tDaoMessage } from "../lib/daoMessages";
import NewThreadModal from "../components/NewThreadModal";

const CATEGORIES = ["all", "tech", "org", "policy", "general"];
const CAT_LABEL_KEYS = {
  all: "catAll", tech: "catTech", org: "catOrg", policy: "catPolicy", general: "catGeneral",
};

export default function ForumPage() {
  const { t } = useTranslation();
  const forum = useForum();
  const [cat, setCat] = useState("all");
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    forum.loadThreads();
  }, []);

  const filtered =
    cat === "all" ? forum.threads : forum.threads.filter((th) => th.category === cat);

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.forum.community")}
      </div>
      <div className="flex items-center justify-between mb-2">
        <h1 className="font-display font-semibold text-3xl text-parchment flex items-center gap-3">
          <MessagesSquare size={26} className="text-verdigrisBright" />
          {t("dao.forum.title")}
        </h1>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white text-sm font-medium hover:opacity-90 transition-opacity"
        >
          <Plus size={15} />
          {t("dao.forum.newThread")}
        </button>
      </div>
      <p className="text-parchmentDim text-sm mb-6">
        {t("dao.forum.description")}
      </p>

      <div className="flex flex-wrap gap-2 mb-6">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            onClick={() => setCat(c)}
            className={`font-mono text-xs px-3 py-1.5 rounded-full border transition-colors ${
              cat === c
                ? "border-verdigris text-verdigrisBright bg-verdigris/10"
                : "border-hairline text-parchmentDim hover:text-parchment"
            }`}
          >
            {t(`dao.forum.${CAT_LABEL_KEYS[c]}`)}
          </button>
        ))}
      </div>

      {forum.error && (
        <p className="font-mono text-xs text-sealBright mb-4">{tDaoMessage(t, forum.error)}</p>
      )}

      {forum.loadingThreads && (
        <div className="flex items-center justify-center gap-2 py-10 text-parchmentDim">
          <Loader2 size={18} className="animate-spin" />
          <span className="font-mono text-sm">{t("dao.forum.loading")}</span>
        </div>
      )}

      {!forum.loadingThreads && filtered.length === 0 && (
        <div className="rounded-2xl border border-hairline p-8 text-center font-mono text-sm text-parchmentDim">
          {t("dao.forum.noThreads")}
        </div>
      )}

      <div className="rounded-2xl border border-hairline overflow-hidden">
        {filtered.map((th) => (
          <Link
            key={th.id}
            to={`/forum/${th.id}`}
            className="flex items-center gap-4 px-4 sm:px-5 py-4 border-b border-hairline last:border-b-0 hover:bg-surface2/50 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <span className="text-parchment text-sm font-medium truncate block">
                {th.title}
              </span>
              <div className="font-mono text-[12px] text-parchmentDim mt-1 flex items-center gap-1.5">
                <ForumAuthor pubkey={th.pubkey} address={th.address} size={32} /> · {fmtRelative(th.createdAt)}
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-parchmentDim text-xs shrink-0">
              <MessageCircle size={14} />
            </div>
          </Link>
        ))}
      </div>

      {showNew && (
        <NewThreadModal
          onClose={() => setShowNew(false)}
          onCreate={forum.createThread}
          onCreated={() => {
            setShowNew(false);
            forum.loadThreads();
          }}
        />
      )}
    </div>
  );
}
