// App.jsx
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useDisconnect } from "wagmi";
import { useLensAuth } from "./context/LensAuthContext";
import { useWalletHandoff } from "./hooks/useWalletHandoff";

function App() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { disconnect } = useDisconnect();

  const {
    address,
    isConnected,
    accounts,
    sessionClient,
    sessionRestoring,
    loginLoading,
    connectWallet,
    walletReady,
    fetchAccounts,
    loginWithAccount,
    loginAsOnboardingUser,
    logout,
    justLoggedOutRef,
  } = useLensAuth();

  // Автопідключення гаманця, якщо перехід стався за посиланням
  // DAO Chronicle I/II з параметром ?wallet=0x...
  useWalletHandoff(isConnected, connectWallet, address);

  useEffect(() => {
    // FIXED (infinite loading spinner on Settings → Log out, requiring
    // a manual page reload to recover): see the long comment on
    // justLoggedOutRef in LensAuthContext.jsx for the full story.
    // Short version — right after logout(), `isConnected` can still
    // read stale/true for a moment while wagmi/Privy finish tearing
    // the wallet down asynchronously, and used to make this effect
    // fetch accounts for that already-logged-out wallet, which then
    // fed the auto-login effect below and hung forever trying to sign
    // with a wallet that no longer existed.
    if (isConnected && address && !sessionClient && !justLoggedOutRef.current) {
      fetchAccounts();
    }
  }, [isConnected, address, sessionClient, justLoggedOutRef]);

  const handleLogin = async (accountItem) => {
    const result = await loginWithAccount(accountItem);
    if (result.success) {
      navigate("/country");
    } else {
      alert(`Login error: ${result.error}`);
    }
  };

  // Flag: "has auto-login already been attempted for this address".
  // Without it, the effect below could reopen the MetaMask signature
  // popup on every re-render after the user has rejected the signature
  // once — intrusive and annoying. Reset by a separate effect whenever
  // address changes (a new wallet address = a new auto-login attempt).
  const autoLoginAttempted = useRef(false);

  useEffect(() => {
    autoLoginAttempted.current = false;
  }, [address]);

  // Auto-login when the connected wallet has EXACTLY one Lens account.
  // Consistent with the "one wallet — one account" rule (see
  // LensAuthContext.loginAsOnboardingUser) — there's nothing to choose
  // from, so there's no point making the user click the "Log in as
  // account X" button between the MetaMask "Connect" popup and the
  // message-signing popup: as soon as accounts is loaded (length 1),
  // we call handleLogin ourselves.
  //
  // If there are multiple accounts (accounts.length > 1), auto-login
  // does NOT trigger, because the choice should remain a real choice
  // made by the user.
  //
  // If the user rejected the signature in MetaMask, autoLoginAttempted
  // is already true, so the popup won't reopen automatically; the page
  // falls back to the usual Step 2 render below with an account button
  // that lets them retry the login manually.
  useEffect(() => {
    // See the matching comment on the fetchAccounts effect above and
    // on justLoggedOutRef in LensAuthContext.jsx — this is the second
    // half of the same guard: even if `accounts` somehow got
    // populated (e.g. from a still-in-flight fetch started just
    // before logout()), don't let this effect try to sign a fresh
    // login with a wallet that's mid-teardown.
    if (
      isConnected &&
      address &&
      !sessionClient &&
      accounts &&
      accounts.length === 1 &&
      !loginLoading &&
      !autoLoginAttempted.current &&
      !justLoggedOutRef.current
    ) {
      autoLoginAttempted.current = true;
      handleLogin(accounts[0]);
    }
  }, [
    isConnected,
    address,
    sessionClient,
    accounts,
    loginLoading,
    justLoggedOutRef,
  ]);

  const handleOnboarding = async () => {
    const result = await loginAsOnboardingUser();
    if (result.success) {
      navigate("/create-lens-account");
    } else {
      alert(`Error: ${result.error}`);
    }
  };

  useEffect(() => {
    if (!sessionClient) return;
    if (accounts === null) {
      navigate("/create-lens-account");
    } else if (accounts.length > 0) {
      navigate("/country");
    } else {
      navigate("/create-lens-account");
    }
  }, [sessionClient, accounts]);

  const handleDisconnectWallet = async () => {
    try {
      await logout();
    } catch (err) {
      console.error("Lens logout error on disconnect", err);
    }
    disconnect();
  };

  // Spinner placeholder — used in three states
  const Spinner = () => (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#000d1f]">
      <div className="text-center">
        <div className="inline-block w-12 h-12 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
        <p className="mt-4 text-[14px] text-slate-600 dark:text-white/40">
          {t("loading")}
        </p>
      </div>
    </div>
  );

  if (sessionRestoring) return <Spinner />;
  if (loginLoading) return <Spinner />;
  if (sessionClient) return <Spinner />;

  // === Login screen ===
  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
      <div className="w-full max-w-lg px-4">
        {/* Logo */}
        <div className="flex justify-center mb-6">
          <picture>
            <source srcSet="/logo.webp" type="image/webp" />
            <img
              src="/logo.png"
              alt="Logo"
              width="669"
              height="800"
              fetchPriority="high"
              className="h-48 w-auto object-contain"
            />
          </picture>
        </div>

        {/* Title */}


        <div className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-6 space-y-4">
          {/* Step 1 — wallet not connected */}
          {/* REPLACED (MetaMask → embedded wallet): the button now
              opens the Privy login modal (email / Google / passkey,
              or "connect an existing wallet" for people who prefer
              that) instead of assuming MetaMask specifically. Disabled
              while Privy is still doing its own startup check
              (walletReady), so we don't open a modal that isn't
              actually ready yet. */}
          {!isConnected && (
            <div className="space-y-3">
              <button
                onClick={connectWallet}
                disabled={!walletReady}
                className="w-full py-2.5 px-4 rounded-lg font-medium text-[16px] transition-all duration-300 flex items-center justify-center gap-2 text-white bg-[#2B000A] border border-[#b41e3c]/30 hover:bg-[#3d0012] hover:border-[#b41e3c]/50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {walletReady ? "Log in" : "Loading..."}
              </button>

              <div className="text-center text-[11px] text-slate-600 dark:text-white/40">
                Sign in with email, Google, or passkey — no browser
                extension required. Prefer your own wallet? You can
                connect one from the same login screen.
              </div>
            </div>
          )}

          {/* Step 2 — wallet connected, Lens accounts available */}
          {isConnected && accounts && accounts.length > 0 && (
            <div className="space-y-3">
              <p className="text-center text-[11px] font-medium text-slate-700 dark:text-white/40">
                Choose a Lens account to log in:
              </p>
              {accounts.map((item) => (
                <button
                  key={item.address || item.account?.address || Math.random()}
                  onClick={() => handleLogin(item)}
                  className="w-full py-2.5 px-4 rounded-lg font-medium text-[16px] text-white bg-[#2B000A] border border-[#b41e3c]/30 hover:bg-[#3d0012] hover:border-[#b41e3c]/50 transition-all duration-300 flex items-center justify-center"
                >
                  <span>
                    {item.username?.value
                      ? `@${item.username.value}`
                      : item.address
                        ? `${item.address.slice(0, 6)}...${item.address.slice(-4)}`
                        : item.account?.address
                          ? `${item.account.address.slice(0, 6)}...${item.account.address.slice(-4)}`
                          : "Unknown account"}
                  </span>
                </button>
              ))}
              <button
                onClick={handleDisconnectWallet}
                className="w-full py-2 px-4 text-center text-[11px] text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/60 transition"
              >
                Disconnect wallet
              </button>
            </div>
          )}

          {/* Step 2 — wallet connected, no Lens accounts */}
          {isConnected && accounts && accounts.length === 0 && (
            <div className="space-y-3">
              <div className="p-3 bg-blue-900/15 border border-blue-700/20 rounded-xl text-center">
                <p className="text-[11px] text-blue-400/65 font-medium">
                  Wallet connected
                </p>
                <p className="text-[11px] text-blue-400/40 mt-1 font-mono">
                  {address?.slice(0, 6)}...{address?.slice(-4)}
                </p>
              </div>
              <p className="text-center text-[11px] text-slate-600 dark:text-white/40">
                You don't have a Lens account yet
              </p>
              <button
                onClick={handleOnboarding}
                className="w-full py-2.5 px-4 rounded-lg font-medium text-[16px] text-white bg-[#2B000A] border border-[#b41e3c]/30 hover:bg-[#3d0012] hover:border-[#b41e3c]/50 transition-all duration-300"
              >
                Create account
              </button>
              <button
                onClick={handleDisconnectWallet}
                className="w-full py-2 px-4 text-center text-[11px] text-slate-600 dark:text-white/40 hover:text-slate-900 dark:hover:text-white/60 transition"
              >
                Disconnect wallet
              </button>
            </div>
          )}

          {/* Step 2 — wallet connected, accounts loading */}
          {isConnected && !accounts && (
            <div className="flex items-center justify-center py-3">
              <div className="w-5 h-5 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
              <span className="ml-3 text-[11px] text-slate-600 dark:text-white/40">
                Loading accounts...
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
