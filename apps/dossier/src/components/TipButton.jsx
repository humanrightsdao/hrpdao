import React, { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { HandCoins } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAccount } from "wagmi";
import { useTipJar } from "../hooks/useTipJar";

// ─────────────────────────────────────────────────────────────
// TipButton — a self-contained component.
//
// ⚠️ CHANGE COMPARED TO THE PREVIOUS VERSION:
//   Before: <TipButton author={...} lensPostId={...} tipJar={tipJar} />
//           (the parent component was supposed to call useTipJar()
//            itself and pass it as a prop — in practice this was never
//            done anywhere, so tipJar=undefined and the component crashed).
//   Now:    <TipButton author={...} lensPostId={...} />
//           (useTipJar() is called inside, the tipJar prop is removed).
// ─────────────────────────────────────────────────────────────

const PRESET_AMOUNTS = ["1", "5", "10"];

const TOKENS = [
  {
    key: "tGHO",
    address: import.meta.env.VITE_TEST_TOKEN_GHO,
    symbol: "tGHO",
    decimals: 18,
  },
  {
    key: "tUSDC",
    address: import.meta.env.VITE_TEST_TOKEN_USDC,
    symbol: "tUSDC",
    decimals: 6,
  },
];

// CHANGED: added `containerRef` (optional). When PostCard passes it, the
// tip panel stops being a floating, fixed-position dropdown portaled into
// document.body and instead portals into that ref's DOM node — a slot
// PostCard renders in normal document flow right under the action bar,
// the same place/pattern used by the "Швидкі коментарі" (quick comment)
// panel. This makes the "Гонорар" field slide out inline, full-width,
// exactly like quick comments, instead of popping up as a small card.
// When containerRef is NOT passed (used somewhere outside PostCard),
// TipButton falls back to its original floating-popup behavior — nothing
// changes for that case.
export default function TipButton({ author, lensPostId, containerRef }) {
  const { t } = useTranslation();
  // ── useTipJar inside — the parent component no longer passes anything ──
  const tipJar = useTipJar();
  // FIXED: previously read the viewer's address via
  // window.ethereum?.request({ method: "eth_accounts" }) — silently
  // failed on mobile (WalletConnect connections have no
  // window.ethereum), meaning balance/approve checks were always
  // wrong there. wagmi's useAccount() already tracks the connected
  // address for any connector (injected or WalletConnect), so we
  // don't need a manual provider call here at all.
  const { address: viewerAddress } = useAccount();

  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("1");
  const [selectedToken, setSelectedToken] = useState(TOKENS[0]);
  const [split, setSplit] = useState(null);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [previewRightsAmount, setPreviewRightsAmount] = useState(null);
  const [status, setStatus] = useState("");
  const [modalPos, setModalPos] = useState({ top: -9999, left: -9999 });

  const btnRef = useRef(null);
  const modalRef = useRef(null);
  const authorAddress = author?.wallet_address;

  // ADDED: inline mode = a containerRef was passed in — the panel portals
  // into PostCard's slide-out slot instead of floating over the page, so
  // none of the fixed-position math below is needed for it.
  const isInline = !!containerRef;

  const calcPosition = useCallback(() => {
    if (isInline) return;
    if (!btnRef.current || !modalRef.current) return;
    const btnRect = btnRef.current.getBoundingClientRect();
    const modalRect = modalRef.current.getBoundingClientRect();
    const modalH = modalRect.height;
    const modalW = modalRect.width;
    const spaceBelow = window.innerHeight - btnRect.bottom;
    const spaceRight = window.innerWidth - btnRect.right;
    const top =
      spaceBelow < modalH + 8 ? btnRect.top - modalH - 8 : btnRect.bottom + 8;
    const left = spaceRight < modalW ? btnRect.right - modalW : btnRect.left;
    setModalPos({ top, left });
  }, [isInline]);

  // Reload token info and split when modal opens or token changes
  useEffect(() => {
    if (!open || !authorAddress) return;

    tipJar.previewSplit(authorAddress).then(setSplit);
    tipJar
      .getTokenInfo(viewerAddress, selectedToken.address)
      .then(setTokenInfo);
  }, [open, authorAddress, selectedToken, viewerAddress]);

  // Preview rights on amount change
  useEffect(() => {
    if (!open || !amount || Number(amount) <= 0) {
      setPreviewRightsAmount(null);
      return;
    }
    const handle = setTimeout(() => {
      tipJar
        .previewRights(amount, selectedToken.address)
        .then(setPreviewRightsAmount);
    }, 300);
    return () => clearTimeout(handle);
  }, [open, amount, selectedToken]);

  useEffect(() => {
    if (isInline) return;
    if (!open) return;
    setModalPos({ top: -9999, left: -9999 });
    const raf = requestAnimationFrame(() => calcPosition());
    return () => cancelAnimationFrame(raf);
  }, [open, calcPosition, isInline]);

  // CHANGED: click-outside auto-close only applies to the floating popup.
  // The inline panel behaves like "Швидкі коментарі" — it stays open
  // until the user taps the Гонорар icon again, so clicking elsewhere on
  // the card (e.g. to open quick comments too) doesn't yank it shut.
  useEffect(() => {
    if (isInline) return;
    if (!open) return;
    const handleClickOutside = (e) => {
      if (
        modalRef.current &&
        !modalRef.current.contains(e.target) &&
        btnRef.current &&
        !btnRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClickOutside);
    window.addEventListener("scroll", calcPosition, true);
    window.addEventListener("resize", calcPosition);
    return () => {
      window.removeEventListener("mousedown", handleClickOutside);
      window.removeEventListener("scroll", calcPosition, true);
      window.removeEventListener("resize", calcPosition);
    };
  }, [open, calcPosition, isInline]);

  if (!authorAddress) return null;

  const handleSend = async () => {
    setStatus("");
    const res = await tipJar.sendTip(
      authorAddress,
      amount,
      lensPostId,
      selectedToken.address,
    );
    if (res.success) {
      setStatus(t("tip_thanks"));
      setTimeout(() => setOpen(false), 1500);
    } else {
      setStatus(`✗ ${res.error}`);
    }
  };

  const isLoading = tipJar?.loading ?? false;

  // ADDED: the balance/limit checks are needed in both the amount-row and
  // the send button, so they're computed once here instead of twice.
  const bal = tokenInfo ? Number(tokenInfo.balanceFormatted) : Infinity;
  const min = tokenInfo ? Number(tokenInfo.minAmountFormatted) : 0;
  const amt = Number(amount);
  const overBalance = tokenInfo && amt > bal;
  const underMin = tokenInfo && amt < min && amt > 0;
  const invalid = overBalance || underMin || !amount || amt <= 0;

  // CHANGED: token selector + preset amounts used to be two separate
  // full-width rows (stacked to fit a narrow 272px popup). The inline
  // panel has the full card width available, so they now share one row —
  // token choice and amount choice read as one connected step instead of
  // two, and it takes less vertical space when it slides open.
  const tokenAndPresetsRow = (
    <div className="flex items-center gap-2">
      <div className="flex gap-1 flex-shrink-0">
        {TOKENS.map((token) => (
          <button
            key={token.key}
            onClick={() => {
              setSelectedToken(token);
              setTokenInfo(null);
              setPreviewRightsAmount(null);
            }}
            className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-all ${
              selectedToken.key === token.key
                ? "bg-[#8B1A2A] border-[#8B1A2A]/25 text-white/90 dark:bg-[#2B000A] dark:border-[#b41e3c]/40 dark:text-[#e8a0b0]/85"
                : "bg-slate-50 dark:bg-white/[0.03] border-slate-200 dark:border-white/[0.08] text-slate-400 dark:text-white/35 hover:border-slate-300 dark:hover:border-white/[0.15] hover:text-slate-600 dark:hover:text-white/55"
            }`}
          >
            {token.symbol}
          </button>
        ))}
      </div>
      <div className="w-px h-5 bg-slate-200 dark:bg-white/[0.08] flex-shrink-0" />
      <div className="flex gap-1 flex-shrink-0">
        {PRESET_AMOUNTS.map((a) => (
          <button
            key={a}
            onClick={() => setAmount(a)}
            className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg border transition-all ${
              amount === a
                ? "bg-[#8B1A2A] border-[#8B1A2A]/25 text-white/90 dark:bg-[#2B000A] dark:border-[#b41e3c]/40 dark:text-[#e8a0b0]/85"
                : "bg-slate-50 dark:bg-white/[0.03] border-slate-200 dark:border-white/[0.08] text-slate-400 dark:text-white/35 hover:border-slate-300 dark:hover:border-white/[0.15] hover:text-slate-600 dark:hover:text-white/55"
            }`}
          >
            {a}
          </button>
        ))}
      </div>

      {/* Custom amount — now flexes to fill the rest of the row instead
          of sitting on its own line below. */}
      <div className="relative flex-1 min-w-[90px]">
        <input
          type="number"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          min="0"
          step="0.1"
          className={`w-full px-3 py-1.5 rounded-lg text-[12px]
            bg-slate-50 dark:bg-white/[0.03]
            border transition-all
            text-slate-700 dark:text-white/65
            placeholder-slate-300 dark:placeholder-white/[0.18]
            font-['Inter'] outline-none
            focus:ring-1
            ${
              overBalance
                ? "border-red-400/60 dark:border-red-500/40 focus:border-red-400 focus:ring-red-300/20 dark:focus:ring-red-500/15"
                : "border-slate-200 dark:border-white/[0.09] focus:border-blue-400 dark:focus:border-blue-500/35 focus:ring-blue-300/30 dark:focus:ring-blue-500/15"
            }`}
        />
        {/* Max button — so the user doesn't have to type the amount manually and risk a mistake */}
        {tokenInfo && Number(tokenInfo.balanceFormatted) > 0 && (
          <button
            onClick={() =>
              setAmount(Number(tokenInfo.balanceFormatted).toString())
            }
            className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px]
              text-slate-400 dark:text-white/25 hover:text-slate-600 dark:hover:text-white/50
              px-1.5 py-0.5 rounded border border-slate-200 dark:border-white/[0.08]
              transition-colors"
          >
            {t("tip_max")}
          </button>
        )}
      </div>
    </div>
  );

  const splitInfo = split && (
    <div className="bg-slate-50 dark:bg-white/[0.03] border border-slate-200 dark:border-white/[0.07] rounded-lg px-3 py-2.5 space-y-1">
      {split.tier === "SENATE" && (
        <p className="text-[11px] font-medium text-amber-600 dark:text-amber-400/80 flex items-center gap-1.5">
          {t("tip_tier_senate")}
          <span className="ml-auto text-amber-500 dark:text-amber-400/60">
            {t("tip_share_to_author", { pct: split.authorPct })}
          </span>
        </p>
      )}
      {split.tier === "SHIELD" && (
        <p className="text-[11px] font-medium text-purple-600 dark:text-purple-400/80 flex items-center gap-1.5">
          {t("tip_tier_shield")}
          <span className="ml-auto text-purple-500 dark:text-purple-400/60">
            {t("tip_share_to_author", { pct: split.authorPct })}
          </span>
        </p>
      )}
      {split.tier === "NONE" && (
        <p className="text-[11px] font-medium text-slate-500 dark:text-white/40 flex items-center gap-1.5">
          {t("tip_tier_none")}
          <span className="ml-auto text-slate-400 dark:text-white/30">
            {t("tip_share_to_author", { pct: split.authorPct })}
          </span>
        </p>
      )}
      <p className="text-[10px] text-slate-400 dark:text-white/22">
        {t("tip_pool_share", { pct: split.poolPct })}
      </p>
      {previewRightsAmount !== null && (
        <p className="text-[10px] text-indigo-500 dark:text-indigo-400/55">
          {t("tip_preview_rights", { amount: previewRightsAmount })}
        </p>
      )}
    </div>
  );

  const balanceInfo = tokenInfo && (
    <div className="space-y-1">
      <p className="text-[10px] text-slate-400 dark:text-white/22 leading-relaxed">
        {t("tip_balance_label")}{" "}
        <span
          className={
            overBalance
              ? "text-red-500 dark:text-red-400/80 font-medium"
              : "text-slate-600 dark:text-white/40"
          }
        >
          {bal.toFixed(2)} {selectedToken.symbol}
        </span>
        {" · "}
        {t("tip_min_label")}{" "}
        <span className="text-slate-500 dark:text-white/35">
          {tokenInfo.minAmountFormatted} {selectedToken.symbol}
        </span>
      </p>
      {overBalance && (
        <p className="text-[10px] text-red-500 dark:text-red-400/75">
          {t("tip_insufficient_balance", {
            symbol: selectedToken.symbol,
            max: bal.toFixed(2),
          })}
        </p>
      )}
      {underMin && !overBalance && (
        <p className="text-[10px] text-amber-500 dark:text-amber-400/75">
          {t("tip_below_minimum", {
            min: tokenInfo.minAmountFormatted,
            symbol: selectedToken.symbol,
          })}
        </p>
      )}
    </div>
  );

  // CHANGED: status text now sits to the LEFT of the Send button instead
  // of on its own line underneath — the same footer-row pattern the quick
  // comment field uses for its Send button, so the two slide-out panels
  // read as one consistent pattern.
  const sendRow = (
    <div className="flex items-center gap-3">
      {status && (
        <p
          className={`flex-1 text-[11px] font-mono ${
            status.startsWith("✓")
              ? "text-emerald-600 dark:text-emerald-400/80"
              : "text-red-500 dark:text-red-400/70"
          }`}
        >
          {status}
        </p>
      )}
      <button
        onClick={handleSend}
        disabled={isLoading || invalid}
        className={`${status ? "" : "w-full"} ml-auto flex items-center justify-center gap-2
          px-4 py-2 rounded-lg text-[12px] font-medium transition-colors
          bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232]
          dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/80 dark:hover:bg-[#3d0012]
          disabled:opacity-40 disabled:cursor-not-allowed`}
      >
        {isLoading && (
          <span className="w-3.5 h-3.5 border-2 border-[#e8a0b0]/50 border-t-transparent rounded-full animate-spin" />
        )}
        {isLoading
          ? tipJar.progress || t("tip_sending")
          : overBalance
            ? t("tip_insufficient_short", { symbol: selectedToken.symbol })
            : t("tip_support_button", { amount, symbol: selectedToken.symbol })}
      </button>
    </div>
  );

  // ADDED: the inline panel — slides out under the action bar, full card
  // width, styled the same way as the "Швидкі коментарі" section
  // (px-4 pb-3 + a top divider), instead of floating over the page.
  const inlinePanel =
    open && containerRef?.current
      ? createPortal(
          <div
            ref={modalRef}
            onClick={(e) => e.stopPropagation()}
            className="px-4 pb-3 pt-3 border-t border-slate-200 dark:border-white/[0.05] space-y-2.5 tip-section"
          >
            {tokenAndPresetsRow}
            {splitInfo}
            {balanceInfo}
            {sendRow}
          </div>,
          containerRef.current,
        )
      : null;

  // Original floating popup — unchanged, kept for any usage of TipButton
  // outside PostCard's inline slot (no containerRef passed).
  const floatingPanel = open
    ? createPortal(
        <div
          ref={modalRef}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            top: modalPos.top,
            left: modalPos.left,
            width: 272,
            zIndex: 9999,
            visibility: modalPos.top === -9999 ? "hidden" : "visible",
          }}
          className="bg-white dark:bg-[#000d1f] border border-slate-200 dark:border-white/[0.1] rounded-xl shadow-lg dark:shadow-[0_8px_32px_rgba(0,0,0,0.6)] p-4 space-y-3"
        >
          <div className="flex gap-1.5">
            {TOKENS.map((token) => (
              <button
                key={token.key}
                onClick={() => {
                  setSelectedToken(token);
                  setTokenInfo(null);
                  setPreviewRightsAmount(null);
                }}
                className={`flex-1 py-1.5 text-[11px] font-medium rounded-lg border transition-all ${
                  selectedToken.key === token.key
                    ? "bg-[#8B1A2A] border-[#8B1A2A]/25 text-white/90 dark:bg-[#2B000A] dark:border-[#b41e3c]/40 dark:text-[#e8a0b0]/85"
                    : "bg-slate-50 dark:bg-white/[0.03] border-slate-200 dark:border-white/[0.08] text-slate-400 dark:text-white/35 hover:border-slate-300 dark:hover:border-white/[0.15] hover:text-slate-600 dark:hover:text-white/55"
                }`}
              >
                {token.symbol}
              </button>
            ))}
          </div>
          {splitInfo}
          <div className="flex gap-1.5">
            {PRESET_AMOUNTS.map((a) => (
              <button
                key={a}
                onClick={() => setAmount(a)}
                className={`flex-1 py-1.5 text-[11px] font-medium rounded-lg border transition-all ${
                  amount === a
                    ? "bg-[#8B1A2A] border-[#8B1A2A]/25 text-white/90 dark:bg-[#2B000A] dark:border-[#b41e3c]/40 dark:text-[#e8a0b0]/85"
                    : "bg-slate-50 dark:bg-white/[0.03] border-slate-200 dark:border-white/[0.08] text-slate-400 dark:text-white/35 hover:border-slate-300 dark:hover:border-white/[0.15] hover:text-slate-600 dark:hover:text-white/55"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
          <div className="relative">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              min="0"
              step="0.1"
              className={`w-full px-3 py-1.5 rounded-lg text-[12px]
                bg-slate-50 dark:bg-white/[0.03]
                border transition-all
                text-slate-700 dark:text-white/65
                placeholder-slate-300 dark:placeholder-white/[0.18]
                font-['Inter'] outline-none
                focus:ring-1
                ${
                  overBalance
                    ? "border-red-400/60 dark:border-red-500/40 focus:border-red-400 focus:ring-red-300/20 dark:focus:ring-red-500/15"
                    : "border-slate-200 dark:border-white/[0.09] focus:border-blue-400 dark:focus:border-blue-500/35 focus:ring-blue-300/30 dark:focus:ring-blue-500/15"
                }`}
            />
            {tokenInfo && Number(tokenInfo.balanceFormatted) > 0 && (
              <button
                onClick={() =>
                  setAmount(Number(tokenInfo.balanceFormatted).toString())
                }
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px]
                  text-slate-400 dark:text-white/25 hover:text-slate-600 dark:hover:text-white/50
                  px-1.5 py-0.5 rounded border border-slate-200 dark:border-white/[0.08]
                  transition-colors"
              >
                {t("tip_max")}
              </button>
            )}
          </div>
          {balanceInfo}
          <button
            onClick={handleSend}
            disabled={isLoading || invalid}
            className="w-full py-2 rounded-lg text-[12px] font-medium bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/80 dark:hover:bg-[#3d0012] transition-colors disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isLoading && (
              <span className="w-3.5 h-3.5 border-2 border-[#e8a0b0]/50 border-t-transparent rounded-full animate-spin" />
            )}
            {isLoading
              ? tipJar.progress || t("tip_sending")
              : overBalance
                ? t("tip_insufficient_short", { symbol: selectedToken.symbol })
                : t("tip_support_button", { amount, symbol: selectedToken.symbol })}
          </button>
          {status && (
            <p
              className={`text-[11px] font-mono ${
                status.startsWith("✓")
                  ? "text-emerald-600 dark:text-emerald-400/80"
                  : "text-red-500 dark:text-red-400/70"
              }`}
            >
              {status}
            </p>
          )}
        </div>,
        document.body,
      )
    : null;

  const modal = isInline ? inlinePanel : floatingPanel;

  return (
    <div className="relative inline-block">
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title={t("tip_support")}
        aria-label={t("tip_support")}
        className={`flex items-center justify-center gap-1.5 flex-shrink-0
        w-10 h-10 sm:w-auto sm:h-auto sm:px-3 sm:py-2.5
        rounded-lg text-[13px] font-medium transition-all ${
          open
            ? "bg-[#2B000A] text-[#e8a0b0]/80"
            : "bg-slate-100 dark:bg-white/[0.03] border border-slate-200 dark:border-transparent text-slate-500 dark:text-white/35 hover:bg-[#2B000A]/10 dark:hover:text-[#e8a0b0]/60 hover:text-[#9B1030] hover:border-[#b41e3c]/30"
        }`}
      >
        <HandCoins className="w-5 h-5 flex-shrink-0" />
        {/* CHANGED: label hidden below the `sm` breakpoint (~640px) so the
            button collapses to a compact 40x40 icon-only square matching
            comment/save/share — same as them, it never gets clipped, and
            the colored pill background still sets it apart visually.
            The label stays available to screen readers via aria-label. */}
        <span className="hidden sm:inline whitespace-nowrap">
          {t("tip_support")}
        </span>
      </button>
      {modal}
    </div>
  );
}
