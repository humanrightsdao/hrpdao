import { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { MessagesSquare, Plus, MessageCircle, Loader2, AlertTriangle } from "lucide-react";
import { useForum } from "../hooks/useForum";
import ForumAuthor from "../components/ForumAuthor";
import { fmtRelative } from "../lib/format";
import { tDaoMessage } from "../lib/daoMessages";
import NewThreadModal from "../components/NewThreadModal";
import { fetchAllForumModActions, computeModerationState } from "../lib/forumModeration";

const CATEGORIES = ["all", "tech", "org", "policy", "general"];
const CAT_LABEL_KEYS = {
  all: "catAll", tech: "catTech", org: "catOrg", policy: "catPolicy", general: "catGeneral",
};

export default function ForumPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const forum = useForum(dao);
  const [cat, setCat] = useState("all");
  const [showNew, setShowNew] = useState(false);
  // Which threads a Shield/Council moderator has hidden/blurred — see
  // ForumModerationPage.jsx / src/lib/forumModeration.js. Fetched
  // alongside the thread list itself so a fully-hidden thread never
  // renders here at all (a "best effort" removal — see useForum.js's
  // note that Nostr relays don't reliably support real deletion).
  const [modActions, setModActions] = useState([]);

  useEffect(() => {
    forum.loadThreads();
    fetchAllForumModActions().then(setModActions).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const modState = {};
  for (const th of forum.threads) {
    modState[th.id] = computeModerationState(modActions, th.id);
  }

  const visible = forum.threads.filter((th) => !modState[th.id]?.hidden);
  const filtered = cat === "all" ? visible : visible.filter((th) => th.category === cat);

  // Membership gate (see useDao.js's canPostToForum) — a wallet that
  // never held a Shield/Council token can still READ the forum, just
  // not post. Shown as a disabled button + reason rather than hiding
  // the button outright, so it's clear POSTING is a member privilege,
  // not a missing feature.
  const elig = forum.canPost();

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
          disabled={!elig.eligible}
          title={!elig.eligible ? tDaoMessage(t, elig.reason) : undefined}
          className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Plus size={15} />
          {t("dao.forum.newThread")}
        </button>
      </div>
      <p className="text-parchmentDim text-sm mb-6">
        {t("dao.forum.description")}
      </p>
      {!elig.eligible && (
        <p className="font-mono text-xs text-parchmentDim mb-4">
          {tDaoMessage(t, elig.reason)}
        </p>
      )}

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
              <span className="text-parchment text-sm font-medium truncate flex items-center gap-1.5">
                {modState[th.id]?.blurred && (
                  <AlertTriangle size={13} className="text-gold shrink-0" title={t("dao.forumModeration.stateBlurred")} />
                )}
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
