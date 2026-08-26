// src/components/CreatePostModal.jsx
import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import EmojiPicker, { Theme as EmojiTheme } from "emoji-picker-react";
import {
  X,
  Image as ImageIcon,
  Video,
  File,
  Smile,
  Globe,
  Upload,
  User,
} from "lucide-react";

import { useCountry } from "../hooks/useCountry";
import useLensPosts from "../hooks/useLensPosts";
import { useLensProfile } from "../hooks/useLensProfile";
import { useLensAuth } from "../context/LensAuthContext";
// ADDED: the shared publishing limit (1/min, 10/hr, 20/day) - a single
// counter for posts, violations, help requests, and comments.
import { checkPostRateLimit } from "../utils/postRateLimit";

// ADDED: max length for a post's text. No such limit existed before -
// nothing stopped an arbitrarily long post, which fought against the
// card's own preview clamp (PostCard.jsx) and made publishing slower/
// costlier than it needs to be (content is uploaded to Grove and written
// into the post's metadata on Lens Chain). 3000 chars ≈ 500-600 words -
// enough to describe a situation with real detail (this is a human-rights
// platform, not a microblog), well above Threads/Mastodon's ~500, but
// still short of turning the feed into a blog.
const MAX_POST_LENGTH = 3000;

const CreatePostModal = ({ onClose }) => {
  const { t, i18n } = useTranslation();
  const { getTranslatedCountryName } = useCountry(i18n.language);
  const [content, setContent] = useState("");
  const [mediaFiles, setMediaFiles] = useState([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const fileInputRef = useRef(null);
  const modalRef = useRef(null);
  const textareaRef = useRef(null);
  const emojiPickerRef = useRef(null);
  const emojiButtonRef = useRef(null);

  const [emojiPickerStyle, setEmojiPickerStyle] = useState(null);

  // FIXED: the session is now taken from LensAuthContext
  // and passed into the hook explicitly.
  // CHANGED (embedded wallet): previously read its own
  // useWalletClient() and passed the raw value into useLensPosts —
  // that duplicated the exact "frozen closure" hazard
  // LensAuthContext.getWalletClient() already solves once for the
  // whole app. Passing the function itself through means the actual
  // client is resolved fresh at write-time, correctly, for the
  // embedded wallet, a linked external wallet, or WalletConnect.
  const { sessionClient, getWalletClient } = useLensAuth();
  const { createLensPost, loading, error } = useLensPosts(
    sessionClient,
    getWalletClient,
  );

  // The wallet address for Lens users (needed right away, not only in handleSubmit)
  const lensWalletAddress = localStorage.getItem("lens_wallet_address");
  const { profile: lensProfile } = useLensProfile(lensWalletAddress);

  // FIXED: the country is now taken EXCLUSIVELY from the Lens Account
  // metadata (via useLensProfile).
  const effectiveCountry = lensProfile?.country || "EARTH";

  // Added states for inline messages
  const [submitError, setSubmitError] = useState("");
  const [fileError, setFileError] = useState("");
  const [submitSuccess, setSubmitSuccess] = useState(false);
  const [nostrCrossPostStatus, setNostrCrossPostStatus] = useState(null);

  const isDarkMode =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");

  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      return t("earth") || "Planet Earth";
    }
    return getTranslatedCountryName(countryCode) || countryCode;
  };

  const computeEmojiPickerPosition = useCallback(() => {
    const btn = emojiButtonRef.current;
    if (!btn) return null;

    const MARGIN = 8;
    const WIDTH = 320;
    const MAX_HEIGHT = 380;
    const MIN_HEIGHT = 280;

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

    // If it still doesn't fit even then (a very short viewport) — pin it
    // to the top of the screen instead of letting it overflow.
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
    const handleEscape = (e) => {
      if (e.key === "Escape") {
        onClose();
      }
    };

    const handleClickOutside = (e) => {
      if (
        emojiPickerRef.current &&
        !emojiPickerRef.current.contains(e.target)
      ) {
        setShowEmojiPicker(false);
      }
    };

    document.addEventListener("keydown", handleEscape);
    document.addEventListener("mousedown", handleClickOutside);

    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Function to insert emoji — emoji-picker-react passes an object
  // { emoji, names, ... }, we only need the character
  const insertEmoji = (emojiData) => {
    const emoji = emojiData.emoji;
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = content;

    const newText = text.substring(0, start) + emoji + text.substring(end);
    setContent(newText);

    // Focus on textarea and set cursor after inserted emoji
    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + emoji.length, start + emoji.length);
    }, 0);

    setShowEmojiPicker(false);
  };

  const handleFileSelect = (event) => {
    const files = Array.from(event.target.files);
    // Checking the count
    if (mediaFiles.length + files.length > 4) {
      setFileError(t("max_4_files") || "Maximum 4 files");
      return;
    }
    const validFiles = files.filter((file) => {
      const maxSize = 10 * 1024 * 1024;
      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "video/mp4",
        "video/webm",
        "application/pdf",
        "text/plain",
      ];

      if (file.size > maxSize) {
        setFileError(
          `${file.name}: ${t("file_too_large") || "file is too large (max. 10MB)"}`,
        );
        return false;
      }

      if (!allowedTypes.includes(file.type)) {
        setFileError(
          `${file.name}: ${t("file_type_not_supported") || "file type not supported"}`,
        );
        return false;
      }

      return true;
    });

    setMediaFiles((prev) => [...prev, ...validFiles]);
  };

  const removeMediaFile = (index) => {
    setMediaFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // REMOVED: After the full migration to Lens: createLensPost()
  // in useLensPosts.js itself uploads these same File objects to Grove
  // (lens-chain storage) and puts them into the post's metadata on the blockchain.

  const handleSubmit = async () => {
    if (!content.trim() && mediaFiles.length === 0) {
      setSubmitError(
        t("please_enter_text_or_media") || "Enter text or add a file",
      );
      return;
    }

    // ADDED: defense-in-depth alongside the textarea's maxLength below —
    // maxLength stops normal typing/pasting, but this catches any content
    // that reaches state some other way (e.g. programmatically) before it
    // gets published.
    if (content.trim().length > MAX_POST_LENGTH) {
      setSubmitError(
        t("post_too_long", { max: MAX_POST_LENGTH }) ||
          `Text is too long (max ${MAX_POST_LENGTH} characters)`,
      );
      return;
    }

    // Lens is now the single source of truth,
    // so publishing is impossible without an active session.
    if (!sessionClient) {
      setSubmitError(
        t("lens_session_required") ||
          "Logging in via Lens is required to publish a post",
      );
      return;
    }

    // ADDED: the shared publishing limit (1/min, 10/hr, 20/day - a
    // single counter for posts, violations, help requests, and comments).
    // Checked BEFORE geocoding/media upload, so as not to make the user
    // wait for a pointless file upload if the publication is going to be
    // rejected anyway.
    const myAddressForLimit =
      localStorage.getItem("lens_account_address") ||
      lensProfile?.address ||
      lensWalletAddress ||
      null;
    const rateCheck = await checkPostRateLimit(
      myAddressForLimit,
      content.trim(),
    );
    if (!rateCheck.allowed) {
      setSubmitError(rateCheck.reason);
      return;
    }

    // FIXED: h3Index now comes exclusively from lensProfile (a Lens attribute) —

    const h3IndexValue = lensProfile?.h3Index || null;

    try {
      const lensResult = await createLensPost({
        content: content.trim(),
        countryCode: effectiveCountry,

        category: "general",
        mediaFiles,
        h3Index: h3IndexValue,
      });

      if (!lensResult.success) {
        // FIXED: previously a Lens publishing error was only logged to
        // console.warn, while the UI still showed "Post published!".
        // Now the actual error is shown to the user.
        throw new Error(lensResult.error || "Lens publish failed");
      }

      console.log("✅ Lens result:", JSON.stringify(lensResult, null, 2));

      setSubmitSuccess(true);
      // ADDED: surfaces the best-effort Nostr cross-post outcome from
      // createLensPost (see useLensPosts.js) — purely informational,
      // never blocks or reverts the Lens post above, which already
      // succeeded regardless of what happened here.
      setNostrCrossPostStatus(lensResult.nostr || null);
      setTimeout(() => {
        onClose();
        window.location.reload();
      }, 1000);
    } catch (err) {
      console.error("❌ Error creating Lens post:", err);
      setSubmitError(
        t("error_creating_post") || "Publishing error: " + err.message,
      );
    }
  };

  // Function to handle avatar loading error
  const handleAvatarError = (e) => {
    e.target.style.display = "none";
    // Instead of optional chaining assignment we use a check
    const nextSibling = e.target.nextSibling;
    if (nextSibling && nextSibling.style) {
      nextSibling.style.display = "flex";
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center
      bg-black/60 backdrop-blur-sm px-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-lg sm:max-w-xl md:max-w-2xl lg:max-w-3xl
          bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.1]
          rounded-2xl overflow-hidden flex flex-col
          shadow-xl dark:shadow-[0_16px_48px_rgba(0,0,0,0.7)]
          max-h-[90vh]"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-3.5
          border-b border-slate-300 dark:border-white/[0.07]"
        >
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              aria-label={t("close") || "Close"}
              className="w-10 h-10 rounded-lg flex items-center justify-center
                bg-slate-100 dark:bg-white/[0.04] border border-slate-300 dark:border-white/[0.08]
                text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/60 hover:bg-slate-200 dark:hover:bg-white/[0.07]
                transition-all"
            >
              <X className="w-5 h-5" />
            </button>
            <h2
              className="font-cinzel text-[16px] font-medium
              text-slate-900 dark:text-white/65 tracking-[0.04em]"
            >
              {t("create_post") || "Create post"}
            </h2>
          </div>

        </div>

        {/* Content - main area with scroll */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* User information */}
          <div className="flex items-center gap-2.5">
            {/* Avatar — the same hexagon with a gradient outline used
                on ProfilePage/UserProfilePage (clip-path-hexagon), just a
                smaller size to fit the modal's compact header. */}
            <div className="relative flex-shrink-0">
              <div
                className="relative w-[40px] h-[44px] p-[1.5px] clip-path-hexagon
                  bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]"
              >
                <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                  {lensProfile?.avatar ? (
                    <img
                      src={lensProfile.avatar}
                      alt={
                        lensProfile?.name || lensProfile?.localName || "User"
                      }
                      className="w-full h-full object-cover"
                      onError={handleAvatarError}
                    />
                  ) : null}
                  <div
                    className={`w-full h-full flex items-center justify-center
                    font-cinzel text-[14px] text-[#c8b8a2] bg-[#0d0415]
                    ${lensProfile?.avatar ? "hidden absolute inset-0" : "flex"}`}
                  >
                    {(lensProfile?.name ||
                      lensProfile?.localName)?.[0]?.toUpperCase() || "U"}
                  </div>
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {/* FIXED: now BOTH names are shown — name (if set in
                    Lens) as the primary one, @username always second,
                    muted — the same pattern used on the profile page
                    (ProfilePage/UserProfilePage). */}
                <span className="text-[16px] font-medium text-slate-900 dark:text-white/75">
                  {lensProfile?.name || lensProfile?.localName || "User"}
                </span>
                {lensProfile?.handle && (
                  <span className="text-[14px] text-slate-600 dark:text-white/40">
                    {lensProfile.handle}
                  </span>
                )}
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded
                  bg-blue-100 dark:bg-blue-900/15 border border-blue-300/50 dark:border-blue-700/20 text-blue-800 dark:text-blue-400/65
                  flex items-center gap-1"
                >
                  <Globe className="w-2.5 h-2.5" />
                  {getCountryDisplayName(effectiveCountry)}
                </span>
              </div>
            </div>
          </div>

          {/* Text field */}
          <textarea
            ref={textareaRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setSubmitError("");
            }}
            placeholder={t("whats_on_your_mind") || "What's on your mind?"}
            autoFocus
            maxLength={MAX_POST_LENGTH}
            className="w-full min-h-[187px] md:min-h-[220px] px-3 py-2.5 rounded-lg resize-none
              bg-slate-50 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.09] text-[16px]
              text-slate-900 dark:text-white/65 placeholder-slate-400 dark:placeholder-white/[0.18] font-['Inter']
              outline-none leading-relaxed
              focus:border-blue-400 dark:focus:border-blue-500/35 focus:ring-1 focus:ring-blue-300/30 dark:focus:ring-blue-500/15
              transition-all"
          />

          {/* FileError inline */}
          {fileError && (
            <div
              className="flex items-center justify-between px-3 py-2
              bg-red-500/[0.07] border border-red-500/20 rounded-lg"
            >
              <p className="text-[16px] text-red-500 dark:text-red-400/75">
                {fileError}
              </p>
              <button
                onClick={() => setFileError("")}
                className="text-slate-600 dark:text-white/40 hover:text-slate-800 dark:hover:text-white/50 transition-colors ml-2"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Media files */}
          {mediaFiles.length > 0 && (
            <div>
              <p
                className="font-cinzel text-[11px] text-slate-600 dark:text-white/40
                tracking-[0.1em] uppercase mb-2.5"
              >
                {t("attached_files") || "Attached files"}
                <span
                  className="ml-1.5 text-slate-600 dark:text-white/40 font-['Inter']
                  normal-case tracking-normal"
                >
                  ({mediaFiles.length}/4)
                </span>
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
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
                        className="w-full h-36 object-cover"
                        loading="lazy"
                      />
                    ) : file.type.startsWith("video/") ? (
                      <div
                        className="w-full h-36 flex flex-col
                        items-center justify-center gap-2"
                      >
                        <Video className="w-8 h-8 text-slate-500 dark:text-white/20" />
                        <span
                          className="text-[14px] text-slate-600 dark:text-white/40
                          truncate w-full text-center px-2"
                        >
                          {file.name}
                        </span>
                      </div>
                    ) : (
                      <div
                        className="w-full h-36 flex flex-col
                        items-center justify-center gap-2"
                      >
                        <File className="w-8 h-8 text-slate-500 dark:text-white/20" />
                        <span
                          className="text-[14px] text-slate-600 dark:text-white/40
                          truncate w-full text-center px-2"
                        >
                          {file.name}
                        </span>
                      </div>
                    )}

                    {/* Remove */}
                    <button
                      onClick={() => removeMediaFile(index)}
                      aria-label={t("remove_file") || "Delete"}
                      className="absolute top-1.5 right-1.5 w-6 h-6
                        bg-[#000d1f]/90 border border-red-800/30
                        text-red-400/70 hover:text-red-400/95
                        hover:bg-[#1a0505] rounded-lg
                        flex items-center justify-center
                        transition-all z-10"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Toolbar */}
          <div
            className="pt-3 border-t border-slate-200 dark:border-white/[0.05]
            flex items-center gap-2"
          >
            {/* Add media */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || mediaFiles.length >= 4}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg
                text-[16px] font-medium border border-slate-300 dark:border-white/[0.09]
                bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/40
                hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65
                transition-all disabled:opacity-30 disabled:cursor-not-allowed h-10"
            >
              <Upload className="w-5 h-5" />
              {t("add_media") || "Media"}
            </button>

            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileSelect}
              multiple
              accept="image/*,video/*,.pdf,.txt,.doc,.docx"
              className="hidden"
            />

            {/* Emoji */}
            <div className="relative">
              <button
                ref={emojiButtonRef}
                type="button"
                onClick={() => setShowEmojiPicker(!showEmojiPicker)}
                disabled={loading}
                title={t("add_emoji") || "Emoji"}
                className={`w-10 h-10 rounded-lg flex items-center justify-center
                  border transition-all disabled:opacity-30
                  ${
                    showEmojiPicker
                      ? "border-blue-400 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-900/15 text-blue-600 dark:text-blue-400/80"
                      : "border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/60"
                  }`}
              >
                <Smile className="w-5 h-5" />
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
                      theme={isDarkMode ? EmojiTheme.DARK : EmojiTheme.LIGHT}
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

            {/* Character counter — CHANGED: now shows "N / 3000" instead of
                just N, with color escalating as the limit approaches, so
                the user gets a visual heads-up before hitting the hard
                cap (maxLength on the textarea above stops further typing
                right at the limit). */}
            {content.length > 0 && (
              <span
                className={`ml-auto text-[14px] font-mono ${
                  content.length >= MAX_POST_LENGTH
                    ? "text-red-500 dark:text-red-400/80 font-medium"
                    : content.length >= MAX_POST_LENGTH * 0.9
                      ? "text-amber-500 dark:text-amber-400/80"
                      : "text-slate-600 dark:text-white/40"
                }`}
              >
                {content.length} / {MAX_POST_LENGTH}
              </span>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div
          className="px-4 py-3.5 border-t border-slate-300 dark:border-white/[0.07]
          flex flex-col gap-2"
        >
          {/* Success */}
          {submitSuccess && (
            <div
              className="flex items-center gap-2 px-3 py-2
              bg-emerald-500/[0.08] border border-emerald-500/20 rounded-lg"
            >
              <span className="text-emerald-600 dark:text-emerald-400/80 text-[16px]">
                ✓ {t("post_published") || "Post published!"}
              </span>
            </div>
          )}

          {/* ADDED: Nostr cross-post status — informational only, never
              blocks the flow above; shown only when we actually
              attempted a cross-post (nostrCrossPostStatus is null if
              createLensPost never got that far, e.g. Nostr identity
              derivation itself failed before any relay was tried). */}
          {submitSuccess && nostrCrossPostStatus && (
            <div
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border ${
                nostrCrossPostStatus.success
                  ? "bg-purple-500/[0.08] border-purple-500/20"
                  : "bg-slate-500/[0.06] border-slate-500/15"
              }`}
            >
              <span
                className={`text-[13px] ${
                  nostrCrossPostStatus.success
                    ? "text-purple-600 dark:text-purple-400/80"
                    : "text-slate-500 dark:text-white/40"
                }`}
              >
                {nostrCrossPostStatus.success
                  ? `✓ ${t("also_posted_to_nostr") || "Also posted to Nostr"}`
                  : `${t("nostr_crosspost_skipped") || "Nostr cross-post skipped"}`}
              </span>
            </div>
          )}

          {/* Error */}
          {(submitError || error) && (
            <div
              className="flex items-center justify-between px-3 py-2
              bg-red-500/[0.07] border border-red-500/20 rounded-lg"
            >
              <p className="text-[16px] text-red-500 dark:text-red-400/75">
                {submitError || error}
              </p>
              <button
                onClick={() => setSubmitError("")}
                className="text-slate-600 dark:text-white/40 hover:text-slate-800 dark:hover:text-white/50 ml-2"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            {/* Cancel */}
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="px-4 py-2 text-[16px] rounded-lg
                bg-transparent border border-slate-300 dark:border-white/[0.09]
                text-slate-600 dark:text-white/35 hover:text-slate-900 dark:hover:text-white/55 hover:border-slate-400 dark:hover:border-white/[0.16]
                transition-colors disabled:opacity-40"
            >
              {t("cancel") || "Cancel"}
            </button>

            {/* Publish */}
            <button
              type="button"
              onClick={handleSubmit}
              disabled={
                loading ||
                (!content.trim() && mediaFiles.length === 0) ||
                content.length > MAX_POST_LENGTH
              }
              className="px-5 py-2 text-[16px] font-medium rounded-lg
                bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]/80
                hover:bg-[#3d0012] transition-colors
                disabled:opacity-40 disabled:cursor-not-allowed
                flex items-center gap-2 min-w-[120px] justify-center"
            >
              {loading && (
                <span
                  className="w-3.5 h-3.5 border-2 border-[#e8a0b0]/50
                  border-t-transparent rounded-full animate-spin"
                />
              )}
              {loading
                ? t("publishing") || "Publishing..."
                : t("publish") || "Publish"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CreatePostModal;
