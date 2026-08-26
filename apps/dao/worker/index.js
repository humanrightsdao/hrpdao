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

    // Everything else: serve the static SPA build (React app, index.html
    // fallback, etc.) — must run AFTER the /api/* checks above, and
    // wrangler.jsonc must set "run_worker_first": true, otherwise
    // Cloudflare's SPA fallback intercepts /api/chat* before this code
    // ever runs (see wrangler.jsonc comment).
    return await env.ASSETS.fetch(request);
  },
};
