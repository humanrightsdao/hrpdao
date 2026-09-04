import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ethers } from "ethers";
import { Loader2 } from "lucide-react";
import { useAccount } from "wagmi";
import { CONTRACTS, ACTIVE_CHAIN } from "../hooks/useDao";
import { useTipJar } from "../hooks/useTipJar";
import { useFiatOnramp } from "../hooks/useFiatOnramp";
import { truncAddr, fmtNum } from "../lib/format";
import { tDaoMessage } from "../lib/daoMessages";
import Identity from "./Identity";
import logo from "../assets/logo.png";

// Minimal read-only ABIs — the same functions already used by
// useDao.js (currentRights/balanceOf/isMember/isCouncilMember), just
// without writes and without depending on the visitor's connected wallet.
const RIGHTS_ABI = ["function currentInfluence(address account) view returns (uint256)"];
const SHIELD_ABI = ["function isMember(address account) view returns (bool)"];
const COUNCIL_ABI = ["function isCouncilMember(address account) view returns (bool)"];

// Tokens a tip can be sent in. Only ones with a real address set in
// .env are used — TipJar.acceptedTokens() is checked live via
// getTokenInfo() before sending anyway, so a stray/undeployed token
// here won't break anything, it just won't show up as a selectable
// button. The current deployment only uses tUSD (see the comment in
// useTipJar.js) — once the DAO adds another via governance, it's
// enough to add its address to .env, no new button needed.
const TIP_TOKENS = [
  { key: "tUSD", address: import.meta.env.VITE_TEST_TOKEN_USD },
  { key: "tGHO", address: import.meta.env.VITE_TEST_TOKEN_GHO },
].filter((tok) => tok.address);

const PRESET_AMOUNTS = ["5", "10", "25"];

// A self-contained "business card" block — it reads status from the
// blockchain by address itself, with no props besides address. Used
// in two places:
// 1) the public /card/:address page (where the QR code leads, full
//    layout) — someone who scanned the code immediately sees the
//    status and can send the member a tip without leaving this page;
// 2) the private Business Card page — embedded next to the QR code,
//    an exact preview of what someone scanning the code will see
//    (so the tip form renders the same way here, just with the send
//    button disabled — you can't tip yourself).
export default function CardPreview({ address, showFooterNote = true }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null); // null = loading, false = error
  const isValidAddress = address && ethers.isAddress(address);

  // ── Tip ────────────────────────────────────────────────────
  const tipJar = useTipJar();
  const { address: viewerAddress } = useAccount();
  const [selectedToken, setSelectedToken] = useState(TIP_TOKENS[0] || null);
  const [amount, setAmount] = useState(PRESET_AMOUNTS[0]);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [split, setSplit] = useState(null);
  const [previewRightsAmount, setPreviewRightsAmount] = useState(null);
  const [tipStatus, setTipStatus] = useState("");

  // ── Fiat onramp (buy crypto with a card) ─────────────────────
  // Self-disables on testnets / while the feature flag is off — see
  // useFiatOnramp.js for why. When disabled, no "Карткою" tab renders
  // at all — the form falls back to crypto-only, exactly as before.
  const onramp = useFiatOnramp();
  // "crypto" | "card" — which tab of the form is showing. Always
  // starts on "crypto"; the toggle itself only renders when
  // onramp.enabled, so this stays "crypto" forever on unsupported
  // chains and nothing below ever shows the card-pay UI.
  const [payMethod, setPayMethod] = useState("crypto");
  // Single combined card-pay flow state — see handlePayWithCard().
  // null when idle; one of "checking"|"gas"|"token"|"waiting"|"sending"
  // while in progress; back to null when done (success or error, with
  // the result left in cardFlowMessage either way).
  const [cardFlowStage, setCardFlowStage] = useState(null);
  const [cardFlowMessage, setCardFlowMessage] = useState("");

  const isSelf =
    !!viewerAddress && !!address && viewerAddress.toLowerCase() === address.toLowerCase();

  useEffect(() => {
    if (!isValidAddress) return;
    let cancelled = false;
    setStatus(null);

    async function load() {
      try {
        const provider = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]);
        const rights = new ethers.Contract(CONTRACTS.rightsRegistry, RIGHTS_ABI, provider);
        const shield = new ethers.Contract(CONTRACTS.shieldSBT, SHIELD_ABI, provider);
        const council = new ethers.Contract(CONTRACTS.councilSBT, COUNCIL_ABI, provider);

        const [rightsAmount, isShield, isCouncil] = await Promise.all([
          rights.currentInfluence(address),
          shield.isMember(address),
          council.isCouncilMember(address),
        ]);

        if (!cancelled) setStatus({ rights: Number(rightsAmount), isShield, isCouncil });
      } catch {
        if (!cancelled) setStatus(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [address, isValidAddress]);

  // Preview of the split (what % the member gets) + the visitor's
  // wallet balance/minimum for the selected token — loads right away,
  // without a wallet connection (previewSplit/getTokenInfo read a public RPC).
  useEffect(() => {
    if (!isValidAddress || !selectedToken) return;
    tipJar.previewSplit(address).then(setSplit);
    tipJar.getTokenInfo(viewerAddress, selectedToken.address).then(setTokenInfo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isValidAddress, address, selectedToken, viewerAddress]);

  // Preview of the Influence the member will earn from this tip
  useEffect(() => {
    if (!selectedToken || !amount || Number(amount) <= 0) {
      setPreviewRightsAmount(null);
      return;
    }
    const handle = setTimeout(() => {
      tipJar.previewRights(amount, selectedToken.address).then(setPreviewRightsAmount);
    }, 300);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, selectedToken]);

  async function handleSendTip() {
    setTipStatus("");
    const res = await tipJar.sendTip(address, amount, null, selectedToken.address);
    if (res.success) {
      setTipStatus(t("dao.card.tipSentSuccess"));
    } else {
      // eslint-disable-next-line no-console
      console.error("[CardPreview] sendTip failed:", res.error);
      setTipStatus(
        res.error === "Cannot tip your own post"
          ? t("dao.card.cannotTipSelf")
          : `✗ ${tDaoMessage(t, res.error)}`,
      );
    }
  }

  // Rough "does this wallet look like it can't even pay gas" check —
  // deliberately conservative (a few cents worth of ETH). Not a gas
  // estimate — the actual tip() gas limit is estimated dynamically in
  // useTipJar.js's sendTip(); this is only a threshold for deciding
  // whether handlePayWithCard needs a gas top-up first.
  const GAS_BALANCE_FLOOR = ethers.parseEther("0.0003");

  // ── Single "Pay with card" flow ──────────────────────────────────
  // Chains gas top-up → token purchase → wait for on-chain settlement
  // → send the tip, all behind one button, with no crypto terminology
  // in the visible UI (see the "card" tab below). Re-checks live
  // balances at each stage rather than trusting local state, so it's
  // safe to click again after an error or a settlement timeout — it
  // will skip whatever's already been bought and pick up where it
  // left off, instead of buying gas/tokens a second time.
  //
  // ⚠️ KNOWN LIMITATION: this assumes the selected token is a
  // STABLE-kind token in TipJar.sol (fixed $1≈1 unit) — the $ amount
  // typed by the user is passed straight through as the token amount.
  // If the DAO ever adds an ORACLE-kind token (e.g. ETH) as a *card*
  // funding option, this 1:1 assumption breaks and this flow would
  // need to convert $ → token amount using previewInfluence's inverse
  // (or a live price) before calling fundToken/sendTip. Not needed
  // today since only stablecoins are configured, but flag it before
  // extending TIP_TOKENS with a non-stablecoin for the card tab.
  async function handlePayWithCard() {
    if (!selectedToken || !viewerAddress || cardFlowStage) return;
    setCardFlowMessage("");
    const targetAmount = Number(amount);
    if (!targetAmount || targetAmount <= 0) return;

    const provider = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]);

    // ── Step 1: gas (skip if the wallet already has enough) ────────
    setCardFlowStage("checking");
    let freshNative = null;
    try {
      freshNative = await provider.getBalance(viewerAddress);
    } catch {
      freshNative = null;
    }
    if (freshNative === null || freshNative < GAS_BALANCE_FLOOR) {
      setCardFlowStage("gas");
      setCardFlowMessage(t("dao.card.fiat.buyingGas"));
      const gasRes = await onramp.fundGas(viewerAddress);
      if (!gasRes.success) {
        setCardFlowMessage(`✗ ${gasRes.error}`);
        setCardFlowStage(null);
        return;
      }
    }

    // ── Step 2: the tip token itself (skip if already enough) ──────
    const freshInfo = await tipJar.getTokenInfo(viewerAddress, selectedToken.address);
    if (freshInfo) setTokenInfo(freshInfo);
    const alreadyHave = freshInfo ? Number(freshInfo.balanceFormatted) : 0;

    if (alreadyHave < targetAmount) {
      setCardFlowStage("token");
      setCardFlowMessage(t("dao.card.fiat.buyingToken"));
      const tokenRes = await onramp.fundToken(viewerAddress, selectedToken.address, amount);
      if (!tokenRes.success) {
        setCardFlowMessage(`✗ ${tokenRes.error}`);
        setCardFlowStage(null);
        return;
      }

      // Onramp purchases aren't instant — wait for the tokens to
      // actually land on-chain before trying to spend them. Polls for
      // up to ~60s; if it times out we stop WITHOUT re-buying (a
      // second click will just re-check the balance, see the
      // alreadyHave check above) — safer than silently looping.
      setCardFlowStage("waiting");
      setCardFlowMessage(t("dao.card.fiat.waitingFunds"));
      let landed = false;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        const info = await tipJar.getTokenInfo(viewerAddress, selectedToken.address);
        if (info) setTokenInfo(info);
        if (info && Number(info.balanceFormatted) >= targetAmount) {
          landed = true;
          break;
        }
      }
      if (!landed) {
        setCardFlowMessage(t("dao.card.fiat.stillWaiting"));
        setCardFlowStage(null);
        return;
      }
    }

    // ── Step 3: send the tip itself — same contract call as the
    // crypto tab's "Send Tip" button, just triggered automatically. ──
    setCardFlowStage("sending");
    setCardFlowMessage(t("dao.card.fiat.sending"));
    const res = await tipJar.sendTip(address, amount, null, selectedToken.address);
    if (res.success) {
      setCardFlowMessage(t("dao.card.tipSentSuccess"));
    } else {
      // eslint-disable-next-line no-console
      console.error("[CardPreview] handlePayWithCard sendTip failed:", res.error);
      setCardFlowMessage(`✗ ${tDaoMessage(t, res.error)}`);
    }
    setCardFlowStage(null);
  }

  const isLoadingTip = tipJar?.loading ?? false;
  // Checking the balance only makes sense once a wallet is connected
  // (viewerAddress is known) — otherwise getTokenInfo() always returns 0
  // (no userAddress), and the button would wrongly show
  // "Insufficient funds" before the person has even connected
  // MetaMask. The minimum amount is a TipJar contract constraint that
  // doesn't depend on the visitor's wallet, so it can be checked right away.
  const bal = viewerAddress && tokenInfo ? Number(tokenInfo.balanceFormatted) : null;
  const min = tokenInfo ? Number(tokenInfo.minAmountFormatted) : 0;
  const amt = Number(amount);
  const overBalance = bal !== null && amt > bal;
  const underMin = tokenInfo && amt < min && amt > 0;
  const invalid = overBalance || underMin || !amount || amt <= 0 || !selectedToken;

  return (
    <div className="relative">
      {/* ── Logo + DAO name (same look as in the navbar) ── */}
      <div className="flex items-center justify-center gap-2.5 mb-6">
        <img src={logo} alt="Human Rights Policy DAO" className="w-9 h-9 object-contain shrink-0" />
        <div className="leading-tight">
          <div className="font-cinzel text-parchment text-[0.95rem]">{t("dao.card.brandName")}</div>
          <div className="font-body text-[11px] text-parchmentDim">
            {t("dao.card.brandSubtitle")}
          </div>
        </div>
      </div>

      {/* ── Avatar, name + membership status/Influence on one line ── */}
      <div className="flex flex-col items-center gap-1.5 mb-1">
        <Identity address={address} size={40} className="text-base" showBadge={false} />
        {status && (
          <div className="flex items-center gap-2">
            {(status.isCouncil || status.isShield) && (
              <span
                className="status-stamp !py-[0.15em] !text-[11px]"
                style={{ "--stamp-color": status.isCouncil ? "#C9A227" : "#3B7DFF" }}
              >
                {status.isCouncil ? t("dao.common.council") : t("dao.common.shield")}
              </span>
            )}
            <span className="font-mono text-[12px] text-parchmentDim">
              {fmtNum(status.rights)} Influence
            </span>
          </div>
        )}
      </div>
      <div className="text-center font-mono text-xs text-parchmentDim mb-6">
        {truncAddr(address)}
      </div>

      {!isValidAddress && (
        <p className="text-center font-mono text-sm text-sealBright">{t("dao.card.invalidAddress")}</p>
      )}

      {isValidAddress && status === null && (
        <div className="flex items-center justify-center gap-2 text-parchmentDim py-6">
          <Loader2 size={18} className="animate-spin" />
          <span className="font-mono text-sm">{t("dao.card.checkingRegistry")}</span>
        </div>
      )}

      {status === false && (
        <p className="text-center font-mono text-sm text-sealBright">
          {t("dao.card.readError")}
        </p>
      )}

      {status && (
        <>
          {/* ── Description of what the tip is for (short, with the split %) ── */}
          <p className="font-mono text-[12px] text-parchmentDim leading-relaxed text-center mb-6">
            {t("dao.card.tipDescription")}
            {split && (
              <>
                {" "}
                {t("dao.card.tipSplit", { authorPct: split.authorPct, poolPct: split.poolPct })}
              </>
            )}
          </p>

          {/* ── Payment method toggle ──────────────────────────────
              Only rendered when useFiatOnramp.js has determined we're
              on a supported (mainnet) chain AND the feature flag is
              on — see that file. On testnets/while disabled this
              never renders, payMethod stays "crypto" forever, and the
              form below is identical to before this feature existed. */}
          {onramp.enabled && (
            <div className="flex gap-1.5 mb-4">
              <button
                type="button"
                onClick={() => setPayMethod("crypto")}
                className={`flex-1 py-1.5 text-[12px] font-medium rounded-lg border transition-all ${
                  payMethod === "crypto"
                    ? "bg-seal border-seal/40 text-white"
                    : "bg-surface2 border-hairline text-parchmentDim hover:border-hairlineStrong hover:text-parchment"
                }`}
              >
                {t("dao.card.payMethod.crypto")}
              </button>
              <button
                type="button"
                onClick={() => setPayMethod("card")}
                className={`flex-1 py-1.5 text-[12px] font-medium rounded-lg border transition-all ${
                  payMethod === "card"
                    ? "bg-seal border-seal/40 text-white"
                    : "bg-surface2 border-hairline text-parchmentDim hover:border-hairlineStrong hover:text-parchment"
                }`}
              >
                {t("dao.card.payMethod.card")}
              </button>
            </div>
          )}

          {/* ── Tip form ─────────────────────────────────────────── */}
          {TIP_TOKENS.length === 0 ? (
            <p className="text-center font-mono text-[12px] text-parchmentDim">
              {t("dao.card.noTipToken")}
            </p>
          ) : payMethod === "card" ? (
            /* ── "Карткою" tab — no crypto terminology visible at all.
                Amount is in $ (see the STABLE-kind assumption noted
                on handlePayWithCard above), gas/token purchases and
                the on-chain send all happen inside one button click. ── */
            <div className="space-y-3">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[13px] font-mono text-parchmentDim">
                  $
                </span>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  min="0"
                  step="1"
                  placeholder={t("dao.card.amountPlaceholder")}
                  className="w-full pl-6 pr-3 py-2 rounded-lg text-[13px] bg-surface2 border border-hairline focus:border-verdigris focus:ring-1 focus:ring-verdigris/20 text-parchment placeholder-parchmentDim/40 font-mono outline-none transition-all"
                />
              </div>

              <div className="flex gap-1.5">
                {PRESET_AMOUNTS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmount(a)}
                    className={`flex-1 py-1.5 text-[11px] font-medium rounded-lg border transition-all ${
                      amount === a
                        ? "bg-seal border-seal/40 text-white"
                        : "bg-surface2 border-hairline text-parchmentDim hover:border-hairlineStrong hover:text-parchment"
                    }`}
                  >
                    ${a}
                  </button>
                ))}
              </div>

              {previewRightsAmount !== null && (
                <p className="text-[11px] font-mono text-verdigrisBright">
                  {t("dao.card.receiveEstimate", { amount: fmtNum(previewRightsAmount) })}
                </p>
              )}

              {isSelf ? (
                <p className="text-center font-mono text-[11px] text-parchmentDim py-2">
                  {t("dao.card.ownCard")}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={handlePayWithCard}
                  disabled={cardFlowStage !== null || !amount || Number(amount) <= 0}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[13px] font-medium transition-colors bg-seal border border-seal/40 text-white hover:bg-sealDeep disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {cardFlowStage && (
                    <span className="w-3.5 h-3.5 border-2 border-white/60 border-t-transparent rounded-full animate-spin" />
                  )}
                  {cardFlowStage
                    ? cardFlowMessage || t("dao.card.fiat.processing")
                    : t("dao.card.fiat.payWithCard", { amount: amount || 0 })}
                </button>
              )}

              {!cardFlowStage && cardFlowMessage && (
                <p
                  className={`text-center font-mono text-[11px] ${
                    cardFlowMessage.startsWith("✓") ? "text-verdigrisBright" : "text-sealBright"
                  }`}
                >
                  {cardFlowMessage}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Currency selector */}
              <div className="flex gap-1.5">
                {TIP_TOKENS.map((token) => (
                  <button
                    key={token.key}
                    type="button"
                    onClick={() => {
                      setSelectedToken(token);
                      setTokenInfo(null);
                      setPreviewRightsAmount(null);
                    }}
                    className={`flex-1 py-1.5 text-[11px] font-medium rounded-lg border transition-all ${
                      selectedToken?.key === token.key
                        ? "bg-seal border-seal/40 text-white"
                        : "bg-surface2 border-hairline text-parchmentDim hover:border-hairlineStrong hover:text-parchment"
                    }`}
                  >
                    {tokenInfo && selectedToken?.key === token.key ? tokenInfo.symbol : token.key}
                  </button>
                ))}
              </div>

              {/* Amount input field */}
              <div className="relative">
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  min="0"
                  step="0.1"
                  placeholder={t("dao.card.amountPlaceholder")}
                  className={`w-full px-3 py-2 rounded-lg text-[13px] bg-surface2 border text-parchment placeholder-parchmentDim/40 font-mono outline-none focus:ring-1 transition-all ${
                    overBalance
                      ? "border-seal/60 focus:border-seal focus:ring-seal/20"
                      : "border-hairline focus:border-verdigris focus:ring-verdigris/20"
                  }`}
                />
                {viewerAddress && tokenInfo && Number(tokenInfo.balanceFormatted) > 0 && (
                  <button
                    type="button"
                    onClick={() => setAmount(Number(tokenInfo.balanceFormatted).toString())}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-parchmentDim hover:text-parchment px-1.5 py-0.5 rounded border border-hairline transition-colors"
                  >
                    {t("dao.card.max")}
                  </button>
                )}
              </div>

              {/* Preset amount buttons */}
              <div className="flex gap-1.5">
                {PRESET_AMOUNTS.map((a) => (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setAmount(a)}
                    className={`flex-1 py-1.5 text-[11px] font-medium rounded-lg border transition-all ${
                      amount === a
                        ? "bg-seal border-seal/40 text-white"
                        : "bg-surface2 border-hairline text-parchmentDim hover:border-hairlineStrong hover:text-parchment"
                    }`}
                  >
                    {a}
                  </button>
                ))}
              </div>

              {/* Preview of the Influence earned from this tip */}
              {previewRightsAmount !== null && (
                <p className="text-[11px] font-mono text-verdigrisBright">
                  {t("dao.card.receiveEstimate", { amount: fmtNum(previewRightsAmount) })}
                </p>
              )}

              {tokenInfo && (
                <p className="text-[11px] font-mono text-parchmentDim leading-relaxed">
                  {viewerAddress ? (
                    <>
                      {t("dao.card.balance")}{" "}
                      <span
                        className={overBalance ? "text-sealBright font-medium" : "text-parchment"}
                      >
                        {bal.toFixed(2)} {tokenInfo.symbol}
                      </span>
                      {" · "}
                    </>
                  ) : null}
                  {t("dao.card.minimum")}{" "}
                  <span className="text-parchment">
                    {tokenInfo.minAmountFormatted} {tokenInfo.symbol}
                  </span>
                </p>
              )}
              {overBalance && (
                <p className="text-[11px] font-mono text-sealBright">
                  {t("dao.card.notEnough", { symbol: tokenInfo.symbol })}
                </p>
              )}

              {/* Nudge toward the "Карткою" tab instead of duplicating
                  onramp buttons here — the toggle above is the single,
                  explicit place to switch payment method (see the
                  discussion that led to this — burying rescue buttons
                  inside the crypto form read as an afterthought, not
                  a real choice). */}
              {onramp.enabled && overBalance && (
                <p className="text-[11px] font-mono text-parchmentDim">
                  {t("dao.card.onramp.switchHint")}
                </p>
              )}
              {underMin && !overBalance && (
                <p className="text-[11px] font-mono text-gold">
                  {t("dao.card.minimumAmount", { amount: tokenInfo.minAmountFormatted, symbol: tokenInfo.symbol })}
                </p>
              )}

              {/* Send button */}
              {isSelf ? (
                <p className="text-center font-mono text-[11px] text-parchmentDim py-2">
                  {t("dao.card.ownCard")}
                </p>
              ) : (
                <button
                  type="button"
                  onClick={handleSendTip}
                  disabled={isLoadingTip || invalid}
                  className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg text-[13px] font-medium transition-colors bg-seal border border-seal/40 text-white hover:bg-sealDeep disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isLoadingTip && (
                    <span className="w-3.5 h-3.5 border-2 border-white/60 border-t-transparent rounded-full animate-spin" />
                  )}
                  {isLoadingTip
                    ? tipJar.progress || t("dao.card.sending")
                    : overBalance
                      ? t("dao.card.notEnoughShort", { symbol: selectedToken?.symbol || selectedToken?.key })
                      : t("dao.card.sendTip", { amount: amount || 0, symbol: selectedToken?.symbol || selectedToken?.key || "" })}
                </button>
              )}

              {tipStatus && (
                <p
                  className={`text-center font-mono text-[11px] ${
                    tipStatus.startsWith("✓") ? "text-verdigrisBright" : "text-sealBright"
                  }`}
                >
                  {tipStatus}
                </p>
              )}
            </div>
          )}

          {showFooterNote && (
            <p className="font-mono text-[12px] text-parchmentDim mt-6 leading-relaxed text-center">
              {t("dao.card.footerNote", { chain: ACTIVE_CHAIN?.name })}
            </p>
          )}
        </>
      )}
    </div>
  );
}
