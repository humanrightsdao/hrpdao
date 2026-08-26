import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  MapPin,
  CheckCircle2,
  Lock,
  ShieldAlert,
  Clock,
  Globe2,
} from "lucide-react";
import { fmtDuration } from "../lib/format";
import { tDaoMessage } from "../lib/daoMessages";

// Maximum resolution (MAX_RESOLUTION from LocationRegistry.sol) — we
// declare right away at the deepest level (the raw hexId never appears
// on-chain anyway, only the commitment), and reveal SEPARATELY, only
// the levels that are needed.
const DECLARE_RESOLUTION = 10;

// NODE_CAPACITY from CouncilRankingEpoch.sol — how many Council members
// a node needs to be considered "overflowed" (active) and for deeper
// cascade levels to become available for reveal.
const NODE_CAPACITY = 244;

export default function LocationPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [revealLevel, setRevealLevel] = useState(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [manualLat, setManualLat] = useState("");
  const [manualLng, setManualLng] = useState("");
  const [revealable, setRevealable] = useState(null); // { levels, earthOverflowed } from computeRevealableLevels()

  useEffect(() => {
    dao.refreshTokenStatus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  const info = dao.locationInfo;
  const effective = dao.myEffectiveHex;

  // ⚠️ BUG (fixed): this useEffect used to come AFTER the conditional
  // `return` for the !dao.isConnected case — meaning the number of
  // hooks called differed between renders (1 hook when the wallet
  // isn't connected, 2 when it is). React requires hooks to be called
  // in the SAME number and order on every render. This is exactly
  // what caused the "Rendered fewer hooks than expected" error on
  // page reload: first isConnected=false (the wallet hasn't
  // auto-connected yet), 1 hook renders; a moment later wagmi
  // restores the connection, isConnected becomes true, and on that
  // render React tries to call 2 hooks — a conflict. Now all hooks
  // come BEFORE any conditional return.
  useEffect(() => {
    if (!info?.hasDeclared) {
      setRevealable(null);
      return;
    }
    let cancelled = false;
    dao.computeRevealableLevels?.().then((res) => {
      if (!cancelled) setRevealable(res);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info?.hasDeclared, info?.revealedLevels?.length]);

  const resolutionDesc = (lvl) => t(`dao.location.resolutions.${lvl}`);

  if (!dao.isConnected) {
    return (
      <div className="fade-rise max-w-2xl">
        <Header t={t} />
        <p className="font-mono text-sm text-parchmentDim">
          {t("dao.location.connectPrompt")}
        </p>
      </div>
    );
  }

  const revealableChoices =
    revealable?.levels?.filter(
      (lvl) => !info?.revealedLevels?.some((r) => r.level === lvl),
    ) ?? [];

  async function handleDeclare() {
    setBusy(true);
    setMsg(null);
    const res = await dao.declareLocation(DECLARE_RESOLUTION, (p) => setMsg(tDaoMessage(t, p)));
    if (!res.success) setMsg(`${t("dao.errors.prefix")} ${tDaoMessage(t, res.error)}`);
    setBusy(false);
  }

  async function handleDeclareManual() {
    const lat = parseFloat(manualLat);
    const lng = parseFloat(manualLng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      setMsg(t("dao.location.invalidCoords"));
      return;
    }
    setBusy(true);
    setMsg(null);
    const res = await dao.declareLocation(
      DECLARE_RESOLUTION,
      (p) => setMsg(tDaoMessage(t, p)),
      { latitude: lat, longitude: lng },
    );
    if (!res.success) setMsg(`${t("dao.errors.prefix")} ${tDaoMessage(t, res.error)}`);
    setBusy(false);
  }

  async function handleReveal(level) {
    setBusy(true);
    setMsg(null);
    const res = await dao.revealLocationLevel(level, (p) => setMsg(tDaoMessage(t, p)));
    if (!res.success) setMsg(`${t("dao.errors.prefix")} ${tDaoMessage(t, res.error)}`);
    setBusy(false);
    setRevealLevel(null);
  }

  const cooldownActive = (info?.cooldownSec ?? 0) > 0;

  return (
    <div className="fade-rise max-w-2xl">
      <Header t={t} />

      {/* ── How it works ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="flex items-start gap-3">
          <Globe2 size={20} className="text-verdigrisBright shrink-0 mt-0.5" />
          <div>
            <p className="text-parchmentDim text-sm leading-relaxed">
              {t("dao.location.howItWorks1")}
            </p>
            <p className="text-parchmentDim text-sm leading-relaxed mt-2">
              {t("dao.location.howItWorks2")}
            </p>
          </div>
        </div>
      </div>

      {/* ── Privacy (ZK) ─────────────────────────────────────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="flex items-start gap-3">
          <Lock size={20} className="text-gold shrink-0 mt-0.5" />
          <div>
            <div className="font-display text-base text-parchment mb-1">
              {t("dao.location.privacyTitle")}
            </div>
            <p className="text-parchmentDim text-sm leading-relaxed">
              {t("dao.location.privacyDesc")}
            </p>
            <p className="font-mono text-[12px] text-parchmentDim/70 mt-3">
              {t("dao.location.privacyTestnetNote")}
            </p>
          </div>
        </div>
      </div>

      {/* ── Declaration status ───────────────────────────────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-4">
          {t("dao.location.yourLocation")}
        </div>

        {!info?.hasDeclared ? (
          <>
            <p className="text-parchmentDim text-sm mb-4">
              {t("dao.location.noLocationYet")}
            </p>
            <button
              onClick={handleDeclare}
              disabled={busy}
              className="font-mono text-xs px-4 py-2 border border-verdigris text-verdigrisBright rounded-full hover:bg-verdigris/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "…" : t("dao.location.setLocation")}
            </button>
            <p className="font-mono text-[12px] text-parchmentDim/70 mt-3">
              {t("dao.location.browserWillAsk", { resolution: DECLARE_RESOLUTION, desc: resolutionDesc(DECLARE_RESOLUTION) })}
            </p>

            <div className="mt-5 pt-5 border-t border-hairline">
              {!showManualEntry ? (
                <button
                  onClick={() => setShowManualEntry(true)}
                  className="font-mono text-[12px] text-parchmentDim hover:text-parchment underline decoration-dotted"
                >
                  {t("dao.location.manualEntryPrompt")}
                </button>
              ) : (
                <>
                  <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-3">
                    {t("dao.location.manualEntryTitle")}
                  </div>
                  <p className="font-mono text-[12px] text-parchmentDim/70 mb-3">
                    {t("dao.location.manualEntryHint")}
                  </p>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <input
                      type="number"
                      step="any"
                      placeholder={t("dao.location.latitudePlaceholder")}
                      value={manualLat}
                      onChange={(e) => setManualLat(e.target.value)}
                      className="font-mono text-xs bg-surface2 border border-hairline rounded-md px-3 py-2 text-parchment"
                    />
                    <input
                      type="number"
                      step="any"
                      placeholder={t("dao.location.longitudePlaceholder")}
                      value={manualLng}
                      onChange={(e) => setManualLng(e.target.value)}
                      className="font-mono text-xs bg-surface2 border border-hairline rounded-md px-3 py-2 text-parchment"
                    />
                  </div>
                  <button
                    onClick={handleDeclareManual}
                    disabled={busy || !manualLat || !manualLng}
                    className="font-mono text-xs px-4 py-2 border border-gold text-gold rounded-full hover:bg-gold/10 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {busy ? "…" : t("dao.location.declareWithCoords")}
                  </button>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 font-mono text-xs text-verdigrisBright mb-4">
              <CheckCircle2 size={14} />
              {t("dao.location.locationDeclared")}
            </div>

            <div className="font-mono text-xs text-parchmentDim mb-1">
              {t("dao.location.currentLevel")}
            </div>
            <div className="font-display text-2xl text-parchment mb-4">
              {effective && effective.level >= 0
                ? t("dao.location.level", { n: effective.level })
                : t("dao.location.earthGlobal")}
            </div>

            {cooldownActive && (
              <div className="flex items-center gap-2 font-mono text-[12px] text-parchmentDim mb-4">
                <Clock size={12} />
                {t("dao.location.nextChangePossible", { time: fmtDuration(info.cooldownSec) })}
              </div>
            )}

            <div className="h-px bg-hairline my-5" />

            <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-3">
              {t("dao.location.revealedLevels")}
            </div>
            {info.revealedLevels.length === 0 ? (
              <p className="text-parchmentDim text-sm mb-4">
                {t("dao.location.noLevelsRevealed")}
              </p>
            ) : (
              <ul className="space-y-2 mb-4">
                {info.revealedLevels.map(({ level, branchId }) => (
                  <li
                    key={level}
                    className="flex items-center justify-between font-mono text-xs text-parchment"
                  >
                    <span>{t("dao.location.level", { n: level })}</span>
                    <span className="text-parchmentDim">
                      {t("dao.location.branchId", { id: branchId.slice(0, 10) })}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {!revealable ? (
              <p className="font-mono text-xs text-parchmentDim">
                {t("dao.location.checkingLevels")}
              </p>
            ) : !revealable.earthOverflowed ? (
              <div className="rounded-xl border border-hairline p-4">
                <p className="font-mono text-xs text-parchmentDim leading-relaxed">
                  {t("dao.location.notOverflowedNote", { capacity: NODE_CAPACITY })}
                </p>
              </div>
            ) : revealableChoices.length === 0 ? (
              <div className="rounded-xl border border-hairline p-4">
                <p className="font-mono text-xs text-parchmentDim leading-relaxed">
                  {t("dao.location.allRevealedNote", { capacity: NODE_CAPACITY })}
                </p>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <select
                  value={revealLevel ?? ""}
                  onChange={(e) => setRevealLevel(Number(e.target.value))}
                  className="font-mono text-xs bg-surface2 border border-hairline rounded-md px-3 py-2 text-parchment"
                >
                  <option value="" disabled>
                    {t("dao.location.selectLevel")}
                  </option>
                  {revealableChoices.map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {t("dao.location.level", { n: lvl })} ({resolutionDesc(lvl)})
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => revealLevel !== null && handleReveal(revealLevel)}
                  disabled={busy || revealLevel === null}
                  className="font-mono text-xs px-3 py-2 border border-gold text-gold rounded-full hover:bg-gold/10 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                >
                  {busy ? "…" : t("dao.location.revealButton")}
                </button>
              </div>
            )}
            <p className="font-mono text-[12px] text-parchmentDim/70 mt-2">
              {t("dao.location.revealNote")}
            </p>
          </>
        )}

        {dao.isRestricted && (
          <div className="flex items-center gap-2 font-mono text-xs text-sealBright mt-4">
            <ShieldAlert size={14} />
            {t("dao.location.accountRestricted")}
          </div>
        )}

        {msg && (
          <p className="font-mono text-xs text-parchmentDim border-t border-hairline pt-4 mt-4">
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

function Header({ t }) {
  return (
    <>
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.location.membership")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-8 flex items-center gap-3">
        <MapPin size={26} className="text-gold" />
        {t("dao.location.title")}
      </h1>
    </>
  );
}
