// src/components/CreateHelpRequestModal.jsx
// ✅ Fully migrated to Lens Protocol (canary v3)
// Removed: Supabase, title, payment details (bank, PayPal, crypto wallets)
// Kept: help types, description, media (uploaded via Grove / @lens-chain/storage-client)

import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Check,
  Heart,
  Brain,
  HandHeart,
  Pill,
  Home,
  BookOpen,
  Briefcase,
  Scale,
  Utensils,
  Shirt,
  FileText,
  Image as ImageIcon,
  Video,
  File,
  AlertCircle,
  Upload,
  Loader2,
} from "lucide-react";
// ADDED: the shared publishing limit (1/min, 10/hr, 20/day) - a single
// counter for posts, violations, help requests, and comments.
import { checkPostRateLimit } from "../utils/postRateLimit";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE_MB = 50;
const MAX_FILES = 5;
// ADDED: max length for the help-request description. Same reasoning as
// CreatePostModal.jsx's MAX_POST_LENGTH — a help request reads like a
// regular post (situation + what's needed), so the same 3000-char budget
// (~500-600 words) applies here.
const MAX_DESCRIPTION_LENGTH = 3000;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Props:
 *   userProfile   — { id, country, unique_name, avatar_url, authMethod }
 *   createRequest — the function from useLensHelpRequests
 *   onClose       — close the modal
 *   onSuccess     — called after a successful creation
 */
const CreateHelpRequestModal = ({
  userProfile,
  createRequest,
  onClose,
  onSuccess,
}) => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(""); // text status
  const [error, setError] = useState("");
  const modalRef = useRef(null);
  const fileInputRef = useRef(null);

  // Help types
  const helpTypes = [
    {
      id: "financial",
      icon: Heart,
      cls: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400/85",
    },
    {
      id: "psychological",
      icon: Brain,
      cls: "bg-purple-500/10 border-purple-500/20 text-purple-400/85",
    },
    {
      id: "physical",
      icon: HandHeart,
      cls: "bg-blue-500/10 border-blue-500/20 text-blue-400/85",
    },
    {
      id: "medical",
      icon: Pill,
      cls: "bg-red-500/10 border-red-500/20 text-red-400/85",
    },
    {
      id: "educational",
      icon: BookOpen,
      cls: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400/85",
    },
    {
      id: "housing",
      icon: Home,
      cls: "bg-amber-500/10 border-amber-500/20 text-amber-400/85",
    },
    {
      id: "food",
      icon: Utensils,
      cls: "bg-orange-500/10 border-orange-500/20 text-orange-400/85",
    },
    {
      id: "clothing",
      icon: Shirt,
      cls: "bg-pink-500/10 border-pink-500/20 text-pink-400/85",
    },
    {
      id: "legal",
      icon: Scale,
      cls: "bg-slate-100 dark:bg-white/[0.06] border-slate-300 dark:border-white/[0.1] text-slate-700 dark:text-white/40",
    },
    {
      id: "employment",
      icon: Briefcase,
      cls: "bg-cyan-500/10 border-cyan-500/20 text-cyan-400/85",
    },
  ];

  // Form state — simplified, no payment fields or title
  const [selectedHelpTypes, setSelectedHelpTypes] = useState([]);
  const [description, setDescription] = useState("");
  const [mediaFiles, setMediaFiles] = useState([]); // { file, preview, name, type, size }

  // Escape to close
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onClose, loading]);

  // Clean up URL previews on unmount
  useEffect(() => {
    return () => {
      mediaFiles.forEach((f) => {
        if (f.preview) URL.revokeObjectURL(f.preview);
      });
    };
  }, [mediaFiles]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const toggleHelpType = (typeId) => {
    setSelectedHelpTypes((prev) =>
      prev.includes(typeId)
        ? prev.filter((t) => t !== typeId)
        : [...prev, typeId],
    );
  };

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files);
    e.target.value = "";

    const oversized = files.filter(
      (f) => f.size > MAX_FILE_SIZE_MB * 1024 * 1024,
    );
    if (oversized.length > 0) {
      setError(
        t("file_too_large") || `File must not exceed ${MAX_FILE_SIZE_MB}MB`,
      );
      return;
    }

    if (mediaFiles.length + files.length > MAX_FILES) {
      setError(t("too_many_files") || `Maximum ${MAX_FILES} files allowed`);
      return;
    }

    setError("");
    const newFiles = files.map((file) => ({
      file,
      name: file.name,
      type: file.type,
      size: file.size,
      preview: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : null,
    }));

    setMediaFiles((prev) => [...prev, ...newFiles]);
  };

  const removeFile = (index) => {
    setMediaFiles((prev) => {
      const updated = [...prev];
      if (updated[index].preview) URL.revokeObjectURL(updated[index].preview);
      updated.splice(index, 1);
      return updated;
    });
  };

  const getFileIcon = (type) => {
    if (type.startsWith("image/")) return <ImageIcon className="w-4 h-4" />;
    if (type.startsWith("video/")) return <Video className="w-4 h-4" />;
    if (type.includes("pdf")) return <FileText className="w-4 h-4" />;
    return <File className="w-4 h-4" />;
  };

  const formatSize = (bytes) => {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  // ── Submit ───────────────────────────────────────────────────────────────────

  const handleSubmit = async () => {
    if (!description.trim()) {
      setError(t("description_required") || "Please enter a description");
      return;
    }
    // ADDED: defense-in-depth alongside the textarea's maxLength below —
    // maxLength stops normal typing/pasting, but this catches any content
    // that reaches state some other way before it gets published.
    if (description.trim().length > MAX_DESCRIPTION_LENGTH) {
      setError(
        t("description_too_long", { max: MAX_DESCRIPTION_LENGTH }) ||
          `Description is too long (max ${MAX_DESCRIPTION_LENGTH} characters)`,
      );
      return;
    }
    if (selectedHelpTypes.length === 0) {
      setError(
        t("help_type_required") || "Please select at least one help type",
      );
      return;
    }
    if (!userProfile?.id) {
      setError("Lens profile not found");
      return;
    }
    if (!createRequest) {
      setError("createRequest function not provided");
      return;
    }

    // ADDED: the shared publishing limit - the same counter used for
    // regular posts/violations/comments. localStorage.lens_account_address
    // takes priority (the same convention as in CreatePostModal.jsx/
    // ViolationsPage.jsx) - userProfile.address/.id as a fallback, since
    // there's no direct access to lensProfile/walletClient here.
    const myAddressForLimit =
      localStorage.getItem("lens_account_address") ||
      userProfile?.address ||
      userProfile?.id ||
      null;
    const rateCheck = await checkPostRateLimit(
      myAddressForLimit,
      description.trim(),
    );
    if (!rateCheck.allowed) {
      setError(rateCheck.reason);
      return;
    }

    setLoading(true);
    setError("");

    try {
      // Pass File objects directly to createRequest —
      // the hook itself uploads the media to Grove and publishes the post
      if (mediaFiles.length > 0) {
        setUploadProgress(t("uploading_media") || "Uploading media...");
      }
      setUploadProgress(t("publishing_to_lens") || "Publishing to Lens...");

      await createRequest({
        description: description.trim(),
        helpTypes: selectedHelpTypes,
        countryCode: userProfile.country || "EARTH",
        mediaFiles: mediaFiles.map((f) => f.file),
      });

      // Success
      onSuccess?.();
    } catch (err) {
      console.error("[CreateHelpRequestModal] submit error:", err);
      setError(err?.message ?? "Something went wrong");
    } finally {
      setLoading(false);
      setUploadProgress("");
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col">
      <div
        ref={modalRef}
        className="flex-1 bg-white dark:bg-[#000d1f] rounded-xl overflow-hidden shadow-[0_4px_24px_rgba(0,0,0,0.1)] dark:shadow-[0_24px_64px_rgba(0,0,0,0.7)] border border-slate-300 dark:border-white/[0.07] flex flex-col max-h-[90vh]"
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-300 dark:border-white/[0.06] bg-white dark:bg-[#000d1f] flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <button
              onClick={onClose}
              disabled={loading}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-600 dark:text-white/40 hover:text-slate-600 dark:text-white/60 hover:bg-slate-100 dark:hover:bg-white/[0.06] transition-all disabled:opacity-40"
              aria-label={t("close") || "Close"}
            >
              <X className="w-3.5 h-3.5" />
            </button>
            <h2 className="font-cinzel text-[16px] text-slate-700 dark:text-white/65 tracking-wide">
              {t("create_help_request") || "Create Help Request"}
            </h2>
          </div>

          {/* Author wallet address */}
          {userProfile?.unique_name && (
            <span className="text-[14px] text-slate-600 dark:text-white/40 font-mono truncate max-w-[120px]">
              @{userProfile.unique_name}
            </span>
          )}
        </div>

        {/* ── Scrollable content ── */}
        <div className="flex-1 overflow-y-auto p-4 space-y-5 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-slate-300 dark:scrollbar-thumb-white/[0.08]">
          {/* Error */}
          {error && (
            <div className="p-3 bg-red-950/30 border border-red-700/25 rounded-xl flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 text-red-400/80 flex-shrink-0 mt-0.5" />
              <p className="text-[16px] text-red-400/70 leading-relaxed">
                {error}
              </p>
            </div>
          )}

          {/* ── 1. Help types ── */}
          <div>
            <label className="block font-cinzel text-[11px] text-slate-500 dark:text-white/40 tracking-[0.1em] uppercase mb-2.5">
              {t("help_types") || "Types of help needed"} *
            </label>
            <div className="grid grid-cols-4 md:grid-cols-5 gap-1.5">
              {helpTypes.map((type) => {
                const Icon = type.icon;
                const isSelected = selectedHelpTypes.includes(type.id);
                return (
                  <button
                    key={type.id}
                    type="button"
                    onClick={() => toggleHelpType(type.id)}
                    disabled={loading}
                    className={`relative p-1.5 rounded-lg border transition-all flex flex-col items-center gap-0.5
                      ${
                        isSelected
                          ? `${type.cls} opacity-100`
                          : "border-slate-300 dark:border-white/[0.07] bg-slate-50 dark:bg-white/[0.02] hover:border-slate-400 dark:hover:border-white/[0.13] hover:bg-slate-100 dark:hover:bg-white/[0.04]"
                      }
                      ${loading ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}
                    `}
                    title={t(`help_type_${type.id}`) || type.id}
                  >
                    <Icon
                      className={`w-3.5 h-3.5 ${isSelected ? "" : "text-slate-600 dark:text-white/40"}`}
                    />
                    <span className="text-[11px] text-slate-600 dark:text-white/40 truncate w-full text-center leading-tight">
                      {t(`help_type_${type.id}`) || type.id}
                    </span>
                    {isSelected && (
                      <Check className="w-2.5 h-2.5 text-emerald-400/80 absolute top-0.5 right-0.5" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ── 2. Description ── */}
          <div>
            <label className="block font-cinzel text-[11px] text-slate-500 dark:text-white/40 tracking-[0.1em] uppercase mb-2">
              {t("description") || "Description"} *
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              disabled={loading}
              maxLength={MAX_DESCRIPTION_LENGTH}
              className="w-full px-3 py-2.5 text-[16px] bg-slate-50 dark:bg-white/[0.025] border border-slate-300 dark:border-white/[0.08] rounded-xl focus:border-slate-400 dark:focus:border-white/[0.2] focus:bg-slate-100 dark:focus:bg-white/[0.04] text-slate-900 dark:text-white/70 placeholder:text-slate-400 dark:placeholder:text-white/25 resize-none outline-none transition-all leading-relaxed disabled:opacity-50"
              placeholder={
                t("enter_description") ||
                "Describe your situation and what kind of help you need...\n\nYou can include contact details or wallet address in the description if needed."
              }
            />
            {/* CHANGED: now shows "N / 3000" with color escalating near the
                limit, same pattern as CreatePostModal.jsx. */}
            <p
              className={`mt-1 text-[14px] ${
                description.length >= MAX_DESCRIPTION_LENGTH
                  ? "text-red-500 dark:text-red-400/80 font-medium"
                  : description.length >= MAX_DESCRIPTION_LENGTH * 0.9
                    ? "text-amber-500 dark:text-amber-400/80"
                    : "text-slate-600 dark:text-white/40"
              }`}
            >
              {description.length} / {MAX_DESCRIPTION_LENGTH}{" "}
              {t("characters") || "chars"}
            </p>
          </div>

          {/* ── 3. Media attachments ── */}
          <div>
            <label className="block font-cinzel text-[11px] text-slate-500 dark:text-white/40 tracking-[0.1em] uppercase mb-2">
              {t("media") || "Media"}{" "}
              <span className="normal-case tracking-normal font-sans text-slate-600 dark:text-white/40">
                ({t("optional") || "optional"}, max {MAX_FILES}{" "}
                {t("files") || "files"}, {MAX_FILE_SIZE_MB}MB)
              </span>
            </label>

            {/* Preview grid */}
            {mediaFiles.length > 0 && (
              <div className="grid grid-cols-3 gap-2 mb-2">
                {mediaFiles.map((f, index) => (
                  <div key={index} className="relative group">
                    {f.preview ? (
                      <div className="w-full h-24 rounded-xl overflow-hidden border border-slate-300 dark:border-white/[0.08]">
                        <img
                          src={f.preview}
                          alt={f.name}
                          className="w-full h-full object-cover"
                        />
                      </div>
                    ) : (
                      <div className="w-full h-24 rounded-xl border border-slate-300 dark:border-white/[0.08] bg-slate-50 dark:bg-white/[0.02] flex flex-col items-center justify-center p-2 gap-1">
                        <span className="text-slate-600 dark:text-white/40">
                          {getFileIcon(f.type)}
                        </span>
                        <span className="text-[14px] text-slate-600 dark:text-white/40 truncate w-full text-center">
                          {f.name}
                        </span>
                        <span className="text-[14px] text-slate-600 dark:text-white/40">
                          {formatSize(f.size)}
                        </span>
                      </div>
                    )}
                    {/* Remove button */}
                    <button
                      onClick={() => removeFile(index)}
                      disabled={loading}
                      className="absolute -top-1.5 -right-1.5 bg-red-600 dark:bg-red-900/70 border border-red-700 dark:border-red-700/30 text-white dark:text-red-300/80 rounded-full p-1 opacity-0 group-hover:opacity-100 hover:bg-red-700 dark:hover:bg-red-800/80 transition-all disabled:opacity-30"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Upload button */}
            {mediaFiles.length < MAX_FILES && (
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
                className="w-full px-3 py-3 border border-dashed border-slate-300 dark:border-white/[0.1] rounded-xl hover:border-slate-400 dark:hover:border-white/[0.2] hover:bg-slate-50 dark:hover:bg-white/[0.03] text-slate-600 dark:text-white/40 hover:text-slate-800 dark:hover:text-white/50 disabled:opacity-40 transition-all flex items-center justify-center gap-2 text-[16px]"
              >
                <Upload className="w-4 h-4" />
                {t("upload_media") || "Upload images or videos"}
              </button>
            )}
            <input
              type="file"
              ref={fileInputRef}
              multiple
              onChange={handleFileSelect}
              className="hidden"
              accept="image/*,video/*,.pdf"
              disabled={loading}
            />
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="px-4 py-3 border-t border-slate-300 dark:border-white/[0.06] bg-white dark:bg-[#000d1f] flex-shrink-0">
          {/* Progress status */}
          {uploadProgress && (
            <div className="flex items-center gap-2 mb-2.5">
              <Loader2 className="w-3 h-3 text-slate-600 dark:text-white/40 animate-spin" />
              <span className="text-[14px] text-slate-600 dark:text-white/40">
                {uploadProgress}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            {/* Wallet hint */}
            <p className="text-[11px] text-slate-600 dark:text-white/40 leading-tight">
              {t("stored_on_lens") || "Stored on Lens blockchain"}
            </p>

            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                disabled={loading}
                className="px-4 py-2 text-[16px] text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/60 hover:bg-slate-100 dark:hover:bg-white/[0.04] border border-transparent hover:border-slate-300 dark:hover:border-white/[0.07] rounded-xl transition-all font-medium disabled:opacity-40"
              >
                {t("cancel") || "Cancel"}
              </button>
              <button
                onClick={handleSubmit}
                disabled={
                  loading ||
                  selectedHelpTypes.length === 0 ||
                  !description.trim() ||
                  description.length > MAX_DESCRIPTION_LENGTH
                }
                className="px-5 py-2
                bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
                dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3D0012] rounded-xl transition-all text-[16px] font-medium disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2 min-w-[130px] justify-center"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {uploadProgress
                      ? t("uploading") || "Uploading..."
                      : t("publishing") || "Publishing..."}
                  </>
                ) : (
                  t("create_request") || "Create Request"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CreateHelpRequestModal;
