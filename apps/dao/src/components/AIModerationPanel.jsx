// src/components/AIModerationPanel.jsx
//
// Ported from dossier/src/components/AIModerationPanel.jsx. Makes AI
// moderation ("Atticus Guard") visible in Управління/Moderation → "AI
// moderation" tab, without a terminal:
//
//   1. Service status      GET /api/health → deployed? enabled? key configured?
//   2. Run a check         the same safe probe texts as `npm run moderation:selftest`
//                          (nothing is published; only the moderation endpoint is called)
//   3. Scan latest content the newest forum threads/replies, run through the AI;
//                          lists what it flagged. Governance proposals are NOT
//                          scanned here — they get a MANDATORY check before
//                          submission instead (see useDao.js → submitProposal),
//                          so a proposal that made it on-chain already passed.
//   4. Recent AI checks    what THIS browser's checks/publishes/scans produced,
//                          kept locally without any text (see lib/aiModeration.js)
//
// It only reads. There is currently no blur/hide UI for forum posts driven by
// AI verdicts (unlike dossier) — "flag" is recorded but has no visible effect
// beyond this panel; only "block" refuses publishing. Both self-check and
// scan share a 20s cooldown after each run: they make REAL Gemini calls
// against the same quota real moderation depends on, and repeatedly clicking
// them while diagnosing an issue can itself exhaust a tight quota.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ShieldCheck, Loader2, Search, RefreshCw, Trash2 } from "lucide-react";
import { buildProbes, interpretHealth, evaluateProbes } from "../lib/moderationProbes";
import { scanLatestContent } from "../lib/aiScan";
import {
  getAIActivity,
  clearAIActivity,
  recordAIActivity,
  categoryLabel,
  isAIModerationEnabled,
} from "../lib/aiModeration";

const LEVEL_MARK = { ok: "✔", warn: "⚠", fail: "✖" };
const LEVEL_CLS = { ok: "text-verdigrisBright", warn: "text-gold", fail: "text-sealBright" };
const VERDICT_CLS = {
  allow: "bg-verdigris/10 text-verdigrisBright",
  flag: "bg-gold/10 text-gold",
  block: "bg-seal/10 text-sealBright",
};

function VerdictChip({ verdict }) {
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-mono ${VERDICT_CLS[verdict] || "bg-surface2 text-parchmentDim"}`}>
      {verdict}
    </span>
  );
}

const btnCls =
  "inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-full border border-hairline text-parchmentDim hover:text-parchment hover:border-verdigris transition-colors disabled:opacity-40 disabled:cursor-not-allowed";

/** GET /api/health → a health state object (never throws, no React state involved). */
async function fetchHealth() {
  try {
    const res = await fetch("/api/health");
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON */
    }
    const h = interpretHealth(json);
    return h.state === "not_atticus" ? { state: "unreachable", status: res.status } : h;
  } catch {
    return { state: "unreachable" };
  }
}

export default function AIModerationPanel() {
  const { t } = useTranslation();

  const [health, setHealth] = useState({ state: "checking" });
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState(null);
  const [runError, setRunError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState(null);
  const [scanError, setScanError] = useState("");
  const [activity, setActivity] = useState(() => getAIActivity());

  // A 20s cooldown after each run — see the header note above.
  const COOLDOWN_MS = 20_000;
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [cooldownLeft, setCooldownLeft] = useState(0);
  useEffect(() => {
    if (!cooldownUntil) return undefined;
    const tick = () => setCooldownLeft(Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [cooldownUntil]);
  const onCooldown = cooldownLeft > 0;

  useEffect(() => {
    fetchHealth().then(setHealth);
  }, []);

  const runCheck = async () => {
    setRunning(true);
    setReport(null);
    setRunError("");
    const probes = buildProbes();
    const startedAt = Date.now();
    try {
      const res = await fetch("/api/moderate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: probes.map((p) => ({ id: p.id, kind: p.kind, text: p.text, context: p.context || "" })),
        }),
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        /* keep null */
      }
      if (!res.ok || !data?.success) {
        setRunError(`HTTP ${res.status}${data?.error ? ` (${data.error})` : ""}`);
      } else if (data.disabled) {
        setRunError("MODERATION_ENABLED=false");
      } else {
        const ms = Date.now() - startedAt;
        const evaluated = evaluateProbes(probes, data.results);
        setReport({ ...evaluated, ms });
        recordAIActivity({ stage: "selfcheck", summary: evaluated.summary, ms });
      }
    } catch (err) {
      setRunError(err?.message || "network error");
    } finally {
      setRunning(false);
      setActivity(getAIActivity());
      setCooldownUntil(Date.now() + COOLDOWN_MS);
    }
  };

  const runScan = async () => {
    setScanning(true);
    setScan(null);
    setScanError("");
    const startedAt = Date.now();
    try {
      const result = await scanLatestContent({ limit: 40 });
      setScan(result);
      recordAIActivity({
        stage: "scan", scanned: result.scanned, answered: result.answered,
        flagged: result.flagged.length, ms: Date.now() - startedAt,
      });
    } catch (err) {
      setScanError(err?.message || "scan failed");
    } finally {
      setScanning(false);
      setActivity(getAIActivity());
      setCooldownUntil(Date.now() + COOLDOWN_MS);
    }
  };

  const statusLabel = {
    checking: t("dao.aiModeration.statusChecking", { defaultValue: "Checking…" }),
    ready: t("dao.aiModeration.statusReady", { defaultValue: "Ready" }),
    old_deployment: t("dao.aiModeration.statusOld", { defaultValue: "Old server version — no moderation deployed" }),
    disabled: t("dao.aiModeration.statusDisabled", { defaultValue: "Switched off (MODERATION_ENABLED=false)" }),
    unconfigured: t("dao.aiModeration.statusUnconfigured", { defaultValue: "No Gemini API key configured" }),
    unreachable: t("dao.aiModeration.statusUnreachable", { defaultValue: "Unreachable" }),
  }[health.state];
  const statusCls = health.state === "ready" ? "text-verdigrisBright" : health.state === "checking" ? "text-parchmentDim" : "text-sealBright";

  const summaryText = report && {
    ok: t("dao.aiModeration.summaryOk", { defaultValue: "Working: the rules and Gemini both answered." }),
    rules_only: t("dao.aiModeration.summaryRulesOnly", {
      defaultValue: "The rules work, but Gemini did not answer — only the deterministic rules protect the platform right now. Check the API key, the model and the quota.",
    }),
    fail: t("dao.aiModeration.summaryFail", { defaultValue: "Something that must work does not — see the failed rows." }),
  }[report.summary];

  return (
    <div className="rounded-2xl border border-hairline p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-mono">
          <span className="text-parchmentDim">{t("dao.aiModeration.status", { defaultValue: "Service status" })}: </span>
          <span className={`font-medium ${statusCls}`}>{statusLabel}</span>
          {health.state === "ready" && (
            <span className="text-parchmentDim/70">
              {" "}
              · prompt {health.promptVersion}
              {health.sharedCache === undefined ? "" : health.sharedCache ? " · KV cache" : " · no KV cache"}
            </span>
          )}
          {health.state === "unreachable" && health.status && <span className="text-parchmentDim/70"> · HTTP {health.status}</span>}
        </p>
        <button
          type="button"
          onClick={() => {
            setHealth({ state: "checking" });
            fetchHealth().then(setHealth);
          }}
          className={btnCls}
          aria-label="refresh status"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      {!isAIModerationEnabled() && (
        <p className="text-xs text-gold font-mono">
          VITE_AI_MODERATION=off — {t("dao.aiModeration.clientOff", { defaultValue: "the client part is switched off in this build." })}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={runCheck} disabled={running || scanning || onCooldown} className={btnCls}>
          {running ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}
          {running
            ? t("dao.aiModeration.running", { defaultValue: "Checking…" })
            : onCooldown
              ? t("dao.aiModeration.cooldown", { seconds: cooldownLeft, defaultValue: "Wait {{seconds}}s…" })
              : t("dao.aiModeration.runCheck", { defaultValue: "Run a check" })}
        </button>
        <button type="button" onClick={runScan} disabled={running || scanning || onCooldown} className={btnCls}>
          {scanning ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          {scanning
            ? t("dao.aiModeration.scanning", { defaultValue: "Scanning…" })
            : onCooldown
              ? t("dao.aiModeration.cooldown", { seconds: cooldownLeft, defaultValue: "Wait {{seconds}}s…" })
              : t("dao.aiModeration.scan", { defaultValue: "Scan latest forum content" })}
        </button>
      </div>

      {runError && (
        <p role="alert" className="text-xs text-sealBright font-mono">
          {t("dao.aiModeration.checkFailed", { defaultValue: "The moderation endpoint answered with an error:" })} {runError}
        </p>
      )}
      {report && (
        <div className="space-y-1.5">
          <p className={`text-sm font-medium font-mono ${report.summary === "ok" ? LEVEL_CLS.ok : LEVEL_CLS.fail}`}>{summaryText}</p>
          <p className="text-xs text-parchmentDim/70 font-mono">
            {t("dao.aiModeration.latency", { s: (report.ms / 1000).toFixed(1), defaultValue: "Answered in {{s}} s" })}
          </p>
          <ul className="space-y-1">
            {report.rows.map((row) => (
              <li key={row.probe.id} className="text-xs font-mono leading-snug">
                <span className={`mr-1.5 ${LEVEL_CLS[row.level]}`}>{LEVEL_MARK[row.level]}</span>
                <span className="text-parchment">{row.probe.label}</span>
                <span className="block ml-5 text-parchmentDim/70">{row.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {scanError && (
        <p role="alert" className="text-xs text-sealBright font-mono">
          {t("dao.aiModeration.scanError", { defaultValue: "Scan failed:" })} {scanError}
        </p>
      )}
      {scan && (
        <div className="space-y-2">
          <p className="text-xs text-parchmentDim font-mono">
            {t("dao.aiModeration.scanResult", {
              scanned: scan.scanned, answered: scan.answered, flagged: scan.flagged.length,
              defaultValue: "Scanned {{scanned}} items · AI answered for {{answered}} · flagged {{flagged}}",
            })}
          </p>
          {scan.flagged.length === 0 ? (
            <p className="text-xs text-verdigrisBright font-mono">
              {scan.scanned > 0 && scan.answered === 0
                ? t("dao.aiModeration.scanNoAnswers", { defaultValue: "The AI did not answer for any item (service unavailable?) — nothing could be checked." })
                : t("dao.aiModeration.nothingFlagged", { defaultValue: "Nothing flagged in the latest forum content." })}
            </p>
          ) : (
            <ul className="space-y-2">
              {scan.flagged.map((f) => (
                <li key={f.id} className="rounded-lg border border-hairline p-2.5 text-xs font-mono">
                  <div className="flex flex-wrap items-center gap-2">
                    <VerdictChip verdict={f.result.verdict} />
                    <span className="text-parchment">{(f.result.categories || []).map(categoryLabel).join(", ") || categoryLabel("other")}</span>
                    <span className="text-parchmentDim/70">
                      {f.kind}
                      {f.author ? ` · @${f.author}` : ""}
                    </span>
                    <Link to={f.link} className="ml-auto text-verdigrisBright hover:underline">
                      {t("dao.aiModeration.open", { defaultValue: "Open" })}
                    </Link>
                  </div>
                  {f.result.reason && <p className="mt-1 text-parchmentDim/70">{f.result.reason}</p>}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-parchmentDim/70">{t("dao.aiModeration.showText", { defaultValue: "Show text" })}</summary>
                    <p className="mt-1 whitespace-pre-wrap text-parchmentDim">{f.text.slice(0, 500)}</p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-mono font-semibold text-parchmentDim uppercase tracking-wide">
            {t("dao.aiModeration.recent", { defaultValue: "Recent AI checks in this browser" })}
          </h4>
          {activity.length > 0 && (
            <button
              type="button"
              onClick={() => {
                clearAIActivity();
                setActivity([]);
              }}
              className="inline-flex items-center gap-1 text-[11px] font-mono text-parchmentDim/70 hover:text-parchment"
            >
              <Trash2 size={11} />
              {t("dao.aiModeration.clear", { defaultValue: "Clear" })}
            </button>
          )}
        </div>
        {activity.length === 0 ? (
          <p className="mt-1 text-xs text-parchmentDim/70 font-mono">
            {t("dao.aiModeration.noActivity", { defaultValue: "No checks recorded yet. Publish something, or run a check above." })}
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {activity.slice(0, 15).map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex flex-wrap items-center gap-x-2 text-xs font-mono text-parchmentDim">
                <span className="text-parchmentDim/50">{new Date(e.at).toLocaleTimeString()}</span>
                <span>
                  {{
                    publish: t("dao.aiModeration.stagePublish", { defaultValue: "before publishing" }),
                    display: t("dao.aiModeration.stageDisplay", { defaultValue: "when displayed" }),
                    selfcheck: t("dao.aiModeration.stageSelfcheck", { defaultValue: "self-check" }),
                    scan: t("dao.aiModeration.stageScan", { defaultValue: "content scan" }),
                  }[e.stage] || e.stage}
                </span>
                {e.kind && <span className="text-parchmentDim/70">{e.kind}</span>}
                {e.stage === "selfcheck" && (
                  <span className={e.summary === "ok" ? LEVEL_CLS.ok : e.summary === "rules_only" ? LEVEL_CLS.warn : LEVEL_CLS.fail}>
                    {{
                      ok: t("dao.aiModeration.resultOk", { defaultValue: "OK" }),
                      rules_only: t("dao.aiModeration.resultRulesOnly", { defaultValue: "rules only — Gemini did not answer" }),
                      fail: t("dao.aiModeration.resultFail", { defaultValue: "failed" }),
                    }[e.summary] || e.summary}
                  </span>
                )}
                {e.stage === "scan" && (
                  <span>
                    {t("dao.aiModeration.scanResult", {
                      scanned: e.scanned, answered: e.answered, flagged: e.flagged,
                      defaultValue: "Scanned {{scanned}} items · AI answered for {{answered}} · flagged {{flagged}}",
                    })}
                  </span>
                )}
                {(e.stage === "publish" || e.stage === "display") &&
                  (e.unavailable ? (
                    <span className="text-gold">
                      {e.refused
                        ? t("dao.aiModeration.refusedUnavailable", { defaultValue: "refused — the AI was unavailable" })
                        : t("dao.aiModeration.noVerdict", { defaultValue: "no verdict — published without an AI check" })}
                    </span>
                  ) : (
                    <>
                      <VerdictChip verdict={e.verdict} />
                      <span className="text-parchmentDim/70">{e.source}</span>
                      {e.categories?.length > 0 && <span>{e.categories.map(categoryLabel).join(", ")}</span>}
                      {e.blocked && <span className="text-sealBright">{t("dao.aiModeration.draftRefused", { defaultValue: "draft refused" })}</span>}
                    </>
                  ))}
                {typeof e.ms === "number" && <span className="text-parchmentDim/50">{(e.ms / 1000).toFixed(1)}s</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
