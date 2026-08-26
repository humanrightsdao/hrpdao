// src/hooks/useNostrIdentity.jsx
//
// ⚠️ Ported from dossier's src/hooks/useNostrIdentity.jsx — same
// derivation, same fixed message, same reasoning. Dossier signs a
// fixed message with the user's wallet and hashes the signature into
// a 32-byte secp256k1 key; because ECDSA signing is deterministic
// (RFC 6979) the SAME wallet signing the SAME message always produces
// the SAME key — on any device, in any app, no separate Nostr
// account/backup needed. Before this hook existed, dao-app's Forum
// (useForum.js) signed posts with nostrLookup.js's fallback instead:
// a NIP-07 extension if present, otherwise a random key generated
// once and stashed in this browser's localStorage — unrelated to the
// wallet, and different on every browser/device. That's the literal
// bug behind "Nostr sync doesn't work in the DAO app": a user's forum
// posts were never the same Nostr identity as their Dossier account,
// even logged into the identical wallet.
//
// NOT ported: the Lens-account-metadata publish step (writing
// `nostr_npub` onto the Lens Account) — that's Dossier's job, it owns
// the Lens session. This hook only needs read access to derive the
// SAME key locally; dao-app's identity.js/lensLookup.js already
// surfaces that same nostr_npub attribute when looking up OTHER
// people's identity from their Lens profile.
//
// ALSO PORTED (previously missing here, which was the actual bug
// behind "navigating to the Forum asks for a wallet confirmation"):
// dossier never waits for a Forum-like page to call signEvent()
// before deriving — it derives proactively the moment a wallet is
// available (see the auto-derive effect below), and caches the
// result in sessionStorage keyed by address so a page reload doesn't
// re-prompt either. Without that, this hook only ever derived lazily,
// inside createThread/postReply's first getSignerPubkey() call — so
// the very first thing a user did on the Forum (open the "new
// thread" modal, hit submit) was also the first time a signature got
// requested, which reads as "the Forum needs a confirmation" even
// though, for an embedded Privy wallet, that confirmation is already
// silent (uiOptions.showWalletUIs:false) — it just hadn't happened
// yet. Deriving right after login/connect moves that one-time
// signature earlier and out of the way, so by the time the member
// reaches the Forum the identity is already resolved.
//
// Usage: wrap the app once in <NostrIdentityProvider> (see main.jsx),
// then call useNostrIdentity() from any component/hook that needs to
// sign a Nostr event as "the current DAO member".

import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { sha256 } from "viem";
import { getPublicKey, finalizeEvent, nip19 } from "nostr-tools";
import { useAccount, useWalletClient } from "wagmi";
import { useSignMessage } from "@privy-io/react-auth";

// Must be byte-for-byte identical to dossier's NOSTR_DERIVATION_MESSAGE
// — any difference derives a completely different, unrelated key.
const NOSTR_DERIVATION_MESSAGE =
  "Generate my Nostr identity for Human Rights Policy DAO — v1";

function hexToBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

const NostrIdentityContext = createContext(null);

function useNostrIdentityState() {
  const { address, connector } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { signMessage: privySignMessage } = useSignMessage();
  const [nostrIdentity, setNostrIdentity] = useState(null);
  const [deriving, setDeriving] = useState(false);
  const [error, setError] = useState("");
  const derivingRef = useRef(false);

  const deriveNostrIdentity = useCallback(async () => {
    if (nostrIdentity) return nostrIdentity;
    if (derivingRef.current) return null;

    // Same sessionStorage cache as dossier: the derivation is
    // deterministic (same wallet + same fixed message = same key,
    // always), so once it's been signed once this browser session
    // there's nothing left to gain by asking the wallet to sign
    // again on every page reload — reuse the cached result instead.
    if (address) {
      try {
        const cached = sessionStorage.getItem(`nostr_identity:${address}`);
        if (cached) {
          const { secretKeyHex, pubkey, npub } = JSON.parse(cached);
          const secretKey = hexToBytes(secretKeyHex);
          const identity = { secretKey, pubkey, npub };
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
      // Same connector.id check as dossier — @privy-io/wagmi builds
      // the embedded wallet's connector id as
      // `io.privy.wallet.<address>`, not the bare string.
      const isEmbeddedWallet = connector?.id?.startsWith("io.privy.wallet");

      let signatureHex;
      if (isEmbeddedWallet) {
        const result = await privySignMessage(
          { message: NOSTR_DERIVATION_MESSAGE },
          { uiOptions: { showWalletUIs: false } },
        );
        signatureHex = result.signature;
      } else {
        if (!walletClient) {
          throw new Error("Wallet not connected — cannot derive Nostr key");
        }
        signatureHex = await walletClient.signMessage({
          account: walletClient.account,
          message: NOSTR_DERIVATION_MESSAGE,
        });
      }

      const secretKey = sha256(hexToBytes(signatureHex), "bytes"); // Uint8Array(32)
      const pubkey = getPublicKey(secretKey);
      const npub = nip19.npubEncode(pubkey);

      const identity = { secretKey, pubkey, npub };
      setNostrIdentity(identity);
      if (address) {
        try {
          const secretKeyHex = Array.from(secretKey)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          sessionStorage.setItem(
            `nostr_identity:${address}`,
            JSON.stringify({ secretKeyHex, pubkey, npub }),
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
  }, [address, connector, walletClient, nostrIdentity, privySignMessage]);

  // AUTO-DERIVE: as soon as a wallet is connected, resolve the Nostr
  // identity in the background instead of waiting for the Forum to
  // ask for a signature the first time someone posts. Mirrors
  // dossier's own auto-derive effect (see its useNostrIdentity.jsx),
  // minus the Lens-metadata linking step, which doesn't apply here.
  const autoDeriveAttemptedRef = useRef(false);

  useEffect(() => {
    if (!address) {
      // Wallet disconnected (or not yet connected) — reset so a
      // later connect (possibly with a different account) can
      // auto-derive again instead of being permanently skipped.
      autoDeriveAttemptedRef.current = false;
      return;
    }
    if (autoDeriveAttemptedRef.current) return;
    autoDeriveAttemptedRef.current = true;
    deriveNostrIdentity();
  }, [address, deriveNostrIdentity]);

  const signEvent = useCallback(
    async (template) => {
      const identity = nostrIdentity || (await deriveNostrIdentity());
      if (!identity) return null;
      const eventTemplate = {
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        ...template,
        pubkey: identity.pubkey,
      };
      return finalizeEvent(eventTemplate, identity.secretKey);
    },
    [nostrIdentity, deriveNostrIdentity],
  );

  const getSignerPubkey = useCallback(async () => {
    const identity = nostrIdentity || (await deriveNostrIdentity());
    return identity?.pubkey || null;
  }, [nostrIdentity, deriveNostrIdentity]);

  return {
    nostrIdentity,
    deriving,
    error,
    deriveNostrIdentity,
    signEvent,
    getSignerPubkey,
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
    throw new Error("useNostrIdentity() must be used within <NostrIdentityProvider>");
  }
  return ctx;
}
