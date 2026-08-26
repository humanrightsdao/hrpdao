import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Send } from "lucide-react";
import { useForum } from "../hooks/useForum";
import ForumAuthor from "../components/ForumAuthor";
import SignerBadge, { useForumSigner } from "../components/SignerBadge";
import { fmtRelative } from "../lib/format";
import { tDaoMessage } from "../lib/daoMessages";

export default function ForumThreadPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const forum = useForum();
  const [data, setData] = useState(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const signerInfo = useForumSigner();

  async function load() {
    const res = await forum.loadThread(id);
    setData(res);
  }

  useEffect(() => {
    load();
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

  return (
    <div className="fade-rise max-w-2xl">
      <Link to="/forum" className="font-mono text-xs text-parchmentDim hover:text-verdigris">
        {t("dao.forumThread.backToForum")}
      </Link>

      <h1 className="font-display text-2xl text-parchment mt-4 mb-2">{data.root.title}</h1>
      <div className="font-mono text-xs text-parchmentDim mb-6 flex items-center gap-1.5">
        <ForumAuthor pubkey={data.root.pubkey} address={data.root.address} size={32} /> · {fmtRelative(data.root.createdAt)}
      </div>

      <p className="text-parchment text-sm leading-relaxed whitespace-pre-wrap border-b border-hairline pb-6 mb-6">
        {data.root.body}
      </p>

      <h2 className="font-display text-sm uppercase tracking-widest text-parchmentDim mb-4">
        {t("dao.forumThread.replies", { count: data.replies.length })}
      </h2>

      <div className="space-y-4 mb-8">
        {data.replies.map((r) => (
          <div key={r.id} className="rounded-xl border border-hairline p-4">
            <div className="font-mono text-[12px] text-parchmentDim mb-2 flex items-center gap-1.5">
              <ForumAuthor pubkey={r.pubkey} address={r.address} size={32} /> · {fmtRelative(r.createdAt)}
            </div>
            <p className="text-parchment text-sm leading-relaxed whitespace-pre-wrap">{r.body}</p>
          </div>
        ))}
        {data.replies.length === 0 && (
          <p className="font-mono text-xs text-parchmentDim">{t("dao.forumThread.noReplies")}</p>
        )}
      </div>

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
    </div>
  );
}
