// src/pages/TipTestPage.jsx
//
// ⚠️ TESTNET ONLY — temporary page, not for production.
//
// Tests full cycle: TipButton → useTipJar → TipJar.tip() → RightsRegistry.award()
// without needing a real Supabase post or second-account onboarding.
//
// How to connect (temporarily):
//   In your router (App.jsx / router.jsx) add:
//     import TipTestPage from "./pages/TipTestPage";
//     <Route path="/tip-test" element={<TipTestPage />} />
//   Open /tip-test, connect MetaMask as DONOR (not as author!).
//
// Remove after confirming tips work.
//
// ⚠️ ЗМІНА відносно попередньої версії: цей деплой має ЛИШЕ ОДИН тестовий
// токен — tUSD (6 decimals). Раніше тут було два (tGHO 18-decimals +
// tUSDC 6-decimals) — tGHO у поточному деплої не існує. TOKENS нижче
// відфільтровує токени без заданої адреси, тож якщо колись додасте
// другий токен через TipJar.setAcceptedToken(), досить прописати
// VITE_TEST_TOKEN_GHO в .env — код сторінки міняти не потрібно.

import React, { useState } from "react";
import { useAccount } from "wagmi";
import TipButton from "../components/TipButton";
import { useTipJar } from "../hooks/useTipJar";

const ALL_TOKENS = {
  tUSD: {
    address: import.meta.env.VITE_TEST_TOKEN_USD,
    symbol: "tUSD",
    decimals: 6,
    mintAmount: "500",
    label: "500 tUSD",
  },
  tGHO: {
    address: import.meta.env.VITE_TEST_TOKEN_GHO,
    symbol: "tGHO",
    decimals: 18,
    mintAmount: "500",
    label: "500 tGHO",
  },
};
// Показуємо лише токени, для яких реально задано адресу в .env.
const TOKENS = Object.fromEntries(
  Object.entries(ALL_TOKENS).filter(([, t]) => !!t.address),
);

export default function TipTestPage() {
  const tipJar = useTipJar();
  // FIXED: previously handleMint() called
  // window.ethereum.request({ method: "eth_requestAccounts" }) directly
  // — a browser-extension-only API that doesn't exist on mobile when
  // connected via WalletConnect (see LensAuthContext.jsx / main.jsx).
  // wagmi's useAccount() already tracks the connected address for any
  // connector (injected or WalletConnect), and useTipJar()'s
  // mintTestTokens itself now gets its write-provider from the active
  // wagmi connector too — so there's no need to touch window.ethereum
  // here at all.
  const { address: connectedAddress } = useAccount();
  const [authorAddress, setAuthorAddress] = useState("");
  const [lensPostId, setLensPostId] = useState("test-post-1");
  const [mintStatus, setMintStatus] = useState({});
  const [mintLoading, setMintLoading] = useState({});

  const handleMint = async (tokenKey) => {
    if (!connectedAddress) {
      setMintStatus((s) => ({ ...s, [tokenKey]: "✗ Wallet not connected" }));
      return;
    }
    setMintLoading((l) => ({ ...l, [tokenKey]: true }));
    setMintStatus((s) => ({ ...s, [tokenKey]: "" }));
    try {
      const me = connectedAddress;
      const token = TOKENS[tokenKey];
      const res = await tipJar.mintTestTokens(
        me,
        token.mintAmount,
        token.address,
      );
      setMintStatus((s) => ({
        ...s,
        [tokenKey]: res.success
          ? `✓ Minted ${token.label} to ${me.slice(0, 6)}...${me.slice(-4)}`
          : `✗ ${res.error}`,
      }));
    } catch (err) {
      setMintStatus((s) => ({ ...s, [tokenKey]: `✗ ${err.message}` }));
    } finally {
      setMintLoading((l) => ({ ...l, [tokenKey]: false }));
    }
  };

  return (
    <div className="min-h-screen bg-[#000914] text-white/70 p-8 max-w-lg mx-auto space-y-6 font-['Inter']">
      <div>
        <h1 className="text-[18px] font-medium text-white/80 mb-1">
          🧪 Tip Button — test
        </h1>
        <p className="text-[13px] text-white/35">
          Connect your wallet as the DONOR account (not as the author below).
        </p>
      </div>

      {/* Step 1 — mint test tokens */}
      <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-4 space-y-3">
        <p className="text-[13px] font-medium text-white/50">
          Step 1 — mint test tokens
        </p>
        <p className="text-[12px] text-white/30 leading-relaxed">
          MockERC20.mint() is open to anyone. Click a button — your wallet will
          prompt and mint tokens to your CURRENT connected wallet (this should
          be the DONOR wallet).
          {Object.keys(TOKENS).length === 0 &&
            " ⚠ No test token address configured in .env (VITE_TEST_TOKEN_USD) — set it first."}
        </p>

        <div className="flex gap-3">
          {Object.entries(TOKENS).map(([key, token]) => (
            <div key={key} className="flex-1 space-y-2">
              <button
                onClick={() => handleMint(key)}
                disabled={mintLoading[key]}
                className="w-full px-4 py-2 rounded-lg text-[13px] font-medium
                  bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]/80
                  hover:bg-[#3d0012] transition-colors disabled:opacity-40"
              >
                {mintLoading[key] ? "Minting..." : `Mint ${token.label}`}
              </button>
              {mintStatus[key] && (
                <p
                  className={`text-[11px] font-mono ${
                    mintStatus[key].startsWith("✓")
                      ? "text-emerald-400/80"
                      : "text-red-400/70"
                  }`}
                >
                  {mintStatus[key]}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* Token addresses for reference */}
        <div className="pt-1 space-y-1">
          {Object.entries(TOKENS).map(([key, token]) => (
            <p key={key} className="text-[11px] text-white/20 font-mono">
              {token.symbol}:{" "}
              {token.address
                ? `${token.address.slice(0, 10)}...${token.address.slice(-6)}`
                : "not set in .env"}
            </p>
          ))}
        </div>
      </div>

      {/* Step 2 — set author */}
      <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-4 space-y-3">
        <p className="text-[13px] font-medium text-white/50">
          Step 2 — set "author"
        </p>
        <p className="text-[12px] text-white/30 leading-relaxed">
          Paste the address of ANOTHER wallet (e.g. one you created with{" "}
          <code className="text-white/45">cast wallet new</code>) — TipJar does
          not allow tipping yourself.
        </p>
        <input
          value={authorAddress}
          onChange={(e) => setAuthorAddress(e.target.value)}
          placeholder="0x... (author address, NOT your current one)"
          className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1]
            text-[13px] font-mono text-white/65 placeholder-white/20 outline-none
            focus:border-blue-500/35"
        />
        <input
          value={lensPostId}
          onChange={(e) => setLensPostId(e.target.value)}
          placeholder="lensPostId (any string for testing)"
          className="w-full px-3 py-2 rounded-lg bg-white/[0.04] border border-white/[0.1]
            text-[13px] text-white/65 placeholder-white/20 outline-none
            focus:border-blue-500/35"
        />
      </div>

      {/* Step 3 — real tip button */}
      <div className="bg-white/[0.03] border border-white/[0.08] rounded-xl p-4 space-y-3">
        <p className="text-[13px] font-medium text-white/50">
          Step 3 — real tip button
        </p>
        <p className="text-[12px] text-white/30">
          Rights are awarded at full tip amount before the author/pool split
          (COUNCIL 90/10, SHIELD 80/20, no SBT 50/50).
        </p>
        {authorAddress ? (
          <TipButton
            author={{ wallet_address: authorAddress }}
            lensPostId={lensPostId}
          />
        ) : (
          <p className="text-[12px] text-white/25">
            Set author address above first ↑
          </p>
        )}
      </div>

      {/* Verification hints */}
      <div className="bg-blue-500/[0.05] border border-blue-500/15 rounded-xl p-4 space-y-3">
        <p className="text-[12px] text-blue-400/70 font-medium">
          After sending — verify on-chain:
        </p>
        <div className="space-y-2">
          <p className="text-[11px] text-blue-400/50 leading-relaxed font-mono">
            {`cast call ${import.meta.env.VITE_RIGHTS_REGISTRY ?? "RIGHTS_REGISTRY"} \\`}
            <br />
            {`  "currentRights(address)(uint256)" AUTHOR_ADDRESS \\`}
            <br />
            {`  --rpc-url lens_testnet`}
          </p>
          <p className="text-[11px] text-blue-400/40 leading-relaxed">
            Should increase by tip amount in $ equivalent. tUSD: 1 token = 1
            RIGHT (6 dec, rightsPerUnit=1e12).
          </p>
        </div>

        <div className="pt-1 border-t border-blue-500/10 space-y-1">
          <p className="text-[11px] text-blue-400/40 font-medium">
            MockHumanityProvider (людяність):
          </p>
          <p className="text-[11px] text-blue-400/30 leading-relaxed">
            На цьому деплої MockHumanityProvider вже налаштований на фіксований
            score 10000 (=100.00%) для <b>будь-якої адреси одразу</b> — жодних
            додаткових команд не потрібно, mint() Shield/Council пройде для
            будь-кого. Якщо колись знадобиться змінити цей глобальний score
            (наприклад, щоб протестувати сценарій "score занизький") —{" "}
            <b>лише адмін-адреса деплою</b> може це зробити:
          </p>
          <p className="text-[11px] text-blue-400/30 font-mono leading-relaxed">
            {`cast send ${import.meta.env.VITE_MOCK_PASSPORT_DECODER ?? "MOCK_HUMANITY_PROVIDER"} \\`}
            <br />
            {`  "setFixedScore(uint256)" 5000 \\`}
            <br />
            {`  --rpc-url lens_testnet --private-key $PRIVATE_KEY`}
          </p>
          <p className="text-[11px] text-blue-400/30">
            ⚠ Це ГЛОБАЛЬНИЙ параметр (впливає одразу на ВСІХ, не лише на вашу
            адресу) — на testnet зазвичай залишайте 10000, змінюйте лише для
            свідомого тесту "недостатній score".
          </p>
        </div>
      </div>
    </div>
  );
}
