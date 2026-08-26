import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ShieldAlert } from "lucide-react";
import { tDaoMessage } from "../lib/daoMessages";
import SanctionProposalCard from "../components/SanctionProposalCard";

const SANCTION_TYPE_OPTIONS = [0, 1, 2]; // Warning, PartialRestriction, FullSlash
const RESTRICTION_PERIOD_OPTIONS = [0, 1, 2]; // Quarter, Year, FiveYears

export default function ModerationPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const [searchParams] = useSearchParams();
  const highlightId = searchParams.get("case");

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
