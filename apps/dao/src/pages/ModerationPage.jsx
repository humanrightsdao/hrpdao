import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldAlert, Flag, Loader2, ExternalLink, Ban } from "lucide-react";
import { tDaoMessage } from "../lib/daoMessages";
import SanctionProposalCard from "../components/SanctionProposalCard";
import { pool, RELAYS } from "../lib/nostrLookup";
import { useNostrIdentity } from "../hooks/useNostrIdentity";
import { truncAddr, fmtRelative } from "../lib/format";
import {
  fetchAllForumReports,
  fetchAllForumModActions,
  publishModAction,
  computeModerationState,
  computeBanState,
  MOD_ACTIONS,
  CRITICAL_CONFIRM_REQUIRED,
  BAN_QUORUM_PCT,
} from "../lib/forumModeration";

const SANCTION_TYPE_OPTIONS = [0, 1, 2]; // Warning, PartialRestriction, FullSlash
const RESTRICTION_PERIOD_OPTIONS = [0, 1, 2]; // Quarter, Year, FiveYears

const REPORT_CATEGORY_LABEL_KEYS = {
  hate_speech: "categoryHateSpeech",
  violence_incitement: "categoryViolenceIncitement",
  harassment: "categoryHarassment",
  csam_or_minors: "categoryCsamOrMinors",
  misinformation: "categoryMisinformation",
  spam: "categorySpam",
  other: "categoryOther",
};

export default function ModerationPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const highlightId = searchParams.get("case");
  // Two views of the same overall accountability system, merged onto one
  // page instead of a separate nav item: on-chain Sanction Proposals
  // (binding, Shield-vote + Council-veto) and the forum's own report
  // queue (app-level blur/hide/ban-vote — see forumModeration.js). The
  // "Escalate to Sanction" action below moves a case from the second
  // into the first.
  const [tab, setTab] = useState(searchParams.get("tab") === "forum" ? "forum" : "sanctions");

  const [showForm, setShowForm] = useState(false);
  const [targetAddress, setTargetAddress] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [sanctionType, setSanctionType] = useState(0);
  const [restrictionPeriod, setRestrictionPeriod] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(null);
  const [submitResult, setSubmitResult] = useState(null);

  const [actionLoading, setActionLoading] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [overrides, setOverrides] = useState({});

  useEffect(() => {
    dao.loadSanctionProposals?.();
    // Same fix as in ProposalsPage.jsx/HomePage.jsx.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  // Deep link (e.g. from an external tool, or a bookmarked/shared URL):
  // ?target=<address>&evidence=<ref>&tab=forum — prefills a NEW sanction
  // proposal instead of highlighting an existing one. The in-page
  // "Escalate to Sanction" button in the forum tab below sets the same
  // state directly rather than round-tripping through the URL, but this
  // keeps the link shareable/bookmarkable too.
  useEffect(() => {
    const target = searchParams.get("target");
    const evidence = searchParams.get("evidence");
    if (target) setTargetAddress(target);
    if (evidence) setEvidenceRef(evidence);
    if (target || evidence) {
      setShowForm(true);
      setTab("sanctions");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If we arrived via a "View in DAO" deep link from Dossier
  // (?case=<id>), make sure the create-form isn't in the way — a deep
  // link means someone is here to look at an EXISTING case, not create
  // one. The case itself renders from the list below once loaded.
  useEffect(() => {
    if (highlightId) setShowForm(false);
  }, [highlightId]);

  const list = dao.sanctionProposals || [];
  const visible = list.map((p) => overrides[p.id] || p);

  const refresh = async (id) => {
    const fresh = await dao.getSanctionProposal(id);
    if (fresh) setOverrides((prev) => ({ ...prev, [id]: fresh }));
  };

  const elig = dao.canProposeSanction ? dao.canProposeSanction() : { eligible: false };

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitResult(null);
    const res = await dao.proposeSanction(
      targetAddress.trim(),
      evidenceRef.trim(),
      sanctionType,
      restrictionPeriod,
      setProgress,
    );
    setSubmitResult(res);
    setSubmitting(false);
    if (res.success) {
      setTargetAddress("");
      setEvidenceRef("");
      dao.loadSanctionProposals?.();
    }
  }

  const handleShieldVote = async (id, choice) => {
    setActionLoading(id + "-shield-vote");
    setActionError(null);
    const res = await dao.voteShieldSanction(id, choice, () => {});
    setActionLoading(null);
    if (!res.success) setActionError(tDaoMessage(t, res.error));
    else await refresh(id);
  };

  const handleFinalize = async (id) => {
    setActionLoading(id + "-finalize");
    setActionError(null);
    const res = await dao.finalizeSanctionShieldVote(id, () => {});
    setActionLoading(null);
    if (!res.success) setActionError(tDaoMessage(t, res.error));
    else await refresh(id);
  };

  const handleVeto = async (id) => {
    setActionLoading(id + "-veto");
    setActionError(null);
    const res = await dao.vetoSanction(id, () => {});
    setActionLoading(null);
    if (!res.success) setActionError(tDaoMessage(t, res.error));
    else await refresh(id);
  };

  const handleExecute = async (id) => {
    setActionLoading(id + "-execute-sanction");
    setActionError(null);
    const res = await dao.executeSanction(id, () => {});
    setActionLoading(null);
    if (!res.success) setActionError(tDaoMessage(t, res.error));
    else await refresh(id);
  };

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.moderation.title")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-2 flex items-center gap-3">
        <ShieldAlert size={26} className="text-sealBright" />
        {t("dao.moderation.title")}
      </h1>
      <p className="text-parchmentDim text-sm mb-6">
        {t("dao.moderation.description")}
      </p>

      {/* ── Tabs ──────────────────────────────────────────────── */}
      <div className="flex gap-2 mb-6 border-b border-hairline">
        {[
          { id: "sanctions", label: t("dao.moderation.tabSanctions"), icon: ShieldAlert },
          { id: "forum", label: t("dao.moderation.tabForumReports"), icon: Flag },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => {
              setTab(id);
              setSearchParams((p) => {
                const next = new URLSearchParams(p);
                if (id === "forum") next.set("tab", "forum");
                else next.delete("tab");
                return next;
              });
            }}
            className={`flex items-center gap-1.5 px-4 py-2.5 font-mono text-xs border-b-2 -mb-px transition-colors ${
              tab === id
                ? "border-verdigris text-verdigrisBright"
                : "border-transparent text-parchmentDim hover:text-parchment"
            }`}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>

      {tab === "sanctions" ? (
        <SanctionsTab
          t={t}
          dao={dao}
          showForm={showForm}
          setShowForm={setShowForm}
          targetAddress={targetAddress}
          setTargetAddress={setTargetAddress}
          evidenceRef={evidenceRef}
          setEvidenceRef={setEvidenceRef}
          sanctionType={sanctionType}
          setSanctionType={setSanctionType}
          restrictionPeriod={restrictionPeriod}
          setRestrictionPeriod={setRestrictionPeriod}
          submitting={submitting}
          progress={progress}
          submitResult={submitResult}
          elig={elig}
          handleSubmit={handleSubmit}
          actionError={actionError}
          setActionError={setActionError}
          visible={visible}
          actionLoading={actionLoading}
          handleShieldVote={handleShieldVote}
          handleFinalize={handleFinalize}
          handleVeto={handleVeto}
          handleExecute={handleExecute}
          refresh={refresh}
        />
      ) : (
        <ForumReportsTab
          t={t}
          dao={dao}
          onEscalate={(address, evidence, sanctionTypeHint) => {
            setTargetAddress(address);
            setEvidenceRef(evidence);
            if (sanctionTypeHint !== undefined) setSanctionType(sanctionTypeHint);
            setShowForm(true);
            setTab("sanctions");
            setSearchParams((p) => {
              const next = new URLSearchParams(p);
              next.delete("tab");
              return next;
            });
          }}
        />
      )}

      <style>{`
        .input {
          width: 100%;
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 0.75rem;
          padding: 0.65rem 0.9rem;
          color: #F4F2ED;
          font-size: 0.875rem;
        }
        .input:focus {
          outline: none;
          border-color: #3B7DFF;
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
        {label}
      </label>
      {children}
    </div>
  );
}

// ── Tab 1: on-chain sanction proposals (unchanged from before) ────────
function SanctionsTab({
  t, dao, showForm, setShowForm, targetAddress, setTargetAddress, evidenceRef, setEvidenceRef,
  sanctionType, setSanctionType, restrictionPeriod, setRestrictionPeriod, submitting, progress,
  submitResult, elig, handleSubmit, actionError, setActionError, visible, actionLoading,
  handleShieldVote, handleFinalize, handleVeto, handleExecute, refresh,
}) {
  return (
    <>
      {/* ── New sanction proposal ─────────────────────────────── */}
      <div className="mb-8">
        {!showForm ? (
          <button
            onClick={() => setShowForm(true)}
            disabled={!dao.isConnected}
            className="px-4 py-2 rounded-full border border-verdigris text-verdigrisBright font-mono text-xs hover:bg-verdigris/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            + {t("dao.moderation.newCase")}
          </button>
        ) : (
          <form
            onSubmit={handleSubmit}
            className="rounded-2xl border border-hairline p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 className="font-display text-lg text-parchment">
                {t("dao.moderation.newCase")}
              </h2>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="font-mono text-xs text-parchmentDim hover:text-verdigrisBright"
              >
                {t("dao.moderation.newCaseHide")}
              </button>
            </div>

            {!dao.isConnected ? (
              <p className="font-mono text-xs text-sealBright">
                {t("dao.moderation.connectToPropose")}
              </p>
            ) : !elig.eligible ? (
              <p className="font-mono text-xs text-sealBright">
                {tDaoMessage(t, elig.reason) || t("dao.moderation.notEligible")}
              </p>
            ) : null}

            <Field label={t("dao.moderation.targetAddress")}>
              <input
                value={targetAddress}
                onChange={(e) => setTargetAddress(e.target.value)}
                required
                placeholder={t("dao.moderation.targetAddressPlaceholder")}
                className="input font-mono"
              />
            </Field>

            <Field label={t("dao.moderation.evidenceRef")}>
              <input
                value={evidenceRef}
                onChange={(e) => setEvidenceRef(e.target.value)}
                required
                placeholder={t("dao.moderation.evidenceRefPlaceholder")}
                className="input font-mono"
              />
              <p className="text-parchmentDim text-xs mt-1.5 leading-relaxed">
                {t("dao.moderation.evidenceRefNote")}
              </p>
            </Field>

            <Field label={t("dao.moderation.sanctionType")}>
              <select
                value={sanctionType}
                onChange={(e) => setSanctionType(Number(e.target.value))}
                className="input"
              >
                {SANCTION_TYPE_OPTIONS.map((v) => (
                  <option key={v} value={v}>
                    {t(
                      `dao.sanctionTypes.${["Warning", "PartialRestriction", "FullSlash"][v]}`,
                    )}
                  </option>
                ))}
              </select>
            </Field>

            {sanctionType === 1 && (
              <Field label={t("dao.moderation.restrictionPeriod")}>
                <select
                  value={restrictionPeriod}
                  onChange={(e) => setRestrictionPeriod(Number(e.target.value))}
                  className="input"
                >
                  {RESTRICTION_PERIOD_OPTIONS.map((v) => (
                    <option key={v} value={v}>
                      {t(
                        `dao.restrictionPeriods.${["Quarter", "Year", "FiveYears"][v]}`,
                      )}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            <button
              type="submit"
              disabled={
                submitting ||
                !dao.isConnected ||
                !elig.eligible ||
                !targetAddress ||
                !evidenceRef
              }
              className="px-5 py-2.5 rounded-full bg-gradient-to-r from-seal to-sealDeep text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting
                ? tDaoMessage(t, progress) || t("dao.moderation.submitting")
                : t("dao.moderation.submit")}
            </button>

            {submitResult && !submitResult.success && (
              <p className="font-mono text-xs text-sealBright">
                {t("dao.moderation.submitError", {
                  error: tDaoMessage(t, submitResult.error),
                })}
              </p>
            )}
          </form>
        )}
      </div>

      {/* ── Case list ──────────────────────────────────────────── */}
      {actionError && (
        <div className="rounded-xl border border-seal/40 bg-seal/5 px-4 py-3 mb-4 flex items-center justify-between">
          <p className="font-mono text-xs text-sealBright">✗ {actionError}</p>
          <button
            onClick={() => setActionError(null)}
            className="text-parchmentDim hover:text-parchment text-lg leading-none"
          >
            ×
          </button>
        </div>
      )}

      {dao.loadingSanctionProposals ? (
        <div className="py-16 text-center font-mono text-sm text-parchmentDim">
          {t("dao.moderation.loading")}
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-hairline p-8 text-center font-mono text-sm text-parchmentDim">
          {t("dao.moderation.noCases")}
        </div>
      ) : (
        <div className="space-y-3">
          {visible.map((p) => (
            <SanctionProposalCard
              key={p.id}
              p={p}
              hasShield={dao.hasShield}
              hasCouncil={dao.hasCouncil}
              actionLoading={actionLoading}
              onShieldVote={(choice) => handleShieldVote(p.id, choice)}
              onFinalizeShieldVote={() => handleFinalize(p.id)}
              onVeto={() => handleVeto(p.id)}
              onExecute={() => handleExecute(p.id)}
              onRefresh={() => refresh(p.id)}
            />
          ))}
        </div>
      )}

      <button
        onClick={() => dao.loadSanctionProposals?.()}
        disabled={dao.loadingSanctionProposals}
        className="mt-4 font-mono text-xs text-parchmentDim hover:text-verdigrisBright transition-colors disabled:opacity-40"
      >
        {t("dao.moderation.refresh")}
      </button>
    </>
  );
}

// ── Tab 2: forum report queue (was ForumModerationPage.jsx) ───────────
// See src/lib/forumModeration.js for the underlying Nostr read/write
// logic (ported from dossier-app's moderationActions.js). Visible to
// everyone (transparency), but action buttons only work for
// Shield/Council holders, same rule as posting itself.
function ForumReportsTab({ t, dao, onEscalate }) {
  const { getSignerPubkey, signEvent } = useNostrIdentity();

  const [reports, setReports] = useState([]);
  const [actions, setActions] = useState([]);
  const [targets, setTargets] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyKey, setBusyKey] = useState(null);
  const [actionError, setActionError] = useState(null);

  const canModerate = dao.hasShield || dao.hasCouncil;
  // Shield's totalSupply, NOT Shield+Council summed — Council is a
  // subset of Shield under the current minting model (same invariant
  // DaoGovernor.quorum() uses).
  const totalEligibleVoters = Number(dao.shieldInfo?.totalSupply || 0);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [rpts, acts] = await Promise.all([fetchAllForumReports(), fetchAllForumModActions()]);
      setReports(rpts);
      setActions(acts);

      const ids = [...new Set(rpts.map((r) => r.targetEventId))];
      const found = await pool.querySync(RELAYS, { ids });
      const byId = {};
      for (const eid of ids) {
        const ev = found.find((e) => e.id === eid);
        byId[eid] = ev
          ? { body: ev.content, address: ev.tags.find((tg) => tg[0] === "address")?.[1] || null }
          : "not_found";
      }
      setTargets(byId);
    } catch (e) {
      setError(e.message || "Failed to load the forum moderation queue.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const grouped = {};
  for (const r of reports) (grouped[r.targetEventId] ||= []).push(r);
  const groups = Object.entries(grouped).sort(
    (a, b) => Math.max(...b[1].map((r) => r.createdAt)) - Math.max(...a[1].map((r) => r.createdAt)),
  );

  async function handleAction(targetEventId, action) {
    setBusyKey(`${targetEventId}-${action}`);
    setActionError(null);
    const res = await publishModAction({ action, targetEventId, getSignerPubkey, signEvent, address: dao.account });
    setBusyKey(null);
    if (!res.success) return setActionError(tDaoMessage(t, res.error));
    setActions((prev) => [
      ...prev,
      { id: res.id, moderatorAddress: dao.account?.toLowerCase(), createdAt: Math.floor(Date.now() / 1000), action, targetEventId },
    ]);
  }

  async function handleBanVote(targetAddress) {
    const key = `ban-${targetAddress}`;
    setBusyKey(key);
    setActionError(null);
    const res = await publishModAction({
      action: MOD_ACTIONS.BAN_VOTE,
      targetAddress,
      getSignerPubkey,
      signEvent,
      address: dao.account,
    });
    setBusyKey(null);
    if (!res.success) return setActionError(tDaoMessage(t, res.error));
    setActions((prev) => [
      ...prev,
      {
        id: res.id,
        moderatorAddress: dao.account?.toLowerCase(),
        createdAt: Math.floor(Date.now() / 1000),
        action: MOD_ACTIONS.BAN_VOTE,
        targetAddress,
      },
    ]);
  }

  return (
    <>
      {!canModerate && (
        <p className="font-mono text-xs text-parchmentDim mb-6 rounded-xl border border-hairline p-3">
          {t("dao.forumModeration.readOnlyNotice")}
        </p>
      )}

      {loading && (
        <div className="flex items-center justify-center gap-2 py-10 text-parchmentDim">
          <Loader2 size={18} className="animate-spin" />
          <span className="font-mono text-sm">{t("dao.forumModeration.loading")}</span>
        </div>
      )}

      {error && <p className="font-mono text-xs text-sealBright mb-4">{error}</p>}
      {actionError && <p className="font-mono text-xs text-sealBright mb-4">{actionError}</p>}

      {!loading && groups.length === 0 && (
        <div className="rounded-2xl border border-hairline p-8 text-center font-mono text-sm text-parchmentDim">
          {t("dao.forumModeration.noReports")}
        </div>
      )}

      <div className="space-y-4">
        {groups.map(([targetEventId, groupReports]) => {
          const target = targets[targetEventId];
          const state = computeModerationState(actions, targetEventId, { reports });
          const banState =
            target && target !== "not_found" && target.address
              ? computeBanState(actions, target.address, totalEligibleVoters)
              : null;
          const iVoted =
            banState?.voters?.includes(dao.account?.toLowerCase());
          const busyPrefix = `${targetEventId}-`;

          return (
            <div key={targetEventId} className="rounded-2xl border border-hairline p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="font-mono text-[11px] text-parchmentDim">
                  {t("dao.forumModeration.reportCount", { count: groupReports.length })}
                  {target && target !== "not_found" && target.address && <> · {truncAddr(target.address)}</>}
                </div>
                <div className="flex items-center gap-2">
                  {state.hidden && (
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border border-sealBright text-sealBright">
                      {state.hiddenReason === "critical"
                        ? t("dao.forumModeration.stateCriticalHidden")
                        : t("dao.forumModeration.stateHidden")}
                    </span>
                  )}
                  {!state.hidden && state.blurred && (
                    <span className="font-mono text-[10px] px-2 py-0.5 rounded-full border border-gold text-gold">
                      {state.autoQuarantined
                        ? t("dao.forumModeration.stateAutoQuarantined")
                        : t("dao.forumModeration.stateBlurred")}
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-xl bg-surface2 p-3 mb-3">
                {target === "not_found" && (
                  <p className="font-mono text-xs text-parchmentDim italic">{t("dao.forumModeration.contentNotFound")}</p>
                )}
                {target && target !== "not_found" && (
                  <p className="text-parchment text-sm whitespace-pre-wrap line-clamp-4">{target.body}</p>
                )}
              </div>

              <div className="space-y-2 mb-4">
                {groupReports.map((r) => (
                  <div key={r.id} className="font-mono text-[11px] text-parchmentDim flex flex-wrap gap-x-2">
                    <span className="text-sealBright">
                      {t(`dao.forumReport.${REPORT_CATEGORY_LABEL_KEYS[r.category] || "categoryOther"}`)}
                    </span>
                    {r.description && <span>— {r.description}</span>}
                    <span className="ml-auto">
                      {r.reporterAddress ? truncAddr(r.reporterAddress) : t("dao.forumModeration.anonymousReporter")} · {fmtRelative(r.createdAt)}
                    </span>
                  </div>
                ))}
              </div>

              {state.autoQuarantined && (
                <p className="font-mono text-[11px] text-gold mb-3">
                  {t("dao.forumModeration.autoQuarantineNotice", { count: state.autoQuarantineDistinctReporters })}
                </p>
              )}

              {state.hiddenReason === "critical" && !state.criticalConfirmed && (
                <p className="font-mono text-[11px] text-gold mb-3">
                  {t("dao.forumModeration.criticalProgress", { have: state.criticalConfirmations.length, need: CRITICAL_CONFIRM_REQUIRED })}
                  {" · "}
                  {t("dao.forumModeration.criticalDeadline", { time: new Date(state.criticalDeadline).toLocaleString() })}
                </p>
              )}

              {/* ── Ban-vote progress (per author account) ────────── */}
              {banState && banState.voters.length > 0 && (
                <div className="rounded-lg border border-hairline p-3 mb-3">
                  <div className="flex items-center justify-between font-mono text-[11px] text-parchmentDim mb-1.5">
                    <span className="flex items-center gap-1.5">
                      <Ban size={12} className={banState.banned ? "text-sealBright" : ""} />
                      {t("dao.forumModeration.banVoteProgress", {
                        voters: banState.voters.length,
                        pct: banState.quorumPct.toFixed(0),
                      })}
                    </span>
                    {banState.banned && (
                      <span className="text-sealBright">{t("dao.forumModeration.banQuorumReached")}</span>
                    )}
                  </div>
                  <div className="h-1.5 rounded-full bg-surface2 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${banState.banned ? "bg-sealBright" : "bg-gold"}`}
                      style={{ width: `${Math.min(100, (banState.quorumPct / (BAN_QUORUM_PCT * 100)) * 100)}%` }}
                    />
                  </div>
                  {!banState.expired && (
                    <p className="font-mono text-[10px] text-parchmentDim mt-1.5">
                      {t("dao.forumModeration.banVotingDeadline", { time: new Date(banState.votingDeadline).toLocaleDateString() })}
                    </p>
                  )}
                  {/* This is the bridge to REAL cross-app enforcement.
                      A ban-vote quorum only ever stops posting HERE, on
                      THIS app's own Nostr log — Dossier has no way to
                      see it (see useForum.js's checkNotBanned() for the
                      full explanation). The one state both apps already
                      read identically is the on-chain DisciplineModule,
                      so once quorum is reached, offer to turn it into a
                      real (permanent) FullSlash sanction — sanctionType
                      2, see ModerationPage's SANCTION_TYPE_OPTIONS. */}
                  {canModerate && banState.banned && target && target !== "not_found" && target.address && (
                    <button
                      onClick={() => onEscalate(target.address, targetEventId, 2)}
                      className="mt-2 w-full font-mono text-xs px-3 py-2 rounded-full bg-gradient-to-r from-seal to-sealDeep text-white hover:opacity-90 transition-opacity flex items-center justify-center gap-1.5"
                    >
                      <Ban size={12} />
                      {t("dao.forumModeration.formalizeBan")}
                    </button>
                  )}
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                {canModerate && !state.hidden && (
                  <>
                    <button
                      onClick={() => handleAction(targetEventId, state.blurred ? MOD_ACTIONS.UNBLUR : MOD_ACTIONS.BLUR)}
                      disabled={busyKey === busyPrefix + (state.blurred ? MOD_ACTIONS.UNBLUR : MOD_ACTIONS.BLUR)}
                      className="font-mono text-xs px-3 py-1.5 rounded-full border border-gold text-gold hover:bg-gold/10 transition-colors disabled:opacity-40"
                    >
                      {state.blurred ? t("dao.forumModeration.unblur") : t("dao.forumModeration.blur")}
                    </button>
                    <button
                      onClick={() => handleAction(targetEventId, MOD_ACTIONS.HIDE)}
                      disabled={busyKey === busyPrefix + MOD_ACTIONS.HIDE}
                      className="font-mono text-xs px-3 py-1.5 rounded-full border border-sealBright text-sealBright hover:bg-sealBright/10 transition-colors disabled:opacity-40"
                    >
                      {t("dao.forumModeration.hide")}
                    </button>
                    <button
                      onClick={() => handleAction(targetEventId, MOD_ACTIONS.CRITICAL_HIDE)}
                      disabled={busyKey === busyPrefix + MOD_ACTIONS.CRITICAL_HIDE}
                      className="font-mono text-xs px-3 py-1.5 rounded-full bg-seal text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      {t("dao.forumModeration.criticalHide")}
                    </button>
                  </>
                )}
                {canModerate && state.hidden && state.hiddenBy?.toLowerCase() !== dao.account?.toLowerCase() && (
                  <button
                    onClick={() => handleAction(targetEventId, MOD_ACTIONS.UNHIDE)}
                    disabled={busyKey === busyPrefix + MOD_ACTIONS.UNHIDE}
                    className="font-mono text-xs px-3 py-1.5 rounded-full border border-verdigris text-verdigrisBright hover:bg-verdigris/10 transition-colors disabled:opacity-40"
                  >
                    {t("dao.forumModeration.unhide")}
                  </button>
                )}
                {canModerate &&
                  state.hiddenReason === "critical" &&
                  !state.criticalConfirmed &&
                  state.criticalHideBy?.toLowerCase() !== dao.account?.toLowerCase() &&
                  !state.criticalConfirmations.some((a) => a?.toLowerCase() === dao.account?.toLowerCase()) && (
                    <button
                      onClick={() => handleAction(targetEventId, MOD_ACTIONS.CRITICAL_CONFIRM)}
                      disabled={busyKey === busyPrefix + MOD_ACTIONS.CRITICAL_CONFIRM}
                      className="font-mono text-xs px-3 py-1.5 rounded-full bg-gradient-to-r from-seal to-sealDeep text-white hover:opacity-90 transition-opacity disabled:opacity-40"
                    >
                      {t("dao.forumModeration.confirmCritical")}
                    </button>
                  )}
                {canModerate && target && target !== "not_found" && target.address && !banState?.banned && !iVoted && (
                  <button
                    onClick={() => handleBanVote(target.address)}
                    disabled={busyKey === `ban-${target.address}`}
                    className="font-mono text-xs px-3 py-1.5 rounded-full border border-seal text-sealBright hover:bg-seal/10 transition-colors disabled:opacity-40 flex items-center gap-1"
                  >
                    <Ban size={12} />
                    {t("dao.forumModeration.voteToBan")}
                  </button>
                )}
                {canModerate && target && target !== "not_found" && target.address && (
                  <button
                    onClick={() => onEscalate(target.address, targetEventId)}
                    className="font-mono text-xs px-3 py-1.5 rounded-full border border-hairline text-parchmentDim hover:text-parchment transition-colors flex items-center gap-1 ml-auto"
                  >
                    <ShieldAlert size={12} />
                    {t("dao.forumModeration.escalate")}
                    <ExternalLink size={10} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
