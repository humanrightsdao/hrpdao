import { createContext, useContext, useState, useEffect, useRef } from "react";
import { lensClient } from "../lib/lens";
import {
  signMessageWith,
  handleOperationWith,
} from "@lens-protocol/client/viem";
import {
  useAccount,
  useWalletClient,
  useDisconnect,
  useSwitchChain,
} from "wagmi";
// EMBEDDED WALLET: usePrivy().login() replaces the old MetaMask/
// WalletConnect connectAsync() dance. Privy itself decides HOW to get
// the user a signer (embedded EOA via email/social/passkey, or an
// externally linked wallet if they choose that in the login modal).
// In theory @privy-io/wagmi's WagmiProvider auto-syncs whichever
// wallet becomes active into wagmi's own state — in practice this
// sync can lag or miss entirely right after a FRESH embedded wallet
// is created (the account exists on Privy's side, its own "Success"
// modal confirms that, but wagmi's useAccount()/isConnected never
// flips true, so the app stays stuck on the login screen even though
// Privy itself succeeded). Privy's own official demos handle this by
// explicitly setting the active wallet via useSetActiveWallet() once
// it appears in useWallets() — see the effect below — instead of
// relying purely on the automatic sync.
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useSetActiveWallet } from "@privy-io/wagmi";
import {
  fetchAllModActions,
  computeBanState,
  fetchShieldTotalSupply,
} from "../utils/moderationActions";
// FIXED (logout needing two clicks, losing the Nostr identity on
// Settings): see the long comment above markIntentionalDisconnect in
// useLensDAO.js for the full root cause. Short version: useLensDAO()
// is mounted globally (Navbar) and reloads the page on the wallet
// provider's own "accountsChanged" event — which disconnect()/
// privyLogout() below trigger themselves, hard-reloading mid-logout.
// markIntentionalDisconnect(true) tells every mounted useLensDAO()
// instance to ignore that self-inflicted event.
import { markIntentionalDisconnect } from "../hooks/useLensDAO";

const LensAuthContext = createContext(null);

export function LensAuthProvider({ children }) {
  const { address, isConnected, connector } = useAccount();
  const { data: walletClient } = useWalletClient();
  // EMBEDDED WALLET: login() opens the Privy modal (email/Google/
  // passkey/"connect existing wallet") and resolves once the user has
  // authenticated — Privy then creates (or reuses) their embedded
  // wallet and @privy-io/wagmi syncs it into wagmi automatically, at
  // which point useAccount() above reflects the new address/connector
  // on its own without us calling wagmi's connect() at all.
  const { login, logout: privyLogout, ready: privyReady } = usePrivy();
  // ADDED: explicit fallback for the wagmi sync gap described above.
  // wallets is Privy's own list of connected wallets (embedded +
  // any externally linked ones), independent of wagmi's state.
  const { wallets } = useWallets();
  const { setActiveWallet } = useSetActiveWallet();
  const { disconnect } = useDisconnect();
  // ADDED: guards the wallet-sync effect below against racing with
  // logout() (see there). Between wagmi's disconnect() and Privy's
  // own privyLogout() resolving, there's a real window where
  // isConnected is already false but Privy's `wallets` list hasn't
  // cleared yet — the sync effect, watching exactly that combination,
  // would otherwise call setActiveWallet again and silently undo the
  // disconnect mid-logout, which is what caused "Sign out" to hang
  // forever.
  const loggingOutRef = useRef(false);
  const { switchChain } = useSwitchChain();
  const [loginLoading, setLoginLoading] = useState(false);
  const [accounts, setAccounts] = useState(null);
  const [sessionClient, setSessionClient] = useState(null);
  const [sessionRestoring, setSessionRestoring] = useState(true);

  // ADDED: closes the "Privy succeeded but wagmi never noticed" gap.
  // Privy's own "Successfully connected" modal confirms auth + wallet
  // creation happened on ITS side — but wagmi's useAccount().isConnected
  // (which App.jsx's login screen and this whole context gate on) is a
  // SEPARATE piece of state that @privy-io/wagmi is supposed to sync
  // automatically, and in practice that sync can lag or silently miss
  // right after a brand-new embedded wallet is created (the wallet
  // doesn't exist in `wallets` yet at the exact moment Privy's modal
  // resolves — it appears a beat later). Instead of waiting on the
  // automatic sync, watch Privy's own `wallets` list directly and
  // explicitly call setActiveWallet as soon as a wallet shows up that
  // wagmi doesn't already know about — this is the pattern Privy's own
  // official wagmi demos use for embedded wallets specifically.
  // FIXED: this effect's guard only checked `isConnected` — but
  // isConnected doesn't flip true the instant setActiveWallet() is
  // called, it takes at least one more render cycle for wagmi to
  // actually register the new active connector. In that window, ANY
  // other change that touches this effect's dependencies (wallets
  // identity, setActiveWallet identity, or React just re-rendering
  // for an unrelated reason) re-ran the effect while isConnected was
  // STILL false — and with no in-flight guard, it called
  // setActiveWallet() a SECOND time for the exact same wallet before
  // the first call had even resolved. Two concurrent calls to
  // Privy's own connect() for the same wallet is exactly what
  // produced the "wallet_requestPermissions already pending" errors
  // (and the extra permission popup on every reload) — this was
  // never about some OTHER, independent connection path; it was this
  // effect racing against itself. syncInFlightRef closes that gap:
  // once a setActiveWallet() call is in progress, any re-fire of this
  // effect just skips instead of starting a second one.
  const syncInFlightRef = useRef(false);

  // FIXED (round 2 — confirmed via console trace): syncInFlightRef only
  // protects against OVERLAPPING calls, i.e. a second setActiveWallet()
  // starting before the first one has resolved. It does NOT protect
  // against SEQUENTIAL redundant calls — and that's what was actually
  // happening: setActiveWallet() would resolve OK, syncInFlightRef would
  // reset to false, but wagmi's own isConnected takes a few more renders
  // to actually flip true. In that window this effect re-fires (wallets
  // identity change, or React just re-rendering), sees isConnected still
  // false, and — since nothing was in flight anymore — happily starts a
  // BRAND NEW setActiveWallet() call for the exact same wallet it had
  // literally just finished connecting a moment earlier. Each of those
  // is a real wallet_requestPermissions round-trip to MetaMask; several
  // of them back-to-back is exactly what produced the repeated
  // "already pending" RPC errors (and the connect prompt reappearing)
  // on every page load. syncedAddressRef fixes this at the right level:
  // once a given address has been successfully handed to
  // setActiveWallet(), we don't ask again for THAT address, no matter
  // how many more times this effect re-fires before wagmi's isConnected
  // catches up. It only resets when the wallet list genuinely changes
  // (logout, or the user switches accounts in the extension).
  const syncedAddressRef = useRef(null);

  useEffect(() => {
    // DIAGNOSTIC LOGGING: unconditional, runs on every change of
    // wallets/isConnected so we can see in the console exactly what
    // Privy reports vs. what wagmi currently has, on every render of
    // this effect — regardless of whether we end up calling
    // setActiveWallet below.
    console.log("🔎 [wallet-sync] effect fired:", {
      walletsCount: wallets?.length ?? 0,
      wallets: wallets?.map((w) => ({
        address: w.address,
        walletClientType: w.walletClientType,
        connectorType: w.connectorType,
      })),
      isConnected,
    });
    if (!wallets?.length) {
      syncedAddressRef.current = null; // nothing linked anymore — allow a fresh sync next time a wallet appears
      return;
    }
    if (isConnected) return; // wagmi already has an active wallet — nothing to do
    if (loggingOutRef.current) return; // logout in progress — don't reconnect mid-flow
    if (syncInFlightRef.current) return; // a setActiveWallet() call is already in flight
    // Prefer the embedded wallet (walletClientType === "privy") if one
    // exists — that's the one users created via email/Google/passkey.
    // Fall back to whichever wallet Privy reports first (e.g. a linked
    // external wallet) if there's no embedded one.
    const target =
      wallets.find((w) => w.walletClientType === "privy") || wallets[0];
    if (!target) return;
    if (syncedAddressRef.current === target.address) return; // already asked MetaMask to reconnect THIS address — just waiting for wagmi's own state to catch up, not a reason to ask again
    console.log("🔎 [wallet-sync] calling setActiveWallet with:", {
      address: target.address,
      walletClientType: target.walletClientType,
    });
    syncInFlightRef.current = true;
    setActiveWallet(target)
      .then(() => {
        syncedAddressRef.current = target.address;
        console.log("✅ [wallet-sync] setActiveWallet resolved OK");
      })
      .catch((err) => {
        console.warn("⚠️ [wallet-sync] setActiveWallet failed:", err);
      })
      .finally(() => {
        syncInFlightRef.current = false;
      });
  }, [wallets, isConnected, setActiveWallet]);

  // ADDED: a root-level ban gate (moderationActions.js). Previously the
  // "is banned" check was duplicated in every component separately
  // (CreatePostModal, CountryFeed) - a piecemeal approach that could
  // always be forgotten somewhere (a comment, a like, a repost, a tip -
  // any action in any component where the check simply wasn't written).
  // Now there's a single check, here, at the very top of the component
  // tree - and if banned, the entire app below is replaced with a block
  // screen (see the return below), so it's physically impossible to
  // reach any button in any component.
  //
  // null = not checked yet (as soon as address appears - we'll check);
  // {banned: false, ...} / {banned: true, ...} - the check's result.
  const [banInfo, setBanInfo] = useState(null);

  useEffect(() => {
    if (!address) {
      // Wallet not connected - there's no one to check, and nothing to
      // block (anonymous browsing without a wallet doesn't write anything anyway).
      setBanInfo(null);
      return;
    }

    let cancelled = false;
    setBanInfo(null); // new address - reset until we've re-checked this specific one

    (async () => {
      try {
        const [actions, totalEligibleVoters] = await Promise.all([
          fetchAllModActions(),
          fetchShieldTotalSupply(),
        ]);
        if (cancelled) return;
        setBanInfo(computeBanState(actions, address, totalEligibleVoters));
      } catch (err) {
        if (!cancelled) {
          console.warn("⚠️ Failed to check ban status:", err.message);
          // Fail-safe: a network error shouldn't block a legitimate
          // user - we treat it as "not banned", rather than as undetermined.
          setBanInfo({ banned: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [address]);

  const isBanned = banInfo?.banned === true;
  // While address is known but the check hasn't finished yet - show
  // neither the app nor the block screen (to avoid content "flashing"
  // before it becomes clear that the account is banned).
  const banCheckPending = !!address && banInfo === null;

  // walletClient from useWalletClient() is regular React state: the
  // value an async function sees is "frozen" in the closure at the moment
  // it's called. If walletClient was null at the time of the click, and
  // ensureCorrectNetwork() later changes the network (causing wagmi to
  // update its state somewhat later) — the function itself will no
  // longer see that, since await doesn't "refresh" a closure. This is
  // exactly why it used to always fail with "Wallet not connected" even
  // when the wallet was actually connected. walletClientRef always holds
  // the CURRENT value, since it's updated in the synchronous effect below.
  const walletClientRef = useRef(walletClient);
  useEffect(() => {
    walletClientRef.current = walletClient;
  }, [walletClient]);

  // Waits up to timeoutMs for walletClientRef.current to become
  // available AND on the expected chain. Needed after
  // ensureCorrectNetwork(), since a network change in MetaMask causes
  // walletClient to reconnect with some delay (usually a fraction of a
  // second for localStorage/RPC sync).
  //
  // FIXED: this used to stop waiting as soon as the ref was non-null,
  // regardless of which chain it was on. If a switchChain() request was
  // still in flight, this returned the STALE, still-wrong-chain client
  // immediately — the exact case getWalletClient() now needs this to
  // actually wait through (see its own comment above). expectedChainId
  // is optional so this still works for any other caller that only
  // cares about "connected at all".
  const waitForWalletClient = async (timeoutMs = 5000, expectedChainId = null) => {
    const stepMs = 150;
    let waited = 0;
    const isReady = () =>
      walletClientRef.current &&
      (!expectedChainId || walletClientRef.current.chain?.id === expectedChainId);
    while (!isReady() && waited < timeoutMs) {
      await new Promise((res) => setTimeout(res, stepMs));
      waited += stepMs;
    }
    return walletClientRef.current;
  };

  // === Restoring the session from localStorage on app startup ===
  // By default, PublicClient keeps the session only in memory — it's
  // lost on F5/a fresh visit. resumeSession() picks up the tokens the
  // SDK already saved in window.localStorage during login.
  useEffect(() => {
    let cancelled = false;

    const restoreSession = async () => {
      try {
        const resumed = await lensClient.resumeSession();
        if (cancelled) return;

        if (resumed.isErr()) {
          console.warn("⚠️ Lens session resume failed:", resumed.error.message);
          return;
        }

        setSessionClient(resumed.value);
        console.log("✅ Lens session restored from storage");
      } catch (err) {
        if (!cancelled) {
          console.warn("⚠️ Lens session resume error:", err.message);
        }
      } finally {
        if (!cancelled) setSessionRestoring(false);
      }
    };

    restoreSession();
    return () => {
      cancelled = true;
    };
  }, []);

  // REPLACED (MetaMask → embedded wallet): the old implementation had
  // to branch on isMobileDevice()/hasInjectedProvider() because
  // MetaMask's own connection method differs between desktop (browser
  // extension, window.ethereum) and mobile (separate app, needs
  // WalletConnect). Privy's login() works identically on every
  // device/platform — the modal itself picks email/social/passkey vs.
  // "connect an existing wallet" — so none of that branching is
  // needed here anymore. The old connectAsync()/injected() plumbing
  // moved entirely into Privy internals.
  const connectWallet = async () => {
    if (!privyReady) return;
    try {
      await login();
    } catch (err) {
      // Privy rejects/throws if the user closes the modal without
      // completing login — that's a normal cancellation, not a real
      // error, so we only surface it to the console.
      console.warn("⚠️ Wallet login cancelled or failed:", err);
    }
  };

  // Returns the current list of accounts (rather than just writing it to
  // state). This matters for the "one wallet — one account" check below
  // in loginAsOnboardingUser: there we can NOT rely on the accounts
  // state, since it might not have been fetched yet (e.g. if onboarding
  // is called right after connectWallet, before the App.jsx effect has
  // managed to load accounts), or the state may still be stale/null.
  const fetchAccounts = async (targetAddress = address) => {
    if (!targetAddress) return [];

    // FIXED: when switching wallets (MetaMask "Switch account"), address
    // changes, but the old accounts in state (e.g. 2 accounts from the
    // previous wallet) stayed in memory until this promise resolved.
    // App.jsx, meanwhile, was already rendering with the fresh address,
    // but WITH THE OLD accounts — meaning it showed the previous wallet's
    // list of 2 accounts for a second, until the Lens API response with
    // the new wallet's correct (1) account arrived. We reset accounts to
    // null immediately, synchronously, BEFORE the await — then App.jsx,
    // while waiting, sees null and shows the "Loading accounts..."
    // spinner, rather than a stale list. The same pattern is deliberately
    // already applied below in loginAsOnboardingUser for the same reason.
    setAccounts(null);

    const { fetchAccountsAvailable } =
      await import("@lens-protocol/client/actions");
    const result = await fetchAccountsAvailable(lensClient, {
      managedBy: targetAddress,
      includeOwned: true,
    });
    if (result.isOk()) {
      setAccounts(result.value.items);
      return result.value.items;
    }
    return [];
  };

  const ensureCorrectNetwork = async () => {
    try {
      await switchChain({ chainId: 37111 });
      await new Promise((res) => setTimeout(res, 1000));
    } catch (e) {
      // Chain unknown — add it manually
      if (e.code === 4902 || e?.cause?.code === 4902) {
        try {
          // FIXED: this used to call window.ethereum.request(...)
          // directly — a browser-extension-only API. On mobile, when
          // connected via WalletConnect (no window.ethereum at all),
          // this fallback silently failed (caught below, logged, and
          // the network never actually got added/switched). Getting
          // the provider from the active wagmi connector works for
          // Privy's embedded wallet and any wallet linked through it
          // (extension or WalletConnect) alike.
          // REMOVED the `: window.ethereum` fallback — same reasoning
          // as useLensDAO.js/useTipJar.js: it was an independent,
          // non-Privy connection path that could fire on its own
          // whenever `connector` wasn't populated yet, instead of
          // simply surfacing "wallet not connected" and letting Privy
          // be the one and only source of the connection.
          if (!connector) throw new Error("Wallet not connected");
          const provider = await connector.getProvider();
          if (!provider) throw new Error("Wallet not connected");
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: "0x90F7", // 37111 in hex
                chainName: "Lens Network Sepolia Testnet",
                nativeCurrency: {
                  name: "GRASS",
                  symbol: "GRASS",
                  decimals: 18,
                },
                rpcUrls: ["https://rpc.testnet.lens.dev"],
                blockExplorerUrls: ["https://block-explorer.testnet.lens.dev"],
              },
            ],
          });
          // After adding — switch
          await new Promise((res) => setTimeout(res, 1000));
          await switchChain({ chainId: 37111 });
          await new Promise((res) => setTimeout(res, 1000));
        } catch (addError) {
          console.log("Add chain error:", addError);
        }
      }
    }
  };

  // The single source of truth for "give me the current walletClient" —
  // the same retry pattern (ensureCorrectNetwork + waitForWalletClient)
  // already used by loginWithAccount/loginAsOnboardingUser below.
  // Extracted out and exposed via value, so other components (e.g.
  // ProfileEditModal) don't spawn their own "raw" useWalletClient() —
  // that's exactly what ran into the same frozen-null-in-closure problem.
  //
  // FIXED: this used to only call ensureCorrectNetwork() when `client`
  // was falsy — i.e. only on a fully fresh connection. If the wallet
  // was ALREADY connected but sitting on a different chain (e.g. the
  // user had just been on the Moderation page, which switches the
  // wallet to Arbitrum Sepolia for a DAO write), this returned that
  // client as-is, still bound to the wrong chain. getViemWalletClient()
  // in useLensPosts.js does its own chain check and tries to recover,
  // but by then a second, uncoordinated switchChain call could race
  // against MetaMask's own single-pending-request limit and fail
  // outright ("Wallet not connected" even though a wallet plainly was
  // connected — it was just on the wrong network at the worst possible
  // moment). Checking the chain id here, before ANY Lens write, closes
  // that gap regardless of which page the user was on right before.
  const getWalletClient = async () => {
    let client = walletClientRef.current;
    if (!client || client.chain?.id !== 37111) {
      await ensureCorrectNetwork();
      client = await waitForWalletClient(5000, 37111);
    }
    return client;
  };

  const loginWithAccount = async (accountItem) => {
    console.log("accountItem structure:", JSON.stringify(accountItem, null, 2));
    const client = await getWalletClient();
    if (!client) return { success: false, error: "Wallet not connected" };

    setLoginLoading(true);
    try {
      const result = await lensClient.login({
        accountOwner: {
          account: accountItem.account?.address || accountItem.address,
          app: import.meta.env.VITE_LENS_APP_ADDRESS,
          owner: address,
        },
        signMessage: signMessageWith(client),
      });

      if (result.isErr())
        return { success: false, error: result.error.message };
      setSessionClient(result.value);
      localStorage.setItem(
        "lens_account_address",
        accountItem.account?.address || accountItem.address,
      );
      localStorage.setItem("lens_wallet_address", address);
      return { success: true, session: result.value };
    } finally {
      setLoginLoading(false);
    }
  };

  const loginAsOnboardingUser = async () => {
    console.log(
      "🔑 loginAsOnboardingUser called, walletClientRef:",
      !!walletClientRef.current,
    );
    // === "One wallet — one Lens account" safeguard ===
    // We check the FRESH list of accounts for this wallet directly from
    // the Lens API, not the accounts state — because this can be reached
    // even when accounts hasn't loaded yet (null) or is stale. If the
    // wallet already has at least one account — we don't let it proceed,
    // even if this is called directly (bypassing the button in App.jsx,
    // which is also hidden in this case).
    const existingAccounts = await fetchAccounts();
    if (existingAccounts.length > 0) {
      return {
        success: false,
        error: "This wallet already has a Lens account. One wallet — one account.",
      };
    }

    const client = await getWalletClient();
    if (!client) return { success: false, error: "Wallet not connected" };

    setLoginLoading(true);
    try {
      const result = await lensClient.login({
        onboardingUser: {
          app: import.meta.env.VITE_LENS_APP_ADDRESS,
          wallet: address,
        },
        signMessage: signMessageWith(client),
      });

      console.log(
        "🔑 lensClient.login result isErr:",
        result.isErr(),
        result.isErr() ? result.error.message : "OK",
      );
      if (result.isErr())
        return { success: false, error: result.error.message };
      // An onboarding session by definition doesn't have an account yet.
      // If the old accounts were left here (e.g. [art3] from a previous
      // login), App.jsx would see accounts.length > 0 and redirect to
      // /country instead of /onboarding — that's exactly how the "Create
      // new account leads to an existing one" bug appeared. We reset it
      // explicitly, and let /onboarding call fetchAccounts() itself once
      // the account has actually been created.
      setAccounts(null);
      setSessionClient(result.value);
      localStorage.setItem("lens_wallet_address", address);
      return { success: true, session: result.value };
    } finally {
      setLoginLoading(false);
    }
  };

  const logout = async () => {
    // Set BEFORE anything else — must already be true by the time
    // disconnect() below flips isConnected to false, otherwise the
    // sync effect can still slip in a reconnect before this line runs
    // (effects fire on the next render after state changes, but
    // disconnect()'s own internal state updates are not something we
    // control the exact timing of).
    loggingOutRef.current = true;
    // Same "set before anything else" reasoning as loggingOutRef
    // above, for the same kind of race — see useLensDAO.js's
    // markIntentionalDisconnect for the full story: wagmi's
    // disconnect() / Privy's privyLogout() below can make the wallet
    // provider fire its own "accountsChanged" event, which — without
    // this flag — every globally-mounted useLensDAO() instance
    // (Navbar, etc.) would treat as a reason to hard-reload the page
    // mid-logout.
    markIntentionalDisconnect(true);
    try {
      if (sessionClient) await sessionClient.logout();
      setSessionClient(null);
      setAccounts(null);

      // ADDED: previously logout() disconnected ONLY the Lens session —
      // the actual wallet (MetaMask/injected) connection to the site stayed
      // active via wagmi, and the user had to separately click
      // "Disconnect" in MetaMask after "Log out"/"Deactivate".
      // wagmi.disconnect() clears the connector's own connection state
      // (separate from the Lens-session localStorage, which
      // sessionClient.logout() above clears) — now one button does both.
      // Trade-off: the next login will show the "Connect" popup in
      // MetaMask again, since the connection has genuinely been reset —
      // this is normal/expected behavior for most dApps.
      try {
        disconnect();
      } catch (err) {
        console.warn("⚠️ Wallet disconnect error during logout:", err.message);
      }

      // ADDED (embedded wallet): Privy tracks its own authenticated-user
      // state independently of wagmi's connector state — wagmi.disconnect()
      // above only clears wagmi's side. Without this, Privy would still
      // consider the user logged in and skip straight back to the embedded
      // wallet on the next visit instead of showing the login modal.
      try {
        await privyLogout();
      } catch (err) {
        console.warn("⚠️ Privy logout error:", err.message);
      }
    } finally {
      // Only release the guard once Privy itself has actually finished
      // logging out (wallets should be empty by now) — releasing it
      // earlier would reopen the exact race this guard exists to close.
      loggingOutRef.current = false;
      // Small grace delay before letting useLensDAO() react to
      // "accountsChanged" again: the wallet provider can fire that
      // event a beat AFTER privyLogout() above has already resolved
      // (the actual teardown happens asynchronously on the provider's
      // own side), so clearing the flag in the same tick as
      // loggingOutRef would reopen the exact race this exists to
      // close — same failure this whole fix is for, just moved a
      // few hundred ms later.
      setTimeout(() => markIntentionalDisconnect(false), 1500);
    }
  };

  // ── Anonymizing the account's public metadata (deactivation step 1) ──────
  // Called from SettingsPage.handleDeleteAccount BEFORE logout — so we
  // rely specifically on the sessionClient from this context, not on
  // some externally passed accountId: only the account the user is
  // currently actually authenticated as (signed with the wallet at
  // login) can be anonymized this way, so substituting someone else's
  // account through this path is impossible.
  //
  // The pattern is deliberately identical to
  // ProfileEditModal.updateLensMetadata (the same build → upload to
  // Grove → setAccountMetadata → sign with wallet → waitForTransaction)
  // — this is the only proven way in the app to write AccountMetadata to
  // Lens, so there's no point duplicating it differently here.
  //
  // We deliberately don't try to selectively preserve any attributes
  // (isAdult, hasAcceptedTerms, country, h3Index) — during anonymization
  // the entire AccountMetadata is simply overwritten with a minimal
  // empty object. If the account logs in again later (the blockchain
  // account itself doesn't go anywhere), the app already knows how to
  // tolerate the absence of these fields (see fallbacks like
  // `updates.country || "EARTH"` in ProfileEditModal) — it will just
  // start again from a clean profile.
  //
  // Never throws — returns { success, error }, so the caller in
  // SettingsPage can log the failure and still proceed to step 2
  // (logout) regardless of the anonymization result.
  const anonymizeAccountMetadata = async () => {
    if (!sessionClient) {
      return { success: false, error: "No active Lens session" };
    }

    try {
      const [
        { setAccountMetadata },
        { account: buildAccountMetadata },
        { storageClient },
      ] = await Promise.all([
        import("@lens-protocol/client/actions"),
        import("@lens-protocol/metadata"),
        import("../lib/grove"),
      ]);

      const client = await getWalletClient();
      if (!client) {
        return { success: false, error: "Wallet not connected" };
      }

      // Minimal non-identifying name/bio, no picture, no attributes
      // (country/h3Index also identify the user — we remove them along
      // with everything else). IMPORTANT: a plain space " " can't be
      // left here — the Zod schema in @lens-protocol/metadata does
      // .trim().min(1), so a string of pure whitespace becomes empty
      // after trim() and validation fails with "String must contain at
      // least 1 character(s)".
      const metadata = buildAccountMetadata({
        name: "Deleted",
        bio: "-",
      });

      const { uri } = await storageClient.uploadAsJson(metadata);

      const result = await setAccountMetadata(sessionClient, {
        metadataUri: uri,
      }).andThen(handleOperationWith(client));

      if (result.isErr()) {
        return { success: false, error: result.error.message };
      }

      if (result.value && typeof result.value === "string") {
        await sessionClient.waitForTransaction(result.value);
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const setExternalSessionClient = (client) => {
    setSessionClient(client);
  };

  const value = {
    address,
    isConnected,
    // ADDED: exposed so useNostrIdentity.jsx can tell whether the
    // active wallet is Privy's embedded one (connector.id ===
    // "io.privy.wallet") vs. an externally-linked wallet, to decide
    // whether it can use Privy's own signMessage (with
    // showWalletUIs:false) or must fall back to the normal
    // wagmi-walletClient signing path.
    connector,
    accounts,
    sessionClient,
    sessionRestoring,
    loginLoading,
    connectWallet,
    // Whether Privy has finished its own startup check (reading any
    // existing session). App.jsx uses this to avoid flashing the
    // login button before Privy knows if the user is already
    // authenticated.
    walletReady: privyReady,
    fetchAccounts,
    loginWithAccount,
    loginAsOnboardingUser,
    logout,
    anonymizeAccountMetadata,
    setExternalSessionClient,
    getWalletClient,
    // ADDED: ban status - mostly won't be needed directly (the gate
    // below blocks the entire UI on its own), but keeping it in the
    // context in case somewhere it's needed to show details (how many
    // votes, the voting deadline).
    isBanned,
    banInfo,
  };

  return (
    <LensAuthContext.Provider value={value}>
      {isBanned ? (
        <BannedScreen banInfo={banInfo} onLogout={logout} />
      ) : banCheckPending ? (
        <BanCheckLoadingScreen />
      ) : (
        children
      )}
    </LensAuthContext.Provider>
  );
}

// ADDED: a full block screen for a banned account - rendered INSTEAD OF
// the entire app (children isn't mounted at all), so no button
// (like/comment/repost/tip/post) is physically reachable. Deliberately
// simple, with no dependency on the app's Layout/routing - it should
// work even if something else in the component tree is broken.
function BannedScreen({ banInfo, onLogout }) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#000d1f] px-6">
      <div className="max-w-md w-full text-center space-y-4">
        <div className="text-5xl">🚫</div>
        <h1 className="text-[20px] font-medium text-white/85">
          Account blocked
        </h1>
        <p className="text-[15px] text-white/45 leading-relaxed">
          Shield/Council holders have voted to block your account in
          this app due to systematic violations
          {banInfo?.voters?.length
            ? ` (${banInfo.voters.length} vote${banInfo.voters.length > 1 ? "s" : ""})`
            : ""}
          . Use of the app is unavailable.
        </p>
        <p className="text-[13px] text-white/25">
          This block applies only within this app - your Lens Account
          and wallet remain your own property.
        </p>
        <button
          onClick={onLogout}
          className="mt-2 px-4 py-2 text-[14px] rounded-lg border border-white/[0.1]
            text-white/50 hover:text-white/70 hover:border-white/[0.16] transition-colors"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

// ADDED: a brief interim screen while the ban-status check is running
// (right after address appears - until the first result). Deliberately
// displayed INSTEAD OF the app, rather than on top of it - to avoid
// regular content flashing for a fraction of a second before it becomes
// clear that the account is banned.
function BanCheckLoadingScreen() {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#000d1f]">
      <div className="w-6 h-6 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
    </div>
  );
}

export function useLensAuth() {
  const ctx = useContext(LensAuthContext);
  if (!ctx) {
    throw new Error("useLensAuth must be used within a LensAuthProvider");
  }
  return ctx;
}
