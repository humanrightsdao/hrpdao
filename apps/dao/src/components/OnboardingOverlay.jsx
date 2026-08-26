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
import { LESSON_STRUCTURE, TEST_STRUCTURE, getRandomTestStructureForUser } from "../i18n/structure";
import LanguageSelector from "./LanguageSelector";

const POLICY_URL =
  "https://ipfs.io/ipfs/QmfZ4Qg1XiR6Y1Lnm4fnykWi6EhpwmkVSzzVNiiQS6YMSF/";

const flagKey = (addr) => `dao_onboarded_${addr?.toLowerCase()}`;

export function isOnboarded(addr) {
  if (!addr) return true;
  return localStorage.getItem(flagKey(addr)) === "true";
}

export function markOnboarded(addr) {
  if (addr) localStorage.setItem(flagKey(addr), "true");
}

export default function OnboardingOverlay({ account, onDone }) {
  const { t } = useTranslation();
  const [step, setStep] = useState("welcome");
  const [visitedPolicy, setVisitedPolicy] = useState(false);
  const [agreed, setAgreed] = useState(false);

  function finish() {
    markOnboarded(account);
    onDone();
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

              <label className="flex items-start gap-2.5 mb-7 cursor-pointer">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 accent-[#3B7DFF]"
                />
                <span className="text-parchmentDim text-xs leading-relaxed">
                  {t("dao.onboarding.agree")}
                </span>
              </label>

              <button
                onClick={() => {
                  if (!visitedPolicy || !agreed) return;
                  setStep("lessons");
                }}
                disabled={!visitedPolicy || !agreed}
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
              <button
                onClick={finish}
                className="w-full px-5 py-3 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep text-white font-medium text-sm hover:opacity-90 transition-opacity"
              >
                {t("dao.onboarding.toRegistry")}
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
