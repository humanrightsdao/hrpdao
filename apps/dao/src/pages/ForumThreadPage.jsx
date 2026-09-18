import { useEffect, useState } from "react";
import { useParams, Link, useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Send, Flag, EyeOff, AlertTriangle, Eye } from "lucide-react";
import { useForum } from "../hooks/useForum";
import ForumAuthor from "../components/ForumAuthor";
import ReportForumModal from "../components/ReportForumModal";
import SignerBadge, { useForumSigner } from "../components/SignerBadge";
import { fmtRelative } from "../lib/format";
import { tDaoMessage } from "../lib/daoMessages";
import { fetchAllForumModActions, computeModerationState, computeBanState } from "../lib/forumModeration";

// A moderator-blurred post/reply: collapsed behind a warning until the
// reader explicitly clicks through. Not real access control (see
// forumModeration.js's own notes on what "hidden"/"blurred" can and
// can't guarantee on public Nostr relays) — just a considerate default
// for content a Shield/Council moderator flagged as sensitive.
function BlurredBody({ children }) {
  const { t } = useTranslation();
  const [revealed, setRevealed] = useState(false);
  if (revealed) return children;
  return (
    <button
      onClick={() => setRevealed(true)}
      className="w-full text-left rounded-lg border border-dashed border-gold/50 bg-gold/5 px-4 py-3 font-mono text-xs text-gold flex items-center gap-2 hover:bg-gold/10 transition-colors"
    >
      <AlertTriangle size={13} className="shrink-0" />
      {t("dao.forumModeration.stateBlurred")} — {t("dao.forumThread.clickToReveal")}
      <Eye size={13} className="ml-auto shrink-0" />
    </button>
  );
}

export default function ForumThreadPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const dao = useOutletContext();
  const forum = useForum(dao);
  const [data, setData] = useState(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reportTarget, setReportTarget] = useState(null); // { eventId, pubkey } | null
  const [modActions, setModActions] = useState([]);
  const signerInfo = useForumSigner();
  const elig = forum.canPost();

  async function load() {
    const res = await forum.loadThread(id);
    setData(res);
    fetchAllForumModActions().then(setModActions).catch(() => {});
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleReply(e) {
    e.preventDefault();
    if (!reply.trim()) return;
    setBusy(true);
    setError(null);
    const res = await forum.postReply(id, reply.trim());
    setBusy(false);
    if (res.success) {
      setReply("");
      load();
    } else {
      setError(tDaoMessage(t, res.error));
    }
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-parchmentDim">
        <Loader2 size={18} className="animate-spin" />
        <span className="font-mono text-sm">{t("dao.forumThread.loading")}</span>
      </div>
    );
  }

  if (!data.root) {
    return (
      <div className="py-16 text-center font-mono text-sm text-parchmentDim">
        {t("dao.forumThread.notFound")}
      </div>
    );
  }

  const totalEligibleVoters = Number(dao.shieldInfo?.totalSupply || 0);
  const rootState = computeModerationState(modActions, data.root.id);
  const rootAuthorBanned = data.root.address
    ? computeBanState(modActions, data.root.address, totalEligibleVoters).banned
    : false;
  // A moderator-hidden ROOT thread (or one by a now-banned author): the
  // whole page becomes a removal notice rather than trying to still
  // render a reply form under it — there's nothing left worth replying to.
  if (rootState.hidden || rootAuthorBanned) {
    return (
      <div className="fade-rise max-w-2xl">
        <Link to="/forum" className="font-mono text-xs text-parchmentDim hover:text-verdigris">
          {t("dao.forumThread.backToForum")}
        </Link>
        <div className="mt-6 rounded-2xl border border-hairline p-8 text-center font-mono text-sm text-parchmentDim flex flex-col items-center gap-2">
          <EyeOff size={20} />
          {t("dao.forumThread.threadRemoved")}
        </div>
      </div>
    );
  }

  const visibleReplies = data.replies.filter((r) => {
    if (computeModerationState(modActions, r.id).hidden) return false;
    if (r.address && computeBanState(modActions, r.address, totalEligibleVoters).banned) return false;
    return true;
  });

  return (
    <div className="fade-rise max-w-2xl">
      <Link to="/forum" className="font-mono text-xs text-parchmentDim hover:text-verdigris">
        {t("dao.forumThread.backToForum")}
      </Link>

      <h1 className="font-display text-2xl text-parchment mt-4 mb-2">{data.root.title}</h1>
      <div className="font-mono text-xs text-parchmentDim mb-6 flex items-center gap-1.5">
        <ForumAuthor pubkey={data.root.pubkey} address={data.root.address} size={32} /> · {fmtRelative(data.root.createdAt)}
        <button
          onClick={() => setReportTarget({ eventId: data.root.id, pubkey: data.root.pubkey })}
          className="ml-auto flex items-center gap-1 text-parchmentDim hover:text-sealBright transition-colors"
          title={t("dao.forumReport.reportButton")}
        >
          <Flag size={12} />
        </button>
      </div>

      <div className="border-b border-hairline pb-6 mb-6">
        {rootState.blurred ? (
          <BlurredBody>
            <p className="text-parchment text-sm leading-relaxed whitespace-pre-wrap">{data.root.body}</p>
          </BlurredBody>
        ) : (
          <p className="text-parchment text-sm leading-relaxed whitespace-pre-wrap">{data.root.body}</p>
        )}
      </div>

      <h2 className="font-display text-sm uppercase tracking-widest text-parchmentDim mb-4">
        {t("dao.forumThread.replies", { count: visibleReplies.length })}
      </h2>

      <div className="space-y-4 mb-8">
        {visibleReplies.map((r) => {
          const rState = computeModerationState(modActions, r.id);
          return (
            <div key={r.id} className="rounded-xl border border-hairline p-4">
              <div className="font-mono text-[12px] text-parchmentDim mb-2 flex items-center gap-1.5">
                <ForumAuthor pubkey={r.pubkey} address={r.address} size={32} /> · {fmtRelative(r.createdAt)}
                <button
                  onClick={() => setReportTarget({ eventId: r.id, pubkey: r.pubkey })}
                  className="ml-auto flex items-center gap-1 text-parchmentDim hover:text-sealBright transition-colors"
                  title={t("dao.forumReport.reportButton")}
                >
                  <Flag size={12} />
                </button>
              </div>
              {rState.blurred ? (
                <BlurredBody>
                  <p className="text-parchment text-sm leading-relaxed whitespace-pre-wrap">{r.body}</p>
                </BlurredBody>
              ) : (
                <p className="text-parchment text-sm leading-relaxed whitespace-pre-wrap">{r.body}</p>
              )}
            </div>
          );
        })}
        {visibleReplies.length === 0 && (
          <p className="font-mono text-xs text-parchmentDim">{t("dao.forumThread.noReplies")}</p>
        )}
      </div>

      {elig.eligible ? (
        <>
          <SignerBadge signerInfo={signerInfo} compact />

          <form onSubmit={handleReply} className="flex items-start gap-2">
            <textarea
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              rows={2}
              placeholder={t("dao.forumThread.replyPlaceholder")}
              className="flex-1 bg-surface2 border border-hairline rounded-xl px-4 py-2.5 text-sm text-parchment resize-none focus:outline-none focus:border-verdigris"
            />
            <button
              type="submit"
              disabled={busy || !reply.trim()}
              className="w-11 h-11 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep flex items-center justify-center shrink-0 hover:opacity-90 transition-opacity disabled:opacity-40"
            >
              <Send size={15} className="text-white" />
            </button>
          </form>
          {error && <p className="font-mono text-xs text-sealBright mt-2">{error}</p>}
        </>
      ) : (
        <p className="font-mono text-xs text-parchmentDim border-t border-hairline pt-4">
          {tDaoMessage(t, elig.reason)}
        </p>
      )}

      {reportTarget && (
        <ReportForumModal
          targetEventId={reportTarget.eventId}
          targetPubkey={reportTarget.pubkey}
          onReport={forum.reportPost}
          onClose={() => setReportTarget(null)}
        />
      )}
    </div>
  );
}
