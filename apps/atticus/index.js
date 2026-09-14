// server/index.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3005;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = "gemini-3-flash-preview";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

if (!API_KEY) {
  console.error(
    "❌ GEMINI_API_KEY not found. Add it to server/.env (without the VITE_ prefix)",
  );
  process.exit(1);
}

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
      {
        category: "HARM_CATEGORY_HARASSMENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
      {
        category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_MEDIUM_AND_ABOVE",
      },
    ],
  };
}

/** Retries the request on a 503 (overloaded) or 429 (a short burst over the per-minute limit). */
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
    console.warn(
      `⏳ Gemini ${lastResponse.status}, attempt ${attempt + 1}/${retries} after ${delayMs}ms`,
    );
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

// ---------- Non-streaming (fallback / testConnection) ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== "string") {
      return res
        .status(400)
        .json({ success: false, error: "Message is required" });
    }

    const systemPrompt = SYSTEM_PROMPT_TEMPLATE(
      buildHistoryContext(history),
      message,
    );
    const startTime = Date.now();

    const response = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": API_KEY,
        },
        body: JSON.stringify(geminiRequestBody(systemPrompt)),
      },
    );

    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error("Gemini error:", response.status, errorData);
      const friendly = friendlyErrorMessage(
        response.status,
        errorData.error?.message || `Gemini API error ${response.status}`,
      );
      return res
        .status(response.status)
        .json({ success: false, error: friendly });
    }

    const data = await response.json();
    const candidate = data.candidates?.[0];
    if (!candidate) {
      return res
        .status(502)
        .json({ success: false, error: "No response from Gemini model" });
    }

    let generatedText = candidate.content?.parts?.[0]?.text;
    if (!generatedText) {
      return res
        .status(502)
        .json({ success: false, error: "Empty response from Gemini" });
    }

    res.json({
      success: true,
      message: addSignature(generatedText),
      wasTruncated: candidate.finishReason === "MAX_TOKENS",
      finishReason: candidate.finishReason,
      responseTime,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Server error (/api/chat):", error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: "Internal server error" });
    }
  }
});

// ---------- Streaming (main path) ----------
app.post("/api/chat/stream", async (req, res) => {
  const { message, history } = req.body || {};

  if (!message || typeof message !== "string") {
    return res
      .status(400)
      .json({ success: false, error: "Message is required" });
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  try {
    const systemPrompt = SYSTEM_PROMPT_TEMPLATE(
      buildHistoryContext(history),
      message,
    );

    const geminiRes = await fetchWithRetry(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": API_KEY,
        },
        body: JSON.stringify(geminiRequestBody(systemPrompt)),
      },
    );

    if (!geminiRes.ok || !geminiRes.body) {
      const errText = await geminiRes.text().catch(() => "");
      console.error("Gemini stream error:", geminiRes.status, errText);
      const friendly = friendlyErrorMessage(
        geminiRes.status,
        `Gemini API error ${geminiRes.status}`,
      );
      send({ type: "error", error: friendly });
      return res.end();
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
          send({ type: "delta", text: delta });
        }
        if (candidate?.finishReason) {
          finishReason = candidate.finishReason;
        }
      }
    }

    if (finishReason === "SAFETY" || finishReason === "RECITATION") {
      send({
        type: "error",
        error:
          "Response blocked by safety filters. Please try a different question.",
      });
      return res.end();
    }

    if (!fullText) {
      send({ type: "error", error: "Empty response from Gemini" });
      return res.end();
    }

    const finalMessage = addSignature(fullText);
    send({
      type: "done",
      message: finalMessage,
      wasTruncated: finishReason === "MAX_TOKENS",
    });
    res.end();
  } catch (error) {
    console.error("Streaming error:", error);
    try {
      send({ type: "error", error: "Internal server error" });
      res.end();
    } catch (_) {
      // the connection is already closed
    }
  }
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", model: MODEL });
});

app.listen(PORT, () => {
  console.log(`🧠 AI Atticus backend running on http://localhost:${PORT}`);
  console.log(`⚡ Model: ${MODEL}`);
});
