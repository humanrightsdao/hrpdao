// src/components/CaptchaGate.jsx
//
// A real CAPTCHA (Cloudflare Turnstile) with server-side token
// verification - unlike the test on onboarding (Onboarding.jsx), which
// is ONLY educational, since it's checked in the browser (the answers
// are visible in the bundle).
//
// Here it's different: the Turnstile widget issues a token once passed,
// and this component itself sends the token to /verify-captcha
// (a Cloudflare Pages Function - functions/verify-captcha.js) - a small
// stateless file that holds the SECRET key and pings the Cloudflare API.
// onVerified() is only called after the SERVER responds "yes, the token
// is genuine" - not just because the widget in the browser showed a
// checkmark (a bot can fake the checkmark in the browser, but not the
// server response).
//
// The public site key (VITE_TURNSTILE_SITE_KEY) is NOT a secret, it's
// fine to keep it in frontend code/env without risk. The secret key
// (TURNSTILE_SECRET_KEY) lives ONLY in the Cloudflare Pages env vars,
// where functions/verify-captcha.js reads it from - it never ends up in
// the frontend bundle.

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY;
const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";
const TURNSTILE_SCRIPT_ID = "cf-turnstile-script";

/**
 * @param {Object} props
 * @param {() => void} props.onVerified - called once the server has
 *   confirmed the token is genuine.
 * @param {(reason: string) => void} [props.onError] - called on any
 *   error (missing key, network error, failed verification) - reason:
 *   "missing_site_key" | "widget_error" | "verification_failed" |
 *   "network_error".
 */
export default function CaptchaGate({ onVerified, onError }) {
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const widgetIdRef = useRef(null);
  // idle - not shown yet, ready - the widget is shown and waiting for a
  // human action, verifying - a token has been received from Turnstile,
  // waiting for the server's response, verified - the server confirmed
  // it, error - something went wrong.
  const [status, setStatus] = useState("idle");

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY) {
      // Deliberately do NOT block the whole app if the key isn't
      // configured (e.g. local development without Cloudflare) - just
      // warn in the console and notify the caller, so it can decide for
      // itself whether to skip the step or show an error.
      console.warn(
        "⚠️ CaptchaGate: VITE_TURNSTILE_SITE_KEY is not set - the CAPTCHA won't be shown.",
      );
      setStatus("error");
      onError?.("missing_site_key");
      return;
    }

    let cancelled = false;
    let pollInterval = null;

    const renderWidget = () => {
      if (cancelled || !window.turnstile || !containerRef.current) return;
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: async (token) => {
          if (cancelled) return;
          setStatus("verifying");
          try {
            const res = await fetch("/verify-captcha", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
            });
            const data = await res.json();
            if (cancelled) return;
            if (data?.success) {
              setStatus("verified");
              onVerified?.();
            } else {
              setStatus("error");
              onError?.("verification_failed");
            }
          } catch (err) {
            if (cancelled) return;
            console.warn(
              "⚠️ CaptchaGate: failed to verify the token:",
              err.message,
            );
            setStatus("error");
            onError?.("network_error");
          }
        },
        "error-callback": () => {
          if (cancelled) return;
          setStatus("error");
          onError?.("widget_error");
        },
        "expired-callback": () => {
          // The token expired before it was sent - just go back to the
          // "ready" state, Turnstile will show the widget again on its own.
          if (cancelled) return;
          setStatus("ready");
        },
      });
      setStatus("ready");
    };

    if (window.turnstile) {
      renderWidget();
    } else if (document.getElementById(TURNSTILE_SCRIPT_ID)) {
      // The script is already being loaded by another instance of this
      // component - we wait.
      pollInterval = setInterval(() => {
        if (window.turnstile) {
          clearInterval(pollInterval);
          renderWidget();
        }
      }, 100);
    } else {
      const script = document.createElement("script");
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = renderWidget;
      script.onerror = () => {
        if (cancelled) return;
        setStatus("error");
        onError?.("widget_error");
      };
      document.body.appendChild(script);
    }

    return () => {
      cancelled = true;
      if (pollInterval) clearInterval(pollInterval);
      if (window.turnstile && widgetIdRef.current !== null) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // The widget may have already been removed along with the DOM - no big deal.
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col items-center gap-2">
      <div ref={containerRef} />
      {status === "verifying" && (
        <p className="text-[11px] text-slate-500 dark:text-white/40">
          {t("captcha_verifying")}
        </p>
      )}
      {status === "error" && (
        <p className="text-[11px] text-red-500">
          {t("captcha_error")}
        </p>
      )}
    </div>
  );
}
