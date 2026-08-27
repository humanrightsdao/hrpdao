// worker/index.js
// Cloudflare Worker for the `dao` app. Adds /api/chat and /api/chat/stream
// (Atticus AI advisor, backed by Gemini) directly into dao's own deployed
// Worker — same pattern already used by `dossier/worker/index.js` — so the
// frontend can call a same-origin, relative endpoint instead of reaching
// out to a separate (undeployed) backend.
//
// Requires the GEMINI_API_KEY secret to be set on THIS worker (`dao`):
//   npx wrangler secret put GEMINI_API_KEY
// or via Cloudflare dashboard → Workers & Pages → dao → Settings →
// Variables and secrets → Add → type "Secret".
// This is separate from dossier's own GEMINI_API_KEY secret — each
// worker needs its own copy.

import { verifyMessage } from "viem";

const MODEL = "gemini-3-flash-preview";

const SYSTEM_PROMPT_TEMPLATE = (
  historyContext,
  message,
) => `You are Atticus – AI advisor for human rights. You respond in the same language the user writes in.

YOUR MANDATORY RESPONSE ELEMENTS:
• References to specific law articles (Constitution, laws of any country upon request)
• International instruments (ECHR, Universal Declaration of Human Rights, ICCPR, etc.)
• ECHR case numbers, Supreme Court Grand Chamber cases, etc.
• Practical advice for human rights protection

KNOWLEDGE BASE:
• Human rights policy
• Constitutions of all countries worldwide (specific country upon request)
• Criminal codes of all countries (upon request)
• Criminal procedure codes of all countries (upon request)
• Civil codes of all countries (upon request)
• Administrative procedure codes of all countries (upon request)
• European Convention on Human Rights
• Universal Declaration of Human Rights
• International Covenant on Civil and Political Rights
• Case law of ECHR, Supreme Court, Constitutional Court

COMMUNICATION STYLE:
• Professional but accessible
• Specific, with law references
• Practical, with examples
• Supportive and motivating

COMMUNITY MENTION (use sparingly, only when genuinely relevant):
• If the user asks how to get involved, how to protect human rights collectively, or expresses concern about organized threats to human rights, you may briefly (1-2 sentences) mention that Human Rights Policy DAO is a community where people organize collectively to defend human rights.
• Do not force this mention into every response — only when it naturally fits the question.

CONVERSATION HISTORY:
${historyContext}

CURRENT USER QUESTION: ${message}

AI ATTICUS RESPONSE (in user's language):`;

function addSignature(response) {
  const signature = `\n\n---\nFrom Atticus, AI Advisor for Human Rights\nNote: Artificial intelligence may make mistakes. Verify information in official sources.`;
  return response + signature;
}

function buildHistoryContext(history) {
  return Array.isArray(history)
    ? history
        .slice(-4)
        .map(
          (msg) =>
            `${msg.role === "user" ? "User" : "AI Atticus"}: ${String(msg.content || "").substring(0, 200)}`,
        )
        .join("\n\n")
    : "";
}

function geminiRequestBody(systemPrompt) {
  return {
    contents: [{ role: "user", parts: [{ text: systemPrompt }] }],
    generationConfig: {
      temperature: 0.3,
      topK: 40,
      topP: 0.9,
      maxOutputTokens: 8000,
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
    ],
  };
}

async function fetchWithRetry(url, options, retries = 2, delayMs = 700) {
  let lastResponse;
  for (let attempt = 0; attempt <= retries; attempt++) {
    lastResponse = await fetch(url, options);
    if (
      (lastResponse.status !== 503 && lastResponse.status !== 429) ||
      attempt === retries
    ) {
      return lastResponse;
    }
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs *= 2;
  }
  return lastResponse;
}

function friendlyErrorMessage(status, fallback) {
  if (status === 503) {
    return "The Gemini model is temporarily overloaded. Please try again in a few seconds.";
  }
  if (status === 429) {
    return "Too many requests to the Gemini API in a short time (free-tier limit). Please wait a minute and try again.";
  }
  return fallback;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Same CAPTCHA gate as dossier's worker/index.js (Cloudflare Turnstile,
// verified server-side). Ported here so dao can gate its own actions
// (posting to the forum) behind a real, server-verified CAPTCHA instead
// of trusting a client-side checkmark. Requires the TURNSTILE_SECRET_KEY
// secret to be set on THIS worker (`dao`):
//   npx wrangler secret put TURNSTILE_SECRET_KEY
// or via Cloudflare dashboard → Workers & Pages → dao → Settings →
// Variables and secrets → Add → type "Secret". This is separate from
// dossier's own TURNSTILE_SECRET_KEY — each worker needs its own copy
// (they can share the same Turnstile site/secret key pair if you want
// the two apps to use one Turnstile widget, or use two different ones).
// Must NEVER be the public VITE_TURNSTILE_SITE_KEY value — that one is
// the client-side site key and is fine to be public; this one is the
// server-side secret used to verify tokens with Cloudflare's API and
// must stay private.
async function handleVerifyCaptcha(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "invalid_body" }, 400);
  }

  const token = body?.token;
  if (!token || typeof token !== "string") {
    return json({ success: false, error: "missing_token" }, 400);
  }

  if (!env.TURNSTILE_SECRET_KEY) {
    // Fail-closed deliberately: a missing secret should never silently
    // let everyone through as "verified".
    console.error(
      "⚠️ verify-captcha: TURNSTILE_SECRET_KEY is not configured in env vars.",
    );
    return json({ success: false, error: "server_misconfigured" }, 500);
  }

  const ip = request.headers.get("CF-Connecting-IP") || "";

  let verifyData;
  try {
    const verifyRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: ip,
        }),
      },
    );
    verifyData = await verifyRes.json();
  } catch (err) {
    console.error(
      "⚠️ verify-captcha: error reaching the Turnstile API:",
      err.message,
    );
    return json({ success: false, error: "upstream_error" }, 502);
  }

  if (!verifyData.success) {
    // Log the real reason (visible via `wrangler tail`) - the frontend
    // only ever shows a generic "verification_failed" to the user, so
    // without this the actual cause (expired/duplicate token, hostname
    // mismatch, wrong secret, etc.) is invisible.
    console.warn(
      "⚠️ verify-captcha: Turnstile rejected the token:",
      verifyData["error-codes"],
    );
  }

  return json({ success: !!verifyData.success });
}

// ── Onboarding completion (server-side, signature-verified) ───────
//
// Replaces the old client-only `dao_onboarded_<address>` localStorage
// flag (src/components/OnboardingOverlay.jsx used to read/write it
// directly) — that flag lived ONLY in the browser, so "Clear site
// data" (or a different browser/device) made a member redo the
// lessons/tests even though nothing about their actual completion had
// changed. This makes the fact durable and tied to the wallet itself,
// not the browser:
//
//   1. The wallet signs a FIXED message (same idea as
//      useNostrIdentity.jsx's deterministic Nostr-key derivation —
//      "prove you control this address" via a signature, not a
//      transaction, so there's no gas cost).
//   2. The worker verifies that signature server-side with viem's
//      verifyMessage() — this recovers the signing address from the
//      signature and checks it matches the claimed `address`, so
//      nobody can mark ANOTHER wallet as onboarded.
//   3. Only then does it write `onboarded:<address>` into
//      ONBOARDING_KV (a Cloudflare KV namespace — see wrangler.jsonc).
//
// This is deliberately NOT on-chain (no contract, no gas for the
// user) — it's the same "server holds the source of truth, wallet
// proves identity via signature" pattern already used for the Nostr
// identity's write-once cache, applied to a durable KV write instead
// of a session-only cache. See the chat discussion for why a fully
// on-chain Soulbound Token is the natural next step if/when the DAO
// wants this to be trustless too (reusing the existing
// Shield/Council SBT pattern), and why plain localStorage or a
// deterministic re-derivation (like the Nostr key) don't work here:
// "did this wallet pass the quiz" is a FACT that has to be recorded
// somewhere, not a value that can be mathematically re-derived from a
// signature the way the Nostr key can.
//
// Must be byte-for-byte identical between this file and
// OnboardingOverlay.jsx's ONBOARDING_COMPLETION_MESSAGE — any
// difference makes every signature verification fail.
const ONBOARDING_COMPLETION_MESSAGE =
  "Confirm DAO onboarding completion — v1";

async function handleOnboardingComplete(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "invalid_body" }, 400);
  }

  const { address, signature } = body || {};
  if (!address || typeof address !== "string") {
    return json({ success: false, error: "missing_address" }, 400);
  }
  if (!signature || typeof signature !== "string") {
    return json({ success: false, error: "missing_signature" }, 400);
  }

  let isValid;
  try {
    isValid = await verifyMessage({
      address,
      message: ONBOARDING_COMPLETION_MESSAGE,
      signature,
    });
  } catch (err) {
    console.warn("⚠️ onboarding/complete: signature verification threw:", err.message);
    return json({ success: false, error: "invalid_signature" }, 400);
  }

  if (!isValid) {
    return json({ success: false, error: "invalid_signature" }, 401);
  }

  if (!env.ONBOARDING_KV) {
    // Fail-closed deliberately, same reasoning as the CAPTCHA secret
    // check above: a misconfigured binding should never silently
    // pretend the write succeeded.
    console.error("⚠️ onboarding/complete: ONBOARDING_KV is not bound in env vars.");
    return json({ success: false, error: "server_misconfigured" }, 500);
  }

  await env.ONBOARDING_KV.put(
    `onboarded:${address.toLowerCase()}`,
    JSON.stringify({ completedAt: Date.now() }),
  );

  return json({ success: true });
}

async function handleOnboardingStatus(request, env) {
  const url = new URL(request.url);
  const address = url.searchParams.get("address");
  if (!address) {
    return json({ onboarded: false, error: "missing_address" }, 400);
  }

  if (!env.ONBOARDING_KV) {
    console.error("⚠️ onboarding/status: ONBOARDING_KV is not bound in env vars.");
    return json({ onboarded: false, error: "server_misconfigured" }, 500);
  }

  const value = await env.ONBOARDING_KV.get(`onboarded:${address.toLowerCase()}`);
  return json({ onboarded: value !== null });
}

async function handleChat(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const { message, history } = body || {};

  if (!message || typeof message !== "string") {
    return json({ success: false, error: "Message is required" }, 400);
  }

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE(buildHistoryContext(history), message);
  const startTime = Date.now();

  const response = await fetchWithRetry(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_API_KEY,
      },
      body: JSON.stringify(geminiRequestBody(systemPrompt)),
    },
  );

  const responseTime = Date.now() - startTime;

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const friendly = friendlyErrorMessage(
      response.status,
      errorData.error?.message || `Gemini API error ${response.status}`,
    );
    return json({ success: false, error: friendly }, response.status);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate) {
    return json({ success: false, error: "No response from Gemini model" }, 502);
  }

  const generatedText = candidate.content?.parts?.[0]?.text;
  if (!generatedText) {
    return json({ success: false, error: "Empty response from Gemini" }, 502);
  }

  return json({
    success: true,
    message: addSignature(generatedText),
    wasTruncated: candidate.finishReason === "MAX_TOKENS",
    finishReason: candidate.finishReason,
    responseTime,
    timestamp: new Date().toISOString(),
  });
}

function handleChatStream(request, env, ctx) {
  return (async () => {
    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const { message, history } = body || {};

    if (!message || typeof message !== "string") {
      return json({ success: false, error: "Message is required" }, 400);
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const send = (payload) =>
      writer.write(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

    const streamWork = (async () => {
      try {
        const systemPrompt = SYSTEM_PROMPT_TEMPLATE(buildHistoryContext(history), message);

        const geminiRes = await fetchWithRetry(
          `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": env.GEMINI_API_KEY,
            },
            body: JSON.stringify(geminiRequestBody(systemPrompt)),
          },
        );

        if (!geminiRes.ok || !geminiRes.body) {
          const friendly = friendlyErrorMessage(
            geminiRes.status,
            `Gemini API error ${geminiRes.status}`,
          );
          await send({ type: "error", error: friendly });
          return;
        }

        const reader = geminiRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullText = "";
        let finishReason = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            let parsed;
            try {
              parsed = JSON.parse(jsonStr);
            } catch {
              continue;
            }

            const candidate = parsed.candidates?.[0];
            const delta = candidate?.content?.parts?.[0]?.text;
            if (delta) {
              fullText += delta;
              await send({ type: "delta", text: delta });
            }
            if (candidate?.finishReason) {
              finishReason = candidate.finishReason;
            }
          }
        }

        if (finishReason === "SAFETY" || finishReason === "RECITATION") {
          await send({
            type: "error",
            error: "Response blocked by safety filters. Please try a different question.",
          });
        } else if (!fullText) {
          await send({ type: "error", error: "Empty response from Gemini" });
        } else {
          await send({
            type: "done",
            message: addSignature(fullText),
            wasTruncated: finishReason === "MAX_TOKENS",
          });
        }
      } catch (err) {
        try {
          await send({ type: "error", error: "Internal server error" });
        } catch {
          // connection already closed
        }
      } finally {
        try {
          await writer.close();
        } catch {
          // already closed
        }
      }
    })();

    ctx.waitUntil(streamWork);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      },
    });
  })();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ status: "ok", model: MODEL });
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json({ success: false, error: "GEMINI_API_KEY is not configured" }, 500);
      }
      return await handleChat(request, env);
    }

    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return json({ success: false, error: "GEMINI_API_KEY is not configured" }, 500);
      }
      return await handleChatStream(request, env, ctx);
    }

    if (url.pathname === "/verify-captcha" && request.method === "POST") {
      return await handleVerifyCaptcha(request, env);
    }

    if (url.pathname === "/api/onboarding/complete" && request.method === "POST") {
      return await handleOnboardingComplete(request, env);
    }

    if (url.pathname === "/api/onboarding/status" && request.method === "GET") {
      return await handleOnboardingStatus(request, env);
    }

    // Everything else: serve the static SPA build (React app, index.html
    // fallback, etc.) — must run AFTER the /api/* checks above, and
    // wrangler.jsonc must set "run_worker_first": true, otherwise
    // Cloudflare's SPA fallback intercepts /api/chat* before this code
    // ever runs (see wrangler.jsonc comment).
    return await env.ASSETS.fetch(request);
  },
};
