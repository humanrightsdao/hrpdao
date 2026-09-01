// src/pages/UserProfilePage.jsx
import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { nip19 } from "nostr-tools";
import {
  User,
  Cake,
  ArrowLeft,
  Shield,
  Wallet,
  MessageSquare,
  UserPlus,
  UserMinus,
  Users,
  ShieldAlert,
  ShieldOff,
} from "lucide-react";
import Layout from "../components/Layout";
import CountryFeed from "../components/CountryFeed";
import useUserInfo from "../hooks/useUserInfo";
import { useCountry } from "../hooks/useCountry";
// REMOVED: import { supabase } from "../lib/supabase";
// Full migration from Supabase to Lens — the public profile is now
// read entirely from the blockchain via useLensPublicProfile.
import { useLensPublicProfile } from "../hooks/useLensProfile";
// ADDED: caches a visited profile's Lens name/avatar against their
// Nostr pubkey (see the effect below, right after userData loads).
import { cacheLensProfile } from "../hooks/useNostrProfile";
// ADDED: follow and block — also directly via Lens Protocol, with no
// backend intermediary at all. Each hook resumes the authorized Lens
// session itself (resumeSession) and does nothing if the user isn't
// logged in — the buttons below simply hide themselves in that case.
import { useLensFollow } from "../hooks/useLensFollow";
import { useLensBlock } from "../hooks/useLensBlock";
// ДОДАНО: перевірка community-бану автора — раніше ця сторінка взагалі
// не перевіряла moderationActions.js. Пости вже ховались опосередковано
// через CountryFeed (там уже є ban-фільтр), але сам профіль (аватар,
// ім'я, кнопки "Написати"/"Підписатись") показувався як для будь-кого
// іншого, без жодного індикатора санкції.
import {
  fetchAllModActions,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";

const UserProfilePage = () => {
  const { userId } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { userInfo, loading: userLoading, error: userError } = useUserInfo();
  const { getTranslatedCountryName } = useCountry(i18n.language);

  // REMOVED: the entire useState(userData)/useState(loading)/useState(error)
  // block + the useEffect with manual supabase queries (users / lens_users by
  // UUID / wallet_address / lens_account_address). No longer needed —
  // userId on this page is now always the Lens Account address (the same
  // one post.author.address returns), and useLensPublicProfile loads the
  // data directly from Lens, with no intermediary.
  const {
    profile: userData,
    loading,
    error: lensError,
  } = useLensPublicProfile(userId);

  // ADDED: caches this profile's name/avatar against their Nostr
  // pubkey the moment we see it — not gated on clicking "Message on
  // Nostr" below, so simply having viewed someone's profile once is
  // enough for chat to later show their real name/avatar, instead of
  // depending on their kind:0 ever reaching a relay we're connected
  // to (see hooks/useNostrProfile.js's cacheLensProfile for the full
  // reasoning — this is the other half of the "sync Lens ↔ Nostr" fix,
  // the first half being the piggybacked profile tags every DM now
  // carries, see useNostrChat.js's sendDirectMessage).
  useEffect(() => {
    if (!userData?.nostrNpub) return;
    try {
      const decoded = nip19.decode(userData.nostrNpub);
      if (decoded.type !== "npub") return;
      cacheLensProfile(decoded.data, {
        name: userData.name || null,
        picture: userData.avatar || null,
      });
    } catch {
      // malformed npub — not fatal, chat still falls back to
      // kind:0/piggybacked-tag discovery.
    }
  }, [userData?.nostrNpub, userData?.name, userData?.avatar]);

  // ADDED: follow and block status relative to this profile.
  // userId here is the Lens Account address from the URL (the same one
  // passed to useLensPublicProfile), so both hooks look at the same account.
  const {
    isFollowing,
    toggleFollow,
    loading: followLoading,
    checking: followChecking,
  } = useLensFollow(userId);

  const {
    isBlocked,
    toggleBlock,
    loading: blockLoading,
    checking: blockChecking,
  } = useLensBlock(userId);

  // ДОДАНО: стан community-бану цього профілю (голосування Shield/Council).
  const [banState, setBanState] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!userData?.owner) return;
    (async () => {
      try {
        const [actions, supply] = await Promise.all([
          fetchAllModActions(),
          fetchShieldTotalSupply(),
        ]);
        if (!cancelled) {
          setBanState(computeBanState(actions, userData.owner, supply));
        }
      } catch (err) {
        console.warn("⚠️ Не вдалося перевірити стан бану:", err.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userData?.owner]);

  // If userId is missing from the URL — nothing to show
  useEffect(() => {
    if (!userId) {
      navigate("/");
    }
  }, [userId, navigate]);

  // The profile loaded, but no account with this address was found on Lens
  const notFound = !loading && !userData && !lensError && Boolean(userId);
  const error =
    lensError || (notFound ? t("user_not_found") || "User not found" : "");

  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      return t("earth") || "Планета Земля";
    }
    const translated = getTranslatedCountryName(countryCode);
    return translated || countryCode;
  };

  const formatDate = (dateString) => {
    if (!dateString) return "Not specified";
    const date = new Date(dateString);
    return date
      .toLocaleDateString("uk-UA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
      .replaceAll("/", ".");
  };

  // REMOVED: parseSocialLinks(). Social links are no longer stored as a
  // separate structured entity (previously — userData.social_links in
  // Supabase) — now the user adds links to their social media themselves
  // directly in the Bio text, which is already read from the Lens account
  // metadata anyway.

  const formatWalletAddress = (address) => {
    if (!address) return "Not connected";
    if (address.length <= 10) return address;
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  if (loading) {
    return (
      <Layout
        userProfile={userInfo}
        walletAddress={userInfo?.walletAddress}
        onLogout={() => {
          localStorage.removeItem("token");
          localStorage.removeItem("web3_wallet_address");
          window.location.href = "/";
        }}
        loading={userLoading}
        error={userError}
        onCreatePost={() => {}}
      >
        <div className="min-h-screen flex items-center justify-center">
          <div
            className="w-8 h-8 rounded-full border-2 border-blue-600/40
            border-t-blue-400 animate-spin"
          />
        </div>
      </Layout>
    );
  }

  if (error || !userData) {
    return (
      <Layout
        userProfile={userInfo}
        walletAddress={userInfo?.walletAddress}
        onLogout={() => {
          localStorage.removeItem("token");
          localStorage.removeItem("web3_wallet_address");
          window.location.href = "/";
        }}
        loading={userLoading}
        error={userError}
        onCreatePost={() => {}}
      >
        <div className="min-h-screen flex flex-col items-center justify-center p-4">
          <div className="text-center">
            <User className="w-12 h-12 text-slate-300 dark:text-white/[0.07] mx-auto mb-3" />
            <h2 className="font-cinzel text-[16px] text-slate-800 dark:text-white/70 mb-1">
              {t("user_not_found") || "User not found"}
            </h2>
            <p className="text-[14px] text-slate-600 dark:text-white/45 mb-4">
              {error}
            </p>
            <button
              onClick={() => navigate(-1)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[16px]
                bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]/70
                rounded-lg hover:bg-[#3d0012] transition-colors"
            >
              <ArrowLeft className="w-3 h-3" />
              {t("go_back") || "Go back"}
            </button>
          </div>
        </div>
      </Layout>
    );
  }

  const userCountryName = getCountryDisplayName(userData.country);
  // The profile's own Lens Account address — used both for the message
  // button and for filtering the post feed below.
  const userAddress = userData.address;
  // FIXED: previously userData.name was deliberately ignored here to
  // avoid confusion with username. The final product decision is
  // different: show BOTH — name (if set) as primary, username always as
  // a second line, with a clear visual hierarchy (rather than an
  // equally-weighted duplicate, which is what caused the confusion
  // before). For users who haven't set a name (the field is optional),
  // name is simply null — leaving only the username, with no empty
  // second line.
  const primaryName =
    userData.name || userData.handle || formatWalletAddress(userData.address);

  // FIXED: previously this compared userInfo.walletAddress (the WALLET
  // address) against userAddress (the Lens ACCOUNT address) — these are
  // fundamentally different addresses even for one's own profile (a
  // single wallet controls a Lens Account, but it isn't the same
  // address). Because of this, isOwnProfile always returned false, and
  // the "Message", "Follow", "Block" buttons showed up even on one's own
  // page — hence the ability to follow/block/message oneself.
  //
  // The correct comparison is against lens_account_address in
  // localStorage: this is the address of the logged-in user's ACTIVE
  // Lens Account, the same key already used by useLensProfile.js
  // (fetchLensAccountData) to determine "which of MY accounts is
  // currently active".
  const activeLensAccountAddress = (
    typeof window !== "undefined"
      ? localStorage.getItem("lens_account_address")
      : null
  )?.toLowerCase();

  const isOwnProfile = Boolean(
    activeLensAccountAddress &&
    userAddress &&
    activeLensAccountAddress === userAddress.toLowerCase(),
  );

  return (
    <Layout
      userProfile={userInfo}
      walletAddress={userInfo?.walletAddress}
      onLogout={() => {
        localStorage.removeItem("token");
        localStorage.removeItem("web3_wallet_address");
        window.location.href = "/";
      }}
      loading={userLoading}
      error={userError}
      onCreatePost={() => {}}
    >
      <div>
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-[16px] text-slate-600 dark:text-white/40
            hover:text-slate-900 dark:hover:text-white/60 transition-colors mb-4"
        >
          <ArrowLeft className="w-3 h-3" />
          {t("back") || "Back"}
        </button>

        {/* ДОДАНО: банер community-бану. Показується поверх картки
            профілю, але не блюрить/не приховує саму картку — публічні
            дані (адреса, хендл) і так відкриті он-чейн, а прозорість —
            частина задуму системи Shield/Council голосування. */}
        {banState?.banned && (
          <div className="flex items-center gap-2.5 mb-4 px-4 py-3 rounded-xl border border-red-300 dark:border-red-500/25 bg-red-50 dark:bg-red-500/[0.06]">
            <ShieldAlert className="w-5 h-5 text-red-500 flex-shrink-0" />
            <p className="text-[14px] text-slate-700 dark:text-white/70">
              {t("account_banned") ||
                "Акаунт заблоковано голосуванням спільноти"}
            </p>
          </div>
        )}

        {/* Main profile */}
        <div
          className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-5
          flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-4"
        >
          {/* Avatar with hexagon wrapper */}
          <div className="relative flex-shrink-0">
            <div
              className="relative w-[72px] h-[80px] p-[1.5px] clip-path-hexagon
                bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]"
            >
              <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                {userData.avatar ? (
                  <img
                    src={userData.avatar}
                    alt={primaryName}
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
                  className={`avatar-fallback w-full h-full flex items-center justify-center
                    font-cinzel text-[28px] text-[#c8b8a2] bg-[#0d0415]
                    ${userData.avatar ? "hidden" : "flex"}`}
                >
                  {primaryName?.[0]?.toUpperCase() || "U"}
                </div>
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {/* FIXED: previously there were TWO names here — displayName
                    (name || handle) in the h1, and the handle SEPARATELY
                    again below. If name = "Nazar" and handle = "@nazar" —
                    that's essentially the same identity, just in a
                    different case (a Lens handle is always lowercase —
                    that's how the namespace works, not a formatting bug).
                    So the redundant line was removed — only one name remains. */}
                {/* FIXED: the final decision — name (if present) as the
                    primary line, @username ALWAYS as a second line, in a
                    muted color and smaller size. This is no longer "two
                    equally-weighted names" (the confusion from before) —
                    it's a name + a unique technical identifier, like on
                    Twitter/X, Instagram, Farcaster. The username is unique
                    (reserved in the protocol's namespace), the name isn't,
                    so the username remains what links/mentions/routes rely on. */}
                <h1 className="text-[16px] font-medium text-slate-900 dark:text-white/85">
                  {primaryName}
                </h1>
                {userData.handle && (
                  <p className="text-[14px] text-slate-600 dark:text-white/40">
                    {userData.handle}
                  </p>
                )}
                <span
                  className="text-[11px] px-1.5 py-0.5 rounded
                    bg-blue-100 dark:bg-blue-900/25 border border-blue-300/50 dark:border-blue-700/20 text-blue-700 dark:text-blue-400/65
                    flex-shrink-0"
                >
                  {userCountryName}
                </span>
                {/* ADDED: link to the following/followers list for THIS
                    specific profile — FollowingPage itself distinguishes
                    someone else's profile from your own via :userId in
                    the route. */}
                {userAddress && (
                  <button
                    onClick={() => navigate(`/following/${userAddress}`)}
                    className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5
                      rounded-[5px] bg-slate-100 dark:bg-white/[0.04] border border-slate-300 dark:border-white/10
                      text-slate-600 dark:text-white/50 hover:text-slate-900 dark:hover:text-white/70 hover:bg-slate-200 dark:hover:bg-white/[0.07]
                      transition-colors"
                  >
                    <Users className="w-2.5 h-2.5" />
                    {t("following_followers") || "Following / Followers"}
                  </button>
                )}
              </div>

              {/* Action buttons: message / follow / block.
                  All three hide together on one's own profile —
                  isOwnProfile checks the address from useUserInfo against
                  the address of the Lens Account being viewed. */}
              {userAddress && !isOwnProfile && (
                <div className="flex items-center gap-2 flex-wrap">
                  {/* ADDED: only shown if this user has actually linked a
                      Nostr identity to their Lens account (see
                      useNostrIdentity.js's linkNostrIdentityToLensAccount)
                      — most profiles won't have this yet, so the button
                      simply doesn't render rather than leading to a chat
                      with no possible recipient. */}
                  {userData?.nostrNpub && !banState?.banned && (
                    <button
                      onClick={() =>
                        navigate(
                          `/nostr-chat?npub=${encodeURIComponent(userData.nostrNpub)}`,
                          // ADDED: hands the chat page the Lens name/
                          // avatar we already have right here, instead
                          // of making it rediscover them later via a
                          // Nostr kind:0 relay round-trip (which
                          // depends on: us having ever published one
                          // AND at least one of our configured relays
                          // being reachable right now — see
                          // NostrChatPage.jsx's peer-profile caching
                          // for the full reasoning). This is the
                          // "sync Lens ↔ Nostr" the person doing QA on
                          // this asked for: Lens is the reliable
                          // source, so hand it over at the one moment
                          // we're guaranteed to have both pieces of
                          // data in hand at once.
                          {
                            state: {
                              peerName: userData.name || null,
                              peerAvatar: userData.avatar || null,
                            },
                          },
                        )
                      }
                      className="flex items-center gap-1.5 px-3 py-1.5 text-[16px]
                        bg-purple-600/10 dark:bg-purple-400/10 text-purple-700 dark:text-purple-300
                        border border-purple-600/20 dark:border-purple-400/20 hover:bg-purple-600/15 dark:hover:bg-purple-400/15
                        rounded-lg transition-colors whitespace-nowrap"
                    >
                      💬 {t("message_on_nostr") || "Message on Nostr"}
                    </button>
                  )}

                  {/* ADDED: follow/unfollow. The button hides while the
                      status hasn't been checked yet (followChecking) — so
                      it doesn't flash a "Follow" state for a moment before
                      the real state arrives from Lens. */}
                  {!followChecking && !banState?.banned && (
                    <button
                      onClick={toggleFollow}
                      disabled={followLoading}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[16px] rounded-lg
                        transition-colors whitespace-nowrap disabled:opacity-50 ${
                          isFollowing
                            ? "bg-slate-100 dark:bg-white/[0.05] border border-slate-300 dark:border-white/10 text-slate-700 dark:text-white/60 hover:bg-slate-200 dark:hover:bg-white/[0.08]"
                            : "bg-blue-50 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700/30 text-blue-700 dark:text-blue-400/80 hover:bg-blue-100 dark:hover:bg-blue-900/30"
                        }`}
                    >
                      {isFollowing ? (
                        <UserMinus className="w-3 h-3" />
                      ) : (
                        <UserPlus className="w-3 h-3" />
                      )}
                      {followLoading
                        ? t("processing") || "..."
                        : isFollowing
                          ? t("unfollow") || "Unfollow"
                          : t("follow") || "Follow"}
                    </button>
                  )}

                  {/* ADDED: block/unblock. Before actually blocking, we
                      ask for confirmation — it's an on-chain action and
                      can't be "accidentally" undone unnoticed. */}
                  {!blockChecking && (
                    <button
                      onClick={() => {
                        if (
                          isBlocked ||
                          window.confirm(
                            t("confirm_block") ||
                              "Block this user? You will no longer see their posts and messages.",
                          )
                        ) {
                          toggleBlock();
                        }
                      }}
                      disabled={blockLoading}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-[16px] rounded-lg
                        transition-colors whitespace-nowrap disabled:opacity-50 ${
                          isBlocked
                            ? "bg-emerald-50 dark:bg-green-900/15 border border-emerald-300 dark:border-green-700/20 text-emerald-700 dark:text-green-400/65 hover:bg-emerald-100 dark:hover:bg-green-900/25"
                            : "bg-red-50 dark:bg-[#2B000A]/60 border border-red-300 dark:border-[#b41e3c]/20 text-red-600 dark:text-[#e8a0b0]/60 hover:bg-red-100 dark:hover:bg-[#3d0012]"
                        }`}
                    >
                      {isBlocked ? (
                        <ShieldOff className="w-3 h-3" />
                      ) : (
                        <ShieldAlert className="w-3 h-3" />
                      )}
                      {blockLoading
                        ? t("processing") || "..."
                        : isBlocked
                          ? t("unblock") || "Unblock"
                          : t("block") || "Block"}
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* Bio — here the user can optionally leave links to their
                social media themselves (as text); there's no separate
                social links section anymore */}
            {userData.bio && (
              <div className="mt-2.5">
                <p className="text-[14px] text-slate-700 dark:text-white/45 leading-relaxed whitespace-pre-wrap">
                  {userData.bio}
                </p>
              </div>
            )}

            {/* Additional information */}
            <div className="flex flex-wrap gap-3 mt-2.5">
              {userData.address && (
                <div
                  className="flex items-center gap-1.5 text-[14px] text-slate-600 dark:text-white/40
                    cursor-pointer hover:text-slate-900 dark:hover:text-white/60 transition-colors"
                  title={userData.address}
                  onClick={() =>
                    navigator.clipboard?.writeText(userData.address)
                  }
                >
                  <Wallet className="w-2.5 h-2.5" />
                  <span className="font-mono text-blue-600 dark:text-blue-400/60">
                    {formatWalletAddress(userData.address)}
                  </span>
                </div>
              )}

              {userData.dateOfBirth && (
                <div className="flex items-center gap-1.5 text-[14px] text-slate-600 dark:text-white/40">
                  <Cake className="w-2.5 h-2.5" />
                  <span>{formatDate(userData.dateOfBirth)}</span>
                </div>
              )}

              <div className="flex items-center gap-1.5 text-[14px] text-slate-600 dark:text-white/40">
                <Shield className="w-2.5 h-2.5" />
                <span>
                  {t("member_since") || "Since"}{" "}
                  {formatDate(userData.createdAt)}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* REMOVED: the "Social Media" block (previously rendered
            socialLinks.map(...) from userData.social_links). Social
            links are now something the user specifies themselves in the
            Bio text above. */}

        {/* Posts section - no extra wrapper */}
        <div className="flex items-center justify-between mb-3">
          <p className="font-cinzel text-[11px] text-slate-500 dark:text-white/40 tracking-[0.1em] uppercase">
            <MessageSquare className="w-2.5 h-2.5 inline mr-1.5" />
            {t("user_posts") || "Posts"}
          </p>
          <span className="text-[14px] text-slate-600 dark:text-white/40 opacity-70">
            {t("all_posts") || "All posts"}
          </span>
        </div>

        {/* ADDED: if the viewed account is blocked — hide the posts
            entirely, instead of pulling in CountryFeed with content from
            someone the user has deliberately blocked. */}
        {isBlocked ? (
          <div className="text-center py-8 text-slate-600 dark:text-white/40 text-[14px]">
            {t("blocked_no_posts") ||
              "Content unavailable — user is blocked"}
          </div>
        ) : (
          <CountryFeed
            walletAddress={userAddress}
            userId={null}
            countryCode={null}
            filterByCountry={false}
            compact={true}
          />
        )}
      </div>
    </Layout>
  );
};

export default UserProfilePage;
