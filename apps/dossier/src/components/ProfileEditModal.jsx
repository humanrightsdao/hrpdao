// src/components/ProfileEditModal.jsx
import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  User,
  Camera,
  Globe,
  Link as LinkIcon,
  Plus,
  Trash2,
  MapPin,
  Upload,
  Loader,
} from "lucide-react";
import { useCountry } from "../hooks/useCountry";
import { deleteMyRatingPost } from "../lib/countryRatings";
import { setAccountMetadata } from "@lens-protocol/client/actions";
import {
  account as accountMetadata,
  MetadataAttributeType,
} from "@lens-protocol/metadata";
import { useLensAuth } from "../context/LensAuthContext";
import { uploadFileToGrove } from "../lib/grove";

const AvatarUpload = ({ userInfo, onAvatarUpdated, onUploadingChange }) => {
  const { t } = useTranslation();
  const fileInputRef = useRef(null);

  const [uploading, setUploading] = useState(false);

  // FIX: parent (ProfileEditModal) has no idea an upload to Grove is
  // still in flight — its own "Save" button was only disabled by its
  // own `loading` state. If the user picks a photo and hits "Save"
  // before uploadFileToGrove() resolves, the form submits with the
  // OLD formData.avatarUrl (onAvatarUpdated hasn't fired yet), so the
  // new avatar is silently dropped from the on-chain metadata write.
  // Reporting `uploading` upward lets the parent block submission
  // until the avatar upload actually finishes.
  useEffect(() => {
    if (onUploadingChange) onUploadingChange(uploading);
  }, [uploading, onUploadingChange]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [preview, setPreview] = useState(userInfo?.avatarUrl || null);

  useEffect(() => {
    if (userInfo?.avatarUrl) setPreview(userInfo.avatarUrl);
  }, [userInfo?.avatarUrl]);

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError(t("avatar_file_type_error") || "Please select an image file");
      return;
    }
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowedTypes.includes(file.type)) {
      setError(
        t("avatar_file_format_error") || "Allowed formats: JPG, PNG, WebP, GIF",
      );
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError(
        t("avatar_file_size_error") || "File size should not exceed 5MB",
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target.result);
    reader.readAsDataURL(file);
    handleUpload(file);
  };

  const handleUpload = async (file) => {
    setUploading(true);
    setError("");
    setSuccess("");
    try {
      const { uri, gatewayUrl } = await uploadFileToGrove(file);
      setPreview(gatewayUrl);
      setSuccess(t("avatar_upload_success") || "Avatar uploaded successfully");
      if (onAvatarUpdated) onAvatarUpdated(uri);
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(
        err.message || t("avatar_upload_error") || "Error uploading avatar",
      );
      setPreview(userInfo?.avatarUrl || null);
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = () => {
    setError("");
    setPreview(null);
    setSuccess(t("avatar_delete_success") || "Avatar removed");
    if (onAvatarUpdated) onAvatarUpdated(null);
    setTimeout(() => setSuccess(""), 3000);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer.files;
    if (files && files[0]) handleFileSelect({ target: { files: [files[0]] } });
  };

  return (
    <div
      className="flex items-center gap-4"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Avatar */}
      <div className="relative shrink-0">
        <div
          className="relative w-[80px] h-[88px] p-[1.5px] clip-path-hexagon
            bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]"
        >
          <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
            {preview ? (
              <img
                src={preview}
                alt={userInfo?.uniqueName}
                className="w-full h-full object-cover"
                crossOrigin="anonymous"
                onError={(e) => {
                  e.target.style.display = "none";
                  const fb =
                    e.target.parentElement?.querySelector(".avatar-fallback");
                  if (fb) fb.style.display = "flex";
                }}
              />
            ) : null}
            <div
              className={`avatar-fallback w-full h-full flex items-center justify-center font-cinzel text-[28px] text-[#c8b8a2] bg-[#0d0415] ${preview ? "hidden" : "flex"}`}
            >
              {userInfo?.uniqueName?.[0]?.toUpperCase() || "U"}
            </div>
          </div>
        </div>
        {uploading && (
          <div className="absolute inset-0 bg-black/50 clip-path-hexagon flex items-center justify-center">
            <Loader className="w-5 h-5 text-white/60 animate-spin" />
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 px-2.5 py-1 text-[14px]
              bg-transparent border border-red-300 dark:border-red-800/25
              text-red-600 dark:text-red-400/60
              rounded-md hover:bg-red-50 dark:hover:bg-red-900/15 transition-colors disabled:opacity-40"
          >
            <Upload className="w-5 h-5" />
            {preview ? t("change_avatar") : t("upload_avatar")}
          </button>
          {preview && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={uploading}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[14px]
                bg-transparent border border-red-300 dark:border-red-800/25
                text-red-600 dark:text-red-400/60
                rounded-md hover:bg-red-50 dark:hover:bg-red-900/15 transition-colors disabled:opacity-40"
            >
              <X className="w-5 h-5" />
              {t("remove_avatar")}
            </button>
          )}
        </div>

        {error && (
          <p className="text-[12px] text-red-500 dark:text-red-400/70">
            {error}
          </p>
        )}
        {success && (
          <p className="text-[12px] text-emerald-600 dark:text-emerald-400/70">
            {success}
          </p>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileSelect}
        className="hidden"
      />
    </div>
  );
};

const ProfileEditModal = ({ userInfo, onClose, onSaved }) => {
  const { t } = useTranslation();
  const {
    getTranslatedCountryName,
    detectLocation,
    loading: countryLoading,
  } = useCountry();
  const { sessionClient, getWalletClient } = useLensAuth();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // FIX: tracks whether AvatarUpload is still mid-upload to Grove, so
  // the Save button can be disabled until the new avatar URI is
  // actually available in formData.avatarUrl (see AvatarUpload above).
  const [avatarUploading, setAvatarUploading] = useState(false);

  const [formData, setFormData] = useState({
    name: userInfo.name || "",
    bio: userInfo.bio || "",
    country: userInfo.country || "EARTH",
    avatarUrl: userInfo.avatarUrl || null,
    h3Index: userInfo.h3Cell || null,
  });

  useEffect(() => {
    setFormData({
      name: userInfo.name || "",
      bio: userInfo.bio || "",
      country: userInfo.country || "EARTH",
      avatarUrl: userInfo.avatarUrl || null,
      h3Index: userInfo.h3Cell || null,
    });
  }, [userInfo]);

  const handleDetectLocation = async () => {
    try {
      const location = await detectLocation();
      setFormData({
        ...formData,
        country: location.countryCode,
        h3Index: location.h3Index,
      });
      setSuccess(t("location_detected"));
      setTimeout(() => setSuccess(""), 3000);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAvatarUpdated = (newAvatarUrl) => {
    setFormData((prev) => ({ ...prev, avatarUrl: newAvatarUrl }));
  };

  const updateLensMetadata = async (updates) => {
    if (!sessionClient) {
      console.warn("⚠️ no sessionClient — skipping Lens update");
      return;
    }
    const username =
      userInfo?.uniqueName || userInfo?.lensAccountAddress || "user";
    if (!username) {
      console.warn("⚠️ No username for Lens metadata — skipping");
      return;
    }

    try {
      const { storageClient } = await import("../lib/grove");
      const { handleOperationWith } =
        await import("@lens-protocol/client/viem");
      const walletClient = await getWalletClient();
      if (!walletClient)
        throw new Error("Wallet not connected. Please connect your wallet.");

      const pictureUri = updates.avatarUrl || undefined;
      const displayName = (updates.name || "").trim() || username;

      const attributes = [
        { key: "isAdult", value: "true", type: MetadataAttributeType.BOOLEAN },
        {
          key: "hasAcceptedTerms",
          value: "true",
          type: MetadataAttributeType.BOOLEAN,
        },
        {
          key: "country",
          value: updates.country || "EARTH",
          type: MetadataAttributeType.STRING,
        },
        ...(updates.h3Index
          ? [
              {
                key: "h3Index",
                value: updates.h3Index,
                type: MetadataAttributeType.STRING,
              },
            ]
          : []),
      ];

      // FIX: `bio` in the Lens metadata schema is OPTIONAL, and its
      // validator trims the string before checking min(1) length.
      // Passing " " (a single space) as a "leave it empty" fallback
      // gets trimmed to "" internally and fails with
      // 'lens.bio: String must contain at least 1 character(s)'.
      // The correct way to represent "no bio" is to omit the field
      // entirely (undefined), same as we already do for `picture`.
      const trimmedBio = updates.bio ? updates.bio.trim() : "";

      const metadata = accountMetadata({
        name: displayName,
        bio: trimmedBio ? trimmedBio : undefined,
        picture: pictureUri,
        attributes,
      });
      const { uri } = await storageClient.uploadAsJson(metadata);
      const result = await setAccountMetadata(sessionClient, {
        metadataUri: uri,
      }).andThen(handleOperationWith(walletClient));

      if (result.isErr()) throw new Error(result.error.message);
      if (result.value && typeof result.value === "string")
        await sessionClient.waitForTransaction(result.value);
      console.log("✅ Lens metadata updated on-chain");
    } catch (err) {
      console.warn("⚠️ Lens metadata update failed:", err.message);
      throw err;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    // FIX: hard guard in addition to the disabled Save button — if an
    // avatar upload to Grove is still in flight, block the submit so
    // we never write the stale formData.avatarUrl to the chain.
    if (avatarUploading) {
      setError(
        t("avatar_still_uploading") ||
          "The avatar is still uploading — please wait a moment and try again.",
      );
      return;
    }
    setLoading(true);
    try {
      if (!sessionClient) {
        throw new Error(
          "No active Lens session. Connect a wallet and log in to save changes.",
        );
      }
      setSuccess("Confirm the transaction in your wallet...");
      await updateLensMetadata({
        name: formData.name,
        bio: formData.bio,
        country: formData.country,
        h3Index: formData.h3Index,
        avatarUrl: formData.avatarUrl,
      });

      // ADDED: if the user changed their country of residence — their
      // previous rating post (a Lens Post tagged "country_rating", see
      // src/lib/countryRatings.js) concerns a country they NO LONGER LIVE
      // IN. Product requirement: "only current ratings count" — so we
      // delete it right here. This does NOT throw on failure: the profile
      // itself has already been successfully updated, a lost rating post
      // shouldn't break the entire profile-editing flow in front of the user.
      if (formData.country !== userInfo.country) {
        try {
          const walletClient = await getWalletClient();
          const cleanup = await deleteMyRatingPost({
            sessionClient,
            walletClient,
            accountAddress: userInfo.lensAccountAddress,
          });
          if (!cleanup.success) {
            console.warn(
              "⚠️ Failed to delete the stale rating post:",
              cleanup.error,
            );
          }
        } catch (cleanupError) {
          console.warn(
            "⚠️ Error deleting the stale rating post:",
            cleanupError,
          );
        }
      }

      setSuccess("✓ Profile updated on the blockchain");
      if (onSaved) await onSaved();
      setTimeout(() => onClose(), 1500);
    } catch (err) {
      if (
        err.message?.includes("rejected") ||
        err.message?.includes("denied") ||
        err.message?.includes("user rejected")
      ) {
        setError("Signature rejected in the wallet — changes not saved");
      } else {
        setError(err.message || t("update_failed"));
      }
    } finally {
      setLoading(false);
    }
  };

  // ── Adaptive theme helpers — fonts synced with SettingsPage ────
  const cardBg = "bg-white dark:bg-[#000d1f]";
  const cardBorder = "border border-slate-300 dark:border-white/[0.1]";
  const headerBorder = "border-b border-slate-300 dark:border-white/[0.07]";
  const footerBorder = "border-t border-slate-300 dark:border-white/[0.06]";
  const labelText =
    "text-[11px] uppercase tracking-[0.1em] font-medium text-slate-500 dark:text-white/40";
  const subText = "text-slate-600 dark:text-white/45";
  const inputCls = `w-full px-3 py-2 text-[16px] rounded-lg
    bg-slate-100 dark:bg-white/[0.03]
    border border-slate-300 dark:border-white/[0.1]
    text-slate-900 dark:text-white/65
    placeholder-slate-400 dark:placeholder-white/[0.18]
    font-['Inter'] outline-none
    focus:border-blue-400 dark:focus:border-blue-500/35
    focus:ring-1 focus:ring-blue-300/40 dark:focus:ring-blue-500/15
    transition-all`;
  const readonlyBox = `flex items-center gap-2 px-3 py-2 rounded-lg
    bg-slate-100 dark:bg-white/[0.02]
    border border-slate-300 dark:border-white/[0.06]
    select-none pointer-events-none`;
  // ───────────────────────────────────────────────────────────────────

  return (
    <div
      className={`${cardBg} ${cardBorder} rounded-xl w-full overflow-hidden`}
    >
      {/* Header */}
      <div className={`${headerBorder} px-4 py-3.5`}>
        <div className="flex items-center justify-between mb-0">
          <h2 className="font-cinzel text-[16px] font-medium text-slate-900 dark:text-white/70 tracking-[0.04em]">
            {t("edit_profile")}
          </h2>
          <button
            onClick={onClose}
            className="w-10 h-10 rounded-lg bg-slate-100 dark:bg-white/[0.04]
              border border-slate-300 dark:border-white/[0.08]
              flex items-center justify-center
              text-slate-500 dark:text-white/40
              hover:text-slate-800 dark:hover:text-white/60
              hover:bg-slate-200 dark:hover:bg-white/[0.07] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {error && (
          <div className="mt-2 p-2 bg-red-50 dark:bg-[#1a0505] border border-red-200 dark:border-red-800/30 rounded-lg">
            <p className="text-[16px] text-red-600 dark:text-red-400/70">
              {error}
            </p>
          </div>
        )}
        {success && (
          <div className="mt-2 p-2 bg-emerald-50 dark:bg-[#051a0d] border border-emerald-200 dark:border-emerald-800/30 rounded-lg">
            <p className="text-[16px] text-emerald-700 dark:text-emerald-400/70">
              {success}
            </p>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        {/* Avatar */}
        <AvatarUpload
          userInfo={userInfo}
          onAvatarUpdated={handleAvatarUpdated}
          onUploadingChange={setAvatarUploading}
        />

        {/* Username (readonly) */}
        <div className="space-y-1.5">
          <label className={`flex items-center gap-1.5 ${labelText}`}>
            <User className="w-2.5 h-2.5" />
            {t("username") ||
              "Username"}
          </label>
          <div className={readonlyBox}>
            <span className="text-[14px] text-slate-600 dark:text-white/40 font-mono">
              @{userInfo?.uniqueName || "—"}
            </span>
            <span className="ml-auto text-[11px] text-slate-500 dark:text-white/40">
              {t("unchangeable") ||
                "Unchangeable"}
            </span>
          </div>
        </div>

        {/* Display name */}
        <div className="space-y-1.5">
          <label className={`flex items-center gap-1.5 ${labelText}`}>
            <User className="w-2.5 h-2.5" />
            {t("display_name") || "Name"}
          </label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            maxLength={50}
            placeholder={t("display_name_placeholder") || "e.g. John"}
            className={inputCls}
          />
        </div>

        {/* Country */}
        <div className="space-y-1.5">
          <label className={`flex items-center gap-1.5 ${labelText}`}>
            <Globe className="w-2.5 h-2.5" />
            {t("country")}
          </label>
          <div className="flex flex-col gap-2">
            {/* Earth button */}
            <button
              type="button"
              onClick={() => setFormData({ ...formData, country: "EARTH" })}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[16px] border transition-all ${
                formData.country === "EARTH"
                  ? "border-blue-400 dark:border-blue-500/40 bg-blue-50 dark:bg-blue-900/15 text-blue-600 dark:text-blue-400/65"
                  : "border-slate-300 dark:border-white/[0.08] bg-slate-100 dark:bg-white/[0.02] text-slate-600 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.14]"
              }`}
            >
              <Globe className="w-3.5 h-3.5" />
              {t("earth") || "Planet Earth"}
              {formData.country === "EARTH" && (
                <span className="ml-auto text-[11px] text-blue-500 dark:text-blue-400/60">
                  ✓
                </span>
              )}
            </button>

            {/* Detect location button */}
            <button
              type="button"
              onClick={handleDetectLocation}
              disabled={countryLoading}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[16px] border transition-all disabled:opacity-50 ${
                formData.country && formData.country !== "EARTH"
                  ? "border-emerald-400 dark:border-emerald-500/35 bg-emerald-50 dark:bg-emerald-900/12 text-emerald-700 dark:text-emerald-400/75"
                  : "border-slate-300 dark:border-white/[0.08] bg-slate-100 dark:bg-white/[0.02] text-slate-600 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.14]"
              }`}
            >
              {countryLoading ? (
                <div className="w-3.5 h-3.5 rounded-full border border-current border-t-transparent animate-spin" />
              ) : (
                <MapPin className="w-3.5 h-3.5" />
              )}
              {countryLoading ? t("detecting") : t("detect_location")}
              {formData.country &&
                formData.country !== "EARTH" &&
                !countryLoading && (
                  <span className="ml-auto text-[14px] font-medium">
                    {getTranslatedCountryName(formData.country)} ✓
                  </span>
                )}
            </button>
          </div>

          {formData.h3Index && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-indigo-300 dark:border-indigo-500/25 bg-indigo-50 dark:bg-indigo-900/10 text-indigo-600 dark:text-indigo-400/65">
              <svg
                viewBox="0 0 24 24"
                className="w-3.5 h-3.5 fill-current flex-shrink-0"
              >
                <polygon points="12,2 21,7 21,17 12,22 3,17 3,7" />
              </svg>
              <span className="font-mono text-[14px] truncate">
                {formData.h3Index}
              </span>
              <span className="ml-auto text-[11px] opacity-50">
                {t("resolution_level_3")}
              </span>
            </div>
          )}
        </div>

        {/* Bio */}
        <div className="space-y-1.5">
          <label className={labelText}>{t("about_me")}</label>
          <textarea
            value={formData.bio}
            onChange={(e) => setFormData({ ...formData, bio: e.target.value })}
            rows={3}
            maxLength={500}
            placeholder={t("tell_about_yourself")}
            className={`${inputCls} resize-none`}
          />
          <p className={`text-[14px] ${subText} text-right`}>
            {formData.bio.length}/500
          </p>
        </div>

        {/* Footer buttons */}
        <div
          className={`flex items-center justify-end gap-2.5 pt-4 ${footerBorder}`}
        >
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-[16px] rounded-lg
              bg-transparent
              border border-slate-300 dark:border-white/[0.09]
              text-slate-600 dark:text-white/35
              hover:text-slate-800 dark:hover:text-white/60
              hover:border-slate-400 dark:hover:border-white/[0.16]
              transition-colors"
          >
            {t("cancel")}
          </button>
          <button
            type="submit"
            disabled={loading || avatarUploading}
            className="px-4 py-1.5 text-[16px] font-medium rounded-lg
            // Light theme - red with a maroon tint
            bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
            // Dark theme - dark maroon (as before)
            dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3D0012] transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
              flex items-center gap-1.5"
          >
            {loading ? (
              <>
                <div className="w-3 h-3 rounded-full border border-[#e8a0b0]/50 border-t-transparent animate-spin" />
                {t("saving")}
              </>
            ) : avatarUploading ? (
              t("uploading_avatar") || "Uploading avatar…"
            ) : (
              t("save_changes")
            )}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ProfileEditModal;
