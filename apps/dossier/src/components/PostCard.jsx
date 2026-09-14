// src/components/PostCard.jsx
//
// ADDED: a shared post card, extracted from CountryFeed.jsx and
// FollowingPage.jsx, so the same look/functionality (truth/false
// reactions, comments, bookmarking, repost/share, tips, delete/report
// menu, media, moderation blur) isn't duplicated in two places. Both
// files used to have identical card JSX markup — when a bug was found in
// the reactions, it had to be fixed in two places; this component
// removes that risk going forward.
//
// PROPS PHILOSOPHY: CountryFeed and FollowingPage get posts from
// DIFFERENT sources (getCountryPosts vs useLensTimeline) with a
// different data shape and a different way of computing derived state
// (reactions/bookmarks/moderation — where in CountryFeed all of this is
// part of the local posts state, while in FollowingPage it's a separate
// "overlay" on top of the hook). So PostCard accepts an already
// NORMALIZED post and "ready-made" callbacks/values, rather than trying
// to know on its own where the data came from. Purely presentational,
// ephemeral things (whether the "..." menu is open, whether media is
// expanded, the comment draft text, whether the share modal is shown)
// are kept INSIDE PostCard itself — the parent component doesn't need to
// know about them.
import React, {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import EmojiPicker, { Theme as EmojiTheme } from "emoji-picker-react";
import {
  MessageCircle,
  Send,
  Bookmark,
  BookmarkCheck,
  MoreVertical,
  CheckCircle,
  XCircle,
  Flag,
  Trash2,
  Image as ImageIcon,
  Video as VideoIcon,
  File as FileIcon,
  Copy,
  Check,
  Facebook,
  Twitter,
  Linkedin,
  Upload,
  Smile,
  X,
  ArrowUpRight,
} from "lucide-react";

// ADDED: the same limits as in CreatePostModal.jsx/CommentsSection.jsx —
// up to 4 files, 10MB each, the same list of allowed types.
const MAX_QUICK_COMMENT_FILES = 4;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "text/plain",
];

// ADDED: standard preview cap for the card, so a short update never gets
// truncated but a long essay/report doesn't dominate the feed. Two
// independent triggers, matching common feed conventions (Twitter/
// Threads-style char cutoff, Facebook/Threads-style line cutoff — Threads'
// mobile feed comfortably shows ~10 lines of text before a media block
// without reading as "too long", so that's the bar used here):
//   - a CHARACTER cap - catches one long unbroken paragraph;
//   - a LINE cap - catches text with many short lines/newlines that
//     wouldn't be long enough in characters to trip the cap above.
// Either one alone being exceeded is enough to trigger "Дивитись повністю".
const POST_PREVIEW_CHAR_LIMIT = 500;
const POST_PREVIEW_LINE_LIMIT = 10;

// ADDED: how many media items the CARD shows before collapsing the rest
// behind "+N more" - keeps a post with a large gallery from turning the
// feed into an endless grid. The full set is always visible on PostPage.
const MEDIA_PREVIEW_COUNT = 2;

const formatDate = (dateString, t) => {
  if (!dateString) return "";
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t("just_now") || "just now";
  if (diffMins < 60) return `${diffMins} ${t("minutes_ago") || "min ago"}`;
  if (diffHours < 24) return `${diffHours} ${t("hours_ago") || "h ago"}`;
  if (diffDays < 7) return `${diffDays} ${t("days_ago") || "d ago"}`;

  return date.toLocaleDateString();
};

const getMediaDisplayClass = (type, isExpanded) => {
  if (isExpanded) return "w-full max-h-[500px] object-contain";
  switch (type) {
    case "image":
      return "w-full h-[180px] object-contain bg-slate-200 dark:bg-black/40";
    case "video":
      return "w-full h-[180px] object-contain bg-slate-200 dark:bg-black/40";
    default:
      return "w-full";
  }
};

// ADDED: the share modal now lives inside PostCard (previously each
// page had its own showShareModal/copyStatus state "from above"). It
// only needs the data of the post that's already there — no separate
// lookup in the posts array, as before.
const SharePostModal = ({
  postId,
  content,
  authorName,
  authorAvatar,
  shareCount = 0,
  onClose,
  t,
}) => {
  const [isCopied, setIsCopied] = useState(false);
  const shareUrl = `${window.location.origin}/post/${postId}`;

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error("❌ Failed to copy:", err);
      const textArea = document.createElement("textarea");
      textArea.value = shareUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  const shareToSocial = (platform) => {
    const title =
      content?.substring(0, 100) + (content?.length > 100 ? "..." : "");
    let url = "";
    switch (platform) {
      case "facebook":
        url = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(shareUrl)}`;
        break;
      case "twitter":
        url = `https://twitter.com/intent/tweet?url=${encodeURIComponent(shareUrl)}&text=${encodeURIComponent(title)}`;
        break;
      case "linkedin":
        url = `https://www.linkedin.com/shareArticle?mini=true&url=${encodeURIComponent(shareUrl)}&title=${encodeURIComponent(title)}`;
        break;
      default:
        return;
    }
    window.open(url, "_blank", "width=600,height=400");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black bg-opacity-50 share-modal">
      <div
        className="bg-white dark:bg-gray-800 rounded-xl shadow-xl max-w-md w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-center justify-between mb-6">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white">
              {t("share_post") || "Share post"}
            </h3>
            <button
              onClick={onClose}
              className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full"
            >
              <svg
                className="w-5 h-5 text-gray-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <div className="mb-6 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg">
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                {authorAvatar ? (
                  <img
                    src={authorAvatar}
                    alt={authorName}
                    className="w-10 h-10 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center text-white font-bold">
                    {authorName?.[0]?.toUpperCase() || "U"}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white">
                  {authorName}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {content?.substring(0, 100)}
                  {content?.length > 100 && "..."}
                </p>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3 mb-6">
            <button
              onClick={() => shareToSocial("facebook")}
              className="flex flex-col items-center justify-center p-4 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded-xl transition-colors"
            >
              <Facebook className="w-8 h-8 text-blue-600 dark:text-blue-400 mb-2" />
              <span className="text-sm font-medium text-gray-900 dark:text-white">
                Facebook
              </span>
            </button>
            <button
              onClick={() => shareToSocial("twitter")}
              className="flex flex-col items-center justify-center p-4 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded-xl transition-colors"
            >
              <Twitter className="w-8 h-8 text-blue-400 dark:text-blue-300 mb-2" />
              <span className="text-sm font-medium text-gray-900 dark:text-white">
                Twitter
              </span>
            </button>
            <button
              onClick={() => shareToSocial("linkedin")}
              className="flex flex-col items-center justify-center p-4 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30 rounded-xl transition-colors"
            >
              <Linkedin className="w-8 h-8 text-blue-700 dark:text-blue-500 mb-2" />
              <span className="text-sm font-medium text-gray-900 dark:text-white">
                LinkedIn
              </span>
            </button>
          </div>

          <div className="mb-6">
            <p className="text-sm font-medium text-gray-900 dark:text-white mb-2">
              {t("copy_link") || "Copy link"}
            </p>
            <div className="flex items-center gap-2">
              <div className="flex-1 p-2 bg-gray-100 dark:bg-gray-900 rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden">
                <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                  {shareUrl}
                </p>
              </div>
              <button
                onClick={copyToClipboard}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                  isCopied
                    ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                    : "bg-blue-600 hover:bg-blue-700 text-white"
                }`}
              >
                {isCopied ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>{t("copied") || "Copied"}</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>{t("copy") || "Copy"}</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="text-center">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t("shared_count") || "Shared:"}{" "}
              <span className="font-bold text-gray-900 dark:text-white">
                {shareCount}
              </span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * post: {
 *   id,                 // lens post id — used for /post/:id
 *   content,
 *   createdAt,
 *   editedAt,           // optional — shows "(edited)"
 *   author: { address, name, handle, avatar },
 *   media: [{ url, type: "image"|"video"|"document" }],
 *   commentCount,
 *   shareCount,
 * }
 * countryBadge: a React node (a text badge or <AuthorCountryBadge/>) or null
 * reaction: { truth, false, mine: "truth"|"false"|null }
 * tipButton: a ready-made <TipButton/> or null — PostCard knows nothing about wallets
 */
const PostCard = ({
  post,
  countryBadge = null,
  reaction = { truth: 0, false: 0, mine: null },
  isOwner = false,
  isSaved = false,
  isSaving = false,
  isSharing = false,
  tipButton = null,
  isBlurred = false,
  onRevealBlurred,
  onReaction,
  onSave,
  onShare,
  onDelete,
  onReport,
  onAuthorClick,
  onCommentSubmit,
  onCommentIconClick,
  onOpenPost,
  // ADDED: an inline quick-comment field under the card — by design it
  // should exist ONLY in the feed (CountryFeed.jsx on CountryPage), not
  // on the individual post page (PostPage.jsx), where there's already a
  // full <CommentsSection/> below the card — so there aren't two comment
  // input fields at once. PostPage should pass showQuickComment={false}
  // to its <PostCard/>.
  showQuickComment = true,
  // ADDED: on the feed (CountryFeed.jsx/FollowingPage.jsx) the card should
  // still clamp long text/media, since that's the whole point of a
  // preview — but on PostPage.jsx the card IS the full post, so clamping
  // there just recreated the "too long, click through" problem the user
  // is already past. PostPage passes disablePreview to show everything.
  disablePreview = false,
}) => {
  const { t } = useTranslation();
  const [showMenu, setShowMenu] = useState(false);
  const [expandedMedia, setExpandedMedia] = useState({});
  const [showShareModal, setShowShareModal] = useState(false);
  const [commentValue, setCommentValue] = useState("");
  // ADDED: the quick-comment field (media/emoji/Send buttons) is collapsed
  // by default and only unfolds after clicking the comment (MessageCircle)
  // icon — instead of always taking up space under the card.
  const [isQuickCommentOpen, setIsQuickCommentOpen] = useState(false);

  // ADDED: media + emoji for the inline quick-comment field (the same
  // pattern used in CommentsSection.jsx/CreatePostModal.jsx).
  const [quickMediaFiles, setQuickMediaFiles] = useState([]);
  const [quickFileError, setQuickFileError] = useState("");
  const [showQuickEmojiPicker, setShowQuickEmojiPicker] = useState(false);
  const [quickEmojiPickerStyle, setQuickEmojiPickerStyle] = useState(null);

  // FIXED: "Читати повністю" used to be shown/hidden based on a static
  // char/newline-count heuristic (POST_PREVIEW_CHAR_LIMIT /
  // POST_PREVIEW_LINE_LIMIT), independent of the actual card width and
  // font metrics. A post could cross the character threshold yet still
  // wrap to fewer than POST_PREVIEW_LINE_LIMIT visual lines at the card's
  // real width — the CSS line-clamp then had nothing to clamp, the full
  // text was already visible, but the button still appeared, misleading
  // users into thinking text was cut off. isTextClamped instead measures
  // the actual rendered element: the clamp box is only "active" (and the
  // button only shown) when its content is genuinely taller than the
  // clamped box (scrollHeight > clientHeight).
  const [isTextClamped, setIsTextClamped] = useState(false);
  const contentTextRef = useRef(null);
  const quickFileInputRef = useRef(null);
  const quickInputRef = useRef(null);
  const quickEmojiPickerRef = useRef(null);
  const quickEmojiButtonRef = useRef(null);

  // ADDED: the "Гонорар" (tip) panel now slides out under the action bar
  // the same way "Швидкі коментарі" does, instead of floating as a popup.
  // TipButton portals its expanded panel into this node (a plain slot
  // rendered in normal document flow, right after the action bar) — see
  // the `containerRef` prop passed to it below.
  const tipSlotRef = useRef(null);

  const isDarkMode =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");

  const computeQuickEmojiPickerPosition = useCallback(() => {
    const btn = quickEmojiButtonRef.current;
    if (!btn) return null;

    const MARGIN = 8;
    const WIDTH = 300;
    const MAX_HEIGHT = 360;
    const MIN_HEIGHT = 260;

    const rect = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const spaceAbove = rect.top - MARGIN * 2;
    const spaceBelow = vh - rect.bottom - MARGIN * 2;

    let top;
    let height;

    if (spaceAbove >= MIN_HEIGHT || spaceAbove >= spaceBelow) {
      height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, spaceAbove));
      top = rect.top - height - MARGIN;
    } else {
      height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, spaceBelow));
      top = rect.bottom + MARGIN;
    }

    if (top < MARGIN) top = MARGIN;

    let left = rect.left;
    if (left + WIDTH > vw - MARGIN) left = vw - WIDTH - MARGIN;
    if (left < MARGIN) left = MARGIN;

    return { top, left, width: WIDTH, height };
  }, []);

  useEffect(() => {
    if (!showQuickEmojiPicker) {
      setQuickEmojiPickerStyle(null);
      return;
    }
    const update = () =>
      setQuickEmojiPickerStyle(computeQuickEmojiPickerPosition());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [showQuickEmojiPicker, computeQuickEmojiPickerPosition]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        quickEmojiPickerRef.current &&
        !quickEmojiPickerRef.current.contains(e.target) &&
        quickEmojiButtonRef.current &&
        !quickEmojiButtonRef.current.contains(e.target)
      ) {
        setShowQuickEmojiPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // ADDED: the quick-comment field starts as a single line and grows with
  // the text (up to a cap, after which it scrolls internally instead of
  // pushing the rest of the page down indefinitely).
  const QUICK_COMMENT_MAX_HEIGHT = 180;

  const autoResizeQuickInput = useCallback(() => {
    const el = quickInputRef.current;
    if (!el) return;
    el.style.height = "auto";
    const nextHeight = Math.min(el.scrollHeight, QUICK_COMMENT_MAX_HEIGHT);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY =
      el.scrollHeight > QUICK_COMMENT_MAX_HEIGHT ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    if (isQuickCommentOpen) autoResizeQuickInput();
  }, [commentValue, isQuickCommentOpen, autoResizeQuickInput]);

  // ADDED: focus the field the moment it unfolds, so the user can start
  // typing immediately after clicking the comment icon.
  useEffect(() => {
    if (isQuickCommentOpen) {
      const id = setTimeout(() => quickInputRef.current?.focus(), 0);
      return () => clearTimeout(id);
    }
  }, [isQuickCommentOpen]);

  const insertQuickEmoji = (emojiData) => {
    const emoji = emojiData.emoji;
    const input = quickInputRef.current;
    if (!input) {
      setCommentValue((prev) => prev + emoji);
      setShowQuickEmojiPicker(false);
      return;
    }

    const start = input.selectionStart ?? commentValue.length;
    const end = input.selectionEnd ?? commentValue.length;
    const newText =
      commentValue.substring(0, start) + emoji + commentValue.substring(end);
    setCommentValue(newText);

    setTimeout(() => {
      input.focus();
      input.setSelectionRange(start + emoji.length, start + emoji.length);
    }, 0);

    setShowQuickEmojiPicker(false);
  };

  const handleQuickFileSelect = (event) => {
    const files = Array.from(event.target.files);
    if (quickMediaFiles.length + files.length > MAX_QUICK_COMMENT_FILES) {
      setQuickFileError(t("max_4_files") || "Maximum 4 files");
      event.target.value = "";
      return;
    }

    const validFiles = files.filter((file) => {
      if (file.size > MAX_FILE_SIZE) {
        setQuickFileError(
          `${file.name}: ${t("file_too_large") || "file is too large (max. 10MB)"}`,
        );
        return false;
      }
      if (!ALLOWED_FILE_TYPES.includes(file.type)) {
        setQuickFileError(
          `${file.name}: ${t("file_type_not_supported") || "file type not supported"}`,
        );
        return false;
      }
      return true;
    });

    setQuickMediaFiles((prev) => [...prev, ...validFiles]);
    event.target.value = "";
  };

  const removeQuickMediaFile = (index) => {
    setQuickMediaFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const media = post.media || [];

  // CHANGED: POST_PREVIEW_CHAR_LIMIT/POST_PREVIEW_LINE_LIMIT are now only
  // a cheap pre-check — "could this possibly need clamping" — not the
  // final answer on whether to show "Читати повністю". They avoid running
  // the line-clamp style (and its layout effect) on posts that are
  // obviously short. Whether the button actually renders is decided by
  // isTextClamped below, which measures the real rendered box.
  const contentText = post.content || "";
  const contentLineCount = contentText.split("\n").length;
  const mayNeedClamp =
    !disablePreview &&
    (contentText.length > POST_PREVIEW_CHAR_LIMIT ||
      contentLineCount > POST_PREVIEW_LINE_LIMIT);

  // FIXED: measure the actual rendered <p> after every layout that could
  // change wrapping (new content, media loading/resizing nearby, window
  // resize) and only report the text as clamped when its full content is
  // genuinely taller than the clamped box. This replaces the old
  // heuristic-only decision so "Читати повністю" never appears next to
  // text that is already shown in full.
  useLayoutEffect(() => {
    if (!mayNeedClamp) {
      setIsTextClamped(false);
      return;
    }
    const el = contentTextRef.current;
    if (!el) return;

    const measure = () => {
      setIsTextClamped(el.scrollHeight - el.clientHeight > 1);
    };
    measure();

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    resizeObserver?.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [mayNeedClamp, contentText]);

  const isLongContent = mayNeedClamp && isTextClamped;

  // ADDED: cap how many MEDIA items the card renders — the rest collapse
  // behind a "+N more" control that, like the text's "Дивитись повністю",
  // takes the user to the full PostPage instead of expanding in place.
  // Skipped entirely when disablePreview is set — PostPage always shows
  // every media item.
  const visibleMedia = disablePreview
    ? media
    : media.slice(0, MEDIA_PREVIEW_COUNT);
  const hiddenMediaCount = media.length - visibleMedia.length;

  const toggleMediaExpansion = (index) => {
    setExpandedMedia((prev) => ({ ...prev, [index]: !prev[index] }));
  };

  const handleCardClick = (e) => {
    if (
      e.target.closest(".post-menu") ||
      e.target.closest(".post-actions") ||
      e.target.closest(".comment-section") ||
      e.target.closest("button") ||
      e.target.closest("a") ||
      e.target.closest("input") ||
      e.target.closest("textarea") ||
      e.target.closest("video") ||
      e.target.closest(".share-modal")
    ) {
      return;
    }
    onOpenPost?.();
  };

  const handleShareClick = async (e) => {
    e.stopPropagation();
    await onShare?.();
    setShowShareModal(true);
  };

  const handleCommentSend = () => {
    if (!commentValue.trim() && quickMediaFiles.length === 0) return;
    onCommentSubmit?.(commentValue.trim(), quickMediaFiles);
    setCommentValue("");
    setQuickMediaFiles([]);
    setQuickFileError("");
  };

  return (
    <div className="relative">
      {isBlurred && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2
            bg-white/80 dark:bg-[#000d1f]/85 backdrop-blur-[2px] rounded-xl px-4 text-center"
        >
          <p className="text-[13px] text-slate-600 dark:text-white/60">
            ⚠️ This post has been flagged by Shield/Senate as potentially harmful
          </p>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onRevealBlurred?.();
            }}
            className="px-3 py-1.5 text-[12px] font-medium rounded-lg
              bg-slate-200 dark:bg-white/10 text-slate-900 dark:text-white/80
              hover:bg-slate-300 dark:hover:bg-white/20 transition-colors"
          >
            Show it anyway
          </button>
        </div>
      )}

      <div
        onClick={handleCardClick}
        className={`bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl overflow-hidden
        cursor-pointer transition-all duration-150
        hover:border-slate-400 dark:hover:border-white/[0.13] dark:hover:bg-[#001026]
        ${isBlurred ? "blur-sm pointer-events-none select-none" : ""}`}
      >
        <div className="p-0">
          {/* Header: avatar, name, handle, country, date, menu */}
          <div className="flex items-start justify-between px-4 pt-3.5 pb-0">
            <div className="flex items-center gap-2.5 flex-1 min-w-0">
              <div className="relative flex-shrink-0">
                <div
                  className="relative w-[40px] h-[44px] p-[1.5px] clip-path-hexagon
                  bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]"
                >
                  <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                    {post.author?.avatar ? (
                      <img
                        src={post.author.avatar}
                        alt={post.author?.name}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          e.target.style.display = "none";
                          const fallbackDiv =
                            e.target.parentElement?.querySelector(
                              ".avatar-fallback",
                            );
                          if (fallbackDiv) fallbackDiv.style.display = "flex";
                        }}
                      />
                    ) : null}
                    <div
                      className={`avatar-fallback w-full h-full flex items-center justify-center
                        font-cinzel text-[13px] text-[#c8b8a2] bg-[#0d0415]
                        ${post.author?.avatar ? "hidden" : "flex"}`}
                    >
                      {post.author?.name?.[0]?.toUpperCase() || "U"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onAuthorClick?.();
                    }}
                    className="text-[16px] font-medium text-slate-900 dark:text-white/80
                    hover:text-slate-950 dark:hover:text-white/95 transition-colors text-left truncate"
                  >
                    {post.author?.name || t("anonymous") || "Anonymous"}
                  </button>
                  {post.author?.handle && (
                    <span className="text-[13px] text-slate-600 dark:text-white/30 flex-shrink-0">
                      {post.author.handle}
                    </span>
                  )}
                  {countryBadge}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[11px] text-slate-600 dark:text-white/20">
                    {formatDate(post.createdAt, t)}
                    {post.editedAt && (
                      <span className="ml-1.5 text-slate-500 dark:text-white/15">
                        {t("edited") || "(edited)"}
                      </span>
                    )}
                  </span>
                  <span className="text-slate-400 dark:text-white/10">·</span>
                  <span className="text-[11px] text-slate-500 dark:text-white/15">
                    {post.commentCount ?? 0} {t("comments") || "comments"}
                  </span>
                </div>
              </div>
            </div>

            <div
              className="relative ml-2 flex-shrink-0 post-menu"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowMenu((v) => !v)}
                className="w-10 h-10 rounded-lg flex items-center justify-center
                hover:bg-slate-100 dark:hover:bg-white/[0.05] transition-colors"
              >
                <MoreVertical className="w-5 h-5 text-slate-500 dark:text-white/20" />
              </button>

              {showMenu && (
                <div
                  className="absolute right-0 mt-1 w-36
                bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.1] rounded-xl
                shadow-lg z-10 p-1"
                >
                  {isOwner ? (
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        onDelete?.();
                      }}
                      className="w-full px-3 py-2.5 text-left text-[13px]
                      text-red-500 dark:text-red-400/70 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10
                      rounded-lg flex items-center gap-2 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      {t("delete") || "Delete"}
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setShowMenu(false);
                        onReport?.();
                      }}
                      className="w-full px-3 py-2.5 text-left text-[13px]
                      text-red-500 dark:text-red-400/70 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10
                      rounded-lg flex items-center gap-2 transition-colors"
                    >
                      <Flag className="w-4 h-4" />
                      {t("report") || "Report"}
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Post text — clamped to POST_PREVIEW_LINE_LIMIT lines (via
              -webkit-line-clamp, set inline rather than a Tailwind utility
              class so it doesn't depend on the line-clamp plugin being
              enabled) whenever the text crosses POST_PREVIEW_CHAR_LIMIT or
              the line cap. FIXED: the "Читати повністю" button used to
              follow that same static check, so it could appear even when
              the text actually fit and rendered in full at the card's real
              width. It now only shows when isTextClamped confirms the
              rendered box is actually cut off (see the useLayoutEffect
              above) — never next to fully-visible text. Short posts render
              exactly as before — no clamp, no button. */}
          <div className="px-4 py-2.5">
            <p
              ref={contentTextRef}
              className="text-[16px] text-slate-950 dark:text-white/85 leading-relaxed whitespace-pre-wrap"
              style={
                mayNeedClamp
                  ? {
                      display: "-webkit-box",
                      WebkitLineClamp: POST_PREVIEW_LINE_LIMIT,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                    }
                  : undefined
              }
            >
              {post.content}
            </p>
            {isLongContent && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenPost?.();
                }}
                className="mt-1.5 flex items-center gap-1 text-[13px] font-medium
                text-blue-600 dark:text-blue-400/80 hover:text-blue-700 dark:hover:text-blue-400
                transition-colors"
              >
                {t("read_full_post") || "Дивитись повністю"}
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Media */}
          {media.length > 0 && (
            <div
              className="mx-4 mb-3 rounded-lg overflow-hidden
              border border-slate-300 dark:border-white/[0.06]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-0.5 bg-slate-100 dark:bg-white/[0.04]">
                {visibleMedia.map((item, index) => {
                  const isExpanded = expandedMedia[index];
                  return (
                    <div key={index} className="relative">
                      <div
                        className={`overflow-hidden ${isExpanded ? "fixed inset-0 z-50 bg-black/90 flex items-center justify-center" : ""}`}
                      >
                        {item.type === "image" ? (
                          <div className="relative">
                            <img
                              src={item.url}
                              alt={`Media ${index + 1}`}
                              className={`${getMediaDisplayClass(item.type, isExpanded)} ${isExpanded ? "cursor-zoom-out" : "cursor-zoom-in hover:opacity-95 transition-opacity"}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleMediaExpansion(index);
                              }}
                              loading="lazy"
                            />
                            {!isExpanded && (
                              <div
                                className="absolute top-2 right-2 bg-white/80 dark:bg-[#000d1f]/80 border border-slate-300 dark:border-white/[0.1]
                              text-slate-700 dark:text-white/50 text-[11px] px-2 py-1 rounded flex items-center gap-1"
                              >
                                <ImageIcon className="w-3 h-3" />
                                Image
                              </div>
                            )}
                          </div>
                        ) : item.type === "video" ? (
                          <div className="relative">
                            <video
                              src={item.url}
                              controls
                              className={`${getMediaDisplayClass(item.type, isExpanded)} ${isExpanded ? "cursor-zoom-out" : "cursor-zoom-in"}`}
                              onClick={(e) => {
                                if (isExpanded) {
                                  e.stopPropagation();
                                  toggleMediaExpansion(index);
                                }
                              }}
                              preload="metadata"
                            />
                            {!isExpanded && (
                              <div
                                className="absolute top-2 right-2 bg-white/80 dark:bg-[#000d1f]/80 border border-slate-300 dark:border-white/[0.1]
                              text-slate-700 dark:text-white/50 text-[11px] px-2 py-1 rounded flex items-center gap-1"
                              >
                                <VideoIcon className="w-3 h-3" />
                                Video
                              </div>
                            )}
                          </div>
                        ) : (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block p-3.5 bg-slate-50 dark:bg-[#000d1f] hover:bg-slate-100 dark:hover:bg-white/[0.03]
                            transition-colors"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="flex items-center gap-3">
                              <div className="flex-shrink-0">
                                <FileIcon className="w-7 h-7 text-slate-400 dark:text-white/20" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <FileIcon className="w-3 h-3 text-slate-500 dark:text-white/15" />
                                  <span className="text-[11px] text-slate-600 dark:text-white/20">
                                    Document {index + 1}
                                  </span>
                                </div>
                                <p className="text-[13px] font-medium text-slate-800 dark:text-white/55 truncate">
                                  {item.url.split("/").pop()}
                                </p>
                                <p className="text-[11px] text-slate-600 dark:text-white/20 mt-0.5">
                                  Click to download
                                </p>
                              </div>
                            </div>
                          </a>
                        )}
                      </div>

                      {isExpanded && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleMediaExpansion(index);
                          }}
                          className="absolute top-4 right-4 z-50 p-2 bg-white dark:bg-gray-800 rounded-full shadow-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        >
                          <svg
                            className="w-6 h-6 text-gray-800 dark:text-white"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M6 18L18 6M6 6l12 12"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {hiddenMediaCount > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenPost?.();
                  }}
                  className="w-full mt-2 py-1.5 text-xs font-medium
                  text-slate-600 dark:text-gray-400 hover:text-slate-900 dark:hover:text-white/70
                  transition-colors"
                >
                  + {hiddenMediaCount}{" "}
                  {t("more_files") || "more files"} · {t("view_all") || "переглянути всі"}
                </button>
              )}
            </div>
          )}

          <div className="h-px bg-slate-200 dark:bg-white/[0.05] mx-4" />

          {/* Action bar: truth/false, comments, bookmark, share, tip.
              CHANGED: added flex-wrap + gap-y so that on narrow mobile
              screens, when truth/false + comment/save/share/tip don't all
              fit on one line, the icon group wraps onto its own line below
              instead of the tip button getting clipped off-screen. */}
          <div
            className="flex flex-wrap items-center justify-between gap-x-1 gap-y-2 px-3 py-2.5 post-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onReaction?.("truth");
                }}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-[7px]
                text-[13px] font-medium transition-all duration-150
                ${
                  reaction.mine === "truth"
                    ? "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400"
                    : "bg-emerald-500/[0.04] text-emerald-600/60 dark:text-emerald-400/50 hover:bg-emerald-500/[0.13] hover:text-emerald-600 dark:hover:text-emerald-400"
                }`}
              >
                {reaction.mine === "truth" && (
                  <CheckCircle className="w-5 h-5" />
                )}
                {t("truth") || "Truth"}
                {reaction.truth > 0 && (
                  <span className="text-[11px] opacity-80">
                    {reaction.truth}
                  </span>
                )}
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onReaction?.("false");
                }}
                className={`flex items-center gap-1 px-2.5 py-1.5 rounded-[7px]
                text-[13px] font-medium transition-all duration-150
                ${
                  reaction.mine === "false"
                    ? "bg-red-500/15 text-red-500 dark:text-red-400"
                    : "bg-red-500/[0.04] text-red-600/60 dark:text-red-400/50 hover:bg-red-500/[0.13] hover:text-red-600 dark:hover:text-red-400"
                }`}
              >
                {reaction.mine === "false" && (
                  <XCircle className="w-5 h-5" />
                )}
                {t("false") || "False"}
                {reaction.false > 0 && (
                  <span className="text-[11px] opacity-80">
                    {reaction.false}
                  </span>
                )}
              </button>
            </div>

            <div className="flex items-center gap-0.5 flex-wrap justify-end">
              {/* CHANGED: tipButton now renders FIRST in this group — it's
                  the monetization CTA and the most important action here,
                  so it should never be the element that gets clipped or
                  pushed off-screen. Comment/save/share (universally
                  understood icon-only actions) come after and are the ones
                  that wrap/shrink first when space is tight. */}
              {/* CHANGED: cloned with `containerRef` so TipButton portals
                  its expanded panel into `tipSlotRef` below (a slide-out
                  section, same pattern as quick comments) instead of a
                  floating popup positioned near the button. */}
              {tipButton && (
                <div className="flex-shrink-0">
                  {React.cloneElement(tipButton, { containerRef: tipSlotRef })}
                </div>
              )}

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // CHANGED: only toggles the inline quick-comment panel now.
                  // Previously this also called onCommentIconClick?.(), which
                  // in the parent navigates to PostPage — that caused an
                  // unwanted redirect right after the panel opened.
                  setIsQuickCommentOpen((v) => !v);
                }}
                className={`w-10 h-10 rounded-[7px] flex items-center justify-center transition-all
                ${
                  isQuickCommentOpen
                    ? "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-500/10"
                    : "text-slate-600 dark:text-white/55 hover:text-slate-900 dark:hover:text-white/80 hover:bg-slate-100 dark:hover:bg-white/[0.05]"
                }`}
              >
                <MessageCircle className="w-5 h-5" />
              </button>

              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onSave?.();
                }}
                disabled={isSaving}
                className={`w-10 h-10 rounded-[7px] flex items-center justify-center
                transition-all disabled:opacity-40
                ${
                  isSaved
                    ? "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-500/10"
                    : "text-slate-600 dark:text-white/55 hover:text-slate-900 dark:hover:text-white/80 hover:bg-slate-100 dark:hover:bg-white/[0.05]"
                }`}
              >
                {isSaving ? (
                  <div className="w-5 h-5 rounded-full border border-blue-400/50 border-t-transparent animate-spin" />
                ) : isSaved ? (
                  <BookmarkCheck className="w-5 h-5" />
                ) : (
                  <Bookmark className="w-5 h-5" />
                )}
              </button>

              <button
                onClick={handleShareClick}
                disabled={isSharing}
                className="w-10 h-10 rounded-[7px] flex items-center justify-center
                text-slate-600 dark:text-white/55 hover:text-slate-900 dark:hover:text-white/80 hover:bg-slate-100 dark:hover:bg-white/[0.05]
                transition-all disabled:opacity-40"
              >
                {isSharing ? (
                  <div className="w-5 h-5 rounded-full border border-blue-400/50 border-t-transparent animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
            </div>
          </div>

          {/* ADDED: slot the "Гонорар" panel portals into when open. Stays
              in normal document flow, right under the action bar, so it
              pushes the rest of the card down — exactly like quick
              comments — instead of floating over other content. Always
              rendered (when tipButton exists) but empty/zero-height until
              TipButton portals content into it. */}
          {tipButton && (
            <div ref={tipSlotRef} onClick={(e) => e.stopPropagation()} />
          )}

          {/* Comment — CHANGED: now a conditional block. showQuickComment=false
              (the individual post page, PostPage.jsx) hides this field,
              since there's already a full <CommentsSection/> below the
              card there — there shouldn't be two comment input fields at
              once. In the feed (CountryFeed.jsx on CountryPage)
              showQuickComment stays true by default, and the field
              remains deliberately SINGLE-LINE — it's a quick comment from
              the feed, not a full thread. */}
          {showQuickComment && isQuickCommentOpen && (
            <div
              className="px-4 pb-3 comment-section"
              onClick={(e) => e.stopPropagation()}
            >
              {/* ADDED: preview of attached files */}
              {quickMediaFiles.length > 0 && (
                <div className="grid grid-cols-4 gap-1.5 mb-2">
                  {quickMediaFiles.map((file, index) => (
                    <div
                      key={index}
                      className="relative group border border-slate-300 dark:border-white/[0.07]
                        rounded-lg overflow-hidden bg-slate-50 dark:bg-[#050e1f]"
                    >
                      {file.type.startsWith("image/") ? (
                        <img
                          src={URL.createObjectURL(file)}
                          alt={file.name}
                          className="w-full h-14 object-cover"
                          loading="lazy"
                        />
                      ) : file.type.startsWith("video/") ? (
                        <div className="w-full h-14 flex items-center justify-center">
                          <VideoIcon className="w-4 h-4 text-slate-500 dark:text-white/20" />
                        </div>
                      ) : (
                        <div className="w-full h-14 flex items-center justify-center">
                          <FileIcon className="w-4 h-4 text-slate-500 dark:text-white/20" />
                        </div>
                      )}
                      <button
                        onClick={() => removeQuickMediaFile(index)}
                        aria-label={t("remove_file") || "Delete"}
                        className="absolute top-0.5 right-0.5 w-4 h-4
                          bg-[#000d1f]/90 border border-red-800/30
                          text-red-400/70 hover:text-red-400/95
                          hover:bg-[#1a0505] rounded
                          flex items-center justify-center
                          transition-all"
                      >
                        <X className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {quickFileError && (
                <div className="flex items-center justify-between mb-2 px-2 py-1 bg-red-500/[0.07] border border-red-500/20 rounded-lg">
                  <p className="text-[11px] text-red-500 dark:text-red-400/75">
                    {quickFileError}
                  </p>
                  <button
                    onClick={() => setQuickFileError("")}
                    className="text-slate-600 dark:text-white/40 hover:text-slate-800 dark:hover:text-white/50 ml-2"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}

              {/* CHANGED: textarea now sits on its own full-width row, with
                  media/emoji/Send in a separate row below — instead of
                  sharing one row where the buttons ate into the textarea's
                  width. This also means growth is purely vertical: the
                  field can use the full card width no matter how long the
                  comment gets. */}
              <textarea
                ref={quickInputRef}
                rows={1}
                value={commentValue}
                onChange={(e) => {
                  setCommentValue(e.target.value);
                  autoResizeQuickInput();
                }}
                placeholder={t("write_comment") || "Write a comment..."}
                className="w-full px-3 py-2.5 text-[16px] leading-[1.4] resize-none
                bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.08] rounded-lg
                text-slate-800 dark:text-white/55 placeholder-slate-400 dark:placeholder-white/[0.16]
                focus:outline-none focus:border-blue-400 dark:focus:border-blue-500/35 focus:ring-1 focus:ring-blue-300/30 dark:focus:ring-blue-500/15
                transition-[height,border-color,box-shadow] font-['Inter']"
                onKeyDown={(e) => {
                  // Enter sends the comment, Shift+Enter adds a new line.
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleCommentSend();
                  }
                }}
              />

              <div className="flex items-center gap-2 mt-2">
                {/* ADDED: add-media button */}
                <button
                  type="button"
                  onClick={() => quickFileInputRef.current?.click()}
                  disabled={quickMediaFiles.length >= MAX_QUICK_COMMENT_FILES}
                  title={t("add_media") || "Media"}
                  className="w-10 h-10 flex-shrink-0 rounded-lg flex items-center justify-center
                    border border-slate-300 dark:border-white/[0.09]
                    bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/40
                    hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65
                    transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Upload className="w-5 h-5" />
                </button>
                <input
                  type="file"
                  ref={quickFileInputRef}
                  onChange={handleQuickFileSelect}
                  multiple
                  accept="image/*,video/*,.pdf,.txt,.doc,.docx"
                  className="hidden"
                />

                {/* ADDED: emoji button */}
                <div className="relative flex-shrink-0">
                  <button
                    ref={quickEmojiButtonRef}
                    type="button"
                    onClick={() => setShowQuickEmojiPicker((v) => !v)}
                    title={t("add_emoji") || "Emoji"}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center
                      border transition-all
                      ${
                        showQuickEmojiPicker
                          ? "border-blue-400 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-900/15 text-blue-600 dark:text-blue-400/80"
                          : "border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/60"
                      }`}
                  >
                    <Smile className="w-5 h-5" />
                  </button>

                  {showQuickEmojiPicker &&
                    quickEmojiPickerStyle &&
                    createPortal(
                      <div
                        ref={quickEmojiPickerRef}
                        className="fixed z-50 rounded-2xl overflow-hidden border
                          border-slate-300 dark:border-white/[0.1] shadow-xl
                          dark:shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
                        style={{
                          top: quickEmojiPickerStyle.top,
                          left: quickEmojiPickerStyle.left,
                        }}
                      >
                        <EmojiPicker
                          onEmojiClick={insertQuickEmoji}
                          theme={
                            isDarkMode ? EmojiTheme.DARK : EmojiTheme.LIGHT
                          }
                          width={quickEmojiPickerStyle.width}
                          height={quickEmojiPickerStyle.height}
                          searchPlaceholder={
                            t("search_emoji", "Search emoji...") ||
                            "Search emoji..."
                          }
                          previewConfig={{ showPreview: false }}
                          skinTonesDisabled
                        />
                      </div>,
                      document.body,
                    )}
                </div>

                <button
                  onClick={handleCommentSend}
                  disabled={
                    !commentValue.trim() && quickMediaFiles.length === 0
                  }
                  className="ml-auto px-4 py-2.5 text-[13px] font-medium
                  bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232]
                  dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-[#e8a0b0]/75 dark:hover:bg-[#3d0012]
                  rounded-lg transition-colors
                  disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {t("send") || "Send"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showShareModal && (
        <SharePostModal
          postId={post.id}
          content={post.content}
          authorName={post.author?.name}
          authorAvatar={post.author?.avatar}
          shareCount={post.shareCount}
          onClose={() => setShowShareModal(false)}
          t={t}
        />
      )}
    </div>
  );
};

export default PostCard;
