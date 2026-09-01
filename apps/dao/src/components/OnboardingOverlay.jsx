import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Globe,
  ShieldCheck,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  CheckCircle2,
  XCircle,
  RotateCcw,
} from "lucide-react";
import { useAccount, useWalletClient } from "wagmi";
import { useSignMessage } from "@privy-io/react-auth";
import { LESSON_STRUCTURE, TEST_STRUCTURE, getRandomTestStructureForUser } from "../i18n/structure";
import LanguageSelector from "./LanguageSelector";
import CaptchaGate from "./CaptchaGate";

const POLICY_URL =
  "https://ipfs.io/ipfs/QmfZ4Qg1XiR6Y1Lnm4fnykWi6EhpwmkVSzzVNiiQS6YMSF/";

// Server-side, signature-verified onboarding record — NOT localStorage.
// Replaces the old `dao_onboarded_<address>` flag (localStorage.getItem/
// setItem), which lived only in the browser and reset on "Clear site
// data" or on a different device. See worker/index.js's
// handleOnboardingComplete/handleOnboardingStatus for the server side.
// Must be byte-for-byte identical to worker/index.js's
// ONBOARDING_COMPLETION_MESSAGE — any difference makes every signature
// verification fail.
const ONBOARDING_COMPLETION_MESSAGE =
  "Confirm DAO onboarding completion — v1";

// GET /api/onboarding/status — read-only, no signature needed (reading
// whether an address is onboarded isn't sensitive, so this doesn't need
// proof of wallet ownership the way completing it does).
export async function checkOnboardingStatus(addr) {
  if (!addr) return true;
  try {
    const res = await fetch(`/api/onboarding/status?address=${encodeURIComponent(addr)}`);
    const data = await res.json();
    return !!data.onboarded;
  } catch (err) {
    console.warn("⚠️ Failed to check onboarding status:", err);
    // Fail OPEN here deliberately: this is an educational gate, not a
    // security boundary — a transient network/API error shouldn't
    // trap someone who may have already completed it behind a modal
    // they can't get past.
    return true;
  }
}

export default function OnboardingOverlay({ account, onDone }) {
  const { t } = useTranslation();
  const [step, setStep] = useState("welcome");
  const [visitedPolicy, setVisitedPolicy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  // Age 18+ confirmation — required before onboarding can proceed, same
  // idea as dossier's isAdult checkbox on account creation (CreateLensAccount.jsx).
  // Kept as its own checkbox (not folded into `agreed`) so it's a
  // separate, explicit affirmative act rather than bundled into the
  // Human Rights Policy agreement.
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  // Real CAPTCHA (Cloudflare Turnstile, server-side verification) gating
  // the policy confirmation - required before a wallet can even reach
  // the lessons/tests, same idea as dossier's account-creation gate.
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState("");

  // Same embedded-vs-external wallet signing split as
  // useNostrIdentity.jsx — the fixed message here just proves "this
  // wallet completed onboarding", it isn't used to derive a key.
  const { connector } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { signMessage: privySignMessage } = useSignMessage();

  async function finish() {
    setFinishing(true);
    setFinishError("");
    try {
      const isEmbeddedWallet = connector?.id?.startsWith("io.privy.wallet");
      let signature;
      if (isEmbeddedWallet) {
        const result = await privySignMessage(
          { message: ONBOARDING_COMPLETION_MESSAGE },
          { uiOptions: { showWalletUIs: false } },
        );
        signature = result.signature;
      } else {
        if (!walletClient) throw new Error("Wallet not connected");
        signature = await walletClient.signMessage({
          account: walletClient.account,
          message: ONBOARDING_COMPLETION_MESSAGE,
        });
      }

      const res = await fetch("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: account, signature }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "server_error");

      onDone();
    } catch (err) {
      console.error("⚠️ Failed to record onboarding completion:", err);
      setFinishError(t("dao.onboarding.finishError"));
    } finally {
      setFinishing(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/95 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="w-full max-w-xl rounded-3xl border border-hairline bg-surface p-8 sm:p-10 relative my-8">
        <div className="gradient-orb w-64 h-64 bg-verdigris/20 -top-16 -right-16" aria-hidden />

        <div className="relative flex justify-end mb-2">
          <LanguageSelector compact />
        </div>

        <div className="relative">
          {step === "welcome" && (
            <>
              <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-verdigris to-seal flex items-center justify-center mb-5">
                <Globe size={20} className="text-white" strokeWidth={2.5} />
              </div>
              <h2 className="font-display font-semibold text-2xl text-parchment mb-2">
                {t("dao.onboarding.welcomeTitle")}
              </h2>
              <p className="text-parchmentDim text-sm leading-relaxed mb-6">
                {t("dao.onboarding.welcomeBody")}
              </p>

              <a
                href={POLICY_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => setVisitedPolicy(true)}
                className="flex items-center justify-between gap-2 rounded-xl border border-hairline px-4 py-3 mb-4 hover:border-hairlineStrong transition-colors"
              >
                <span className="text-sm text-parchment">{t("dao.onboarding.policyLink")}</span>
                <ExternalLink size={14} className="text-parchmentDim shrink-0" />
              </a>

              {/* Confirming age 18+, the Human Rights Policy, the Privacy
                  Policy and the Terms of Use — same idea as dossier's
                  confirmation block on CreateLensAccount.jsx, adapted to
                  this app's two-checkbox flow (the external Policy link
                  above still has to be opened first via visitedPolicy). */}
              <div className="rounded-xl border border-hairline bg-surface2/40 p-4 mb-7 space-y-3">
                <p className="text-parchment text-xs font-medium">
                  {t("dao.onboarding.confirmTitle")}
                </p>

                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ageConfirmed}
                    onChange={(e) => setAgeConfirmed(e.target.checked)}
                    className="mt-0.5 accent-[#3B7DFF]"
                  />
                  <span className="text-parchmentDim text-xs leading-relaxed">
                    {t("dao.onboarding.ageLine")}
                  </span>
                </label>

                <label className="flex items-start gap-2.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-0.5 accent-[#3B7DFF]"
                  />
                  <span className="text-parchmentDim text-xs leading-relaxed">
                    {t("dao.onboarding.policyLine")}
                  </span>
                </label>

                <p className="text-parchmentDim text-xs leading-relaxed pl-[26px]">
                  {t("dao.onboarding.privacyLinePrefix")}{" "}
                  <a
                    href="/privacy"
                    target="_blank"
                    rel="noreferrer"
                    className="text-verdigrisBright hover:underline"
                  >
                    {t("dao.onboarding.privacyPolicyLink")}
                  </a>
                  {" · "}
                  {t("dao.onboarding.termsLinePrefix")}{" "}
                  <a
                    href="/terms"
                    target="_blank"
                    rel="noreferrer"
                    className="text-verdigrisBright hover:underline"
                  >
                    {t("dao.onboarding.termsOfServiceLink")}
                  </a>
                </p>
              </div>

              {/* Real CAPTCHA before the policy confirmation can proceed
                  to lessons/tests - CaptchaGate hits /verify-captcha for
                  server-side verification on its own. */}
              {!captchaVerified && (
                <div className="mb-7">
                  <CaptchaGate
                    onVerified={() => setCaptchaVerified(true)}
                    onError={(reason) => {
                      console.warn("⚠️ CAPTCHA not passed:", reason);
                    }}
                  />
                </div>
              )}

              <button
                onClick={() => {
                  if (!visitedPolicy || !agreed || !ageConfirmed || !captchaVerified) return;
                  setStep("lessons");
                }}
                disabled={!visitedPolicy || !agreed || !ageConfirmed || !captchaVerified}
                className="w-full flex items-center justify-center gap-1.5 px-5 py-3 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t("dao.onboarding.continue")}
                <ChevronRight size={15} />
              </button>
              {!visitedPolicy && (
                <p className="text-center font-mono text-[12px] text-parchmentDim mt-3">
                  {t("dao.onboarding.visitFirst")}
                </p>
              )}
            </>
          )}

          {step === "lessons" && (
            <LessonsStep onBack={() => setStep("welcome")} onComplete={() => setStep("tests")} />
          )}

          {step === "tests" && (
            <TestsStep onBack={() => setStep("lessons")} onComplete={() => setStep("done")} />
          )}

          {step === "done" && (
            <>
              <div className="w-11 h-11 rounded-xl bg-verdigris/15 flex items-center justify-center mb-5">
                <ShieldCheck size={22} className="text-verdigrisBright" />
              </div>
              <h2 className="font-display font-semibold text-2xl text-parchment mb-2">
                {t("dao.onboarding.doneTitle")}
              </h2>
              <p className="text-parchmentDim text-sm leading-relaxed mb-8">
                {t("dao.onboarding.doneBody")}
              </p>
              {finishError && (
                <p className="text-center font-mono text-[12px] text-sealBright mb-3">
                  {finishError}
                </p>
              )}
              <button
                onClick={finish}
                disabled={finishing}
                className="w-full px-5 py-3 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-60"
              >
                {finishing ? t("dao.onboarding.finishing") : t("dao.onboarding.toRegistry")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function LessonsStep({ onBack, onComplete }) {
  const { t } = useTranslation();
  const [idx, setIdx] = useState(0);
  const [readIds, setReadIds] = useState(new Set());

  useEffect(() => {
    setReadIds((prev) => new Set(prev).add(LESSON_STRUCTURE[idx].id));
  }, [idx]);

  const lesson = LESSON_STRUCTURE[idx];
  const allRead = readIds.size === LESSON_STRUCTURE.length;
  const isLast = idx === LESSON_STRUCTURE.length - 1;

  return (
    <>
      <div className="flex gap-1 mb-6 flex-wrap">
        {LESSON_STRUCTURE.map((l, i) => (
          <button
            key={l.id}
            onClick={() => setIdx(i)}
            className={`h-1.5 flex-1 min-w-[8px] rounded-full transition-colors ${
              readIds.has(l.id) ? "bg-verdigris" : i === idx ? "bg-verdigrisBright" : "bg-hairline"
            }`}
          />
        ))}
      </div>

      <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
        {t("dao.onboarding.lessonOf", { n: idx + 1, total: LESSON_STRUCTURE.length })}
      </div>
      <h3 className="font-display text-xl text-parchment mb-3">
        {t(`lessons.${lesson.key}.title`)}
      </h3>
      <p className="text-parchmentDim text-sm leading-relaxed mb-8 max-h-[40vh] overflow-y-auto pr-1">
        {t(`lessons.${lesson.key}.content`)}
      </p>

      <div className="flex items-center justify-between">
        <button
          onClick={() => (idx > 0 ? setIdx(idx - 1) : onBack())}
          className="flex items-center gap-1 font-mono text-xs text-parchmentDim hover:text-parchment"
        >
          <ChevronLeft size={14} />
          {t("dao.onboarding.back")}
        </button>
        <button
          onClick={() => {
            if (!isLast) setIdx(idx + 1);
            else if (allRead) onComplete();
          }}
          className="flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity"
        >
          {isLast ? t("dao.onboarding.toTest") : t("dao.onboarding.next")}
          <ChevronRight size={15} />
        </button>
      </div>
    </>
  );
}

function TestsStep({ onBack, onComplete }) {
  const { t } = useTranslation();
  const [tests, setTests] = useState(() => getRandomTestStructureForUser());
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [score, setScore] = useState(0);

  const test = tests[idx];
  const allAnswered = Object.keys(answers).length === tests.length;
  const isLast = idx === tests.length - 1;

  function handleSubmit() {
    if (!allAnswered) return;
    let correct = 0;
    tests.forEach((tq, i) => {
      if (answers[i] === tq.correctAnswer) correct++;
    });
    setScore(correct);
    setSubmitted(true);
    if (correct === tests.length) onComplete();
  }

  function handleRetry() {
    setTests(getRandomTestStructureForUser());
    setIdx(0);
    setAnswers({});
    setSubmitted(false);
    setScore(0);
  }

  if (submitted && score < tests.length) {
    return (
      <div className="text-center py-4">
        <XCircle size={32} className="text-sealBright mx-auto mb-4" />
        <h3 className="font-display text-xl text-parchment mb-2">
          {t("dao.onboarding.correctCount", { score, total: tests.length })}
        </h3>
        <p className="text-parchmentDim text-sm leading-relaxed mb-8">
          {t("dao.onboarding.retryBody", { total: tests.length })}
        </p>
        <button
          onClick={handleRetry}
          className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity"
        >
          <RotateCcw size={15} />
          {t("dao.onboarding.retry")}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex gap-1 mb-6 flex-wrap">
        {tests.map((tq, i) => (
          <button
            key={tq.id}
            onClick={() => setIdx(i)}
            className={`h-1.5 flex-1 min-w-[8px] rounded-full transition-colors ${
              answers[i] !== undefined ? "bg-verdigris" : i === idx ? "bg-verdigrisBright" : "bg-hairline"
            }`}
          />
        ))}
      </div>

      <div className="font-mono text-[12px] uppercase tracking-widest text-parchmentDim mb-2">
        {t("dao.onboarding.questionOf", { n: idx + 1, total: tests.length })}
      </div>
      <h3 className="font-display text-lg text-parchment mb-5 leading-snug">
        {t(`tests.${test.questionKey}`)}
      </h3>

      <div className="space-y-2 mb-8">
        {test.options.map((opt) => (
          <label
            key={opt.value}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border cursor-pointer transition-colors ${
              answers[idx] === opt.value
                ? "border-verdigris bg-verdigris/10"
                : "border-hairline hover:border-hairlineStrong"
            }`}
          >
            <input
              type="radio"
              name={`q-${idx}`}
              checked={answers[idx] === opt.value}
              onChange={() => setAnswers((a) => ({ ...a, [idx]: opt.value }))}
              className="accent-[#3B7DFF]"
            />
            <span className="text-parchment text-sm">{t(`answers.${opt.key}`)}</span>
          </label>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={() => (idx > 0 ? setIdx(idx - 1) : onBack())}
          className="flex items-center gap-1 font-mono text-xs text-parchmentDim hover:text-parchment"
        >
          <ChevronLeft size={14} />
          {t("dao.onboarding.back")}
        </button>
        {isLast ? (
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <CheckCircle2 size={15} />
            {t("dao.onboarding.finishTest")}
          </button>
        ) : (
          <button
            onClick={() => setIdx(idx + 1)}
            className="flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity"
          >
            {t("dao.onboarding.next")}
            <ChevronRight size={15} />
          </button>
        )}
      </div>
    </>
  );
}
