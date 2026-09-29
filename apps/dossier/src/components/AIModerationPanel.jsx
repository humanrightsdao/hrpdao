// src/components/AIModerationPanel.jsx
//
// Управління → "Atticus AI". The AI moderation is silent by design (it fails
// open), which makes it impossible to tell from the outside whether it works.
// This panel makes it visible, without a terminal:
//
//   1. Service status      GET /api/health → deployed? enabled? key configured?
//   2. Run a check         the same safe probe texts as `npm run moderation:selftest`
//                          (nothing is published; only the moderation endpoint is called)
//   3. Scan latest content the newest posts/comments, run through the AI; lists what
//                          it flagged (published content only — a refused draft never
//                          reaches Lens, so it can't be listed here)
//   4. Recent AI checks    what THIS browser's checks/displays produced, kept locally
//                          without any text (see utils/aiModeration.js → activity log)
//
// It only reads. Acting on a flagged item (blur / hide / ban) stays with the
// moderators in the queue below — the AI never acts alone.

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ShieldCheck, Loader2, Search, RefreshCw, Trash2 } from "lucide-react";
import { buildProbes, interpretHealth, evaluateProbes } from "../utils/moderationProbes";
import { scanLatestContent } from "../utils/aiScan";
import {
  getAIActivity,
  clearAIActivity,
  recordAIActivity,
  categoryLabel,
  isAIModerationEnabled,
} from "../utils/aiModeration";

const LEVEL_MARK = { ok: "✔", warn: "⚠", fail: "✖" };
const LEVEL_CLS = {
  ok: "text-emerald-700 dark:text-emerald-400/80",
  warn: "text-amber-700 dark:text-amber-400/80",
  fail: "text-red-700 dark:text-red-400/80",
};
const VERDICT_CLS = {
  allow: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400/80",
  flag: "bg-amber-500/10 text-amber-700 dark:text-amber-400/80",
  block: "bg-red-500/10 text-red-700 dark:text-red-400/80",
};

function VerdictChip({ verdict }) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${
        VERDICT_CLS[verdict] || "bg-slate-500/10 text-slate-600 dark:text-white/50"
      }`}
    >
      {verdict}
    </span>
  );
}

/** GET /api/health → a health state object (never throws, no React state involved). */
async function fetchHealth() {
  try {
    const res = await fetch("/api/health");
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON (e.g. an HTML fallback page) */
    }
    const h = interpretHealth(json);
    return h.state === "not_atticus" ? { state: "unreachable", status: res.status } : h;
  } catch {
    return { state: "unreachable" };
  }
}

const btnCls =
  "inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-lg border border-slate-300 dark:border-white/[0.1] bg-slate-50 dark:bg-white/[0.04] text-slate-700 dark:text-white/70 hover:bg-slate-100 dark:hover:bg-white/[0.08] disabled:opacity-50 disabled:cursor-not-allowed transition-colors";

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

  // The initial state is already "checking"; the refresh button sets it explicitly.
  useEffect(() => {
    let cancelled = false;
    fetchHealth().then((h) => {
      if (!cancelled) setHealth(h);
    });
    return () => {
      cancelled = true;
    };
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
        stage: "scan",
        scanned: result.scanned,
        answered: result.answered,
        flagged: result.flagged.length,
        ms: Date.now() - startedAt,
      });
    } catch (err) {
      setScanError(err?.message || "scan failed");
    } finally {
      setScanning(false);
      setActivity(getAIActivity());
    }
  };

  const statusLabel = {
    checking: t("ai_panel_status_checking", { defaultValue: "Checking…" }),
    ready: t("ai_panel_status_ready", { defaultValue: "Ready" }),
    old_deployment: t("ai_panel_status_old", { defaultValue: "Old server version — no moderation deployed" }),
    disabled: t("ai_panel_status_disabled", { defaultValue: "Switched off (MODERATION_ENABLED=false)" }),
    unconfigured: t("ai_panel_status_unconfigured", { defaultValue: "No Gemini API key configured" }),
    unreachable: t("ai_panel_status_unreachable", { defaultValue: "Unreachable" }),
  }[health.state];
  const statusCls =
    health.state === "ready"
      ? "text-emerald-700 dark:text-emerald-400/80"
      : health.state === "checking"
        ? "text-slate-500 dark:text-white/40"
        : "text-red-700 dark:text-red-400/80";

  const summaryText = report && {
    ok: t("ai_panel_summary_ok", { defaultValue: "Working: the rules and Gemini both answered." }),
    rules_only: t("ai_panel_summary_rules_only", {
      defaultValue:
        "The rules work, but Gemini did not answer — only the deterministic rules protect the platform right now. Check the API key, the model and the quota.",
    }),
    fail: t("ai_panel_summary_fail", { defaultValue: "Something that must work does not — see the failed rows." }),
  }[report.summary];

  return (
    <section
      id="ai-moderation-panel"
      className="bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] rounded-xl p-4 space-y-3"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-[13px]">
          <span className="text-slate-500 dark:text-white/40">
            {t("ai_panel_status", { defaultValue: "Service status" })}:{" "}
          </span>
          <span className={`font-medium ${statusCls}`}>{statusLabel}</span>
          {health.state === "ready" && (
            <span className="text-slate-500 dark:text-white/30">
              {" "}
              · prompt {health.promptVersion}
              {health.sharedCache === undefined ? "" : health.sharedCache ? " · KV cache" : " · no KV cache"}
            </span>
          )}
          {health.state === "unreachable" && health.status && (
            <span className="text-slate-500 dark:text-white/30"> · HTTP {health.status}</span>
          )}
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
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>

      {!isAIModerationEnabled() && (
        <p className="text-[12px] text-amber-700 dark:text-amber-400/80">
          VITE_AI_MODERATION=off — {t("ai_panel_client_off", { defaultValue: "the client part is switched off in this build." })}
        </p>
      )}

      {/* actions */}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={runCheck} disabled={running || scanning} className={btnCls}>
          {running ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
          {running
            ? t("ai_panel_running", { defaultValue: "Checking…" })
            : t("ai_panel_run_check", { defaultValue: "Run a check" })}
        </button>
        <button type="button" onClick={runScan} disabled={running || scanning} className={btnCls}>
          {scanning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          {scanning
            ? t("ai_panel_scanning", { defaultValue: "Scanning…" })
            : t("ai_panel_scan", { defaultValue: "Scan latest content" })}
        </button>
      </div>

      {/* 2. self-check result */}
      {runError && (
        <p role="alert" className="text-[12px] text-red-700 dark:text-red-400/80">
          {t("ai_panel_check_failed", { defaultValue: "The moderation endpoint answered with an error:" })} {runError}
        </p>
      )}
      {report && (
        <div className="space-y-1.5">
          <p className={`text-[13px] font-medium ${report.summary === "ok" ? LEVEL_CLS.ok : LEVEL_CLS.fail}`}>{summaryText}</p>
          <p className="text-[12px] text-slate-500 dark:text-white/30">
            {t("ai_panel_latency", {
              s: (report.ms / 1000).toFixed(1),
              defaultValue: "Answered in {{s}} s",
            })}
          </p>
          <ul className="space-y-1">
            {report.rows.map((row) => (
              <li key={row.probe.id} className="text-[12px] leading-snug">
                <span className={`mr-1.5 ${LEVEL_CLS[row.level]}`}>{LEVEL_MARK[row.level]}</span>
                <span className="text-slate-700 dark:text-white/70">{row.probe.label}</span>
                <span className="block ml-5 text-slate-500 dark:text-white/30">{row.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 3. scan result */}
      {scanError && (
        <p role="alert" className="text-[12px] text-red-700 dark:text-red-400/80">
          {t("ai_panel_scan_error", { defaultValue: "Scan failed:" })} {scanError}
        </p>
      )}
      {scan && (
        <div className="space-y-2">
          <p className="text-[12px] text-slate-600 dark:text-white/50">
            {t("ai_panel_scan_result", {
              scanned: scan.scanned,
              answered: scan.answered,
              flagged: scan.flagged.length,
              defaultValue: "Scanned {{scanned}} items · AI answered for {{answered}} · flagged {{flagged}}",
            })}
          </p>
          {scan.flagged.length === 0 ? (
            <p className="text-[12px] text-emerald-700 dark:text-emerald-400/80">
              {scan.scanned > 0 && scan.answered === 0
                ? t("ai_panel_scan_no_answers", {
                    defaultValue: "The AI did not answer for any item (service unavailable?) — nothing could be checked.",
                  })
                : t("ai_panel_nothing_flagged", { defaultValue: "Nothing flagged in the latest content." })}
            </p>
          ) : (
            <ul className="space-y-2">
              {scan.flagged.map((f) => (
                <li key={f.id} className="rounded-lg border border-slate-200 dark:border-white/[0.07] p-2.5 text-[12px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <VerdictChip verdict={f.result.verdict} />
                    <span className="text-slate-700 dark:text-white/70">
                      {(f.result.categories || []).map(categoryLabel).join(", ") || categoryLabel("other")}
                    </span>
                    <span className="text-slate-500 dark:text-white/30">
                      {f.kind}
                      {f.author ? ` · @${f.author}` : ""}
                    </span>
                    <Link to={f.link} className="ml-auto text-sky-700 dark:text-sky-400/80 hover:underline">
                      {t("ai_panel_open", { defaultValue: "Open" })}
                    </Link>
                  </div>
                  {f.result.reason && (
                    <p className="mt-1 text-slate-500 dark:text-white/35">{f.result.reason}</p>
                  )}
                  <details className="mt-1">
                    <summary className="cursor-pointer text-slate-500 dark:text-white/40">
                      {t("ai_panel_show_text", { defaultValue: "Show text" })}
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap text-slate-600 dark:text-white/55">{f.text.slice(0, 500)}</p>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* 4. local activity */}
      <div>
        <div className="flex items-center justify-between">
          <h4 className="text-[12px] font-semibold text-slate-600 dark:text-white/50">
            {t("ai_panel_recent", { defaultValue: "Recent AI checks in this browser" })}
          </h4>
          {activity.length > 0 && (
            <button
              type="button"
              onClick={() => {
                clearAIActivity();
                setActivity([]);
              }}
              className="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-white/30 hover:text-slate-700 dark:hover:text-white/60"
            >
              <Trash2 className="w-3 h-3" />
              {t("ai_panel_clear", { defaultValue: "Clear" })}
            </button>
          )}
        </div>
        {activity.length === 0 ? (
          <p className="mt-1 text-[12px] text-slate-500 dark:text-white/30">
            {t("ai_panel_no_activity", {
              defaultValue: "No checks recorded yet. Publish something, or open a page with comments.",
            })}
          </p>
        ) : (
          <ul className="mt-1 space-y-1">
            {activity.slice(0, 15).map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex flex-wrap items-center gap-x-2 text-[12px] text-slate-600 dark:text-white/50">
                <span className="text-slate-400 dark:text-white/25">{new Date(e.at).toLocaleTimeString()}</span>
                <span>
                  {{
                    publish: t("ai_panel_stage_publish", { defaultValue: "before publishing" }),
                    display: t("ai_panel_stage_display", { defaultValue: "when displayed" }),
                    selfcheck: t("ai_panel_stage_selfcheck", { defaultValue: "self-check" }),
                    scan: t("ai_panel_stage_scan", { defaultValue: "content scan" }),
                  }[e.stage] || e.stage}
                </span>
                {e.kind && (
                  <span className="text-slate-500 dark:text-white/30">
                    {e.kind === "media" && e.mediaKind ? `${e.kind} (${e.mediaKind})` : e.kind}
                  </span>
                )}
                {e.stage === "selfcheck" && (
                  <span
                    className={
                      e.summary === "ok" ? LEVEL_CLS.ok : e.summary === "rules_only" ? LEVEL_CLS.warn : LEVEL_CLS.fail
                    }
                  >
                    {{
                      ok: t("ai_panel_result_ok", { defaultValue: "OK" }),
                      rules_only: t("ai_panel_result_rules_only", { defaultValue: "rules only — Gemini did not answer" }),
                      fail: t("ai_panel_result_fail", { defaultValue: "failed" }),
                    }[e.summary] || e.summary}
                  </span>
                )}
                {e.stage === "scan" && (
                  <span>
                    {t("ai_panel_scan_result", {
                      scanned: e.scanned,
                      answered: e.answered,
                      flagged: e.flagged,
                      defaultValue: "Scanned {{scanned}} items · AI answered for {{answered}} · flagged {{flagged}}",
                    })}
                  </span>
                )}
                {(e.stage === "publish" || e.stage === "display") &&
                  (e.unavailable ? (
                    <span className="text-amber-700 dark:text-amber-400/80">
                      {e.refused
                        ? t("ai_panel_refused_unavailable", { defaultValue: "refused — the AI was unavailable" })
                        : t("ai_panel_no_verdict", { defaultValue: "no verdict — published without an AI check" })}
                    </span>
                  ) : (
                    <>
                      <VerdictChip verdict={e.verdict} />
                      <span className="text-slate-500 dark:text-white/30">{e.source}</span>
                      {e.categories?.length > 0 && <span>{e.categories.map(categoryLabel).join(", ")}</span>}
                      {e.blocked && (
                        <span className="text-red-700 dark:text-red-400/80">
                          {t("ai_panel_draft_refused", { defaultValue: "draft refused" })}
                        </span>
                      )}
                    </>
                  ))}
                {typeof e.ms === "number" && (
                  <span className="text-slate-400 dark:text-white/25">{(e.ms / 1000).toFixed(1)}s</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
