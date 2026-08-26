// worker/index.js
// Cloudflare Worker version of server/index.js.
// Serves /api/chat and /api/chat/stream, everything else falls through to static assets.

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

// MOVED HERE FROM functions/verify-captcha.js: this project deploys as a
// plain Cloudflare Worker (wrangler.jsonc has "main": "worker/index.js"
// with an "assets" binding), NOT as Cloudflare Pages. The
// functions/verify-captcha.js file only works under the Cloudflare
// Pages build system's automatic file-based routing — with a plain
// Worker deploy (`wrangler deploy`), that file is never picked up or
// executed at all, so POST /verify-captcha just fell through to static
// asset serving and never actually validated anything. Moving the exact
// same logic into a route inside this fetch handler (same pattern as
// /api/chat below) makes it actually run.
//
// TURNSTILE_SECRET_KEY must be added the same way GEMINI_API_KEY is —
// as a Secret in Cloudflare (Workers & Pages → hrpdaolens → Settings →
// Variables and secrets → Add → type "Secret"), or via
// `npx wrangler secret put TURNSTILE_SECRET_KEY` from the CLI. It must
// NEVER be the public VITE_TURNSTILE_SITE_KEY value — that one is the
// client-side site key and is fine to be public; this one is the
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

  return json({ success: !!verifyData.success });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

// Security headers applied to every response. Addresses the Lighthouse
// "Trust & Safety" checks (CSP, HSTS, COOP, X-Frame-Options, Trusted
// Types). CSP starts in Report-Only: this app talks to many third-party
// origins (wallet connectors/WalletConnect relay, Lens API + RPC,
// IPFS/Arweave/Grove storage, OpenStreetMap/Carto map tiles, IP
// geolocation lookups, Cloudflare Turnstile). Shipping an *enforced*
// CSP without first observing real traffic risks silently breaking
// wallet connect or the violations map. Watch the browser console (or
// wire up a report-to endpoint) for a while, fix any violations, then
// flip the header name below from Content-Security-Policy-Report-Only
// to Content-Security-Policy once it's confirmed clean.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src https://challenges.cloudflare.com https://verify.walletconnect.com https://verify.walletconnect.org",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'self'",
].join("; ");

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy-Report-Only", CSP);
  headers.set(
    "Strict-Transport-Security",
    "max-age=63072000; includeSubDomains; preload",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  // "same-origin-allow-popups" (not "same-origin") is required for
  // Privy's OAuth login popups (Google, plus the Coinbase/Base
  // Account SDKs it loads for the "wallet" login option) — plain
  // "same-origin" severs window.opener, so the popup completes login
  // but can never report success back to this page.
  headers.set("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // HTML documents (index.html) must never be cached at Cloudflare's edge.
  // The static-assets handler sets "Cache-Control: public, max-age=0,
  // must-revalidate" on it, which still lets the CDN cache the *entire*
  // response (headers included) and serve that frozen snapshot on every
  // subsequent request via 304 revalidation - so a new deploy's updated
  // headers (like the ones above) or body could silently keep being
  // masked by an older cached copy. Hashed JS/CSS/image filenames (e.g.
  // index-BwYBdYUu.js) are safe to cache forever since their name
  // changes whenever their content does - only override the entry
  // document itself.
  const contentType = headers.get("Content-Type") || "";
  if (contentType.includes("text/html")) {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return withSecurityHeaders(json({ status: "ok", model: MODEL }));
    }

    if (url.pathname === "/api/chat" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return withSecurityHeaders(
          json({ success: false, error: "GEMINI_API_KEY is not configured" }, 500),
        );
      }
      return withSecurityHeaders(await handleChat(request, env));
    }

    if (url.pathname === "/api/chat/stream" && request.method === "POST") {
      if (!env.GEMINI_API_KEY) {
        return withSecurityHeaders(
          json({ success: false, error: "GEMINI_API_KEY is not configured" }, 500),
        );
      }
      // SSE stream response: headers only, body passes through untouched.
      return withSecurityHeaders(await handleChatStream(request, env, ctx));
    }

    if (url.pathname === "/verify-captcha" && request.method === "POST") {
      return withSecurityHeaders(await handleVerifyCaptcha(request, env));
    }

    // Everything else: serve the static SPA build
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
