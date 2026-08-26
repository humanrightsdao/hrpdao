import { useEffect, useState } from "react";
import { useOutletContext, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { tDaoMessage } from "../lib/daoMessages";

const TYPES = ["test", "updatePolicy", "custom"];
const TYPE_LABEL_KEYS = { test: "typeTestLabel", updatePolicy: "typePolicyLabel", custom: "typeCustomLabel" };
const TYPE_DESC_KEYS = { test: "typeTestDesc", updatePolicy: "typePolicyDesc", custom: "typeCustomDesc" };

export default function NewProposalPage() {
  const { t } = useTranslation();
  const dao = useOutletContext();
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("test");
  const [policyHash, setPolicyHash] = useState("");
  const [policyURI, setPolicyURI] = useState("");
  const [target, setTarget] = useState("");
  const [calldata, setCalldata] = useState("");
  const [scopeChoice, setScopeChoice] = useState("earth");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);

  const canPropose = dao.hasCouncil;

  useEffect(() => {
    if (dao.isConnected) dao.refreshTokenStatus?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dao.account]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setResult(null);

    const params =
      type === "updatePolicy"
        ? { policyHash, policyURI }
        : type === "custom"
          ? { target, calldata }
          : undefined;

    const res = await dao.submitProposal(
      { title, description, type, params, scopeChoice },
      setProgress,
    );
    setResult(res);
    setBusy(false);
    if (res.success && res.proposalId) {
      navigate(`/proposals/${res.proposalId}`);
    }
  }

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.newProposal.governance")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-2">{t("dao.newProposal.title")}</h1>
      <p className="text-parchmentDim text-sm mb-8">
        {t("dao.newProposal.onlyCouncil")}
      </p>

      {!canPropose && (
        <div className="border border-seal/40 bg-seal/5 rounded-xl p-4 mb-6 font-mono text-xs text-sealBright">
          {dao.isConnected
            ? t("dao.newProposal.noCouncilConnected")
            : t("dao.newProposal.noCouncilDisconnected")}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
            {t("dao.newProposal.proposalType")}
          </label>
          <div className="grid gap-2">
            {TYPES.map((typeOpt) => (
              <label
                key={typeOpt}
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                  type === typeOpt
                    ? "border-verdigris bg-verdigris/10"
                    : "border-hairline hover:border-hairlineStrong"
                }`}
              >
                <input
                  type="radio"
                  name="type"
                  value={typeOpt}
                  checked={type === typeOpt}
                  onChange={() => setType(typeOpt)}
                  className="mt-1 accent-[#3B7DFF]"
                />
                <div>
                  <div className="text-parchment text-sm font-medium">{t(`dao.newProposal.${TYPE_LABEL_KEYS[typeOpt]}`)}</div>
                  <div className="text-parchmentDim text-xs mt-0.5">{t(`dao.newProposal.${TYPE_DESC_KEYS[typeOpt]}`)}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div>
          <label className="block font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
            {t("dao.newProposal.scope")}
          </label>
          <div className="grid gap-2">
            <label
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors ${
                scopeChoice === "earth"
                  ? "border-verdigris bg-verdigris/10"
                  : "border-hairline hover:border-hairlineStrong"
              }`}
            >
              <input
                type="radio"
                name="scope"
                value="earth"
                checked={scopeChoice === "earth"}
                onChange={() => setScopeChoice("earth")}
                className="mt-1 accent-[#3B7DFF]"
              />
              <div>
                <div className="text-parchment text-sm font-medium">
                  {t("dao.newProposal.scopeEarthLabel")}
                </div>
                <div className="text-parchmentDim text-xs mt-0.5">
                  {t("dao.newProposal.scopeEarthDesc")}
                </div>
              </div>
            </label>
            <label
              className={`flex items-start gap-3 p-3 rounded-xl border transition-colors ${
                dao.myEffectiveHex && dao.myEffectiveHex.level >= 0
                  ? "cursor-pointer " +
                    (scopeChoice === "territory"
                      ? "border-gold bg-gold/10"
                      : "border-hairline hover:border-hairlineStrong")
                  : "cursor-not-allowed opacity-50 border-hairline"
              }`}
            >
              <input
                type="radio"
                name="scope"
                value="territory"
                checked={scopeChoice === "territory"}
                disabled={!dao.myEffectiveHex || dao.myEffectiveHex.level < 0}
                onChange={() => setScopeChoice("territory")}
                className="mt-1 accent-[#C9A227]"
              />
              <div>
                <div className="text-parchment text-sm font-medium">
                  {t("dao.newProposal.scopeTerritoryLabel")}
                  {dao.myEffectiveHex && dao.myEffectiveHex.level >= 0 && (
                    <span className="text-parchmentDim font-mono text-xs ml-2">
                      {t("dao.newProposal.scopeTerritoryLevel", { level: dao.myEffectiveHex.level })}
                    </span>
                  )}
                </div>
                <div className="text-parchmentDim text-xs mt-0.5">
                  {dao.myEffectiveHex && dao.myEffectiveHex.level >= 0
                    ? t("dao.newProposal.scopeTerritoryDescActive")
                    : t("dao.newProposal.scopeTerritoryDescInactive")}
                </div>
              </div>
            </label>
          </div>
        </div>

        <Field label={t("dao.newProposal.fieldTitle")}>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            placeholder={t("dao.newProposal.titlePlaceholder")}
            className="input"
          />
        </Field>

        <Field label={t("dao.newProposal.fieldDescription")}>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            placeholder={t("dao.newProposal.descPlaceholder")}
            className="input resize-none"
          />
        </Field>

        {type === "updatePolicy" && (
          <>
            <Field label={t("dao.newProposal.policyHash")}>
              <input
                value={policyHash}
                onChange={(e) => setPolicyHash(e.target.value)}
                placeholder="0x…"
                className="input font-mono"
              />
            </Field>
            <Field label={t("dao.newProposal.policyUri")}>
              <input
                value={policyURI}
                onChange={(e) => setPolicyURI(e.target.value)}
                placeholder={t("dao.newProposal.policyUriPlaceholder")}
                className="input font-mono"
              />
            </Field>
          </>
        )}

        {type === "custom" && (
          <>
            <Field label={t("dao.newProposal.targetAddress")}>
              <input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="0x…"
                className="input font-mono"
              />
            </Field>
            <Field label={t("dao.newProposal.calldata")}>
              <input
                value={calldata}
                onChange={(e) => setCalldata(e.target.value)}
                placeholder="0x…"
                className="input font-mono"
              />
            </Field>
          </>
        )}

        <button
          type="submit"
          disabled={busy || !canPropose || !title}
          className="px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {busy ? tDaoMessage(t, progress) || t("dao.newProposal.submitting") : t("dao.newProposal.submit")}
        </button>

        {result && !result.success && (
          <p className="font-mono text-xs text-sealBright">{tDaoMessage(t, result.error)}</p>
        )}
      </form>

      <style>{`
        .input {
          width: 100%;
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--tw-border-opacity, rgba(255,255,255,0.08));
          border-color: rgba(255,255,255,0.08);
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
