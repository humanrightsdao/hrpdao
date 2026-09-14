// src/components/PublicFeedPreview.jsx
//
// Read-only preview of the global ("EARTH") social feed, shown on the
// login/registration screen (App.jsx) before the person has connected
// a wallet. Reuses useLensPosts().getCountryPosts("EARTH") — the same
// public feed query CountryFeed.jsx uses for the "world" view — which
// already falls back to the public `lensClient` when there's no
// sessionClient.
//
// Deliberately NOT the full <PostCard/>: no reactions, comments, tips,
// bookmarking, reposting, share, or report/delete menu on this screen.
// Just enough to show the feed is alive — avatar, name/handle,
// timestamp, text and (if present) a single media preview.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import useLensPosts from "../hooks/useLensPosts";
import { useCountry } from "../hooks/useCountry";

const formatDate = (dateString, t) => {
  if (!dateString) return "";
  const date = new Date(dateString);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t("just_now") || "just now";
  if (diffMins < 60) return `${diffMins} ${t("minutes_ago") || "min ago"}`;
  if (diffHours < 24) return `${diffHours} ${t("hours_ago") || "h ago"}`;
  if (diffDays < 7) return `${diffDays} ${t("days_ago") || "d ago"}`;
  return date.toLocaleDateString();
};

const PublicFeedPreview = () => {
  const { t, i18n } = useTranslation();
  const tf = (key, fallback) => {
    const val = t(key);
    return val && val !== key ? val : fallback;
  };

  const { getCountryPosts } = useLensPosts();
  const { getTranslatedCountryName } = useCountry(i18n.language || "uk");

  // Same convention as CountryFeed.jsx: posts without a real country
  // (or explicitly tagged "EARTH") are about the planet in general,
  // not any one place — shown as "Planet Earth" rather than left blank,
  // so it's always clear at a glance what a post is scoped to.
  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      return t("earth") || "Planet Earth";
    }
    return getTranslatedCountryName(countryCode) || countryCode;
  };

  const [posts, setPosts] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const sentinelRef = useRef(null);

  // Initial page — the login card is always right there next to this
  // panel (see App.jsx's sticky column), so there's no need to cap the
  // feed to a small "preview" count: it can keep going for as long as
  // there are posts, just not all revealed at once (see the
  // IntersectionObserver below).
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError("");
      try {
        const result = await getCountryPosts("EARTH");
        if (!result.success) throw new Error(result.error);
        if (!cancelled) {
          setPosts(result.posts || []);
          setCursor(result.nextCursor || null);
          setHasMore(!!result.hasMore);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch the next page and append it — called by the IntersectionObserver
  // below once the sentinel at the bottom of the list scrolls into view.
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || !cursor) return;
    setLoadingMore(true);
    try {
      const result = await getCountryPosts("EARTH", cursor);
      if (result.success) {
        setPosts((prev) => [...prev, ...(result.posts || [])]);
        setCursor(result.nextCursor || null);
        setHasMore(!!result.hasMore);
      } else {
        // A failed "load more" shouldn't wipe out the posts already
        // shown — just stop trying to load further.
        setHasMore(false);
      }
    } catch {
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [getCountryPosts, cursor, hasMore, loadingMore]);

  // Reveals more posts progressively as the person scrolls, instead of
  // rendering everything up front — the sentinel div sits right after
  // the last rendered post, and rootMargin fires loadMore a bit before
  // it actually reaches the bottom, so it feels seamless.
  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { rootMargin: "300px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  return (
    <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl overflow-hidden">
      <div className="px-4 pt-3.5 pb-2">
        <h3 className="text-[13px] font-medium text-slate-700 dark:text-white/50">
          {tf("global_feed_title", "Latest from the community")}
        </h3>
      </div>

      <div className="divide-y divide-slate-200 dark:divide-white/[0.06]">
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
          </div>
        )}

        {!loading && error && (
          <p className="px-4 py-6 text-[12px] text-slate-500 dark:text-white/30 text-center">
            {tf("feed_load_error", "Couldn't load the feed right now.")}
          </p>
        )}

        {!loading && !error && posts.length === 0 && (
          <p className="px-4 py-6 text-[12px] text-slate-500 dark:text-white/30 text-center">
            {tf("no_posts_yet", "No posts yet.")}
          </p>
        )}

        {!loading &&
          !error &&
          posts.map((post) => {
            const displayName =
              post.author?.name || t("anonymous") || "Anonymous";
            const handle = post.author?.unique_name
              ? `@${post.author.unique_name}`
              : null;
            const previewMedia = post.media_urls?.[0] || null;
            const previewMediaType = post.media_types?.[0] || null;

            return (
              <div key={post.id} className="px-4 py-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-8 h-8 rounded-full overflow-hidden bg-gradient-to-br from-[#e8a0b0] to-[#2B000A] flex-shrink-0 flex items-center justify-center">
                    {post.author?.avatar_url ? (
                      <img
                        src={post.author.avatar_url}
                        alt={displayName}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <span className="text-[12px] text-[#c8b8a2] font-medium">
                        {displayName[0]?.toUpperCase() || "U"}
                      </span>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[13px] font-medium text-slate-900 dark:text-white/80 truncate">
                        {displayName}
                      </span>
                      {handle && (
                        <span className="text-[11px] text-slate-600 dark:text-white/30">
                          {handle}
                        </span>
                      )}
                      <span
                        className="text-[11px] px-1.5 py-0.5 rounded
                        bg-blue-100 dark:bg-blue-900/25 border border-blue-300/50 dark:border-blue-700/20 text-blue-700 dark:text-blue-400/65
                        flex-shrink-0"
                      >
                        {getCountryDisplayName(post.country_code)}
                      </span>
                    </div>
                    <span className="text-[11px] text-slate-500 dark:text-white/20">
                      {formatDate(post.created_at, t)}
                    </span>
                  </div>
                </div>

                {post.content && (
                  <p
                    className="mt-1.5 text-[13px] text-slate-800 dark:text-white/70 leading-relaxed"
                    style={{
                      display: "-webkit-box",
                      WebkitLineClamp: 3,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }}
                  >
                    {post.content}
                  </p>
                )}

                {previewMedia && previewMediaType === "image" && (
                  <img
                    src={previewMedia}
                    alt=""
                    className="mt-2 w-full h-[120px] object-cover rounded-lg bg-slate-200 dark:bg-black/40"
                  />
                )}
              </div>
            );
          })}

        {/* Sentinel for the IntersectionObserver above — invisible,
            just marks "we're near the bottom of what's rendered so
            far". Only present while there's actually more to fetch. */}
        {!loading && !error && hasMore && (
          <div ref={sentinelRef} className="h-1 w-full" />
        )}

        {loadingMore && (
          <div className="flex items-center justify-center py-4">
            <div className="w-5 h-5 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
};

export default PublicFeedPreview;
