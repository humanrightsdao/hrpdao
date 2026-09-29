// src/components/CommentsSection.jsx
//
// A presentational comments component — the same JSX/styles that used
// to be "baked into" PostPage.jsx, now extracted separately, so it can
// be plugged into HelpRequestPage.jsx / ViolationDetailsPage.jsx without
// duplicating the markup.
//
// The component does NOT talk to the Lens API directly — all data and
// actions come from the useLensComments() hook (comments/postComment/
// deleteComment/reactToComment/isCommentOwner). This lets one and the
// same <CommentsSection /> serve a post, a help_request, or a violation
// — the only difference is which lensPostId the hook was initialized
// with on the page.
//
// Props:
//   comments            — the array of comments from useLensComments
//   lensProfile         — the currently logged-in profile (or null)
//   postingComment       — bool, whether sending is in progress
//   onSubmitComment(text, mediaFiles) — submit a new comment
//                          (mediaFiles — a File[] array, can be empty)
//   onDeleteComment(id)   — delete your own comment
//   onReactComment(id, "truth"|"false") — react to a comment
//   onReportComment(comment) — open the ReportModal for a comment
//   isCommentOwner(comment)  — whether this comment belongs to the current user
//   getCountryDisplayName(code) — the same helper used on the pages
//   formatDate(iso)      — the same date-formatting helper
//
// Optional moderation props (only the author of the post/violation/request
// being commented on can use them — Lens enforces that server-side):
//   canModerateComments      — show "Hide" and the "Hidden comments" section
//   onHideComment(id)        — hide a comment (Lens hideReply); returns {success}
//   onUnhideComment(id)      — restore a hidden comment (Lens unhideReply)
//   onLoadHiddenComments()   — load the hidden comments (called when the
//                              "Hidden comments" section is opened)
//   hiddenComments           — the array of hidden comments
//   loadingHidden            — bool, whether hidden comments are loading
//
// Comments posted through a different Lens app (comment.is_external_app)
// get an "External Lens app" badge.
//
// Clicking a comment author's avatar or name navigates to their public
// profile (/user/:userId) — same as clicking a post author in the feed.

import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
// ADDED: display-time AI moderation ("Atticus Guard") — see AI_MODERATION.md.
import { useAIVerdicts } from "../hooks/useAIVerdicts";
import { isFlagged, primaryCategoryLabel } from "../utils/aiModeration";
import EmojiPicker, { Theme as EmojiTheme } from "emoji-picker-react";
import {
  MessageCircle,
  MoreVertical,
  CheckCircle,
  XCircle,
  Trash2,
  Flag,
  Upload,
  Smile,
  Video,
  File,
  X,
  Maximize2,
  ExternalLink,
  EyeOff,
  RotateCcw,
} from "lucide-react";

// ADDED: the same limits as in CreatePostModal.jsx — up to 4 files,
// 10MB each, the same list of allowed types. Deliberately duplicated
// here (rather than imported), so CommentsSection remains a self-
// contained presentational component with no dependency on CreatePostModal.jsx.
const MAX_COMMENT_FILES = 4;
const MAX_FILE_SIZE = 10 * 1024 * 1024;
// ADDED: max length for a comment's text. A comment is a reply/reaction,
// not a standalone post - much shorter than CreatePostModal.jsx's 3000 or
// ViolationsPage.jsx's 6000, but still enough room for a real, detailed
// reply (not just a one-liner).
const MAX_COMMENT_LENGTH = 1000;
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

export default function CommentsSection({
  comments,
  lensProfile,
  postingComment,
  onSubmitComment,
  onDeleteComment,
  onReactComment,
  onReportComment,
  isCommentOwner,
  getCountryDisplayName,
  formatDate,
  canModerateComments = false,
  onHideComment,
  onUnhideComment,
  onLoadHiddenComments,
  hiddenComments = [],
  loadingHidden = false,
  // ADDED: the text of the post/violation/request being commented on.
  // Lets the AI judge relevance (a generic copy-paste reply that says
  // nothing about the post is bot-like spam).
  moderationContext = "",
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  // ADDED: AI verdicts for the comments on screen. A "flag"/"block" verdict
  // collapses that comment's body behind a notice with a "Show anyway"
  // button — nothing is deleted or hidden for good, and a comment with no
  // verdict yet (loading, service down, too short) renders normally.
  const aiItems = useMemo(
    () =>
      comments.map((c) => ({
        id: c.id,
        kind: "comment",
        text: c.content || "",
        context: moderationContext,
      })),
    [comments, moderationContext],
  );
  const aiVerdicts = useAIVerdicts(aiItems);
  const [revealedAI, setRevealedAI] = useState(() => new Set());
  const [commentInput, setCommentInput] = useState("");
  const [showCommentMenu, setShowCommentMenu] = useState(null);
  // ADDED: hide/restore UI state.
  const [showHidden, setShowHidden] = useState(false);
  const [actionError, setActionError] = useState("");

  // ADDED: a fullscreen view of a comment's media (clicking an image /
  // the video-expand button) — previously a comment's image/video was
  // rendered as a plain <img>/<video> with no way to view it fully after
  // it was published.
  const [lightboxMedia, setLightboxMedia] = useState(null);

  // ADDED: media + emoji for the comment, the same pattern used in
  // CreatePostModal.jsx (mediaFiles/showEmojiPicker/fileInputRef/...).
  const [mediaFiles, setMediaFiles] = useState([]);
  const [fileError, setFileError] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiPickerStyle, setEmojiPickerStyle] = useState(null);
  const fileInputRef = useRef(null);
  const inputRef = useRef(null);
  const emojiPickerRef = useRef(null);
  const emojiButtonRef = useRef(null);

  const isDarkMode =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");

  // ADDED: positioning the popup EmojiPicker relative to the button —
  // identical logic to computeEmojiPickerPosition() in
  // CreatePostModal.jsx, just a smaller WIDTH/height to fit the narrower
  // comments block.
  const computeEmojiPickerPosition = useCallback(() => {
    const btn = emojiButtonRef.current;
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
    if (!showEmojiPicker) {
      setEmojiPickerStyle(null);
      return;
    }
    const update = () => setEmojiPickerStyle(computeEmojiPickerPosition());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [showEmojiPicker, computeEmojiPickerPosition]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(e.target) &&
        emojiButtonRef.current &&
        !emojiButtonRef.current.contains(e.target)
      ) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Inserting emoji at the cursor position — the same logic used in
  // CreatePostModal.jsx insertEmoji().
  const insertEmoji = (emojiData) => {
    const emoji = emojiData.emoji;
    const input = inputRef.current;
    if (!input) {
      setCommentInput((prev) => prev + emoji);
      setShowEmojiPicker(false);
      return;
    }

    const start = input.selectionStart ?? commentInput.length;
    const end = input.selectionEnd ?? commentInput.length;
    const newText =
      commentInput.substring(0, start) + emoji + commentInput.substring(end);
    setCommentInput(newText);

    setTimeout(() => {
      input.focus();
      input.setSelectionRange(start + emoji.length, start + emoji.length);
    }, 0);

    setShowEmojiPicker(false);
  };

  const handleFileSelect = (event) => {
    const files = Array.from(event.target.files);
    if (mediaFiles.length + files.length > MAX_COMMENT_FILES) {
      setFileError(t("max_4_files") || "Maximum 4 files");
      event.target.value = "";
      return;
    }

    const validFiles = files.filter((file) => {
      if (file.size > MAX_FILE_SIZE) {
        setFileError(
          `${file.name}: ${t("file_too_large") || "file is too large (max. 10MB)"}`,
        );
        return false;
      }
      if (!ALLOWED_FILE_TYPES.includes(file.type)) {
        setFileError(
          `${file.name}: ${t("file_type_not_supported") || "file type not supported"}`,
        );
        return false;
      }
      return true;
    });

    setMediaFiles((prev) => [...prev, ...validFiles]);
    event.target.value = "";
  };

  const removeMediaFile = (index) => {
    setMediaFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const submit = () => {
    if (!commentInput.trim() && mediaFiles.length === 0) return;
    // ADDED: defense-in-depth alongside the textarea's maxLength below —
    // maxLength stops normal typing/pasting, but this catches any content
    // that reaches state some other way before it gets published. Reuses
    // the existing file-error banner below the input for the message.
    if (commentInput.trim().length > MAX_COMMENT_LENGTH) {
      setFileError(
        t("comment_too_long", { max: MAX_COMMENT_LENGTH }) ||
          `Comment is too long (max ${MAX_COMMENT_LENGTH} characters)`,
      );
      return;
    }
    onSubmitComment(commentInput, mediaFiles);
    setCommentInput("");
    setMediaFiles([]);
    setFileError("");
  };

  const handleDelete = (commentId) => {
    if (
      !window.confirm(
        t("confirm_delete_comment") ||
          "Are you sure you want to delete this comment?",
      )
    ) {
      return;
    }
    setShowCommentMenu(null);
    onDeleteComment(commentId);
  };

  const handleReport = (comment) => {
    setShowCommentMenu(null);
    onReportComment(comment);
  };

  // ADDED: open the public profile of a comment's author — the same
  // route ("/user/:userId") and the same identifier (the Lens Account
  // address) that PostCard's onAuthorClick uses for the post author in
  // the feed (post.lens_user_id || post.user_id === comment.author.id,
  // see useLensComments.js). Previously the name/avatar in a comment
  // were plain non-clickable elements.
  const getCommentAuthorId = (comment) =>
    comment.author?.id || comment.author?.wallet_address || null;

  const openAuthorProfile = (comment) => {
    const authorId = getCommentAuthorId(comment);
    if (authorId) navigate(`/user/${authorId}`);
  };

  // ADDED: hide a comment (post author only). Hidden comments disappear
  // for everyone and can be restored from the "Hidden comments" section.
  const handleHide = async (commentId) => {
    setShowCommentMenu(null);
    if (
      !window.confirm(
        t(
          "confirm_hide_comment",
          "Hide this comment for everyone? You can restore it later from “Hidden comments”.",
        ),
      )
    ) {
      return;
    }
    setActionError("");
    const res = await onHideComment?.(commentId);
    if (res && !res.success) {
      setActionError(
        t(
          "comment_action_failed",
          "Couldn't complete the action. Please try again.",
        ),
      );
    }
  };

  const handleUnhide = async (commentId) => {
    setActionError("");
    const res = await onUnhideComment?.(commentId);
    if (res && !res.success) {
      setActionError(
        t(
          "comment_action_failed",
          "Couldn't complete the action. Please try again.",
        ),
      );
    }
  };

  const toggleHiddenSection = () => {
    const next = !showHidden;
    setShowHidden(next);
    if (next) onLoadHiddenComments?.();
  };

  // ADDED: the "External Lens app" marker — Lens is an open protocol, so
  // comments can come from accounts that never used this app. Only the
  // icon is shown inline; the label (+ short explanation) appears in a
  // tooltip on hover. It is also focusable (keyboard / tap on touch
  // screens, where there is no hover) and has an aria-label for screen
  // readers. The tooltip opens BELOW the icon: the section root has
  // overflow-hidden, so an upward tooltip on the first comment could
  // otherwise be clipped.
  const externalLabel = t("external_lens_app", "External Lens app");
  const externalBadge = (
    <span
      className="group relative inline-flex flex-shrink-0"
      tabIndex={0}
      role="img"
      aria-label={externalLabel}
      onClick={(e) => e.currentTarget.focus()}
    >
      <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded bg-amber-100 dark:bg-amber-900/20 border border-amber-300/60 dark:border-amber-700/25 text-amber-700 dark:text-amber-400/75 cursor-help">
        <ExternalLink className="w-3 h-3" />
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full mt-1 z-20 hidden group-hover:block group-focus:block w-max max-w-[220px] rounded-lg border border-slate-300 dark:border-white/[0.1] bg-white dark:bg-[#000d1f] shadow-lg px-2.5 py-1.5"
      >
        <span className="block text-[11px] font-medium text-amber-700 dark:text-amber-400/80">
          {externalLabel}
        </span>
        <span className="block mt-0.5 text-[11px] leading-snug text-slate-500 dark:text-white/40 whitespace-normal">
          {t(
            "external_lens_app_hint",
            "This comment was posted through a different Lens app, not this one",
          )}
        </span>
      </span>
    </span>
  );

  return (
    <div
      id="comments-section"
      className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-slate-100 dark:border-white/[0.06]">
        <h3 className="text-[12px] font-medium text-slate-600 dark:text-white/40 uppercase tracking-wider">
          {t("comments") || "Comments"} ({comments.length})
        </h3>
      </div>

      {actionError && (
        <div className="flex items-center justify-between px-4 py-2 bg-red-500/[0.07] border-b border-red-500/20">
          <p className="text-[12px] text-red-500 dark:text-red-400/75">
            {actionError}
          </p>
          <button
            type="button"
            onClick={() => setActionError("")}
            className="p-1 -mr-1 text-slate-600 dark:text-white/40 hover:text-slate-800 dark:hover:text-white/50 ml-2"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Comment input */}
      {lensProfile && (
        <div className="p-4 border-b border-slate-100 dark:border-white/[0.06]">
          <div className="flex items-start gap-2.5">
            <div className="flex-shrink-0">
              <div className="relative w-[32px] h-[36px] p-[1.5px] clip-path-hexagon bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]">
                <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                  {lensProfile.avatar ? (
                    <img
                      src={lensProfile.avatar}
                      alt={lensProfile.name || lensProfile.localName}
                      className="w-full h-full object-cover"
                    />
                  ) : null}
                  <div
                    className={`avatar-fallback w-full h-full flex items-center justify-center font-cinzel text-[13px] text-[#c8b8a2] bg-[#0d0415] ${lensProfile.avatar ? "hidden" : "flex"}`}
                  >
                    {(lensProfile.name ||
                      lensProfile.localName)?.[0]?.toUpperCase() || "U"}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="text-[13px] font-medium text-slate-700 dark:text-white/70">
                  {lensProfile.name || lensProfile.localName || t("anonymous")}
                </span>
                {lensProfile.handle && (
                  <span className="text-[11px] text-slate-600 dark:text-white/30">
                    {lensProfile.handle}
                  </span>
                )}
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/25 border border-blue-300/50 dark:border-blue-700/20 text-blue-700 dark:text-blue-400/65">
                  {getCountryDisplayName(lensProfile.country)}
                </span>
              </div>
              {/* ADDED: preview of attached files above the input field —
                  the same thumbnail look used in CreatePostModal.jsx,
                  just a bit more compact to fit the width of the comments block. */}
              {mediaFiles.length > 0 && (
                <div className="grid grid-cols-4 gap-1.5 mb-2">
                  {mediaFiles.map((file, index) => (
                    <div
                      key={index}
                      className="relative group border border-slate-300 dark:border-white/[0.07]
                        rounded-lg overflow-hidden bg-slate-50 dark:bg-[#050e1f]"
                    >
                      {file.type.startsWith("image/") ? (
                        <img
                          src={URL.createObjectURL(file)}
                          alt={file.name}
                          className="w-full h-16 object-cover"
                          loading="lazy"
                        />
                      ) : file.type.startsWith("video/") ? (
                        <div className="w-full h-16 flex items-center justify-center">
                          <Video className="w-4 h-4 text-slate-500 dark:text-white/20" />
                        </div>
                      ) : (
                        <div className="w-full h-16 flex items-center justify-center">
                          <File className="w-4 h-4 text-slate-500 dark:text-white/20" />
                        </div>
                      )}
                      <button
                        onClick={() => removeMediaFile(index)}
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

              {fileError && (
                <div className="flex items-center justify-between mb-2 px-2 py-1 bg-red-500/[0.07] border border-red-500/20 rounded-lg">
                  <p className="text-[11px] text-red-500 dark:text-red-400/75">
                    {fileError}
                  </p>
                  <button
                    onClick={() => setFileError("")}
                    className="p-1 -mr-1 text-slate-600 dark:text-white/40 hover:text-slate-800 dark:hover:text-white/50 ml-2"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* CHANGED: used to be a single-line <input>, now a
                  multi-line <textarea> — per the request: "make the
                  comment-writing area bigger". Enter sends the comment,
                  Shift+Enter — a new line (like in most chat apps). */}
              <textarea
                ref={inputRef}
                value={commentInput}
                onChange={(e) => setCommentInput(e.target.value)}
                placeholder={t("write_comment") || "Write a comment..."}
                rows={3}
                maxLength={MAX_COMMENT_LENGTH}
                className="w-full px-3 py-2.5 text-[16px] bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.08] rounded-lg text-slate-600 dark:text-white/55 placeholder-slate-400 dark:placeholder-white/[0.16] focus:outline-none focus:border-blue-400 dark:focus:border-blue-500/35 focus:ring-1 focus:ring-blue-300/30 dark:focus:ring-blue-500/15 transition-all font-['Inter'] resize-y min-h-[76px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              {/* ADDED: "N / 1000" counter, same escalating-color pattern
                  as the other content-length counters in the app. Only
                  shown once the user starts typing, to avoid clutter on
                  an empty field. */}
              {commentInput.length > 0 && (
                <p
                  className={`mt-1 text-right text-[12px] font-mono ${
                    commentInput.length >= MAX_COMMENT_LENGTH
                      ? "text-red-500 dark:text-red-400/80 font-medium"
                      : commentInput.length >= MAX_COMMENT_LENGTH * 0.9
                        ? "text-amber-500 dark:text-amber-400/80"
                        : "text-slate-600 dark:text-white/40"
                  }`}
                >
                  {commentInput.length} / {MAX_COMMENT_LENGTH}
                </p>
              )}

              <div className="flex items-center gap-2 mt-2">
                {/* ADDED: add-media button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={
                    postingComment || mediaFiles.length >= MAX_COMMENT_FILES
                  }
                  title={t("add_media") || "Media"}
                  className="w-10 h-10 flex-shrink-0 rounded-lg flex items-center justify-center
                    border border-slate-300 dark:border-white/[0.09]
                    bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/40
                    hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65
                    transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Upload className="w-4 h-4" />
                </button>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileSelect}
                  multiple
                  accept="image/*,video/*,.pdf,.txt,.doc,.docx"
                  className="hidden"
                />

                {/* ADDED: emoji button */}
                <div className="relative flex-shrink-0">
                  <button
                    ref={emojiButtonRef}
                    type="button"
                    onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                    disabled={postingComment}
                    title={t("add_emoji") || "Emoji"}
                    className={`w-10 h-10 rounded-lg flex items-center justify-center
                      border transition-all disabled:opacity-30
                      ${
                        showEmojiPicker
                          ? "border-blue-400 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-900/15 text-blue-600 dark:text-blue-400/80"
                          : "border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/60"
                      }`}
                  >
                    <Smile className="w-4 h-4" />
                  </button>

                  {showEmojiPicker &&
                    emojiPickerStyle &&
                    createPortal(
                      <div
                        ref={emojiPickerRef}
                        className="fixed z-50 rounded-2xl overflow-hidden border
                          border-slate-300 dark:border-white/[0.1] shadow-xl
                          dark:shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
                        style={{
                          top: emojiPickerStyle.top,
                          left: emojiPickerStyle.left,
                        }}
                      >
                        <EmojiPicker
                          onEmojiClick={insertEmoji}
                          theme={
                            isDarkMode ? EmojiTheme.DARK : EmojiTheme.LIGHT
                          }
                          width={emojiPickerStyle.width}
                          height={emojiPickerStyle.height}
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
                  onClick={submit}
                  disabled={
                    (!commentInput.trim() && mediaFiles.length === 0) ||
                    postingComment ||
                    commentInput.length > MAX_COMMENT_LENGTH
                  }
                  className="ml-auto px-4 py-2.5 text-[13px] font-medium bg-[#2B000A] border border-[#2B000A]/50 text-[#e8a0b0]/75 rounded-lg hover:bg-[#3d0012] transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  {postingComment
                    ? t("posting") || "..."
                    : t("send") || "Send"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Comments list */}
      <div className="divide-y divide-slate-100 dark:divide-white/[0.05]">
        {comments.length === 0 ? (
          <div className="flex flex-col items-center py-10">
            <MessageCircle className="w-8 h-8 text-slate-200 dark:text-white/[0.08] mb-2" />
            <p className="text-[13px] text-slate-600 dark:text-white/20">
              {t("no_comments_yet") || "No comments yet"}
            </p>
          </div>
        ) : (
          comments.map((comment) => {
            const commentAuthorName =
              comment.author?.name ||
              comment.author?.unique_name ||
              t("anonymous");
            const commentAuthorHandle = comment.author?.unique_name
              ? `@${comment.author.unique_name}`
              : null;
            const commentAuthorAvatar = comment.author?.avatar_url;
            const commentAuthorInitial = (commentAuthorName ||
              "U")[0].toUpperCase();
            const commentAuthorCountry = comment.author?.country;
            const commentAuthorId = getCommentAuthorId(comment);
            const aiVerdict = aiVerdicts.get(comment.id);
            const aiCollapsed =
              isFlagged(aiVerdict) && !revealedAI.has(comment.id);

            return (
              <div
                key={comment.id}
                className="p-4 hover:bg-slate-50 dark:hover:bg-white/[0.02] transition-colors"
              >
                <div className="flex items-start gap-2.5">
                  {/* Avatar — click opens the author's public profile */}
                  <button
                    type="button"
                    onClick={() => openAuthorProfile(comment)}
                    disabled={!commentAuthorId}
                    aria-label={commentAuthorName}
                    title={commentAuthorName}
                    className="flex-shrink-0 p-0 bg-transparent border-0 enabled:cursor-pointer enabled:hover:opacity-85 transition-opacity disabled:cursor-default"
                  >
                    <div className="relative w-[40px] h-[44px] p-[1.5px] clip-path-hexagon bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]">
                      <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                        {commentAuthorAvatar ? (
                          <img
                            src={commentAuthorAvatar}
                            alt={commentAuthorName}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                              e.target.style.display = "none";
                              const fallback =
                                e.target.parentElement?.querySelector(
                                  ".avatar-fallback",
                                );
                              if (fallback) fallback.style.display = "flex";
                            }}
                          />
                        ) : null}
                        <div
                          className={`avatar-fallback w-full h-full flex items-center justify-center font-cinzel text-[11px] text-[#c8b8a2] bg-[#0d0415] ${commentAuthorAvatar ? "hidden" : "flex"}`}
                        >
                          {commentAuthorInitial}
                        </div>
                      </div>
                    </div>
                  </button>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          onClick={() => openAuthorProfile(comment)}
                          disabled={!commentAuthorId}
                          className="text-[13px] font-medium text-slate-700 dark:text-white/70 text-left enabled:cursor-pointer enabled:hover:text-slate-950 dark:enabled:hover:text-white/95 enabled:hover:underline transition-colors disabled:cursor-default"
                        >
                          {commentAuthorName}
                        </button>
                        {commentAuthorHandle && (
                          <span className="text-[11px] text-slate-600 dark:text-white/25">
                            {commentAuthorHandle}
                          </span>
                        )}
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/25 border border-blue-300/50 dark:border-blue-700/20 text-blue-700 dark:text-blue-400/65">
                          {getCountryDisplayName(commentAuthorCountry)}
                        </span>
                        {comment.is_external_app && externalBadge}
                        <span className="text-[11px] text-slate-600 dark:text-white/20">
                          {formatDate(comment.created_at)}
                        </span>
                      </div>

                      {/* Comment menu — "Delete" for the owner, "Report" for everyone else */}
                      {lensProfile && (
                        <div className="relative">
                          <button
                            onClick={() =>
                              setShowCommentMenu(
                                showCommentMenu === comment.id
                                  ? null
                                  : comment.id,
                              )
                            }
                            className="p-2 hover:bg-slate-100 dark:hover:bg-white/[0.05] rounded-full transition-colors"
                          >
                            <MoreVertical className="w-4 h-4 text-slate-500 dark:text-white/20" />
                          </button>
                          {showCommentMenu === comment.id && (
                            <div className="absolute right-0 mt-1 w-44 bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.1] rounded-lg shadow-lg z-10 p-1">
                              {isCommentOwner(comment) ? (
                                <button
                                  onClick={() => handleDelete(comment.id)}
                                  className="w-full px-3 py-2 text-left text-[12px] text-red-500 dark:text-red-400/70 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md flex items-center gap-2 transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                  {t("delete") || "Delete"}
                                </button>
                              ) : (
                                <>
                                  {/* ADDED: hide — post author only */}
                                  {canModerateComments && onHideComment && (
                                    <button
                                      onClick={() => handleHide(comment.id)}
                                      className="w-full px-3 py-2 text-left text-[12px] text-slate-600 dark:text-white/55 hover:text-slate-900 dark:hover:text-white/80 hover:bg-slate-100 dark:hover:bg-white/[0.05] rounded-md flex items-center gap-2 transition-colors"
                                    >
                                      <EyeOff className="w-3.5 h-3.5" />
                                      {t("hide_comment", "Hide")}
                                    </button>
                                  )}
                                  <button
                                    onClick={() => handleReport(comment)}
                                    className="w-full px-3 py-2 text-left text-[12px] text-red-500 dark:text-red-400/70 hover:text-red-600 dark:hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10 rounded-md flex items-center gap-2 transition-colors"
                                  >
                                    <Flag className="w-3.5 h-3.5" />
                                    {t("report") || "Report"}
                                  </button>
                                </>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {aiCollapsed ? (
                      <div
                        title={aiVerdict?.reason || undefined}
                        className="mb-1 flex items-center justify-between gap-3 rounded-lg border border-amber-300/60 dark:border-amber-700/25 bg-amber-50 dark:bg-amber-900/10 px-3 py-2.5"
                      >
                        <p className="text-[12px] leading-snug text-amber-800 dark:text-amber-300/80">
                          {t("ai_moderation_comment_flagged", {
                            category: primaryCategoryLabel(aiVerdict),
                            defaultValue:
                              "⚠️ Atticus AI flagged this comment automatically (reason: {{category}}). It is awaiting human review.",
                          })}
                        </p>
                        <button
                          type="button"
                          onClick={() =>
                            setRevealedAI((prev) => new Set(prev).add(comment.id))
                          }
                          className="flex-shrink-0 px-2.5 py-1 text-[11px] rounded-md bg-slate-200 dark:bg-white/10 text-slate-800 dark:text-white/75 hover:bg-slate-300 dark:hover:bg-white/20 transition-colors"
                        >
                          {t("ai_moderation_show_anyway", {
                            defaultValue: "Show anyway",
                          })}
                        </button>
                      </div>
                    ) : (
                      <>
                    {comment.content && (
                      <p className="text-[13px] text-slate-600 dark:text-white/55 leading-relaxed whitespace-pre-wrap mb-2">
                        {comment.content}
                      </p>
                    )}

                    {/* ADDED: media files attached to a comment
                        (comment.media_urls/media_types from useLensComments.js).
                        Clicking an image or the expand button on a video
                        opens lightboxMedia — a fullscreen view. */}
                    {comment.media_urls?.length > 0 && (
                      <div className="grid grid-cols-2 gap-1.5 mb-2 max-w-sm">
                        {comment.media_urls.map((url, index) =>
                          comment.media_types?.[index] === "image" ? (
                            <img
                              key={index}
                              src={url}
                              alt=""
                              className="rounded-lg w-full h-28 object-cover border border-slate-200 dark:border-white/[0.06] cursor-zoom-in hover:opacity-90 transition-opacity"
                              loading="lazy"
                              onClick={() =>
                                setLightboxMedia({ url, type: "image" })
                              }
                            />
                          ) : comment.media_types?.[index] === "video" ? (
                            <div className="relative">
                              <video
                                src={url}
                                controls
                                className="rounded-lg w-full h-28 object-cover border border-slate-200 dark:border-white/[0.06]"
                              />
                              <button
                                type="button"
                                onClick={() =>
                                  setLightboxMedia({ url, type: "video" })
                                }
                                title={t("expand") || "Expand"}
                                className="absolute top-1.5 right-1.5 w-8 h-8 rounded-md
                                  bg-black/60 hover:bg-black/80 text-white/90
                                  flex items-center justify-center transition-colors"
                              >
                                <Maximize2 className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <a
                              key={index}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-1.5 px-2 py-2 rounded-lg h-28
                                border border-slate-200 dark:border-white/[0.06]
                                bg-slate-50 dark:bg-white/[0.03]
                                text-[11px] text-slate-600 dark:text-white/40
                                hover:text-slate-900 dark:hover:text-white/65"
                            >
                              <File className="w-3.5 h-3.5 flex-shrink-0" />
                              {t("attached_file") || "File"}
                            </a>
                          ),
                        )}
                      </div>
                    )}

                    {/* Comment reactions */}
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onReactComment(comment.id, "truth")}
                        className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-[6px] transition-all ${
                          comment.my_reaction === "truth"
                            ? "bg-emerald-500/15 text-emerald-500 dark:text-emerald-400"
                            : "bg-slate-100 dark:bg-white/[0.03] text-slate-600 dark:text-white/30 hover:bg-slate-200 dark:hover:bg-white/[0.06] hover:text-slate-600 dark:hover:text-white/50"
                        }`}
                      >
                        {comment.my_reaction === "truth" && (
                          <CheckCircle className="w-3.5 h-3.5" />
                        )}
                        <span>{t("truth") || "Truth"}</span>
                        {(comment.truth_count || 0) > 0 && (
                          <span className="ml-0.5 opacity-80">
                            {comment.truth_count}
                          </span>
                        )}
                      </button>

                      <button
                        onClick={() => onReactComment(comment.id, "false")}
                        className={`flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded-[6px] transition-all ${
                          comment.my_reaction === "false"
                            ? "bg-red-500/15 text-red-500 dark:text-red-400"
                            : "bg-slate-100 dark:bg-white/[0.03] text-slate-600 dark:text-white/30 hover:bg-slate-200 dark:hover:bg-white/[0.06] hover:text-slate-600 dark:hover:text-white/50"
                        }`}
                      >
                        {comment.my_reaction === "false" && (
                          <XCircle className="w-3.5 h-3.5" />
                        )}
                        <span>{t("false") || "False"}</span>
                        {(comment.false_count || 0) > 0 && (
                          <span className="ml-0.5 opacity-80">
                            {comment.false_count}
                          </span>
                        )}
                      </button>
                    </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* ADDED: hidden comments — visible to (and restorable by) the
          author of the post only */}
      {canModerateComments && onLoadHiddenComments && (
        <div className="border-t border-slate-100 dark:border-white/[0.06]">
          <button
            type="button"
            onClick={toggleHiddenSection}
            className="w-full flex items-center gap-2 px-4 py-2.5 text-[12px] text-slate-600 dark:text-white/40 hover:bg-slate-50 dark:hover:bg-white/[0.02] hover:text-slate-800 dark:hover:text-white/60 transition-colors"
          >
            <EyeOff className="w-3.5 h-3.5" />
            <span>
              {t("hidden_comments", "Hidden comments")}
              {showHidden || hiddenComments.length > 0
                ? ` (${hiddenComments.length})`
                : ""}
            </span>
          </button>

          {showHidden && (
            <div className="divide-y divide-slate-100 dark:divide-white/[0.05]">
              {loadingHidden && hiddenComments.length === 0 ? (
                <p className="px-4 py-4 text-[12px] text-slate-500 dark:text-white/25">
                  {t("loading", "Loading...")}
                </p>
              ) : hiddenComments.length === 0 ? (
                <p className="px-4 py-4 text-[12px] text-slate-500 dark:text-white/25">
                  {t("no_hidden_comments", "No hidden comments")}
                </p>
              ) : (
                hiddenComments.map((comment) => {
                  const name =
                    comment.author?.name ||
                    comment.author?.unique_name ||
                    t("anonymous");
                  return (
                    <div
                      key={comment.id}
                      className="px-4 py-3 flex items-start gap-3 bg-slate-50/70 dark:bg-white/[0.015]"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap mb-0.5">
                          <button
                            type="button"
                            onClick={() => openAuthorProfile(comment)}
                            className="text-[12px] font-medium text-slate-700 dark:text-white/60 hover:underline text-left"
                          >
                            {name}
                          </button>
                          {comment.author?.unique_name && (
                            <span className="text-[11px] text-slate-500 dark:text-white/25">
                              @{comment.author.unique_name}
                            </span>
                          )}
                          {comment.is_external_app && externalBadge}
                        </div>
                        {comment.content && (
                          <p className="text-[12px] text-slate-500 dark:text-white/40 leading-relaxed whitespace-pre-wrap line-clamp-3">
                            {comment.content}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleUnhide(comment.id)}
                        className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] rounded-[6px] bg-slate-100 dark:bg-white/[0.04] text-slate-700 dark:text-white/50 hover:bg-slate-200 dark:hover:bg-white/[0.08] transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        {t("restore_comment", "Restore")}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      )}

      {/* ADDED: fullscreen view of a comment's media */}
      {lightboxMedia &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
            onClick={() => setLightboxMedia(null)}
          >
            <button
              onClick={() => setLightboxMedia(null)}
              aria-label={t("close") || "Close"}
              className="absolute top-4 right-4 w-9 h-9 rounded-full
                bg-white/10 hover:bg-white/20 text-white
                flex items-center justify-center transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            {lightboxMedia.type === "image" ? (
              <img
                src={lightboxMedia.url}
                alt=""
                className="max-w-full max-h-full object-contain"
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <video
                src={lightboxMedia.url}
                controls
                autoPlay
                className="max-w-full max-h-full"
                onClick={(e) => e.stopPropagation()}
              />
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
