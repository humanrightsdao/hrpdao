import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate, useSearchParams, useLocation } from "react-router-dom";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { nip19 } from "nostr-tools";
import EmojiPicker, { Theme as EmojiTheme } from "emoji-picker-react";
import { Smile, Paperclip, X, Video as VideoIcon, File as FileIcon, Send, Download } from "lucide-react";
import { useLensAuth } from "../context/LensAuthContext";
import { useLensProfile } from "../hooks/useLensProfile";
import { useNostrIdentity } from "../hooks/useNostrIdentity";
import { useNostrChat } from "../hooks/useNostrChat";
import { useNostrRelay } from "../hooks/useNostrRelay";
import { useNostrConversations } from "../hooks/useNostrConversations";
import { usePeerProfile, usePeerProfiles, cacheLensProfile } from "../hooks/useNostrProfile";
import { getRumorPeer, extractSenderProfileTags } from "../lib/nostrDm";
import { buildImetaTags } from "../lib/nostrRelay";
import { uploadFileToGrove } from "../lib/grove";
import Layout from "../components/Layout";
import CreatePostModal from "../components/CreatePostModal";

// ADDED (chat media attachments): same constraints CreatePostModal.jsx
// applies to post media — kept identical on purpose so "what you can
// attach" doesn't quietly differ between posts and chat.
const MAX_CHAT_FILES = 4;
const MAX_CHAT_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_CHAT_FILE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "application/pdf",
  "text/plain",
];

// ADDED: pulls the NIP-92 "imeta" tags (see lib/nostrRelay.js's
// buildImetaTags, the same helper post-creation uses) back out of a
// decrypted rumor so a message with attachments can render them
// inline instead of just showing a bare Grove URL as text.
function parseImetaTags(tags) {
  return (tags || [])
    .filter((tag) => tag[0] === "imeta")
    .map((tag) => {
      const urlPart = tag.find((p) => p.startsWith("url "));
      const mimePart = tag.find((p) => p.startsWith("m "));
      return {
        url: urlPart ? urlPart.slice(4) : null,
        mime: mimePart ? mimePart.slice(2) : "",
      };
    })
    .filter((a) => a.url);
}

const shortNpub = (pubkeyHex) => {
  try {
    const npub = nip19.npubEncode(pubkeyHex);
    return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
  } catch {
    return pubkeyHex.slice(0, 8) + "…";
  }
};

const relativeTime = (unixSeconds, t) => {
  if (!unixSeconds) return null;
  const diffSec = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diffSec < 60) return t("just_now") || "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return `${Math.floor(diffSec / 86400)}d`;
};

// ADDED: date + time shown under each message bubble. Same-day
// messages just show the time (e.g. "14:32"); older ones get a short
// date prefix too, so a long-running thread stays readable.
const messageTimestamp = (unixSeconds) => {
  if (!unixSeconds) return "";
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (date.toDateString() === now.toDateString()) return time;
  const datePart = date.toLocaleDateString([], {
    day: "2-digit",
    month: "2-digit",
  });
  return `${datePart} ${time}`;
};

// Avatar bubble — hexagon-clipped to match the shape used everywhere
// else in this app (PostCard.jsx, Navbar.jsx, UserProfilePage.jsx),
// instead of the plain circle this used before. Falls back to a
// monogram (first letter of the name) or a bare dot when we have
// neither a picture nor a name yet.
function PeerAvatar({ profile, pubkeyHex, size = 40 }) {
  const initial = profile?.name?.trim()?.[0]?.toUpperCase();
  const height = Math.round(size * (44 / 40)); // same 40:44 ratio as PostCard.jsx
  return (
    <div
      style={{ width: size, height }}
      className="relative flex-shrink-0 p-[1.5px] clip-path-hexagon bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]"
      title={pubkeyHex ? shortNpub(pubkeyHex) : undefined}
    >
      <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon flex items-center justify-center">
        {profile?.picture ? (
          <img
            src={profile.picture}
            alt=""
            className="w-full h-full object-cover"
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        ) : (
          <span className="font-cinzel text-[13px] text-[#c8b8a2]">
            {initial || "•"}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Nostr DMs (NIP-17). Two views in one page, switched by the ?npub=
 * query param:
 *  - no npub → conversation list (useNostrConversations)
 *  - npub present → single-thread view for that peer
 *
 * NOTE on what this deliberately does NOT show: no "online" indicator
 * (Nostr has no connection-based presence concept — see
 * useNostrConversations.js for the full reasoning) and no cross-client
 * read receipts (unread/read tracking here is local to this browser
 * only). What IS shown instead, honestly labeled, is "last public
 * activity" — the timestamp of the peer's most recent event visible
 * on these relays (any kind, not just DMs), which is a real, verifiable
 * signal without pretending to be presence.
 */
export default function NostrChatPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const recipientNpubParam = searchParams.get("npub") || "";
  // ADDED: resolved once here (not just inside ThreadView) so the
  // conversation list, sitting right next to it in the new two-pane
  // layout, can highlight which conversation is currently open.
  const activeRecipientPubkeyHex = useMemo(() => {
    if (!recipientNpubParam || recipientNpubParam === "new") return null;
    try {
      if (/^[0-9a-f]{64}$/i.test(recipientNpubParam)) return recipientNpubParam;
      const decoded = nip19.decode(recipientNpubParam);
      return decoded.type === "npub" ? decoded.data : null;
    } catch {
      return null;
    }
  }, [recipientNpubParam]);

  const { isConnected } = useLensAuth();
  const lensWalletAddress =
    typeof window !== "undefined"
      ? localStorage.getItem("lens_wallet_address")
      : null;  // FIXED: <Layout> requires userProfile/loading as PROPS (it does not
  // fetch them itself) — without passing these, Layout always treated
  // this page as "no profile yet" and showed its own blocking
  // "Профіль не знайдено / Завершити реєстрацію" screen, regardless of
  // whether the user was actually fully set up. Same lightweight,
  // Supabase-free pattern PostPage.jsx uses (useLensProfile, not
  // useUserInfo) — this page doesn't need anything more than
  // Layout's own display fields.
  const {
    profile: lensProfile,
    loading: profileLoading,
    refetch: refetchLensProfile,
  } = useLensProfile(lensWalletAddress);
  // ADDED: memoized so this object has a STABLE reference across
  // re-renders unless lensProfile itself actually changed — plain
  // object-literal construction on every render was making the
  // kind:0 publish effect below re-evaluate on every single render of
  // this page (its dependency array includes layoutUserProfile),
  // which made the console noisier and the intent harder to follow
  // even though the fingerprint/sessionStorage guards already
  // prevented it from actually re-publishing.
  const layoutUserProfile = useMemo(
    () =>
      lensProfile
        ? {
            uniqueName: lensProfile.localName,
            name: lensProfile.name,
            avatarUrl: lensProfile.avatar,
            bio: lensProfile.bio,
            country: lensProfile.country,
            lensAccountAddress: lensProfile.address,
            walletAddress: lensWalletAddress,
            hasCompletedOnboarding: lensProfile.hasCompletedOnboarding ?? true,
          }
        : null,
    [lensProfile, lensWalletAddress],
  );  const {
    nostrIdentity,
    deriving,
    error: identityError,
    ensureLinkedNostrIdentity,
    linkNostrIdentityToLensAccount,
    linking,
    linkError,
    signEvent,
  } = useNostrIdentity();
  const { publishToNostr } = useNostrRelay();

  // CHANGED: was `deriveNostrIdentity()` — only derived the key, never
  // triggered the one-time Nostr↔Lens link. Linking used to happen
  // separately via an auto-effect that fired on every login (even
  // without opening chat). Now that this page is the only place that
  // actually needs nsec, it's also the one place that should trigger
  // both the derivation AND the (at-most-once, skipped if already
  // linked) on-chain link — so a MetaMask user sees the wallet popup(s)
  // only when they open chat, not on every login.
  useEffect(() => {
    if (isConnected) ensureLinkedNostrIdentity();
  }, [isConnected, ensureLinkedNostrIdentity]);

  // ADDED: publishes a Nostr kind:0 (profile metadata) event with our
  // current Lens name/avatar, so OTHER people's chat windows can show
  // an actual name/avatar for us instead of just our raw npub — this
  // app previously never published one at all, which is why every
  // participant in every conversation only ever showed up as a bare
  // npub code (see PeerAvatar/useNostrProfile above/in
  // hooks/useNostrProfile.js for the read side of this fix). Re-runs
  // only when the name/avatar actually change (fingerprint check) and
  // is cached in sessionStorage so it doesn't republish on every
  // reload for no reason.
  const publishedProfileFingerprintRef = useRef(null);
  useEffect(() => {
    if (!nostrIdentity || !layoutUserProfile) return;
    const name = layoutUserProfile.name || layoutUserProfile.uniqueName || "";
    const picture = layoutUserProfile.avatarUrl || "";
    if (!name && !picture) {
      console.log(
        "ℹ️ Nostr profile publish skipped: no Lens name/avatar available yet.",
      );
      return;
    }
    const fingerprint = `${name}|${picture}`;
    if (publishedProfileFingerprintRef.current === fingerprint) return;

    const cacheKey = `nostr_profile_published:v2:${nostrIdentity.pubkey}`;
    if (
      typeof window !== "undefined" &&
      sessionStorage.getItem(cacheKey) === fingerprint
    ) {
      publishedProfileFingerprintRef.current = fingerprint;
      return;
    }

    let cancelled = false;
    (async () => {
      console.log("📡 Publishing Nostr kind:0 profile…", { name, hasPicture: !!picture });
      try {
        const event = await signEvent({
          kind: 0,
          content: JSON.stringify({
            name,
            display_name: name,
            picture: picture || undefined,
          }),
        });
        if (!event || cancelled) return;
        const results = await publishToNostr(event);
        if (cancelled) return;
        // FIXED: this used to mark the fingerprint as "published" the
        // moment publishToNostr() resolved, regardless of whether any
        // relay actually accepted it. publishToNostr never rejects
        // (Promise.allSettled under the hood — see useNostrRelay.js),
        // so a run where every relay failed still looked like success:
        // the sessionStorage flag got set, and this effect would then
        // skip retrying for the rest of the session, permanently
        // stuck as "our profile isn't out there" with no visible
        // error. Only cache once we know at least one relay took it.
        const okRelays = results.filter((r) => r.ok).map((r) => r.url);
        if (okRelays.length === 0) {
          console.warn(
            "⚠️ Nostr profile publish: no relay accepted the event, will retry.",
            results,
          );
          return;
        }
        console.log("✅ Nostr kind:0 profile published to:", okRelays);
        publishedProfileFingerprintRef.current = fingerprint;
        try {
          sessionStorage.setItem(cacheKey, fingerprint);
        } catch {
          // best-effort only
        }
      } catch (err) {
        console.warn("⚠️ Failed to publish Nostr profile metadata:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nostrIdentity, layoutUserProfile, signEvent, publishToNostr]);

  // Nudge, don't force: linking npub→Lens metadata is an on-chain
  // write (real cost, even if sponsored, and it's public data), so it
  // deliberately stays an explicit action rather than something we
  // silently auto-trigger. This banner just makes the suggestion
  // impossible to miss right where it's actually useful (opening
  // chat), instead of being buried in Settings.
  const isLinked = lensProfile?.nostrNpub === nostrIdentity?.npub;
  const showLinkBanner = nostrIdentity && !isLinked;

  // ADDED: every other page passes onCreatePost to <Layout>, which is
  // what makes the Sidebar show its "Create post" button (Sidebar.jsx
  // hides that button entirely when onCreatePost is missing — see
  // showCreatePostButton()). This page simply never passed it, which
  // is why the button was missing here specifically. Same
  // modal-toggle pattern PostPage.jsx uses.
  const [showCreatePostModal, setShowCreatePostModal] = useState(false);

  if (!isConnected) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#000d1f]">
        <p className="text-slate-500 dark:text-white/50">
          {t("login_required") || "Please log in first."}
        </p>
      </div>
    );
  }

  return (
    <Layout
      userProfile={layoutUserProfile}
      loading={profileLoading}
      onCreatePost={() => setShowCreatePostModal(true)}
    >
      {showCreatePostModal ? (
        <CreatePostModal onClose={() => setShowCreatePostModal(false)} />
      ) : (
      // CHANGED: single narrow column that swapped between "list" and
      // "thread" as two entirely separate screens → a real two-pane
      // layout (list always visible on the left, thread on the
      // right), the way every desktop messenger works. On narrow
      // viewports this collapses back to the old one-screen-at-a-time
      // behavior via the `md:` responsive classes below — see the
      // aside/main visibility comments.
      <div className="flex flex-col h-[calc(100vh-80px)] overflow-hidden">
        {(deriving || identityError) && (
          <div className="text-[13px] text-slate-500 dark:text-white/40 mb-3 flex-shrink-0">
            {deriving
              ? t("preparing_nostr_identity") ||
                "Preparing your Nostr identity…"
              : identityError}
          </div>
        )}

        {/* CHANGED: linking now happens automatically in the
            background (see the auto-link effect in
            useNostrIdentity.jsx) — no more "Link now" call-to-action
            banner nagging the user to press a button they likely
            didn't understand. This only shows up transiently while
            the automatic link is in flight, or if it actually failed
            (with a small retry action, since a silent permanent
            failure would be worse than an occasional visible one). */}
        {linking && (
          <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-purple-600/10 dark:bg-purple-400/10 border border-purple-600/20 dark:border-purple-400/20 flex-shrink-0">
            <span className="inline-block w-3 h-3 rounded-full border border-purple-500/50 border-t-transparent animate-spin" />
            <p className="text-[13px] text-purple-700 dark:text-purple-300">
              {t("syncing_with_lens") || "Syncing with Lens…"}
            </p>
          </div>
        )}
        {!linking && linkError && showLinkBanner && (
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 mb-3 rounded-lg bg-red-600/10 dark:bg-red-400/10 border border-red-600/20 dark:border-red-400/20 flex-shrink-0">
            <p className="text-[13px] text-red-700 dark:text-red-300">
              {linkError}
            </p>
            <button
              onClick={async () => {
                const ok = await linkNostrIdentityToLensAccount({
                  name: lensProfile?.name,
                  bio: lensProfile?.bio,
                  picture: lensProfile?.avatar,
                });
                if (ok) await refetchLensProfile();
              }}
              disabled={linking}
              className="flex-shrink-0 text-[12px] px-2.5 py-1.5 rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
            >
              {t("retry") || "Retry"}
            </button>
          </div>
        )}

        {/* CHANGED: two-pane layout — the conversation list (aside)
            and the open thread (main) now sit inside ONE shared
            bordered/rounded card (with a divider line between them)
            instead of being two separate boxes with independent
            borders and mismatched header heights, which is what made
            them read as unrelated floating panels rather than one
            messenger. On narrow viewports there isn't room for both,
            so it collapses back to showing exactly one at a time:
            aside is hidden while a thread is open, main is hidden
            while browsing the list — controlled purely by the
            `hidden md:flex` pairing below, no separate mobile-specific
            logic needed. */}
        <div className="flex-1 min-h-0 flex flex-col md:flex-row rounded-xl border border-slate-200 dark:border-white/[0.06] bg-slate-50 dark:bg-white/[0.02] overflow-hidden">
          <aside
            className={`min-h-0 flex-col flex-1 md:flex-none md:w-[220px] md:border-r border-slate-200 dark:border-white/[0.06] ${
              recipientNpubParam ? "hidden md:flex" : "flex"
            }`}
          >
            <ConversationListView
              nostrIdentity={nostrIdentity}
              activePubkeyHex={activeRecipientPubkeyHex}
              onOpenConversation={(pubkeyHex) =>
                setSearchParams({ npub: nip19.npubEncode(pubkeyHex) })
              }
              onNewConversation={() => setSearchParams({ npub: "new" })}
            />
          </aside>

          <main
            className={`min-h-0 flex-1 flex-col ${
              recipientNpubParam ? "flex" : "hidden md:flex"
            }`}
          >
            {recipientNpubParam ? (
              <ThreadView
                recipientNpubOrHex={recipientNpubParam}
                nostrIdentity={nostrIdentity}
                senderProfile={{
                  name:
                    layoutUserProfile?.name ||
                    layoutUserProfile?.uniqueName ||
                    null,
                  picture: layoutUserProfile?.avatarUrl || null,
                }}
                onBack={() => setSearchParams({})}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="text-[13px] text-slate-400 dark:text-white/30 px-4 text-center">
                  {t("select_a_conversation") ||
                    "Select a conversation, or start a new one"}
                </p>
              </div>
            )}
          </main>
        </div>
      </div>
      )}
    </Layout>
  );
}

// ─── Conversation list ───────────────────────────────────────────────────────
function ConversationListView({
  nostrIdentity,
  activePubkeyHex,
  onOpenConversation,
  onNewConversation,
}) {
  const { t } = useTranslation();
  const { conversations, loading } = useNostrConversations();
  const profiles = usePeerProfiles(conversations.map((c) => c.pubkey));

  return (
    <>
      {/* CHANGED: header height/padding now matches ThreadView's own
          header exactly (px-4, fixed h-[60px], border-b) so the two
          panes'
          top edges line up as one continuous strip instead of two
          differently-sized headers sitting at different heights. */}
      <div className="flex items-center justify-between gap-2 px-4 h-[60px] border-b border-slate-200 dark:border-white/[0.06] flex-shrink-0">
        <h1 className="text-[16px] font-semibold text-slate-900 dark:text-white truncate">
          {t("nostr_chat") || "Chat"}
        </h1>
        <button
          onClick={onNewConversation}
          className="flex-shrink-0 text-[13px] px-2.5 py-1.5 rounded-lg bg-[#2B000A] text-white/90 hover:bg-[#3d0012] transition-colors"
        >
          + {t("new_message") || "New"}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-slate-200 dark:divide-white/[0.06]">
        {loading ? (
          <p className="text-[13px] text-slate-400 dark:text-white/30 text-center py-8">
            {t("loading") || "Loading…"}
          </p>
        ) : conversations.length === 0 ? (
          <p className="text-[13px] text-slate-400 dark:text-white/30 text-center py-8 px-4">
            {t("no_conversations_yet") ||
              "No conversations yet — tap \"New\" to message someone, or visit a profile that has linked their Nostr identity."}
          </p>
        ) : (
          conversations.map((c) => {
            const profile = profiles[c.pubkey];
            const isActive = c.pubkey === activePubkeyHex;
            return (
              <button
                key={c.pubkey}
                onClick={() => onOpenConversation(c.pubkey)}
                className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors ${
                  isActive
                    ? "bg-slate-200/70 dark:bg-white/[0.07]"
                    : "hover:bg-slate-100 dark:hover:bg-white/[0.03]"
                }`}
              >
                <PeerAvatar profile={profile} pubkeyHex={c.pubkey} />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-slate-800 dark:text-white/80 truncate">
                    {profile?.name || shortNpub(c.pubkey)}
                  </p>
                  {c.lastMessage && (
                    <p className="text-[13px] text-slate-500 dark:text-white/40 truncate mt-0.5">
                      {c.lastMessage}
                    </p>
                  )}
                </div>
                {c.unread && (
                  <span className="flex-shrink-0 w-2 h-2 rounded-full bg-[#b41e3c]" />
                )}
              </button>
            );
          })
        )}
      </div>
    </>
  );
}

// ─── Single-thread view ──────────────────────────────────────────────────────
function ThreadView({ recipientNpubOrHex, nostrIdentity, senderProfile, onBack }) {
  const { t } = useTranslation();
  const location = useLocation();
  const { sendDirectMessage, startInboxSubscription, stopInboxSubscription } =
    useNostrChat();
  const { queryNostr } = useNostrRelay();
  const { registerOutgoingPeer, markConversationRead } =
    useNostrConversations();

  const [recipientInput, setRecipientInput] = useState(
    recipientNpubOrHex === "new" ? "" : recipientNpubOrHex,
  );
  const [recipientPubkeyHex, setRecipientPubkeyHex] = useState("");
  const [recipientError, setRecipientError] = useState("");
  const [lastActive, setLastActive] = useState(null); // unix seconds or null
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const scrollRef = useRef(null);

  // FIXED: `recipientInput`'s useState initializer only runs once, on
  // this component's FIRST mount. But ThreadView does NOT remount
  // when switching between conversations in the two-pane layout — the
  // same component instance just receives a new recipientNpubOrHex
  // prop — so recipientInput (and therefore recipientPubkeyHex, and
  // therefore every message-loading effect below) stayed frozen on
  // whichever conversation was opened first. This is exactly why
  // switching conversations silently did nothing short of a full page
  // reload. Explicitly re-syncing on every prop change fixes it.
  useEffect(() => {
    setRecipientInput(recipientNpubOrHex === "new" ? "" : recipientNpubOrHex);
  }, [recipientNpubOrHex]);

  const peerProfile = usePeerProfile(recipientPubkeyHex || null);

  // ADDED: full-screen preview for image/video attachments, with a
  // download action — tapping a photo in the message list used to do
  // nothing but show it at bubble size.
  const [lightboxAttachment, setLightboxAttachment] = useState(null);

  // ADDED: if we got here from a Lens profile page ("Message on
  // Nostr"), UserProfilePage.jsx handed us that profile's name/avatar
  // directly via router state — cache it against this peer's pubkey
  // right away. This is the "Lens ↔ Nostr sync" fix: it's the one
  // place a reliable, non-relay-dependent name/avatar is actually
  // available for a peer we didn't derive ourselves, so we capture it
  // here instead of hoping their kind:0 shows up on a relay.
  useEffect(() => {
    if (!recipientPubkeyHex) return;
    const { peerName, peerAvatar } = location.state || {};
    if (peerName || peerAvatar) {
      cacheLensProfile(recipientPubkeyHex, {
        name: peerName,
        picture: peerAvatar,
      });
    }
  }, [recipientPubkeyHex, location.state]);

  // ADDED: media attachments + emoji picker for the message composer,
  // mirroring CreatePostModal.jsx's own pattern (same file constraints,
  // same emoji-picker-react usage) so chat and posts behave the same.
  const [mediaFiles, setMediaFiles] = useState([]);
  const [fileError, setFileError] = useState("");
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [emojiPickerStyle, setEmojiPickerStyle] = useState(null);
  const fileInputRef = useRef(null);
  const draftInputRef = useRef(null);
  const emojiPickerRef = useRef(null);
  const emojiButtonRef = useRef(null);
  const isDarkMode =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");

  // FIXED: without this, switching to a different conversation kept
  // showing the PREVIOUS conversation's messages for a moment (or
  // permanently, if the history-loading effect's own prev/next merge
  // — meant to preserve an optimistic send while ITS OWN history
  // reloads — ended up merging in messages that belong to a
  // different peer entirely). Reset immediately whenever the peer
  // actually changes, before that effect below runs.
  useEffect(() => {
    setMessages([]);
    setDraft("");
    setMediaFiles([]);
    setFileError("");
    setSendError("");
    setLightboxAttachment(null);
    setLastActive(null);
  }, [recipientPubkeyHex]);


  const handleFileSelect = (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = ""; // allow re-selecting the same file later
    setFileError("");
    if (mediaFiles.length + files.length > MAX_CHAT_FILES) {
      setFileError(t("max_4_files") || `Maximum ${MAX_CHAT_FILES} files`);
      return;
    }
    const validFiles = files.filter((file) => {
      if (file.size > MAX_CHAT_FILE_SIZE) {
        setFileError(
          `${file.name}: ${t("file_too_large") || "file is too large (max. 10MB)"}`,
        );
        return false;
      }
      if (!ALLOWED_CHAT_FILE_TYPES.includes(file.type)) {
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
    if (!showEmojiPicker) return;
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
  }, [showEmojiPicker]);

  const insertEmoji = (emojiData) => {
    const emoji = emojiData.emoji;
    const input = draftInputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? draft.length;
    const newText = draft.slice(0, start) + emoji + draft.slice(end);
    setDraft(newText);
    setTimeout(() => {
      input?.focus();
      input?.setSelectionRange(start + emoji.length, start + emoji.length);
      // Emoji insertion bypasses the textarea's own onChange (we set
      // draft directly above), so the auto-resize logic there never
      // runs — do it here too, or a long draft can end up taller than
      // its box after an emoji push it over a line boundary.
      if (input) {
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
      }
    }, 0);
    setShowEmojiPicker(false);
  };

  const resolveRecipient = useCallback(
    (value) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setRecipientPubkeyHex("");
        setRecipientError("");
        return;
      }
      try {
        if (trimmed.startsWith("npub1")) {
          const decoded = nip19.decode(trimmed);
          if (decoded.type !== "npub") throw new Error("Not an npub");
          setRecipientPubkeyHex(decoded.data);
        } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
          setRecipientPubkeyHex(trimmed.toLowerCase());
        } else {
          throw new Error("Invalid format");
        }
        setRecipientError("");
      } catch {
        setRecipientPubkeyHex("");
        setRecipientError(
          t("invalid_nostr_recipient") ||
            "Enter a valid npub1... or 64-character hex pubkey.",
        );
      }
    },
    [t],
  );

  useEffect(() => {
    resolveRecipient(recipientInput);
  }, [recipientInput, resolveRecipient]);

  // Mark read as soon as we open this thread.
  useEffect(() => {
    if (recipientPubkeyHex) markConversationRead(recipientPubkeyHex);
  }, [recipientPubkeyHex, markConversationRead]);

  // "Last public activity" — a one-shot, honestly-labeled signal (NOT
  // "online"; see the file-level comment above). Any recent event by
  // this pubkey on these relays, regardless of kind.
  useEffect(() => {
    if (!recipientPubkeyHex) return;
    let cancelled = false;
    (async () => {
      const events = await queryNostr({
        authors: [recipientPubkeyHex],
        limit: 1,
      });
      if (!cancelled && events.length) {
        setLastActive(Math.max(...events.map((e) => e.created_at)));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recipientPubkeyHex, queryNostr]);

  // History + live subscription for this specific peer.
  useEffect(() => {
    if (!nostrIdentity || !recipientPubkeyHex) return;
    let cancelled = false;

    (async () => {
      const { nip17 } = await import("nostr-tools");
      const pastWraps = await queryNostr({
        kinds: [1059],
        "#p": [nostrIdentity.pubkey],
      });
      if (cancelled) return;

      const pastMessages = [];
      for (const wrap of pastWraps) {
        try {
          const rumor = nip17.unwrapEvent(wrap, nostrIdentity.secretKey);
          // FIXED: getRumorPeer resolves the peer whether this rumor
          // was sent TO us by them (rumor.pubkey is the peer) or is
          // OUR OWN self-copy of something WE sent (rumor.pubkey is
          // us, real peer comes from the rumor's "p" tag) — see
          // lib/nostrDm.js and useNostrChat.js for the full story.
          // This is what makes our own sent messages survive a
          // reload/reopen instead of only ever showing the other
          // person's side of the conversation.
          if (getRumorPeer(rumor, nostrIdentity.pubkey) === recipientPubkeyHex) {
            pastMessages.push(rumor);
            // ADDED: a message actually FROM the peer (not one of our
            // own self-copies) carries their current name/avatar as
            // rumor tags — see lib/nostrDm.js's
            // extractSenderProfileTags / useNostrChat.js's
            // sendDirectMessage. Far more reliable than hoping their
            // kind:0 exists on a relay we happen to be connected to.
            if (rumor.pubkey !== nostrIdentity.pubkey) {
              const senderProfile = extractSenderProfileTags(rumor);
              if (senderProfile) cacheLensProfile(recipientPubkeyHex, senderProfile);
            }
          }
        } catch {
          // skip
        }
      }
      pastMessages.sort((a, b) => a.created_at - b.created_at);
      if (!cancelled) {
        setMessages((prev) => {
          // Merge rather than overwrite: an optimistic send from
          // handleSend() may have already landed in state (and its
          // relay echo may not be in `pastWraps` yet on a slow
          // relay) — dedupe by id instead of dropping it.
          const merged = [...pastMessages];
          for (const m of prev) {
            if (!merged.some((x) => x.id === m.id)) merged.push(m);
          }
          return merged.sort((a, b) => a.created_at - b.created_at);
        });
      }
    })();

    startInboxSubscription((rumor) => {
      if (getRumorPeer(rumor, nostrIdentity.pubkey) !== recipientPubkeyHex) return;
      setMessages((prev) => {
        if (prev.some((m) => m.id === rumor.id)) return prev;
        return [...prev, rumor].sort((a, b) => a.created_at - b.created_at);
      });
      // Only a genuine incoming message should affect the unread
      // state — the live echo of our own self-copy isn't something
      // to "mark as read", it's just our own sent message arriving
      // back from the relay.
      if (rumor.pubkey !== nostrIdentity.pubkey) {
        markConversationRead(recipientPubkeyHex);
        // ADDED: same piggybacked-profile capture as the history load
        // above, for messages arriving live.
        const senderProfile = extractSenderProfileTags(rumor);
        if (senderProfile) cacheLensProfile(recipientPubkeyHex, senderProfile);
      }
    });

    return () => {
      cancelled = true;
      stopInboxSubscription();
    };
  }, [
    nostrIdentity,
    recipientPubkeyHex,
    queryNostr,
    startInboxSubscription,
    stopInboxSubscription,
    markConversationRead,
  ]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // ADDED (anti-spam): once we've sent a first message into an
  // otherwise-empty conversation, block sending any more until the
  // peer actually replies. Recomputed from `messages` itself (not a
  // separate flag) so it stays correct across reloads/reopens now
  // that history correctly includes our own past messages too.
  const myPubkey = nostrIdentity?.pubkey;
  const sentByMeCount = messages.filter((m) => m.pubkey === myPubkey).length;
  const receivedFromPeerCount = messages.filter(
    (m) => m.pubkey === recipientPubkeyHex,
  ).length;
  const spamLimitReached =
    !!recipientPubkeyHex && sentByMeCount > 0 && receivedFromPeerCount === 0;

  const handleSend = async () => {
    const hasText = !!draft.trim();
    const hasMedia = mediaFiles.length > 0;
    if ((!hasText && !hasMedia) || !recipientPubkeyHex) return;
    if (spamLimitReached) {
      setSendError(
        t("spam_wait_for_reply") ||
          "You've already sent the first message — wait for a reply before sending another.",
      );
      return;
    }
    setSending(true);
    setSendError("");
    try {
      let extraTags = [];
      if (hasMedia) {
        setUploadingMedia(true);
        try {
          const uploaded = await Promise.all(
            mediaFiles.map(async (file) => {
              const { gatewayUrl } = await uploadFileToGrove(file);
              return { gatewayUrl, type: file.type };
            }),
          );
          extraTags = buildImetaTags(uploaded);
        } finally {
          setUploadingMedia(false);
        }
      }

      const result = await sendDirectMessage(recipientPubkeyHex, draft.trim(), {
        extraTags,
        senderProfile,
      });
      if (!result.success) throw new Error("No relay accepted the message.");
      setMessages((prev) => {
        if (prev.some((m) => m.id === result.rumor.id)) return prev;
        return [...prev, result.rumor].sort(
          (a, b) => a.created_at - b.created_at,
        );
      });
      registerOutgoingPeer(
        recipientPubkeyHex,
        result.rumor.content || t("attachment") || "📎 Attachment",
      );
      setDraft("");
      setMediaFiles([]);
      setFileError("");
      // Reset the textarea's imperatively-set height too — clearing
      // `draft` alone doesn't touch the inline style the auto-resize
      // handler set, so without this the box would stay tall/empty
      // after sending a multi-line message.
      if (draftInputRef.current) draftInputRef.current.style.height = "auto";
    } catch (err) {
      setSendError(err.message || "Failed to send message.");
    } finally {
      setSending(false);
    }
  };

  const activeLabel = relativeTime(lastActive, t);

  return (
    <>
      {/* CHANGED: header uses a fixed h-[60px] (not just matching
          padding) — same as ConversationListView's header below —
          because padding alone wasn't enough: this header's tallest
          element (the 32px avatar) is taller than the list header's
          tallest element (the "+ Нова" button), so equal padding
          still produced a few pixels of height difference between
          the two border-b lines. A fixed height on both, with
          items-center, guarantees they land on the exact same row
          regardless of what each side's content happens to be. */}
      <div className="flex items-center justify-between gap-3 px-4 h-[60px] border-b border-slate-200 dark:border-white/[0.06] flex-shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* CHANGED: only relevant on mobile now — on the two-pane
              desktop layout the conversation list is already visible
              right next to this thread, so a "back" affordance would
              be redundant there. */}
          <button
            onClick={onBack}
            aria-label={t("back_to_conversations") || "Back to conversations"}
            className="md:hidden flex-shrink-0 text-slate-500 dark:text-white/40 hover:text-slate-700 dark:hover:text-white/70 text-[18px] leading-none px-0.5"
          >
            ←
          </button>
          {recipientPubkeyHex && (
            <PeerAvatar profile={peerProfile} pubkeyHex={recipientPubkeyHex} size={32} />
          )}
          <div className="min-w-0">
            <h1 className="text-[16px] font-semibold text-slate-900 dark:text-white truncate">
              {peerProfile?.name ||
                (recipientPubkeyHex ? shortNpub(recipientPubkeyHex) : "—")}
            </h1>
            {peerProfile?.name && recipientPubkeyHex && (
              <p className="text-[11px] font-mono text-slate-400 dark:text-white/30 truncate">
                {shortNpub(recipientPubkeyHex)}
              </p>
            )}
          </div>
        </div>
        {activeLabel && (
          <span
            className="text-[11px] text-slate-400 dark:text-white/30 flex-shrink-0"
            title={
              t("last_public_activity_hint") ||
              "Timestamp of their most recent public Nostr event on these relays — not a presence/online indicator."
            }
          >
            {t("last_active") || "Last active"}: {activeLabel}
          </span>
        )}
      </div>

      {recipientNpubOrHex === "new" && (
        <div className="px-4 pt-3 flex-shrink-0">
          <label className="text-[11px] uppercase tracking-[0.1em] text-slate-500 dark:text-white/40 mb-1 block">
            {t("recipient") || "Recipient (npub or hex pubkey)"}
          </label>
          <input
            type="text"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            placeholder="npub1..."
            className="w-full px-3 py-2 rounded-lg bg-slate-100 dark:bg-white/[0.04] border border-slate-300 dark:border-white/[0.08] text-[14px] font-mono text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-white/30 focus:outline-none focus:border-[#b41e3c]/40"
          />
          {recipientError && (
            <p className="text-[12px] text-red-600 dark:text-red-400/70 mt-1">
              {recipientError}
            </p>
          )}
        </div>
      )}

      {/* CHANGED: no more own rounded/bordered box — this pane now
          shares the outer card's background/border with the list
          instead of nesting a second, differently-sized box inside
          it. */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2"
      >
        {!recipientPubkeyHex ? (
          <p className="text-[13px] text-slate-400 dark:text-white/30 text-center py-8">
            {t("enter_recipient_to_start") ||
              "Enter a recipient's npub above to start chatting."}
          </p>
        ) : messages.length === 0 ? (
          <p className="text-[13px] text-slate-400 dark:text-white/30 text-center py-8">
            {t("no_messages_yet") || "No messages yet — say hi!"}
          </p>
        ) : (
          messages.map((m) => {
            const isMine = m.pubkey === nostrIdentity?.pubkey;
            const attachments = parseImetaTags(m.tags);
            return (
              <div
                key={m.id}
                className={`flex ${isMine ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[75%] px-3 py-2 rounded-xl text-[14px] break-words ${
                    isMine
                      ? "bg-[#2B000A] text-white/90"
                      : "bg-slate-200 dark:bg-white/[0.06] text-slate-800 dark:text-white/80"
                  }`}
                >
                  {/* ADDED: inline attachments — images/videos render
                      directly, anything else (pdf/txt) shows as a
                      tappable file chip. Detected via the rumor's own
                      NIP-92 "imeta" tags (see parseImetaTags above),
                      not by guessing from the URL, since Grove's
                      gatewayUrls carry no file extension. */}
                  {attachments.length > 0 && (
                    <div className="flex flex-col gap-1.5 mb-1.5">
                      {attachments.map((a, i) =>
                        a.mime.startsWith("image/") ? (
                          <img
                            key={i}
                            src={a.url}
                            alt=""
                            onClick={() => setLightboxAttachment(a)}
                            className="max-w-full max-h-64 rounded-lg object-cover cursor-zoom-in hover:opacity-90 transition-opacity"
                          />
                        ) : a.mime.startsWith("video/") ? (
                          <video
                            key={i}
                            src={a.url}
                            controls
                            className="max-w-full max-h-64 rounded-lg"
                          />
                        ) : (
                          <a
                            key={i}
                            href={a.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[13px] underline ${
                              isMine
                                ? "bg-white/10 text-white/90"
                                : "bg-black/5 dark:bg-white/10"
                            }`}
                          >
                            <FileIcon className="w-3.5 h-3.5 flex-shrink-0" />
                            {t("attachment") || "Attachment"}
                          </a>
                        ),
                      )}
                    </div>
                  )}
                  {m.content && <p>{m.content}</p>}
                  {/* ADDED: sent/received date + time per message. */}
                  <p
                    className={`text-[10px] mt-1 text-right ${
                      isMine
                        ? "text-white/50"
                        : "text-slate-500 dark:text-white/35"
                    }`}
                  >
                    {messageTimestamp(m.created_at)}
                  </p>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* CHANGED: whole composer area (spam notice, media previews,
          input row, upload/send errors) wrapped in one border-t px-4
          py-3 section — same padding/weight as the header's border-b
          — so the card reads as header / scrollable middle / footer,
          the same three-zone structure every chat app uses, instead
          of a loose stack of differently-indented rows. */}
      <div className="flex-shrink-0 border-t border-slate-200 dark:border-white/[0.06] px-4 py-3">
        {spamLimitReached && (
          <p className="text-[12px] text-amber-600 dark:text-amber-400/80 mb-1.5">
            {t("spam_wait_for_reply") ||
              "You've already sent the first message — wait for a reply before sending another."}
          </p>
        )}

        {/* ADDED: selected-but-not-yet-sent media previews. */}
        {mediaFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-2">
          {mediaFiles.map((file, index) => (
            <div
              key={index}
              className="relative w-16 h-16 rounded-lg overflow-hidden border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-[#050e1f] flex-shrink-0"
            >
              {file.type.startsWith("image/") ? (
                <img
                  src={URL.createObjectURL(file)}
                  alt={file.name}
                  className="w-full h-full object-cover"
                />
              ) : file.type.startsWith("video/") ? (
                <div className="w-full h-full flex items-center justify-center">
                  <VideoIcon className="w-5 h-5 text-slate-500 dark:text-white/30" />
                </div>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <FileIcon className="w-5 h-5 text-slate-500 dark:text-white/30" />
                </div>
              )}
              <button
                onClick={() => removeMediaFile(index)}
                aria-label={t("remove_file") || "Remove"}
                className="absolute top-0.5 right-0.5 w-4.5 h-4.5 bg-[#000d1f]/90 border border-red-800/30 text-red-400/70 hover:text-red-400/95 rounded-md flex items-center justify-center"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </div>
          ))}
        </div>
      )}
        {fileError && (
          <p className="text-[12px] text-red-600 dark:text-red-400/70 mb-1.5">
            {fileError}
          </p>
        )}

        <div className="flex gap-2 items-end">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          multiple
          accept="image/*,video/*,.pdf,.txt"
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={
            !recipientPubkeyHex ||
            spamLimitReached ||
            mediaFiles.length >= MAX_CHAT_FILES
          }
          title={t("add_media") || "Attach media"}
          className="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center border border-slate-300 dark:border-white/[0.09] bg-slate-50 dark:bg-white/[0.03] text-slate-700 dark:text-white/40 hover:border-slate-400 dark:hover:border-white/[0.16] hover:text-slate-900 dark:hover:text-white/65 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Paperclip className="w-5 h-5" />
        </button>

        <div className="relative flex-shrink-0">
          <button
            ref={emojiButtonRef}
            type="button"
            onClick={() => setShowEmojiPicker((v) => !v)}
            disabled={!recipientPubkeyHex || spamLimitReached}
            title={t("add_emoji") || "Emoji"}
            className={`w-10 h-10 rounded-lg flex items-center justify-center border transition-all disabled:opacity-30 ${
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
                className="fixed z-50 rounded-2xl overflow-hidden border border-slate-300 dark:border-white/[0.1] shadow-xl dark:shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
                style={{ top: emojiPickerStyle.top, left: emojiPickerStyle.left }}
              >
                <EmojiPicker
                  onEmojiClick={insertEmoji}
                  theme={isDarkMode ? EmojiTheme.DARK : EmojiTheme.LIGHT}
                  width={emojiPickerStyle.width}
                  height={emojiPickerStyle.height}
                  searchPlaceholder={
                    t("search_emoji", "Search emoji...") || "Search emoji..."
                  }
                  previewConfig={{ showPreview: false }}
                  skinTonesDisabled
                />
              </div>,
              document.body,
            )}
        </div>

        {/* CHANGED: single-line <input> → auto-resizing <textarea>,
            same min/max-height + Enter-to-send/Shift+Enter-for-newline
            pattern as AIAssistant.jsx's chat input, so multi-line
            messages no longer scroll sideways inside a one-line box. */}
        <textarea
          ref={draftInputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            const el = e.target;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (!sending) handleSend();
            }
          }}
          placeholder={t("write_a_message") || "Write a message…"}
          disabled={!recipientPubkeyHex || spamLimitReached}
          rows={1}
          style={{ minHeight: "40px", maxHeight: "160px" }}
          className="flex-1 px-3 py-2 rounded-lg bg-slate-100 dark:bg-white/[0.04] border border-slate-300 dark:border-white/[0.08] text-[14px] text-slate-900 dark:text-white placeholder:text-slate-400 dark:placeholder:text-white/30 focus:outline-none focus:border-[#b41e3c]/40 disabled:opacity-50 resize-none overflow-y-auto leading-relaxed"
        />
        {/* CHANGED: icon-only round-ish send button, matching
            AIAssistant.jsx's (the Atticus chat) send button exactly
            — same Send icon, same p-2.5/rounded-xl sizing and
            maroon color — instead of a text-labelled button. */}
        <button
          onClick={handleSend}
          disabled={
            !recipientPubkeyHex ||
            (!draft.trim() && mediaFiles.length === 0) ||
            sending ||
            spamLimitReached
          }
          title={t("send") || "Send"}
          className="flex-shrink-0 p-2.5 rounded-xl bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35 dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-[#e8a0b0]/80 dark:hover:bg-[#3d0012] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
        >
          {sending ? (
            <span className="block w-5 h-5 rounded-full border-2 border-current border-t-transparent animate-spin" />
          ) : (
            <Send className="w-5 h-5" />
          )}
        </button>
        </div>
        {uploadingMedia && (
          <p className="text-[12px] text-slate-500 dark:text-white/40 mt-1.5">
            {t("uploading") || "Uploading…"}
          </p>
        )}
        {sendError && (
          <p className="text-[12px] text-red-600 dark:text-red-400/70 mt-1.5">
            {sendError}
          </p>
        )}
      </div>

      {/* ADDED: full-screen lightbox for tapped image attachments,
          with a download action — see the onClick on the message
          image above. */}
      {lightboxAttachment &&
        createPortal(
          <div
            className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-4"
            onClick={() => setLightboxAttachment(null)}
          >
            <button
              onClick={() => setLightboxAttachment(null)}
              aria-label={t("close") || "Close"}
              className="absolute top-4 right-4 w-10 h-10 rounded-full flex items-center justify-center bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
            <a
              href={lightboxAttachment.url}
              download
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={t("download") || "Download"}
              className="absolute top-4 right-16 w-10 h-10 rounded-full flex items-center justify-center bg-white/10 text-white hover:bg-white/20 transition-colors"
            >
              <Download className="w-5 h-5" />
            </a>
            <img
              src={lightboxAttachment.url}
              alt=""
              onClick={(e) => e.stopPropagation()}
              className="max-w-full max-h-full object-contain rounded-lg"
            />
          </div>,
          document.body,
        )}
    </>
  );
}
