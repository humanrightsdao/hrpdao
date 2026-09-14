import { useCallback, useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ethers } from "ethers";
import { Landmark, Globe2, Wallet, ArrowRightLeft } from "lucide-react";
import { CONTRACTS, ACTIVE_CHAIN } from "../hooks/useDao";
import { useTipJar } from "../hooks/useTipJar";
import { fmtNum, truncAddr } from "../lib/format";

// Every ERC-20 currency the Treasury's geo-routed accounts might hold.
// Same pattern/order as CardPreview.jsx's TIP_TOKENS — only entries with
// a real address configured in .env are used, so adding a token the DAO
// accepts later (via TipJar.setAcceptedToken()) is just one .env line,
// no code change needed here.
const TREASURY_TOKENS = [
  { key: "tUSD", address: CONTRACTS.testTokenUSD },
  { key: "USDC", address: CONTRACTS.testTokenUSDC },
  { key: "tGHO", address: CONTRACTS.testTokenGHO },
].filter((tok) => tok.address);

export default function TreasuryPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const tipJar = useTipJar();
  const [ethBalance, setEthBalance] = useState(null);
  const [loadingEth, setLoadingEth] = useState(true);
  const [ethErr, setEthErr] = useState(null);

  // Keyed by token address: { hexData, decimals, symbol, escrowed, loading }
  const [tokenData, setTokenData] = useState({});
  // Keyed by token address: { pending, error } — state of the "sweep
  // escrow into Treasury" button, separate from the read-only fetch above.
  const [sweepState, setSweepState] = useState({});

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const provider = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]);
        const raw = await provider.getBalance(CONTRACTS.treasury);
        if (!cancelled) setEthBalance(ethers.formatEther(raw));
      } catch (e) {
        if (!cancelled) setEthErr(t("dao.treasury.ethError"));
      } finally {
        if (!cancelled) setLoadingEth(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Shared fetch used both by the effect below (all tokens, on connect)
  // and by handleSweep (a single token, right after a successful sweep).
  const fetchTokenSnapshot = useCallback(
    async (address) => {
      const provider = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]);
      const tokenRead = new ethers.Contract(
        address,
        [
          "function decimals() view returns (uint8)",
          "function symbol() view returns (string)",
        ],
        provider,
      );
      const [res, dec, sym, escrowed] = await Promise.all([
        dao.loadHexTreasuryBalances(address),
        tokenRead.decimals().catch(() => 6),
        tokenRead.symbol().catch(() => "?"),
        tipJar.getEscrowedPool(address),
      ]);
      return { hexData: res, decimals: Number(dec), symbol: sym, escrowed, loading: false };
    },
    [dao, tipJar],
  );

  useEffect(() => {
    if (!dao?.isConnected || !dao.loadHexTreasuryBalances || TREASURY_TOKENS.length === 0) return;
    let cancelled = false;

    // One independent fetch per currency — a slow/broken token RPC call
    // shouldn't block the others from rendering.
    TREASURY_TOKENS.forEach(({ address }) => {
      setTokenData((prev) => ({ ...prev, [address]: { ...(prev[address] || {}), loading: true } }));

      fetchTokenSnapshot(address)
        .then((snapshot) => {
          if (cancelled) return;
          setTokenData((prev) => ({ ...prev, [address]: snapshot }));
        })
        .catch(() => {
          if (cancelled) return;
          setTokenData((prev) => ({ ...prev, [address]: { ...(prev[address] || {}), loading: false, error: true } }));
        });
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao?.isConnected, dao?.locationInfo]);

  // Sweep TipJar's escrowed pool for one token into Treasury (permissionless
  // — see TIPJAR_ABI comment in useTipJar.js), then re-read that token's
  // figures so the newly-arrived balance shows up right away.
  const handleSweep = useCallback(
    async (address) => {
      setSweepState((prev) => ({ ...prev, [address]: { pending: true, error: null } }));
      const result = await tipJar.sweepEscrow(address);
      if (!result.success) {
        setSweepState((prev) => ({ ...prev, [address]: { pending: false, error: result.error } }));
        return;
      }
      setSweepState((prev) => ({ ...prev, [address]: { pending: false, error: null } }));
      try {
        const snapshot = await fetchTokenSnapshot(address);
        setTokenData((prev) => ({ ...prev, [address]: snapshot }));
      } catch {
        // Best-effort refresh — if this fails the numbers just stay stale
        // until the next reload; the sweep itself already succeeded.
      }
    },
    [tipJar, fetchTokenSnapshot],
  );

  // ⚠️ ACTIVE_CHAIN here is useDao.js's own object (chainId/rpcUrls/
  // blockExplorerUrls), NOT a wagmi network object — so we take the
  // link from blockExplorerUrls[0], not blockExplorers.default.url
  // (that path is always undefined on this object).
  const explorer = ACTIVE_CHAIN?.blockExplorerUrls?.[0];
  const nativeSymbol = ACTIVE_CHAIN?.nativeCurrency?.symbol || "ETH";

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigris uppercase mb-2">
        {t("dao.treasury.title")}
      </div>
      <h1 className="font-display text-3xl text-parchment mb-2">{t("dao.treasury.title")}</h1>
      <p className="text-parchmentDim text-sm mb-8">
        {t("dao.treasury.description")}
      </p>

      {/* ── Free ETH balance ("direct grant") ─────────────────── */}
      <BalanceCard
        icon={<Wallet size={16} />}
        title={t("dao.treasury.freeBalanceTitle")}
        subtitle={t("dao.treasury.freeBalanceSubtitle", { symbol: nativeSymbol })}
        value={loadingEth ? "…" : ethErr ? "—" : fmtNum(ethBalance, 4)}
        currency={nativeSymbol}
        error={ethErr}
      />

      {/* ── Geo-routed balance (STAGE 4 of the geo reform) ──────── */}
      {/* One card per configured currency (TREASURY_TOKENS) — Treasury's
          hexBalance/operationalBalance mappings are per-token, so every
          accepted currency gets its own independent breakdown. */}
      {TREASURY_TOKENS.map(({ key, address }) => {
        const data = tokenData[address];
        const symbol = data?.symbol || key;
        const decimals = data?.decimals ?? 6;
        return (
          <div key={address} className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
            <div className="flex items-center gap-2 font-display text-base text-parchment mb-1">
              <Landmark size={18} className="text-gold" />
              {t("dao.treasury.geoBalanceTitle")}
              <span className="ml-1 font-mono text-[11px] uppercase tracking-widest text-parchmentDim/80 border border-hairline rounded-full px-2 py-0.5">
                {symbol}
              </span>
            </div>
            <p className="text-parchmentDim text-sm mb-4">
              {t("dao.treasury.geoBalanceDesc", { token: symbol })}
            </p>

            {!dao?.isConnected ? (
              <p className="font-mono text-xs text-parchmentDim">
                {t("dao.treasury.connectForBreakdown")}
              </p>
            ) : !data || data.loading || !data.hexData ? (
              <p className="font-mono text-xs text-parchmentDim">
                {data?.error ? t("dao.treasury.ethError") : t("dao.treasury.loading")}
              </p>
            ) : (
              <div className="grid gap-3">
                <SubBalanceRow
                  icon={<Landmark size={13} className="text-gold" />}
                  label={t("dao.treasury.operationalFund")}
                  value={fmtNum(ethers.formatUnits(data.hexData.operationalBalance, decimals))}
                  currency={symbol}
                />
                {data.hexData.hexBalances.map((h) => (
                  <SubBalanceRow
                    key={`${h.level}-${h.branchId}`}
                    icon={
                      h.level < 0 ? (
                        <Globe2 size={13} className="text-verdigrisBright" />
                      ) : (
                        <Landmark size={13} className="text-parchmentDim" />
                      )
                    }
                    label={h.label}
                    value={fmtNum(ethers.formatUnits(h.balance, decimals))}
                    currency={symbol}
                  />
                ))}
                <p className="font-mono text-[12px] text-parchmentDim/70 mt-1">
                  {t("dao.treasury.earmarkedNote")}
                </p>

                {/* Genesis-fairness escrow: pool share of tips made before
                    Treasury had TIPJAR_ROLE is stuck in TipJar itself until
                    someone (anyone) calls sweepEscrowToTreasury(). */}
                {data.escrowed > 0n && (
                  <div className="mt-2 rounded-xl border border-gold/40 bg-gold/5 p-3">
                    <p className="font-mono text-[12px] text-parchment leading-relaxed">
                      {t("dao.treasury.escrowNotice", {
                        amount: fmtNum(ethers.formatUnits(data.escrowed, decimals)),
                        symbol,
                      })}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleSweep(address)}
                      disabled={sweepState[address]?.pending}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-gold/60 px-3 py-1 font-mono text-[11px] uppercase tracking-widest text-gold hover:bg-gold/10 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ArrowRightLeft size={12} />
                      {sweepState[address]?.pending
                        ? t("dao.treasury.sweeping")
                        : t("dao.treasury.sweepButton")}
                    </button>
                    {sweepState[address]?.error && (
                      <p className="mt-1.5 font-mono text-[11px] text-seal">
                        {t("dao.treasury.sweepFailed", { error: sweepState[address].error })}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* ── Contract address ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-1">
              {t("dao.treasury.contractAddress")}
            </div>
            <div className="font-mono text-sm text-parchment">{truncAddr(CONTRACTS.treasury)}</div>
          </div>
          {explorer && (
            <a
              href={`${explorer}/address/${CONTRACTS.treasury}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-xs text-verdigris hover:text-verdigrisBright shrink-0"
            >
              {t("dao.treasury.explorer")}
            </a>
          )}
        </div>
      </div>

      <p className="font-mono text-xs text-parchmentDim leading-relaxed">
        {t("dao.treasury.footerNote")}
      </p>
    </div>
  );
}

function BalanceCard({ icon, title, subtitle, value, currency, error }) {
  return (
    <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
      <div className="flex items-center gap-2 font-display text-base text-parchment mb-1">
        {icon}
        {title}
      </div>
      <p className="text-parchmentDim text-sm mb-4">{subtitle}</p>
      <div className="flex items-baseline gap-2">
        <div className="font-display text-4xl text-parchment num-tabular">{value}</div>
        <div className="font-mono text-sm text-parchmentDim uppercase">{currency}</div>
      </div>
      {error && <p className="mt-2 font-mono text-xs text-seal">{error}</p>}
    </div>
  );
}

function SubBalanceRow({ icon, label, value, currency }) {
  return (
    <div className="flex items-center justify-between font-mono text-xs">
      <span className="flex items-center gap-1.5 text-parchment">
        {icon}
        {label}
      </span>
      <span className="text-parchmentDim num-tabular">
        {value} <span className="text-parchmentDim/60 uppercase">{currency}</span>
      </span>
    </div>
  );
}
