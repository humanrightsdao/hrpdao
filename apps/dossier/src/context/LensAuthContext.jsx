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
// Getting that wallet registered as wagmi's active connection is now
// handled entirely by @privy-io/wagmi's own internal sync, driven by
// the `setActiveWalletForWagmi` prop passed to its WagmiProvider in
// main.jsx — see the comment on LensAuthProvider below for the full
// history of why a manual sync effect used to live here and why it
// was removed.
import { usePrivy, useWallets } from "@privy-io/react-auth";
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
  //
  // FIXED (root cause of both the Google-login "Wallet not connected"
  // bug AND the later "No wagmi connector found for wallet ..."
  // regression): this used to maintain its OWN "wallet-sync" useEffect
  // here, manually watching Privy's useWallets() and calling
  // @privy-io/wagmi's useSetActiveWallet() (and later, our own
  // connectAsync()/switchAccountAsync() replacement) to hook the
  // active wallet into wagmi.
  //
  // That was fighting @privy-io/wagmi's OWN internal sync
  // (useSyncPrivyWallets, which runs unconditionally inside its
  // WagmiProvider, below in main.jsx) for the exact same job — TWO
  // separate effects, in two different components, both reacting to
  // the same `wallets` change, each with its own async work
  // (`wallet.getEthereumProvider()`, connector setup) with no
  // ordering guarantee between them. "No wagmi connector found for
  // wallet ... (io.privy.wallet.0x...)" was this effect's connector
  // lookup running BEFORE @privy-io/wagmi's own internal
  // setupConnectors() had finished registering that connector — a
  // pure race, not a real missing connector.
  //
  // @privy-io/wagmi ships an official mechanism for exactly this —
  // picking which Privy wallet should become wagmi's active
  // connection — via the `setActiveWalletForWagmi` prop on its
  // WagmiProvider (see main.jsx). Passing it makes the library's own
  // internal effect do BOTH the connector setup AND the activation
  // (setting connections/current/status directly), in one place, with
  // no second effect to race against. useAccount() above simply
  // reflects that once it's done — nothing else to write here.
  const { login, logout: privyLogout, ready: privyReady } = usePrivy();
  const { wallets } = useWallets();
  const { disconnect } = useDisconnect();
  // Still needed by logout() further down, to stop the wallet from
  // being treated as "should reconnect" mid sign-out.
  const loggingOutRef = useRef(false);
  // FIXED (Settings logout stuck on the loading spinner until a manual
  // F5): disconnect()/privyLogout() inside logout() below tear the
  // embedded wallet down ASYNCHRONOUSLY and can themselves fail (see
  // the long comment inside logout() for the rpc.lens.xyz 403 case) —
  // so wagmi's `isConnected` does not necessarily flip to false by the
  // time SettingsPage's navigate("/") has already mounted App.jsx.
  // App.jsx's own effects (`fetchAccounts()` when `isConnected &&
  // !sessionClient`, then auto-login when exactly one account comes
  // back) see the stale isConnected=true and immediately try to log
  // the user straight back in with the very wallet logout() just tore
  // down. loginWithAccount()'s signMessage() call then fails deep
  // inside the SDK with "No embedded or connected wallet found for
  // address" as a rejection nothing awaits/catches — so
  // `await lensClient.login(...)` in loginWithAccount never settles,
  // its `finally { setLoginLoading(false) }` never runs, and
  // App.jsx's `if (loginLoading) return <Spinner />` spins forever.
  // justLoggedOutRef is the same "suppress reactive re-triggers for a
  // short grace window after an intentional logout" idiom already used
  // for markIntentionalDisconnect below — App.jsx's effects check
  // `.current` before calling fetchAccounts()/auto-login, so the stale
  // isConnected blip during teardown can no longer start a doomed
  // re-login.
  const justLoggedOutRef = useRef(false);
  const { switchChain } = useSwitchChain();
  const [loginLoading, setLoginLoading] = useState(false);
  const [accounts, setAccounts] = useState(null);
  const [sessionClient, setSessionClient] = useState(null);
  const [sessionRestoring, setSessionRestoring] = useState(true);

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

        // FIXED: a restored session used to leave `accounts` at its
        // initial value (null) — the exact same value
        // loginAsOnboardingUser() deliberately sets to mean "this
        // session has no account yet, go create one" (see its comment
        // above). App.jsx's routing effect can't tell these two "null"
        // cases apart, so every returning user with a real account was
        // sent to /create-lens-account on a fresh page load — that page
        // then ran its OWN "one wallet — one account" check, found the
        // existing account, and showed the "Перейти до акаунту" screen
        // instead of the create-account form. One extra click, on every
        // single visit, for every user who already has an account.
        // getAuthenticatedUser() reads this straight off the session's
        // own JWT — no network round trip — so it's safe to call right
        // here: if it resolves to an account address, this is a real
        // accountOwner session and App.jsx can route straight to
        // /country. `accounts` is only left as [] (genuinely "no
        // account yet") for a resumed onboardingUser session, which is
        // the one case that legitimately belongs on /create-lens-account.
        const authedUser = resumed.value.getAuthenticatedUser();
        if (authedUser.isOk() && authedUser.value?.address) {
          setAccounts([{ address: authedUser.value.address }]);
        } else {
          setAccounts([]);
        }

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
      // MIGRATED to Lens Mainnet (chainId 232).
      await switchChain({ chainId: 232 });
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
                // MIGRATED to Lens Mainnet.
                chainId: "0xE8", // 232 in hex
                chainName: "Lens Network Mainnet",
                nativeCurrency: {
                  name: "Grass",
                  symbol: "GHO",
                  decimals: 18,
                },
                rpcUrls: ["https://rpc.lens.xyz"],
                blockExplorerUrls: ["https://explorer.lens.xyz"],
              },
            ],
          });
          // After adding — switch
          await new Promise((res) => setTimeout(res, 1000));
          await switchChain({ chainId: 232 });
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
    if (!client || client.chain?.id !== 232) {
      await ensureCorrectNetwork();
      client = await waitForWalletClient(5000, 232);
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
    // See the comment on justLoggedOutRef's declaration above: this
    // blocks App.jsx's fetchAccounts()/auto-login effects from racing
    // back in with the wallet mid-teardown.
    justLoggedOutRef.current = true;
    try {
      // FIXED (infinite spinner after clicking "Log out" in Settings):
      // sessionClient.logout() revokes the session on Lens's own
      // backend (an actual network call to rpc.lens.xyz) — and it can
      // fail (403, timeout, offline), exactly like any other network
      // call. It used to be the ONLY step in this function without its
      // own try/catch, so a failed revocation threw straight out of
      // this whole try block and skipped setSessionClient(null) /
      // setAccounts(null) below it entirely. SettingsPage.handleLogout
      // still caught the rethrown error and navigated to "/" as if
      // logout had succeeded — but App.jsx's root route does
      // `if (sessionClient) return <Spinner />`, and with
      // sessionClient stuck at its old (truthy) value forever, that
      // spinner never went away. Local state must always be cleared
      // regardless of whether the remote revocation call itself
      // succeeded — same reasoning as disconnect()/privyLogout() just
      // below, which were already isolated this way.
      try {
        if (sessionClient) await sessionClient.logout();
      } catch (err) {
        console.warn(
          "⚠️ Lens sessionClient.logout() error (continuing local logout anyway):",
          err.message,
        );
      }
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
      // Same grace window as markIntentionalDisconnect above, same
      // reason: isConnected can still report stale/true for a beat
      // after privyLogout() has resolved, since the actual wallet
      // teardown finishes asynchronously on the provider's own side.
      setTimeout(() => {
        justLoggedOutRef.current = false;
      }, 1500);
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
    // See the comment on its declaration above: App.jsx's
    // fetchAccounts()/auto-login effects check `.current` to avoid
    // racing a fresh login attempt back in with a wallet that
    // logout() just started tearing down.
    justLoggedOutRef,
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
