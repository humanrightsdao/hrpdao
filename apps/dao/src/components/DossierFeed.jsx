// src/components/DossierFeed.jsx
//
// REPLACES SocialFeedTemplate.jsx (the mockup this was built from — see
// its header comment: a unified feed from dossier's Lens+Nostr posts).
// Real data now comes from src/lib/dossierFeed.js (a read-only port of
// dossier's own "Planet Earth" / no-filter feed query — the same mode
// CountryFeed.jsx uses when no country is selected). Deliberately
// display-only: no reactions, comments, reposts, tips, bookmarks, or
// delete/report menu — this app has no Lens session of its own to act
// through anyway. Clicking a post (or its "open" icon) opens it on
// dossier itself, in a new tab.
import { useEffect, useState, useCallback } from "react";
import { MessageCircle, ExternalLink, Globe } from "lucide-react";
import { useTranslation } from "react-i18next";
import { truncAddr } from "../lib/format";
import { fetchWorldPosts } from "../lib/dossierFeed";
import { getCountryName } from "../lib/countries";
import {
  fetchAllModActions,
  computeModerationState,
  computeBanState,
  fetchShieldTotalSupply,
} from "../lib/moderationCheck";

const DOSSIER_APP_URL =
  import.meta.env.VITE_DOSSIER_APP_URL || "http://localhost:5173";

// CHANGED: exact date + time instead of a relative "2d ago" — a
// moderator/observer scanning the world feed wants to know exactly
// when something was posted, not roughly how long ago.
function formatExactDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-US", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function DossierFeed() {
  const [posts, setPosts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadPage = useCallback(async (append = false, fromCursor = null) => {
    setLoading(true);
    setError("");
    try {
      const [{ posts: page, nextCursor, hasMore: more }, modActions, shieldTotalSupply] =
        await Promise.all([
          fetchWorldPosts(fromCursor),
          fetchAllModActions(),
          fetchShieldTotalSupply(),
        ]);

      const visible = page.filter((p) => {
        if (computeModerationState(modActions, p.id).hidden) return false;
        if (p.author.ownerAddress) {
          const banState = computeBanState(
            modActions,
            p.author.ownerAddress,
            shieldTotalSupply,
          );
          if (banState.banned) return false;
        }
        return true;
      });

      setPosts((prev) => (append ? [...prev, ...visible] : visible));
      setCursor(nextCursor);
      setHasMore(more);
    } catch (err) {
      console.error("Error loading dossier feed:", err);
      setError(err.message || "Error loading feed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPage(false, null);
  }, [loadPage]);

  return (
    <div className="rounded-2xl border border-hairline bg-surface overflow-hidden">
      <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-hairline">
        <span className="font-display text-sm text-parchment">Community Feed</span>
        <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-surface2 text-parchmentDim">
          planet earth · dossier
        </span>
      </div>

      {error && (
        <div className="text-center py-8 px-4">
          <p className="text-sm text-seal/80 mb-3">{error}</p>
          <button
            onClick={() => loadPage(false, null)}
            className="px-3 py-1.5 text-xs bg-seal/15 border border-seal/30 text-parchment rounded-lg hover:bg-seal/25 transition-colors"
          >
            Try again
          </button>
        </div>
      )}

      {!error && loading && posts.length === 0 && (
        <div className="py-14 flex justify-center">
          <div className="w-6 h-6 border-2 border-verdigris/40 border-t-verdigrisBright rounded-full animate-spin" />
        </div>
      )}

      {!error && !loading && posts.length === 0 && (
        <div className="flex flex-col items-center py-12">
          <Globe className="w-9 h-9 text-parchmentDim/40 mb-3" />
          <p className="text-sm text-parchmentDim">No posts yet</p>
        </div>
      )}

      <div>
        {posts.map((post) => (
          <PostRow key={post.id} post={post} />
        ))}
      </div>

      {hasMore && posts.length > 0 && (
        <div className="text-center py-3 border-t border-hairline">
          <button
            onClick={() => loadPage(true, cursor)}
            disabled={loading}
            className="px-5 py-2 text-[12px] font-medium text-parchmentDim border border-hairline rounded-lg
              hover:border-verdigris hover:text-verdigrisBright disabled:opacity-40 transition-colors"
          >
            {loading ? "Loading..." : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function PostRow({ post }) {
  const { i18n } = useTranslation();
  const openOnDossier = () =>
    window.open(`${DOSSIER_APP_URL}/post/${post.id}`, "_blank", "noreferrer");

  const initials = (post.author.name || "?").slice(0, 2).toUpperCase();
  const image = post.media.find((m) => m.type === "image");
  const countryName = getCountryName(post.countryCode, i18n.language);

  return (
    <div
      onClick={openOnDossier}
      className="flex gap-3 px-4 sm:px-5 py-4 border-b border-hairline last:border-b-0
        hover:bg-surface2/50 transition-colors cursor-pointer"
    >
      {/* CHANGED: hexagon avatar (clip-path-hexagon), matching
          Identity.jsx/ForumAuthor.jsx and dossier-app's own shape. */}
      <div className="shrink-0">
        <span
          className="clip-path-hexagon block bg-gradient-to-br from-sealBright to-sealDeep p-[1.5px]"
          style={{ width: 40, height: 44 }}
        >
          <span className="clip-path-hexagon flex w-full h-full items-center justify-center overflow-hidden bg-surface">
            {post.author.avatar ? (
              <img src={post.author.avatar} alt="" className="w-full h-full object-cover" />
            ) : (
              <span
                className="w-full h-full flex items-center justify-center font-display text-xs text-white"
                style={{ background: "linear-gradient(135deg, #3B7DFF, #8B1A2A)" }}
              >
                {initials}
              </span>
            )}
          </span>
        </span>
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-parchment text-sm font-medium">
            {post.author.name}
          </span>
          <span className="text-parchmentDim text-xs">
            @{post.author.handle || truncAddr(post.author.address)}
          </span>
          {/* ADDED: author's country, next to the name/handle — same
              badge dossier itself shows in CountryFeed.jsx. */}
          <span
            className="text-[11px] px-1.5 py-0.5 rounded bg-verdigris/10 border border-verdigris/25
              text-verdigrisBright/85 shrink-0"
          >
            {countryName}
          </span>
          <span className="text-parchmentDim text-[12px] ml-auto font-mono whitespace-nowrap">
            {formatExactDate(post.createdAt)}
          </span>
        </div>

        <p className="text-parchment/90 text-sm mt-1.5 leading-relaxed line-clamp-4">
          {post.content || "(no text)"}
        </p>

        {image && (
          <img
            src={image.url}
            alt=""
            className="mt-2 max-h-56 rounded-xl border border-hairline object-cover"
          />
        )}

        <div className="flex items-center gap-4 mt-3 text-parchmentDim">
          <span className="flex items-center gap-1.5 text-xs">
            <MessageCircle size={14} strokeWidth={2} />
            {post.commentCount}
          </span>
          <span className="flex items-center gap-1.5 text-xs ml-auto hover:text-verdigrisBright transition-colors">
            <ExternalLink size={13} strokeWidth={2} />
            View on Dossier
          </span>
        </div>
      </div>
    </div>
  );
}
