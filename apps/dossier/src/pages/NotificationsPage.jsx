// src/pages/NotificationsPage.jsx
//
// MIGRATION FROM SUPABASE TO LENS — supabase.from(...) /
// supabase.channel(...) / supabase.auth.* have been fully removed.
// Notification and saved-post data now comes from the Lens blockchain via
// useLensPosts (getNotifications / getBookmarkedPosts methods, added
// specifically for this migration — see the comments in useLensPosts.js).
//
// 🔍 IMPORTANT — CHECK before running:
// 1) The `useLensAuth` import below — the path "../contexts/LensAuthContext"
//    is an assumption based on the hook name mentioned directly in the
//    comments of useLensPosts.js ("session client... obtained from
//    LensAuthContext (useLensAuth().sessionClient)"). The context file
//    itself wasn't provided to me — verify the actual path/filename in
//    your project.
// 2) `lensLogout` (logout from useLensAuth()) — also an assumption about
//    the field name. If the context doesn't provide logout(), there's a
//    safe fallback below (just clearing localStorage), but it's better
//    to call the official logout from the context if it exists — it
//    invalidates the session on Lens's side.
// 3) The "/profile/:address" route when clicking a new-follower
//    notification — added by analogy with "/post/:id", verify against
//    your own router (App.jsx).
import React, { useEffect, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Bell,
  Check,
  Trash2,
  Bookmark,
  ChevronRight,
  Globe,
  Eye,
} from "lucide-react";
import Layout from "../components/Layout";
import { useNavigate } from "react-router-dom";
import CreatePostModal from "../components/CreatePostModal";
import useUserInfo from "../hooks/useUserInfo";
import useLensPosts from "../hooks/useLensPosts";
import { useLensAuth } from "../context/LensAuthContext";
import { useCountry } from "../hooks/useCountry";

// ADDED: converting lens:// / ar:// / ipfs:// to https://, needed to show
// the avatar of the notification actor (who reacted/commented/followed).
// The same logic already exists in useLensProfile.js and useLensPosts.js
// — duplicated here following the same principle explained in the
// comments of those files: this is a separate, independent file, simpler
// not to get tangled up in dependencies between modules.
const resolveActorPicture = (picture) => {
  if (!picture) return null;

  if (typeof picture === "object") {
    picture =
      picture?.optimized?.uri || picture?.raw?.uri || picture?.uri || null;
    if (!picture) return null;
  }

  if (picture.startsWith("lens://")) {
    return `https://api.grove.storage/${picture.replace("lens://", "")}`;
  }
  if (picture.startsWith("ar://")) {
    return `https://arweave.net/${picture.replace("ar://", "")}`;
  }
  if (picture.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${picture.replace("ipfs://", "")}`;
  }

  return picture;
};

// ADDED: get the country from a raw Lens Account's attributes (the same
// fallback key chain used in mapAccountToProfile in useLensProfile.js).
const getActorCountry = (account) => {
  const attrs = {};
  for (const attr of account?.metadata?.attributes || []) {
    attrs[attr.key] = attr.value;
  }
  return attrs.country || attrs.countryCode || attrs.Country || "EARTH";
};

// ADDED: the local storage key for the notifications "read"/"deleted"
// state — separate for each Lens account (wallet), so one user's state
// doesn't "leak" to another on the same device.
const getNotificationsStorageKey = (walletAddress) =>
  `lens_notifications_state_${(walletAddress || "anon").toLowerCase()}`;

const loadNotificationsState = (walletAddress) => {
  try {
    const raw = localStorage.getItem(getNotificationsStorageKey(walletAddress));
    if (!raw) return { read: [], deleted: [] };
    const parsed = JSON.parse(raw);
    return { read: parsed.read || [], deleted: parsed.deleted || [] };
  } catch {
    return { read: [], deleted: [] };
  }
};

const saveNotificationsState = (walletAddress, state) => {
  try {
    localStorage.setItem(
      getNotificationsStorageKey(walletAddress),
      JSON.stringify(state),
    );
  } catch (e) {
    console.error("❌ Error saving local notifications state:", e);
  }
};

const NotificationsPage = () => {
  const { t, i18n } = useTranslation();
  const { userInfo, loading: userInfoLoading } = useUserInfo();
  const { getTranslatedCountryName } = useCountry(i18n.language);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notifications, setNotifications] = useState([]);
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState("notifications");
  const [savedPosts, setSavedPosts] = useState([]);
  const [loadingSavedPosts, setLoadingSavedPosts] = useState(false);
  const [savedPostsError, setSavedPostsError] = useState("");

  // REPLACED (was: supabase + usePosts): both notifications and "saved
  // posts" (bookmarks) now go through a single useLensPosts — the same
  // way it's already done for the regular post feed.
  const { sessionClient, logout: lensLogout } = useLensAuth();
  const { getNotifications, getBookmarkedPosts, undoBookmarkLensPost } =
    useLensPosts(sessionClient);

  // A set of already-known notification ids — needed so that during
  // polling a toast is shown only for genuinely NEW notifications, not
  // for the entire history on every request. null = no load has happened yet.
  const knownNotificationIdsRef = useRef(null);

  // FIX (notifications "un-read themselves" after 45s): the setInterval
  // below is created ONCE (the effect depends on [userInfo?.id,
  // sessionClient], which stabilize and don't change again) — so the
  // arrow function inside forever captures the version of
  // loadNotifications() that existed AT THE EXACT MOMENT the effect first
  // fired. And loadNotifications is a regular (NOT useCallback) function
  // that reads userProfile?.wallet_address from the closure of the
  // current render. At the moment the effect first fires, userProfile is
  // still almost certainly null (the neighboring useEffect that calls
  // setUserProfile(...) hasn't managed to reach the next render yet) —
  // so EVERY subsequent poll (including the first) forever reads from and
  // writes to the localStorage key "lens_notifications_state_anon",
  // rather than the key with the real wallet address. The "Mark as read"
  // button, on the other hand, is called from a fresh render (where
  // userProfile is already real) and writes to a DIFFERENT key — the two
  // keys never intersect, so after every poll everything looks
  // "unread" again. loadNotificationsRef always points to the freshest
  // version of the function — the same pattern already used in
  // LensAuthContext.jsx (loadUserInfoRef).
  const loadNotificationsRef = useRef(null);

  useEffect(() => {
    if (userInfoLoading) return;

    if (!userInfo) {
      navigate("/");
      return;
    }

    if (!userInfo.hasCompletedOnboarding) {
      navigate("/create-lens-account");
      return;
    }

    setUserProfile({
      id: userInfo.id,
      unique_name: userInfo.uniqueName,
      country: userInfo.country,
      avatar_url: userInfo.avatarUrl,
      wallet_address: userInfo.walletAddress,
      authMethod: userInfo.authMethod,
    });
    setLoading(false);
  }, [userInfo, userInfoLoading, navigate]);

  const getCountryDisplayName = (countryCode) => {
    if (!countryCode || countryCode === "EARTH") return "";
    const translated = getTranslatedCountryName(countryCode);
    return translated || countryCode;
  };

  useEffect(() => {
    // FIX (part 2 — after F5 the page immediately shows "unread"): the
    // ref pattern above alone isn't enough for the FIRST call. This
    // effect fires on the same render where the neighboring effect (that
    // calls setUserProfile) hasn't managed to push its update through to
    // the next render yet — meaning userProfile is still null at that
    // point, and even the "fresh" loadNotificationsRef.current on THIS
    // render points to a version of loadNotifications that was also
    // closed over userProfile=null. Solution: add
    // userProfile?.wallet_address to the dependencies and DON'T perform
    // any request until it's actually ready — then the effect will only
    // fire on the render where userProfile is already correct.
    if (userInfo?.id && sessionClient && userProfile?.wallet_address) {
      loadNotificationsRef.current?.();

      // REPLACED: Supabase Realtime (postgres_changes on the
      // notifications table, a WebSocket subscription) has no direct
      // equivalent in the Lens API — fetchNotifications is a regular
      // paginated GraphQL query, with no server push. Here — periodic
      // polling instead of realtime. The interval can be tuned to actual load.
      const intervalId = setInterval(() => {
        // Call via ref — in case userProfile (unique_name, avatar, etc.)
        // still gets updated later, the ref will still always point to
        // the freshest version of the function.
        loadNotificationsRef.current?.();
      }, 45000);

      return () => clearInterval(intervalId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userInfo?.id, sessionClient, userProfile?.wallet_address]);

  useEffect(() => {
    if (activeTab === "saved" && userInfo?.id && savedPosts.length === 0) {
      loadSavedPosts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, userInfo]);

  const loadNotifications = async () => {
    if (!userInfo?.id) return;

    try {
      const result = await getNotifications();

      if (!result.success) {
        console.error("❌ Error loading Lens notifications:", result.error);
        return;
      }

      const { read, deleted } = loadNotificationsState(
        userProfile?.wallet_address,
      );

      const visible = result.notifications.filter(
        (n) => !deleted.includes(n.id),
      );
      const formatted = visible.map((n) => formatNotification(n, read));

      // Toast only for new ids, and only not on the page's first load
      // (otherwise it would show a toast for the entire history at once).
      if (knownNotificationIdsRef.current) {
        const newOnes = formatted.filter(
          (n) => !knownNotificationIdsRef.current.has(n.id),
        );
        newOnes.forEach(showToastNotification);
      }
      knownNotificationIdsRef.current = new Set(formatted.map((n) => n.id));

      setNotifications(formatted);
    } catch (error) {
      console.error("❌ Error loading notifications:", error);
    }
  };

  // Sync the ref with the current version of the function after EVERY
  // render — this is exactly what fixes the stale closure: setInterval
  // always calls loadNotificationsRef.current(), and this property always
  // points to the version of the function with the MOST RECENT userProfile.
  loadNotificationsRef.current = loadNotifications;

  const showToastNotification = (notification) => {
    const toast = document.createElement("div");
    toast.className = `fixed top-4 right-4 z-50 p-3 rounded-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] border-l-4 ${
      notification.type === "reaction"
        ? "border-pink-500/60 bg-[#1a0510]"
        : notification.type === "comment"
          ? "border-green-500/60 bg-[#051a0f]"
          : notification.type === "follow"
            ? "border-indigo-500/60 bg-[#0a0a1a]"
            : "border-yellow-500/60 bg-[#1a1405]"
    }`;
    toast.style.minWidth = "250px";
    toast.style.maxWidth = "300px";
    toast.style.animation = "slideInRight 0.3s ease-out";

    const icon = getNotificationIcon(notification.type);
    const colorClass = getNotificationColor(notification.type).split(" ")[0];

    toast.innerHTML = `
      <div class="flex items-start gap-2">
        <div class="flex-shrink-0">
          <div class="w-8 h-8 rounded-lg ${colorClass} flex items-center justify-center text-sm">
            ${icon}
          </div>
        </div>
        <div class="flex-1 min-w-0">
          <h4 class="font-medium text-white/80 text-xs mb-0.5">${notification.title}</h4>
          <p class="text-white/45 text-xs mb-1 line-clamp-2">${notification.message}</p>
          <div class="flex items-center justify-between">
            <span class="text-xs text-white/20">${notification.time}</span>
            <button class="text-xs text-white/30 hover:text-white/60 transition-colors">
              ${t("close")}
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(toast);

    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.animation = "slideOutRight 0.3s ease-in";
        setTimeout(() => {
          if (toast.parentNode) {
            document.body.removeChild(toast);
          }
        }, 300);
      }
    }, 5000);

    toast.querySelector("button").onclick = () => {
      toast.style.animation = "slideOutRight 0.3s ease-in";
      setTimeout(() => {
        if (toast.parentNode) {
          document.body.removeChild(toast);
        }
      }, 300);
    };
  };

  const loadSavedPosts = async () => {
    if (!userInfo?.id) return;

    setLoadingSavedPosts(true);
    setSavedPostsError("");

    try {
      // REPLACED (was: getSavedPosts(userInfo.id, 0, 20) from the
      // Supabase usePosts hook): bookmarks are now read directly from
      // Lens — getBookmarkedPosts() returns the same posts that
      // bookmarkLensPost/undoBookmarkLensPost add/remove.
      const result = await getBookmarkedPosts();

      if (result.success) {
        setSavedPosts(result.posts);
      } else {
        setSavedPostsError(result.error || t("saved_posts_load_error"));
      }
    } catch (error) {
      console.error("❌ Error loading saved posts:", error);
      setSavedPostsError(error.message || t("saved_posts_load_error"));
    } finally {
      setLoadingSavedPosts(false);
    }
  };

  const handleRemoveSavedPost = async (postId, e) => {
    e.stopPropagation();

    if (!window.confirm(t("remove_saved_post_confirm"))) {
      return;
    }

    try {
      // REPLACED: in Supabase a bookmark had its own save_id (a row in
      // the join table). In Lens there's no separate id for "the fact of
      // a bookmark" — there's only a toggle on the post itself, so we
      // remove it by postId via undoBookmarkLensPost (already existed in
      // useLensPosts.js for the regular feed, nothing extra needed to be written).
      const result = await undoBookmarkLensPost(postId);

      if (result.success) {
        setSavedPosts((prev) => prev.filter((post) => post.id !== postId));
      } else {
        console.error("❌ Failed to remove saved post:", result.error);
        alert(t("remove_saved_post_error"));
      }
    } catch (error) {
      console.error("❌ Error removing saved post:", error);
      alert(t("remove_saved_post_error"));
    }
  };

  // REPLACED: in Supabase markAsRead/markAllAsRead/delete* did
  // UPDATE/DELETE on rows in the "notifications" table. Lens notifications
  // are immutable, indexed protocol events, they cannot be marked as read
  // or deleted via the API. So the "read"/"deleted" state is kept locally
  // (localStorage, per wallet) — the UI behaves the same way, but nothing
  // is written back to the blockchain.
  const markAsRead = (id) => {
    const walletAddress = userProfile?.wallet_address;
    const state = loadNotificationsState(walletAddress);
    if (!state.read.includes(id)) {
      state.read.push(id);
      saveNotificationsState(walletAddress, state);
    }
    setNotifications((prev) =>
      prev.map((notif) => (notif.id === id ? { ...notif, read: true } : notif)),
    );
  };

  const markAllAsRead = () => {
    const walletAddress = userProfile?.wallet_address;
    const state = loadNotificationsState(walletAddress);
    const allIds = notifications.map((n) => n.id);
    state.read = Array.from(new Set([...state.read, ...allIds]));
    saveNotificationsState(walletAddress, state);

    setNotifications((prev) => prev.map((notif) => ({ ...notif, read: true })));
  };

  const deleteNotification = (id) => {
    const walletAddress = userProfile?.wallet_address;
    const state = loadNotificationsState(walletAddress);
    if (!state.deleted.includes(id)) {
      state.deleted.push(id);
      saveNotificationsState(walletAddress, state);
    }

    setNotifications((prev) => prev.filter((notif) => notif.id !== id));
  };

  const deleteAllNotifications = () => {
    if (!window.confirm(t("confirm_delete_notifications"))) {
      return;
    }

    const walletAddress = userProfile?.wallet_address;
    const state = loadNotificationsState(walletAddress);
    const allIds = notifications.map((n) => n.id);
    state.deleted = Array.from(new Set([...state.deleted, ...allIds]));
    saveNotificationsState(walletAddress, state);

    setNotifications([]);
  };

  const handleLogout = async () => {
    try {
      // REMOVED: await supabase.auth.signOut() — authentication now goes
      // through Lens/wallet, Supabase Auth is no longer involved here.
      if (typeof lensLogout === "function") {
        await lensLogout();
      }
      localStorage.removeItem("lens_wallet_address");
      localStorage.removeItem("lens_account_address");
      navigate("/");
    } catch (error) {
      console.error(t("logout_error"), error);
      alert(t("logout_failed"));
    }
  };

  // ADDED: get the name/avatar of the notification actor (the one who
  // reacted/commented/followed) from the raw Lens Account object.
  const getActorDisplay = (account) => {
    if (!account) {
      return { name: t("user"), avatar: null, address: null };
    }
    return {
      name:
        account.metadata?.name ||
        account.username?.localName ||
        account.address?.slice(0, 8) ||
        t("user"),
      avatar: resolveActorPicture(account.metadata?.picture),
      address: account.address,
    };
  };

  // ADDED: converts normalizeLensNotification(...) (from
  // useLensPosts.js) into the format the UI below already knows how to
  // render (title/message/time/read).
  const formatNotification = (n, readIds) => ({
    id: n.id,
    type: n.type,
    read: readIds.includes(n.id),
    time: formatTimeAgo(n.timestamp),
    title: getNotificationTitle(n),
    message: getNotificationMessage(n),
    data: {
      actors: n.actors,
      post: n.post,
      count: n.count,
      reactionType: n.reactionType,
    },
  });

  // REPLACED: notification types now match the Notification union type
  // from the Lens API (FollowNotification/ReactionNotification/...),
  // rather than the old Supabase types
  // post/reaction/comment/comment_reaction/system/welcome. "post" (a new
  // post from someone you follow) and "system"/"welcome" (internal app
  // messages) have no direct equivalent in the Lens protocol — these are
  // no longer protocol notifications, but functionality of the app itself
  // (feed/onboarding).
  const getNotificationTitle = (n) => {
    switch (n.type) {
      case "follow":
        return t("notification_title_follow");
      case "reaction":
        return t("notification_title_reaction");
      case "comment":
        return t("notification_title_comment");
      case "repost":
        return t("notification_title_repost");
      case "quote":
        return t("notification_title_quote");
      case "mention":
        return t("notification_title_mention");
      default:
        return t("notification_title_default");
    }
  };

  const getNotificationMessage = (n) => {
    const first = getActorDisplay(n.actors?.[0]);
    const others = (n.count || 1) - 1;
    const postContent = n.post?.content
      ? n.post.content.substring(0, 30) +
        (n.post.content.length > 30 ? "..." : "")
      : t("your_personal_profile");

    switch (n.type) {
      case "follow":
        return others > 0
          ? t("notification_message_follow_multiple", {
              sender: first.name,
              count: others,
            })
          : t("notification_message_follow", { sender: first.name });
      case "reaction": {
        const baseKey =
          n.reactionType === "truth"
            ? "notification_message_reaction_truth"
            : "notification_message_reaction_false";
        const key = others > 0 ? `${baseKey}_multiple` : baseKey;
        return t(key, { sender: first.name, count: others });
      }
      case "comment":
        return t("notification_message_comment", {
          sender: first.name,
          content: postContent,
        });
      case "repost":
        return others > 0
          ? t("notification_message_repost_multiple", {
              sender: first.name,
              count: others,
            })
          : t("notification_message_repost", { sender: first.name });
      case "quote":
        return t("notification_message_quote", {
          sender: first.name,
          content: postContent,
        });
      case "mention":
        return t("notification_message_mention", {
          sender: first.name,
          content: postContent,
        });
      default:
        return t("notification_message_default");
    }
  };

  const getNotificationIcon = (type) => {
    switch (type) {
      case "follow":
        return "🫂";
      case "reaction":
        return "❤️";
      case "comment":
        return "💬";
      case "repost":
        return "🔁";
      case "quote":
        return "🗣️";
      case "mention":
        return "📣";
      default:
        return "🔔";
    }
  };

  const getNotificationColor = (type) => {
    switch (type) {
      case "follow":
        return "bg-indigo-500/10 border-indigo-500/20 text-indigo-400/80";
      case "reaction":
        return "bg-pink-500/10 border-pink-500/20 text-pink-400/80";
      case "comment":
        return "bg-green-500/10 border-green-500/20 text-green-400/80";
      case "repost":
        return "bg-purple-500/10 border-purple-500/20 text-purple-400/80";
      case "quote":
        return "bg-cyan-500/10 border-cyan-500/20 text-cyan-400/80";
      case "mention":
        return "bg-yellow-500/10 border-yellow-500/20 text-yellow-400/80";
      default:
        return "bg-slate-100 dark:bg-white/[0.06] border-slate-300 dark:border-white/[0.1] text-slate-600 dark:text-white/40";
    }
  };

  const formatTimeAgo = (dateString) => {
    if (!dateString) return t("just_now");

    const date =
      typeof dateString === "string" ? new Date(dateString) : dateString;
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t("just_now");
    if (diffMins < 60) return t("minutes_ago", { count: diffMins });
    if (diffHours < 24) return t("hours_ago", { count: diffHours });
    if (diffDays < 7) return t("days_ago", { count: diffDays });

    return date.toLocaleDateString();
  };

  const handleNotificationClick = (notification) => {
    if (!notification.read) {
      markAsRead(notification.id);
    }

    switch (notification.type) {
      case "reaction":
      case "mention":
      case "quote":
      case "repost":
        if (notification.data?.post?.id) {
          navigate(`/post/${notification.data.post.id}`);
        }
        break;
      case "comment":
        // 🔍 VERIFY: notification.data.post here is the comment ITSELF
        // (not the original post it was left on). The Lens API in
        // CommentNotification doesn't return the parent post's id
        // (ReferencedPost deliberately has no commentOn, to avoid
        // circular references) — so we navigate to the comment as a
        // standalone post. If /post/:id in the app can't show "context"
        // (what this is a reply to), you'll need to additionally fetch
        // the parent post (e.g. via getLensPost) and extend
        // normalizeLensPost with a field for commentOn.
        if (notification.data?.post?.id) {
          navigate(`/post/${notification.data.post.id}`);
        }
        break;
      case "follow": {
        const address = notification.data?.actors?.[0]?.address;
        if (address) {
          // FIXED: in main.jsx the route is called "/user/:userId", not
          // "/profile/:address" — previously clicking a follower
          // notification led nowhere (no such Route).
          navigate(`/user/${address}`);
        }
        break;
      }
      default:
        break;
    }
  };

  // ─── Design tokens (aligned with SettingsPage) ──────────────────────────────
  // 3 font sizes only: 16px body · 14px mono/meta · 11px label
  const SavedPostsSection = () => {
    if (loadingSavedPosts) {
      return (
        <div className="flex justify-center items-center py-8">
          <div className="w-7 h-7 rounded-full border-2 border-blue-600/30 border-t-blue-400 animate-spin" />
        </div>
      );
    }

    if (savedPostsError) {
      return (
        <div className="text-center py-8">
          <div className="bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-xl p-4 mb-3">
            <p className="text-red-500 dark:text-red-400/70 text-[16px]">
              {savedPostsError}
            </p>
            <button
              onClick={loadSavedPosts}
              className="mt-3 px-3 py-1.5 bg-[#2B000A] border border-[#2B000A]/50 text-[#e8a0b0]/80 rounded-lg hover:bg-[#3d0012] transition-colors text-[16px]"
            >
              {t("retry")}
            </button>
          </div>
        </div>
      );
    }

    if (savedPosts.length === 0) {
      return (
        <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-10 text-center">
          <Bookmark className="w-12 h-12 text-slate-300 dark:text-white/[0.07] mx-auto mb-3" />
          <h3 className="font-cinzel text-[14px] text-slate-600 dark:text-white/22 mb-1">
            {t("no_saved_posts")}
          </h3>
          <p className="text-[13px] text-slate-500 dark:text-white/14">
            {t("no_saved_posts_description")}
          </p>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {savedPosts.map((post) => (
          <div
            key={post.id}
            onClick={(e) => {
              if (!e.target.closest(".delete-button")) {
                navigate(`/post/${post.id}`);
              }
            }}
            className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 cursor-pointer hover:border-slate-400 dark:hover:border-white/[0.13] dark:hover:bg-[#001026] transition-all duration-150 group"
          >
            <div className="flex items-start gap-3">
              <div className="flex-shrink-0">
                {post.author?.avatar_url ? (
                  <img
                    src={post.author.avatar_url}
                    alt={post.author?.unique_name}
                    className="w-8 h-8 rounded-full object-cover border border-[#b41e3c]/25"
                  />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-[#0d0415] border border-[#b41e3c]/25 flex items-center justify-center font-cinzel text-[11px] text-[#c8b8a2]">
                    {post.author?.unique_name?.[0]?.toUpperCase() || "U"}
                  </div>
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="font-medium text-slate-900 dark:text-white/75 text-[16px]">
                    {post.author?.unique_name || t("anonymous")}
                  </span>
                </div>

                <p className="text-slate-700 dark:text-white/45 text-[16px] line-clamp-2 mb-1.5">
                  {post.content}
                </p>

                <div className="flex items-center justify-between text-[14px] text-slate-600 dark:text-white/20">
                  <span>{new Date(post.created_at).toLocaleDateString()}</span>
                  <div className="flex items-center gap-3">
                    <span>
                      {post.reactions_count || 0} {t("reactions")}
                    </span>
                    <span>
                      {post.comments_count || 0} {t("comments")}
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex-shrink-0 ml-2 flex flex-col items-end gap-2">
                <button
                  onClick={(e) => handleRemoveSavedPost(post.id, e)}
                  className="delete-button p-1.5 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500/10 hover:bg-red-500/20 rounded-lg"
                  title={t("remove_from_saved")}
                >
                  <Trash2 className="w-3.5 h-3.5 text-red-400/60" />
                </button>
                <div className="bg-blue-100 dark:bg-blue-500/10 border border-blue-300 dark:border-blue-500/20 text-blue-700 dark:text-blue-400/80 px-2 py-0.5 rounded text-[11px] flex items-center gap-1">
                  <Bookmark className="w-2.5 h-2.5" />
                  {t("saved")}
                </div>
              </div>
            </div>

            {post.media_urls && post.media_urls.length > 0 && (
              <div className="mt-3">
                <div className="flex items-center gap-1 overflow-x-auto pb-1">
                  {post.media_urls.slice(0, 3).map((url, index) => (
                    <div key={index} className="flex-shrink-0">
                      {post.media_types?.[index] === "image" ? (
                        <img
                          src={url}
                          alt={`Media ${index + 1}`}
                          className="w-12 h-12 object-cover rounded-lg"
                        />
                      ) : (
                        <div className="w-12 h-12 bg-slate-100 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.06] rounded-lg flex items-center justify-center">
                          <span className="text-[11px] text-slate-600 dark:text-white/20">
                            {t("attachment")}
                          </span>
                        </div>
                      )}
                    </div>
                  ))}
                  {post.media_urls.length > 3 && (
                    <div className="w-12 h-12 bg-slate-100 dark:bg-white/[0.03] border border-slate-300 dark:border-white/[0.06] rounded-lg flex items-center justify-center">
                      <span className="text-[11px] text-slate-600 dark:text-white/20">
                        +{post.media_urls.length - 3}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <Layout
      userProfile={userProfile}
      onLogout={handleLogout}
      loading={loading}
      error={error}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      {showCreatePostModal && (
        <CreatePostModal
          onClose={() => setShowCreatePostModal(false)}
          userCountry={userInfo?.country || "EARTH"}
        />
      )}

      <div>
        {/* Page title — aligned with SettingsPage.
            FIXED: the previous version switched between column/row via
            "sm:" (640px) — but that's a breakpoint on the width of the
            entire viewport, not the actual middle content column, which
            in this app is always narrow (squeezed by the side panels)
            regardless of the browser window's width. So on wide windows
            sm: enabled row mode even though there wasn't actually enough
            width for it — the button text still got cut off. Now the
            layout responds to the ACTUAL width of the container via
            flex-wrap, rather than a guessed breakpoint. */}
        <div className="flex flex-wrap items-start justify-between gap-3 mb-6 pb-4 border-b border-slate-300 dark:border-white/[0.06]">
          <h1 className="font-cinzel text-[19px] font-medium text-slate-950 dark:text-white/85 tracking-[0.04em]">
            {activeTab === "notifications"
              ? t("notifications")
              : t("saved_posts")}
          </h1>

          {/* Notification control buttons — in the top-right corner
              when there's room; otherwise they wrap below the title
              thanks to flex-wrap on the parent container. The buttons do
              NOT shrink — the same padding/font size always; instead,
              whitespace-nowrap has been removed, so when a button lacks
              width, its text wraps onto a second line. */}
          {activeTab === "notifications" && (
            <div className="flex items-center gap-2">
              <button
                onClick={markAllAsRead}
                className="min-w-0 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg
                  bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
                  dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3D0012] transition-colors text-[16px]"
                disabled={notifications.filter((n) => !n.read).length === 0}
              >
                <Check className="w-3 h-3 flex-shrink-0" />
                <span className="text-center leading-tight">
                  {t("mark_all_read")}
                </span>
              </button>
              {notifications.length > 0 && (
                <button
                  onClick={deleteAllNotifications}
                  className="min-w-0 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-50 dark:bg-red-500/10 border border-red-300 dark:border-red-500/20 text-red-500 dark:text-red-400/60 text-[16px] font-medium hover:bg-red-100 dark:hover:bg-red-500/20 transition-colors"
                >
                  <Trash2 className="w-3 h-3 flex-shrink-0" />
                  <span className="text-center leading-tight">
                    {t("delete_all")}
                  </span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* ——— Tabs ——— */}
        <div className="bg-slate-100 dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-1 mb-5">
          <div className="flex space-x-1">
            <button
              onClick={() => setActiveTab("notifications")}
              className={`flex-1 px-3 py-2 rounded-lg text-center transition-all text-[16px] font-medium ${
                activeTab === "notifications"
                  ? "bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85"
                  : "text-slate-600 dark:text-white/30 hover:text-slate-900 dark:hover:text-white/50 hover:bg-white/[0.05] dark:hover:bg-white/[0.03]"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <Bell className="w-3.5 h-3.5" />
                <span>{t("notifications")}</span>
                {notifications.filter((n) => !n.read).length > 0 && (
                  <span className="bg-red-500/20 border border-red-500/30 text-red-400/80 text-[11px] px-1.5 py-0.5 rounded">
                    {notifications.filter((n) => !n.read).length}
                  </span>
                )}
              </div>
            </button>

            <button
              onClick={() => setActiveTab("saved")}
              className={`flex-1 px-3 py-2 rounded-lg text-center transition-all text-[16px] font-medium ${
                activeTab === "saved"
                  ? "bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85"
                  : "text-slate-600 dark:text-white/30 hover:text-slate-900 dark:hover:text-white/50 hover:bg-white/[0.05] dark:hover:bg-white/[0.03]"
              }`}
            >
              <div className="flex items-center justify-center gap-1.5">
                <Bookmark className="w-3.5 h-3.5" />
                <span>{t("saved_posts")}</span>
                {savedPosts.length > 0 && (
                  <span className="bg-blue-500/20 border border-blue-500/30 text-blue-400/80 text-[11px] px-1.5 py-0.5 rounded">
                    {savedPosts.length}
                  </span>
                )}
              </div>
            </button>
          </div>
        </div>

        {activeTab === "notifications" ? (
          <div className="space-y-3">
            {notifications.length === 0 ? (
              <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-10 text-center">
                <Bell className="w-12 h-12 text-slate-300 dark:text-white/[0.07] mx-auto mb-3" />
                <h3 className="font-cinzel text-[14px] text-slate-600 dark:text-white/22 mb-1">
                  {t("no_notifications")}
                </h3>
                <p className="text-[13px] text-slate-500 dark:text-white/14">
                  {t("no_notifications_description")}
                </p>
              </div>
            ) : (
              notifications.map((notification) => {
                const actor = getActorDisplay(notification.data?.actors?.[0]);
                const actorCountry = notification.data?.actors?.[0]
                  ? getActorCountry(notification.data.actors[0])
                  : null;

                return (
                  <div
                    key={notification.id}
                    onClick={() => handleNotificationClick(notification)}
                    className={`bg-white dark:bg-[#000d1f] border rounded-xl p-4 cursor-pointer transition-all duration-150 hover:border-slate-400 dark:hover:border-white/[0.13] dark:hover:bg-[#001026] ${
                      !notification.read
                        ? "border-blue-400 dark:border-blue-500/30"
                        : "border-slate-300 dark:border-white/[0.07]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <h3 className="font-medium text-slate-900 dark:text-white/75 text-[16px]">
                              {notification.title}
                            </h3>
                            {!notification.read && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-500/10 border border-blue-300 dark:border-blue-500/20 text-blue-700 dark:text-blue-400/80">
                                {t("new")}
                              </span>
                            )}
                          </div>
                          <p className="text-slate-700 dark:text-white/45 text-[16px] mb-1 line-clamp-2">
                            {notification.message}
                          </p>

                          {notification.data?.actors?.length > 0 && (
                            <div className="flex items-center gap-1.5 mb-1">
                              <div className="flex items-center gap-1">
                                {actor.avatar ? (
                                  <img
                                    src={actor.avatar}
                                    alt={actor.name}
                                    className="w-4 h-4 rounded-full object-cover"
                                  />
                                ) : (
                                  <div className="w-4 h-4 rounded-full bg-[#0d0415] border border-[#b41e3c]/25 flex items-center justify-center text-[8px] text-[#c8b8a2]">
                                    {actor.name?.[0]?.toUpperCase() || "U"}
                                  </div>
                                )}
                                <span className="text-[14px] font-medium text-slate-700 dark:text-white/52">
                                  {actor.name}
                                  {notification.data?.count > 1 &&
                                    ` +${notification.data.count - 1}`}
                                </span>
                              </div>
                              {actorCountry && actorCountry !== "EARTH" && (
                                <div className="flex items-center gap-1 text-[11px] text-slate-600 dark:text-white/22">
                                  <Globe className="w-2.5 h-2.5" />
                                  <span>
                                    {getCountryDisplayName(actorCountry)}
                                  </span>
                                </div>
                              )}
                            </div>
                          )}

                          <div className="flex items-center justify-between">
                            <span className="text-[14px] text-slate-600 dark:text-white/20">
                              {notification.time}
                            </span>
                            <ChevronRight className="w-3.5 h-3.5 text-slate-500 dark:text-white/15" />
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-0.5 flex-shrink-0 ml-2">
                        {!notification.read && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              markAsRead(notification.id);
                            }}
                            className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 dark:text-white/20 hover:text-green-600 dark:hover:text-green-400/75 hover:bg-green-50 dark:hover:bg-green-500/[0.08] transition-all"
                            title={t("mark_as_read")}
                          >
                            <Eye className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteNotification(notification.id);
                          }}
                          className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-500 dark:text-white/20 hover:text-red-500 dark:hover:text-red-400/75 hover:bg-red-50 dark:hover:bg-red-500/[0.08] transition-all"
                          title={t("delete")}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        ) : (
          <SavedPostsSection />
        )}
      </div>

      <style jsx="true">{`
        @keyframes slideInRight {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }

        @keyframes slideOutRight {
          from {
            transform: translateX(0);
            opacity: 1;
          }
          to {
            transform: translateX(100%);
            opacity: 0;
          }
        }
      `}</style>
    </Layout>
  );
};

export default NotificationsPage;
