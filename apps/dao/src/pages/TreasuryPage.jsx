import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ethers } from "ethers";
import { Landmark, Globe2, Wallet } from "lucide-react";
import { CONTRACTS, ACTIVE_CHAIN } from "../hooks/useDao";
import { fmtNum, truncAddr } from "../lib/format";

export default function TreasuryPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const [ethBalance, setEthBalance] = useState(null);
  const [loadingEth, setLoadingEth] = useState(true);
  const [ethErr, setEthErr] = useState(null);

  const [hexData, setHexData] = useState(null);
  const [loadingHex, setLoadingHex] = useState(false);
  const [tokenDecimals, setTokenDecimals] = useState(6); // default tUSD (Deploy.s.sol: 6)
  const [tokenSymbol, setTokenSymbol] = useState("tUSD");

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

  useEffect(() => {
    if (!dao?.isConnected || !dao.loadHexTreasuryBalances) return;
    let cancelled = false;
    setLoadingHex(true);
    const tokenRead = new ethers.Contract(
      CONTRACTS.testTokenUSD,
      [
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)",
      ],
      new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]),
    );
    Promise.all([
      dao.loadHexTreasuryBalances(CONTRACTS.testTokenUSD),
      tokenRead.decimals().catch(() => 6),
      tokenRead.symbol().catch(() => "tUSD"),
    ])
      .then(([res, dec, sym]) => {
        if (!cancelled) {
          setHexData(res);
          setTokenDecimals(Number(dec));
          setTokenSymbol(sym);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingHex(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao?.isConnected, dao?.locationInfo]);

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
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="flex items-center gap-2 font-display text-base text-parchment mb-1">
          <Landmark size={18} className="text-gold" />
          {t("dao.treasury.geoBalanceTitle")}
        </div>
        <p className="text-parchmentDim text-sm mb-4">
          {t("dao.treasury.geoBalanceDesc", { token: tokenSymbol })}
        </p>

        {!dao?.isConnected ? (
          <p className="font-mono text-xs text-parchmentDim">
            {t("dao.treasury.connectForBreakdown")}
          </p>
        ) : loadingHex || !hexData ? (
          <p className="font-mono text-xs text-parchmentDim">{t("dao.treasury.loading")}</p>
        ) : (
          <div className="grid gap-3">
            <SubBalanceRow
              icon={<Landmark size={13} className="text-gold" />}
              label={t("dao.treasury.operationalFund")}
              value={fmtNum(ethers.formatUnits(hexData.operationalBalance, tokenDecimals))}
              currency={tokenSymbol}
            />
            {hexData.hexBalances.map((h) => (
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
                value={fmtNum(ethers.formatUnits(h.balance, tokenDecimals))}
                currency={tokenSymbol}
              />
            ))}
            <p className="font-mono text-[12px] text-parchmentDim/70 mt-1">
              {t("dao.treasury.earmarkedNote")}
            </p>
          </div>
        )}
      </div>

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
