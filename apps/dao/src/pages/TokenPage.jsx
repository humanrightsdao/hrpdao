import { useEffect, useState } from "react";
import { useOutletContext, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Award, ExternalLink, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { fmtNum, fmtDuration, fmtDateTime, fmtRelative } from "../lib/format";
import { tDaoMessage } from "../lib/daoMessages";

// The same document as in Documentation (MATERIALS → "Human Rights
// Policy — full text"). Kept separate here because this page has its
// own functional context (accepting the policy), not just a link in
// a list of materials.
const POLICY_URL = "https://ipfs.io/ipfs/QmfZ4Qg1XiR6Y1Lnm4fnykWi6EhpwmkVSzzVNiiQS6YMSF/";

// The "Get SHIELD/COUNCIL" buttons used to live on the Business Card
// page — a logically unrelated action (that page generates a QR
// code). Here all the requirements for getting the token are
// gathered in one place: Influence, Human Passport score,
// accepting the Human Rights Policy, and the mint buttons themselves.
export default function TokenPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    dao.refreshTokenStatus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  if (!dao.isConnected) {
    return (
      <div className="fade-rise max-w-2xl">
        <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
          {t("dao.token.membership")}
        </div>
        <h1 className="font-display font-semibold text-3xl text-parchment mb-6 flex items-center gap-3">
          <Award size={26} className="text-verdigrisBright" />
          {t("dao.token.title")}
        </h1>
        <p className="font-mono text-sm text-parchmentDim">
          {t("dao.token.connectPrompt")}
        </p>
      </div>
    );
  }

  const shieldElig = dao.shieldEligibility?.();
  const councilElig = dao.councilEligibility?.();

  const shieldThreshold = dao.shieldInfo?.rightsThreshold ?? 200;
  const councilThreshold = dao.councilInfo?.rightsThreshold ?? shieldThreshold;
  const rights = dao.rights ?? 0;

  const shieldScore = dao.shieldInfo?.humanityScore ?? 0;
  const shieldMinScore = dao.shieldInfo?.minHumanityScore ?? 0;
  const scoreOk = dao.shieldInfo ? shieldScore >= shieldMinScore : false;

  const policyAccepted = dao.hasShield && dao.shieldInfo?.hasAcceptedPolicy === true;
  const policyOutdated = dao.hasShield && dao.shieldInfo?.hasAcceptedPolicy === false;

  async function handleMintShield() {
    setBusy(true);
    setMsg(null);
    const res = await dao.mintShield((p) => setMsg(tDaoMessage(t, p)));
    setMsg(res.success ? t("dao.token.shieldIssued") : tDaoMessage(t, res.error));
    setBusy(false);
  }

  async function handleMintCouncil() {
    setBusy(true);
    setMsg(null);
    const res = await dao.mintCouncil((p) => setMsg(tDaoMessage(t, p)));
    setMsg(res.success ? t("dao.token.councilIssued") : tDaoMessage(t, res.error));
    setBusy(false);
  }

  async function handleReaccept() {
    setBusy(true);
    setMsg(null);
    const res = await dao.reacceptPolicy((p) => setMsg(tDaoMessage(t, p)));
    setMsg(res.success ? t("dao.token.policyAcceptedMsg") : tDaoMessage(t, res.error));
    setBusy(false);
  }

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.token.membership")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-8 flex items-center gap-3">
        <Award size={26} className="text-verdigrisBright" />
        {t("dao.token.title")}
      </h1>

      {/* ── Influence and progress toward thresholds ────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="grid grid-cols-2 gap-4 mb-6">
          <div>
            <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-1">
              {t("dao.token.influence")}
            </div>
            <div className="font-display text-3xl text-parchment num-tabular">
              {fmtNum(rights)}
            </div>
          </div>
          <div title={t("dao.token.votingPowerTooltip")}>
            <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-1">
              {t("dao.token.votingPower")}
            </div>
            <div className="font-display text-3xl text-parchment num-tabular">
              {dao.votingPower !== null && dao.votingPower !== undefined
                ? fmtNum(dao.votingPower)
                : "…"}
            </div>
          </div>
        </div>

        <ThresholdBar
          label={t("dao.token.toShield")}
          current={rights}
          threshold={shieldThreshold}
          achieved={dao.hasShield}
          color="#3B7DFF"
          t={t}
        />
        <div className="h-4" />
        <ThresholdBar
          label={t("dao.token.toCouncil")}
          current={rights}
          threshold={councilThreshold}
          achieved={dao.hasCouncil}
          color="#C9A227"
          t={t}
        />

        {/* SHIELD → COUNCIL time requirement. requiredCouncilDurationSeconds
            is read directly from the contract (ShieldSBT.requiredCouncilDuration) —
            the same field works correctly both on testnet (a matter of
            minutes) and on a future mainnet (tens of days), with no
            hardcoded duration. */}
        {dao.hasShield && !dao.hasCouncil && dao.shieldInfo?.memberSince && (
          <>
            <div className="h-4" />
            <CouncilCooldownBar shieldInfo={dao.shieldInfo} t={t} />
          </>
        )}
      </div>

      {/* ── Human Passport score ─────────────────────────────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="font-display text-base text-parchment mb-1">{t("dao.token.humanPassportScore")}</div>
        <p className="text-parchmentDim text-sm mb-4">
          {t("dao.token.scoreDescription")}
        </p>
        <div className="flex items-center justify-between font-mono text-sm mb-1">
          <span className="text-parchmentDim">{t("dao.token.yourScore")}</span>
          <span className={scoreOk ? "text-verdigrisBright" : "text-parchment"}>
            {(shieldScore / 100).toFixed(2)}
          </span>
        </div>
        <div className="flex items-center justify-between font-mono text-sm">
          <span className="text-parchmentDim">{t("dao.token.minimumForShield")}</span>
          <span className="text-parchment">{(shieldMinScore / 100).toFixed(2)}</span>
        </div>
        {!scoreOk && (
          <Link
            to="/verification"
            className="inline-flex items-center gap-1.5 mt-4 font-mono text-xs text-verdigris hover:text-verdigrisBright"
          >
            {t("dao.token.getVerified")} <ExternalLink size={12} />
          </Link>
        )}
      </div>

      {/* ── Human Rights Policy ───────────────────────────────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="font-display text-base text-parchment mb-1">
          {t("dao.token.policyTitle")}
        </div>
        <p className="text-parchmentDim text-sm mb-4">
          {t("dao.token.policyDescription")}
        </p>
        <a
          href={POLICY_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-xs text-verdigris hover:text-verdigrisBright mb-4"
        >
          {t("dao.token.readFullText")} <ExternalLink size={12} />
        </a>

        {policyAccepted && (
          <div className="flex items-center gap-2 font-mono text-xs text-verdigrisBright">
            <CheckCircle2 size={14} />
            {t("dao.token.policyAccepted", { version: dao.shieldInfo.policyVersion })}
          </div>
        )}
        {policyOutdated && (
          <div>
            <div className="flex items-center gap-2 font-mono text-xs text-gold mb-3">
              <AlertTriangle size={14} />
              {t("dao.token.policyOutdated")}
            </div>
            <button
              onClick={handleReaccept}
              disabled={busy}
              className="font-mono text-xs px-3 py-1.5 border border-verdigris text-verdigrisBright rounded-full hover:bg-verdigris/10 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? t("dao.token.accepting") : t("dao.token.acceptUpdatedPolicy")}
            </button>
          </div>
        )}
        {!dao.hasShield && (
          <p className="font-mono text-xs text-parchmentDim">
            {t("dao.token.willSignAutomatically")}
          </p>
        )}
      </div>

      {/* ── Membership actions ───────────────────────────── */}
      <div className="rounded-2xl border border-hairline p-6 sm:p-8 mb-6">
        <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-4">
          {t("dao.token.actions")}
        </div>
        <MembershipRow
          title={t("dao.token.shieldGuardian")}
          active={dao.hasShield}
          elig={shieldElig}
          onMint={handleMintShield}
          busy={busy}
          t={t}
        />
        <div className="h-px bg-hairline my-5" />
        <MembershipRow
          title={t("dao.token.councilTitle")}
          active={dao.hasCouncil}
          elig={councilElig}
          onMint={handleMintCouncil}
          busy={busy}
          t={t}
        />
      </div>

      {dao.isRestricted && (
        <div className="border border-seal/40 bg-seal/5 rounded-sm p-4 mb-6">
          <p className="font-mono text-xs text-sealBright">
            {t("dao.token.accountRestricted", { count: dao.blackMarks })}
          </p>
        </div>
      )}

      {msg && (
        <p className="font-mono text-xs text-parchmentDim border-t border-hairline pt-4">{msg}</p>
      )}
    </div>
  );
}

function CouncilCooldownBar({ shieldInfo, t }) {
  const requiredSec = shieldInfo.requiredCouncilDurationSeconds ?? 0;
  const elapsedSec = Math.max(0, Date.now() / 1000 - shieldInfo.memberSince);
  const unlockAt = shieldInfo.memberSince + requiredSec;
  const done = elapsedSec >= requiredSec;
  const pct = requiredSec > 0 ? Math.min(100, (elapsedSec / requiredSec) * 100) : 100;

  return (
    <div>
      <div className="flex items-center justify-between font-mono text-[12px] mb-1.5">
        <span className="text-parchmentDim flex items-center gap-1.5">
          <Clock size={11} />
          {t("dao.token.timeAsShield")}
        </span>
        <span className={done ? "text-verdigrisBright" : "text-parchmentDim"}>
          {done
            ? t("dao.token.requirementMet")
            : `${fmtDuration(elapsedSec)} / ${fmtDuration(requiredSec)}`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface2 overflow-hidden mb-1.5">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${done ? 100 : pct}%`, background: "#C9A227" }}
        />
      </div>
      <div className="font-mono text-[12px] text-parchmentDim">
        {t("dao.token.memberSince", { date: fmtDateTime(shieldInfo.memberSince) })}
        {!done && (
          <>
            {" · "}
            {t("dao.token.councilUnlocks", { time: fmtRelative(unlockAt), date: fmtDateTime(unlockAt) })}
          </>
        )}
      </div>
    </div>
  );
}

function ThresholdBar({ label, current, threshold, achieved, color, t }) {
  const pct = threshold > 0 ? Math.min(100, (current / threshold) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between font-mono text-[12px] mb-1.5">
        <span className="text-parchmentDim">{label}</span>
        <span className={achieved ? "text-verdigrisBright" : "text-parchmentDim"}>
          {achieved ? t("dao.token.obtained") : `${fmtNum(current)} / ${fmtNum(threshold)}`}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-surface2 overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${achieved ? 100 : pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

function MembershipRow({ title, active, elig, onMint, busy, t }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="font-display text-base text-parchment">{title}</div>
        {!active && elig && !elig.eligible && (
          <div className="font-mono text-[12px] text-parchmentDim mt-0.5">{elig.reason}</div>
        )}
      </div>
      {active ? (
        <span className="status-stamp" style={{ "--stamp-color": "#6FA98A" }}>
          {t("dao.token.obtainedBadge")}
        </span>
      ) : (
        <button
          onClick={onMint}
          disabled={busy || !elig?.eligible}
          className="font-mono text-xs px-3 py-1.5 border border-verdigris text-verdigrisBright rounded-full hover:bg-verdigris/10 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          {busy ? "…" : t("dao.token.getButton")}
        </button>
      )}
    </div>
  );
}
