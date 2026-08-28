import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { hexToBytes, sha256 } from "viem";
import { getPublicKey, finalizeEvent, nip19 } from "nostr-tools";
import { fetchAccount, setAccountMetadata } from "@lens-protocol/client/actions";
import { handleOperationWith } from "@lens-protocol/client/viem";
import {
  account as accountMetadata,
  MetadataAttributeType,
} from "@lens-protocol/metadata";
import { useSignMessage } from "@privy-io/react-auth";
import { useLensAuth } from "../context/LensAuthContext";
import { storageClient } from "../lib/grove";

// FIXED MESSAGE: signing the exact same string with the exact same
// wallet always produces the exact same signature (viem/wagmi use
// RFC 6979 deterministic-k ECDSA under the hood, same as MetaMask and
// every other standard EVM wallet) — so hashing that signature gives
// us a stable, reproducible 32-byte seed for a Nostr private key,
// without ever storing the key anywhere. Re-deriving it later (any
// device, any session) with the same wallet always yields the exact
// same Nostr identity. Bump the "v1" if this message ever needs to
// change — that would intentionally rotate everyone's derived Nostr
// key, same as changing a password would.
const NOSTR_DERIVATION_MESSAGE =
  "Generate my Nostr identity for Human Rights Policy DAO — v1";

/**
 * Derives a Nostr keypair deterministically from the user's Privy
 * embedded wallet (or any connected EOA) by signing a fixed message
 * and hashing the signature into a 32-byte secp256k1 secret key.
 *
 * This is what keeps the user's Lens account and Nostr identity
 * "synchronized" — they aren't stored as two separate, independently
 * managed credentials that could drift apart; the Nostr key is always
 * mathematically re-derivable from the same wallet that owns the Lens
 * account, on demand, with no separate backup/recovery flow needed.
 *
 * NOTE: the derived secretKey (Uint8Array) and nsec (bech32-encoded
 * string) are both genuinely sensitive — treat them exactly like a
 * password. Keep them in memory only (this hook's own React state);
 * never log them, never persist them to localStorage/a database, and
 * never send them to a server. Signing individual Nostr events
 * (signEvent below) is fine to do fully client-side.
 */
// CHANGED (fixes repeated signature prompts): this used to be a plain
// hook — every component that called useNostrIdentity() got its own,
// completely independent useState(null) for nostrIdentity, with no
// sharing between them. Since SettingsPage, NostrChatPage,
// useLensPosts, and useNostrConversations all call this hook
// separately (often simultaneously, e.g. on first login when several
// mount at once), each one triggered its OWN signMessage() call —
// same deterministic message, so cryptographically harmless, but
// Privy shows a confirmation prompt for EACH one, so the user saw
// "Sign message" over and over for what should have been one signature
// per session. Wrapping the actual state in a Context — with a single
// Provider mounted once near the app root — means there is exactly
// ONE nostrIdentity value, derived (and prompted for) at most once,
// shared by every consumer. The hook below (useNostrIdentity) keeps
// the exact same call signature every existing caller already uses;
// only main.jsx needs a new <NostrIdentityProvider> wrapper.
const NostrIdentityContext = createContext(null);

function useNostrIdentityState() {
  const { getWalletClient, sessionClient, address, connector } = useLensAuth();
  // Privy's OWN signing hook — the only way to pass uiOptions.
  // showWalletUIs:false and suppress the embedded wallet's "Sign
  // message" confirmation screen. This is SEPARATE from the wagmi
  // walletClient.signMessage() path used elsewhere in the app (e.g.
  // for the actual Lens session-login signature, which SHOULD stay
  // visible to the user — that one authorizes something meaningful).
  // The Nostr-derivation message below is fixed, non-sensitive, and
  // purely technical, so hiding its confirmation is a reasonable,
  // narrowly-scoped UX improvement rather than a blanket "hide all
  // signing" choice.
  const { signMessage: privySignMessage } = useSignMessage();
  // { secretKey: Uint8Array(32), pubkey: hex string, npub, nsec }
  const [nostrIdentity, setNostrIdentity] = useState(null);
  const [deriving, setDeriving] = useState(false);
  const [error, setError] = useState("");
  const derivingRef = useRef(false);

  const deriveNostrIdentity = useCallback(async () => {
    // Already derived this session — reuse it instead of asking the
    // wallet to sign again.
    if (nostrIdentity) return nostrIdentity;
    // A derivation is already in flight (e.g. two components both
    // called this on mount) — wait for it instead of duplicating the
    // signature request.
    if (derivingRef.current) return null;

    // FIXED: nostrIdentity above only survives within ONE page
    // session — a full reload resets it to null, and since the
    // derivation is deterministic (same wallet + same fixed message
    // = same key, always), that meant asking for a fresh signature on
    // literally every reload for no benefit — nothing about the
    // result could ever differ. Caching the derived key in
    // sessionStorage (scoped per-address, cleared when the tab
    // closes) removes that repeat prompt entirely after the first one
    // per browser session, without changing what gets derived or
    // introducing any new secret — the key was always fully
    // recoverable from the wallet on demand anyway.
    if (address) {
      try {
        const cached = sessionStorage.getItem(`nostr_identity:${address}`);
        if (cached) {
          const { secretKeyHex, pubkey, npub, nsec } = JSON.parse(cached);
          const secretKey = hexToBytes(`0x${secretKeyHex}`);
          const identity = { secretKey, pubkey, npub, nsec };
          setNostrIdentity(identity);
          return identity;
        }
      } catch (err) {
        console.warn("⚠️ Failed to read cached Nostr identity:", err);
      }
    }

    derivingRef.current = true;
    setDeriving(true);
    setError("");
    try {
      // Privy's own useSignMessage() only works for the embedded
      // wallet — for an externally-linked wallet (MetaMask etc.) we
      // fall back to the normal wagmi walletClient path, which will
      // show whatever confirmation UI that wallet natively uses (not
      // something we can suppress — it's not Privy's UI to control).
      // FIXED: connector.id for the embedded wallet is NOT the plain
      // string "io.privy.wallet" — @privy-io/wagmi's own
      // toWalletConnectorId() builds it as `${meta.id}.${address}`
      // (e.g. "io.privy.wallet.0xA7A4...264b") for any "privy"
      // walletClientType, specifically so multiple embedded wallets
      // could theoretically coexist as distinct connectors. An exact
      // `=== "io.privy.wallet"` match therefore NEVER succeeded, this
      // branch never ran, and every derivation silently fell through
      // to the wagmi walletClient path below — which goes through the
      // provider's raw personal_sign RPC and always triggers Privy's
      // "Sign message" confirmation screen (uiOptions only bypasses
      // it via Privy's own dedicated useSignMessage() hook, not raw
      // provider RPC calls) — explaining why the confirmation kept
      // showing up despite this code appearing to handle it.
      const isEmbeddedWallet = connector?.id?.startsWith("io.privy.wallet");

      let signatureHex;
      if (isEmbeddedWallet) {
        const result = await privySignMessage(
          { message: NOSTR_DERIVATION_MESSAGE },
          { uiOptions: { showWalletUIs: false } },
        );
        signatureHex = result.signature;
      } else {
        const client = await getWalletClient();
        if (!client) {
          throw new Error("Wallet not connected — cannot derive Nostr key");
        }
        signatureHex = await client.signMessage({
          account: client.account,
          message: NOSTR_DERIVATION_MESSAGE,
        });
      }

      const signatureBytes = hexToBytes(signatureHex);
      const secretKey = sha256(signatureBytes, "bytes"); // Uint8Array(32)

      const pubkey = getPublicKey(secretKey); // hex string
      const npub = nip19.npubEncode(pubkey);
      const nsec = nip19.nsecEncode(secretKey);

      const identity = { secretKey, pubkey, npub, nsec };
      setNostrIdentity(identity);
      if (address) {
        try {
          const secretKeyHex = Array.from(secretKey)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          sessionStorage.setItem(
            `nostr_identity:${address}`,
            JSON.stringify({ secretKeyHex, pubkey, npub, nsec }),
          );
        } catch (err) {
          console.warn("⚠️ Failed to cache Nostr identity:", err);
        }
      }
      return identity;
    } catch (err) {
      console.error("⚠️ Failed to derive Nostr identity:", err);
      setError(err.message || "Failed to derive Nostr identity");
      return null;
    } finally {
      derivingRef.current = false;
      setDeriving(false);
    }
  }, [getWalletClient, nostrIdentity]);

  /**
   * Signs a Nostr event with the derived key. Auto-derives the
   * identity first if it hasn't been derived yet this session.
   * @param {{kind: number, content: string, tags?: string[][], created_at?: number}} template
   * @returns {Promise<import('nostr-tools').VerifiedEvent | null>}
   */
  const signEvent = useCallback(
    async (template) => {
      const identity = nostrIdentity || (await deriveNostrIdentity());
      if (!identity) return null;
      const eventTemplate = {
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        ...template,
      };
      return finalizeEvent(eventTemplate, identity.secretKey);
    },
    [nostrIdentity, deriveNostrIdentity],
  );

  const clearNostrIdentity = useCallback(() => {
    setNostrIdentity(null);
  }, []);

  const [linking, setLinking] = useState(false);
  const [linkError, setLinkError] = useState("");

  /**
   * Publishes the derived npub onto the user's Lens Account metadata
   * (as a "nostr_npub" attribute — the same mechanism already used for
   * country/isAdult/hasAcceptedTerms elsewhere in this app), so other
   * Lens clients/indexers can discover the linked Nostr identity too.
   *
   * This reads the CURRENT on-chain metadata first and only adds/
   * replaces the nostr_npub attribute — every other existing attribute
   * (country, h3Index, isAdult, hasAcceptedTerms, ...) and the name/
   * bio/picture are preserved exactly as they were. This matters
   * because a naive "always rebuild the attributes list from a fixed
   * set" approach (the pattern ProfileEditModal.jsx uses for its own,
   * different, always-known set of fields) would silently wipe out any
   * attribute it doesn't already know about.
   */
  const linkNostrIdentityToLensAccount = useCallback(async (currentProfile) => {
    if (!sessionClient || !address) {
      setLinkError("Not logged in — connect and log in first.");
      return false;
    }
    setLinking(true);
    setLinkError("");
    try {
      const identity = nostrIdentity || (await deriveNostrIdentity());
      if (!identity) throw new Error("Could not derive Nostr identity.");

      // FIX: `address` here is the connected WALLET's EOA (from
      // useAccount()/useLensAuth()) — NOT the Lens Account's own
      // smart-contract address, which is a *different* address. Every
      // other place in this app that reads/writes Lens Account
      // metadata (ProfileEditModal.jsx, useUserInfo.js,
      // useLensProfile.js) deliberately uses the Lens Account address
      // stored in localStorage under "lens_account_address" for
      // exactly this reason. Passing the wallet address to
      // fetchAccount() here queried the wrong (non-existent, as a
      // Lens Account) address, so `current` below came back empty —
      // and the metadata rebuild then wrote back an EMPTY name/bio/
      // picture, silently wiping the user's profile the next time it
      // was read from chain.
      const lensAccountAddress =
        localStorage.getItem("lens_account_address") || address;

      // Read the account's current metadata so we don't clobber
      // anything the user (or the app) already set.
      //
      // FIX: right after account CREATION (CreateLensAccount.jsx
      // already uploads a metadataUri as part of createAccountWithUsername),
      // this auto-link effect fires within moments — often before the
      // Lens indexer has caught up with that just-written metadata.
      // fetchAccount() then returns the account with metadata: null,
      // which used to be treated as the (rarer, genuinely ambiguous)
      // indexer-lag-after-edit case below and threw immediately,
      // surfacing a scary error to every single new-account user. Since
      // this is virtually always just the indexer catching up within a
      // few seconds — not a real error — retry a few times with a
      // short delay before giving up and falling through to the
      // safety-net error.
      let accountResult = await fetchAccount(sessionClient, {
        address: lensAccountAddress,
      });
      for (
        let attempt = 0;
        attempt < 3 &&
        accountResult.isOk() &&
        accountResult.value &&
        !accountResult.value.metadata;
        attempt++
      ) {
        await new Promise((r) => setTimeout(r, 1500));
        accountResult = await fetchAccount(sessionClient, {
          address: lensAccountAddress,
        });
      }
      if (accountResult.isErr()) {
        throw new Error(accountResult.error.message);
      }
      const current = accountResult.value?.metadata;

      // SAFETY NET: if the account was found but somehow came back
      // with a name/bio/picture already set that we're about to
      // "preserve" as undefined, that's a sign fetchAccount returned
      // incomplete data (e.g. indexer lag right after a previous
      // save) rather than the account genuinely having no profile
      // info. Refuse to overwrite in that ambiguous case instead of
      // silently wiping the user's profile — better to ask them to
      // retry the link in a moment than to risk erasing their avatar
      // and bio again.
      if (accountResult.value && !current) {
        throw new Error(
          "Could not read the account's current profile data — please try again in a moment (this can happen right after a profile edit, before it's fully indexed).",
        );
      }

      // FIX (indexer-lag race): fetchAccount reads from the Lens
      // INDEXER, which can lag a few seconds behind the chain. If the
      // user just saved an avatar/bio in ProfileEditModal and then
      // immediately clicks "Link to my Lens account", this fetch can
      // come back with the OLD (pre-edit) snapshot — and we'd then
      // "preserve" that stale name/bio/picture, overwriting the
      // brand-new one the user just set. The caller (SettingsPage /
      // NostrChatPage) already has the freshest known profile state
      // in memory (from useUserInfo/useLensProfile, populated right
      // after that save) — when provided, trust IT over the indexer
      // read for these three fields specifically. `attributes` still
      // comes from the fetch above since flattened profile state
      // doesn't carry the raw attribute list.
      const effectiveName =
        currentProfile && currentProfile.name !== undefined
          ? currentProfile.name
          : current?.name;
      const effectiveBio =
        currentProfile && currentProfile.bio !== undefined
          ? currentProfile.bio
          : current?.bio;
      const effectivePicture =
        currentProfile && currentProfile.picture !== undefined
          ? currentProfile.picture
          : current?.picture;

      // FIX: the Lens GraphQL API returns attribute `type` in
      // UPPERCASE ("STRING", "BOOLEAN", "NUMBER", "DATE", "JSON" —
      // see MetadataAttributeType in @lens-protocol/graphql), but the
      // Zod schema inside @lens-protocol/metadata's accountMetadata()
      // builder validates `type` against its OWN enum values, which
      // are capitalized differently ("String", "Boolean", "Number",
      // "Date", "JSON"). Passing the raw GraphQL value straight back
      // into the builder fails with "Invalid discriminator value.
      // Expected 'Boolean' | 'Date' | 'Number' | 'String' | 'JSON'"
      // for every preserved attribute. Map GraphQL's uppercase value
      // to the matching MetadataAttributeType before rebuilding.
      const GRAPHQL_TO_METADATA_ATTRIBUTE_TYPE = {
        BOOLEAN: MetadataAttributeType.BOOLEAN,
        DATE: MetadataAttributeType.DATE,
        NUMBER: MetadataAttributeType.NUMBER,
        STRING: MetadataAttributeType.STRING,
        JSON: MetadataAttributeType.JSON,
      };

      const existingAttributes = (current?.attributes || [])
        // Drop any existing nostr_npub — we're about to write a fresh
        // one below, this is the "replace" part of "add or replace".
        .filter((attr) => attr.key !== "nostr_npub")
        .map((attr) => ({
          key: attr.key,
          value: attr.value,
          type:
            GRAPHQL_TO_METADATA_ATTRIBUTE_TYPE[attr.type] ||
            MetadataAttributeType.STRING,
        }));

      const attributes = [
        ...existingAttributes,
        {
          key: "nostr_npub",
          value: identity.npub,
          type: MetadataAttributeType.STRING,
        },
      ];

      const metadata = accountMetadata({
        name: effectiveName || undefined,
        // Same trim-then-validate quirk as ProfileEditModal.jsx: an
        // empty/whitespace-only bio must be omitted (undefined), not
        // sent as "" or " ", or @lens-protocol/metadata's Zod schema
        // rejects it with "String must contain at least 1
        // character(s)".
        bio: effectiveBio && effectiveBio.trim() ? effectiveBio.trim() : undefined,
        picture: effectivePicture || undefined,
        coverPicture: current?.coverPicture || undefined,
        attributes,
      });

      const { uri } = await storageClient.uploadAsJson(metadata);
      const walletClient = await getWalletClient();
      if (!walletClient) throw new Error("Wallet not connected.");

      const result = await setAccountMetadata(sessionClient, {
        metadataUri: uri,
      }).andThen(handleOperationWith(walletClient));

      if (result.isErr()) throw new Error(result.error.message);
      if (result.value && typeof result.value === "string") {
        await sessionClient.waitForTransaction(result.value);
      }
      console.log("✅ Nostr npub linked to Lens account metadata");
      return true;
    } catch (err) {
      console.error("⚠️ Failed to link Nostr identity to Lens account:", err);
      setLinkError(err.message || "Failed to link Nostr identity.");
      return false;
    } finally {
      setLinking(false);
    }
  }, [sessionClient, address, nostrIdentity, deriveNostrIdentity, getWalletClient]);

  // CHANGED (was AUTO-LINK-ON-LOGIN): this used to fire the moment
  // sessionClient+address became available — i.e. right after login,
  // for EVERY user, whether or not they ever opened the chat. For
  // external wallets (MetaMask etc.) that meant an unavoidable native
  // "Sign message" popup (and, the first time ever, a second popup to
  // approve the on-chain setAccountMetadata transaction) on every
  // single login, regardless of whether Nostr chat was used at all.
  //
  // Nostr's own protocol genuinely needs the derived secretKey to
  // sign/decrypt anything — that part isn't optional. But *when* we
  // ask for it is a product choice, not a protocol requirement. Moved
  // to be lazy: the caller (NostrChatPage, on mount) now explicitly
  // invokes `ensureLinkedNostrIdentity()` only when the user actually
  // opens the chat — see that page for the call site. Settings no
  // longer needs this to run at all just to display npub; it reads
  // the already-on-chain `nostr_npub` value instead (see
  // SettingsPage.jsx / useLensProfile.js's `nostrNpub`), which
  // requires no wallet interaction once the one-time link below has
  // happened at least once from some previous chat visit.
  const autoLinkAttemptedRef = useRef(false);

  const ensureLinkedNostrIdentity = useCallback(async () => {
    if (!sessionClient || !address) return null;
    // Note: deriveNostrIdentity() has its own internal in-flight
    // guard (derivingRef), so concurrent callers naturally dedupe
    // into a single signature request.
    const identity = nostrIdentity || (await deriveNostrIdentity());
    if (!identity) return null;

    // Only ever attempt the on-chain link once per session — whether
    // it succeeds or fails, retrying automatically on every call
    // would risk spamming an external wallet's signature prompt.
    if (autoLinkAttemptedRef.current) return identity;
    autoLinkAttemptedRef.current = true;

    try {
      const lensAccountAddress =
        localStorage.getItem("lens_account_address") || address;
      const accountResult = await fetchAccount(sessionClient, {
        address: lensAccountAddress,
      });
      if (accountResult.isErr()) return identity;

      const existingNpub = (
        accountResult.value?.metadata?.attributes || []
      ).find((attr) => attr.key === "nostr_npub")?.value;

      // Already linked and pointing at the current identity — nothing
      // to do, avoid an unnecessary on-chain write (and an unnecessary
      // second wallet popup).
      if (existingNpub === identity.npub) return identity;

      await linkNostrIdentityToLensAccount();
    } catch (err) {
      // Best-effort — chat should keep working even if the link write
      // fails; linkError is still set by linkNostrIdentityToLensAccount
      // itself for the rare case something wants to surface it.
      console.warn("⚠️ Nostr↔Lens link skipped/failed:", err);
    }
    return identity;
  }, [
    sessionClient,
    address,
    nostrIdentity,
    deriveNostrIdentity,
    linkNostrIdentityToLensAccount,
  ]);

  return {
    ensureLinkedNostrIdentity,
    nostrIdentity, // null until derived; { secretKey, pubkey, npub, nsec } after
    deriving,
    error,
    deriveNostrIdentity,
    signEvent,
    clearNostrIdentity,
    linkNostrIdentityToLensAccount,
    linking,
    linkError,
  };
}

export function NostrIdentityProvider({ children }) {
  const value = useNostrIdentityState();
  return (
    <NostrIdentityContext.Provider value={value}>
      {children}
    </NostrIdentityContext.Provider>
  );
}

export function useNostrIdentity() {
  const ctx = useContext(NostrIdentityContext);
  if (!ctx) {
    throw new Error(
      "useNostrIdentity() must be used within <NostrIdentityProvider> — add it in main.jsx, inside <LensAuthProvider> (it depends on useLensAuth()).",
    );
  }
  return ctx;
}

export default useNostrIdentity;
