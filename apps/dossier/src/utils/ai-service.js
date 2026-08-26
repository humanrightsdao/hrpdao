// src/utils/ai-service.js

class AIService {
  constructor() {
    this.name = "AI Atticus";
    this.isInitialized = true;
    this.apiCalls = 0;
    this.lastResponseTime = null;
    this.conversationHistory = [];
  }

  _pushHistory(userMessage, assistantMessage, responseTime, wasTruncated) {
    this.conversationHistory.push({
      role: "user",
      content: userMessage,
      timestamp: new Date().toISOString(),
    });
    this.conversationHistory.push({
      role: "assistant",
      content: assistantMessage,
      timestamp: new Date().toISOString(),
      responseTime,
      wasTruncated: wasTruncated || false,
    });
    if (this.conversationHistory.length > 20) {
      this.conversationHistory = this.conversationHistory.slice(-20);
    }
  }

  restoreHistory(history) {
    this.conversationHistory = Array.isArray(history) ? history.slice(-20) : [];
  }

  /**
   * Streams the response via SSE. Accepts an optional AbortSignal to stop generation.
   * onDelta(chunkText, fullTextSoFar) is called for each new chunk of text.
   */
  async _fetchStreamWithRetry(payload, signal, retries = 1, delayMs = 700) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch("/api/chat/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        });

        if (!response.ok || !response.body) {
          const errText = await response.text().catch(() => "");
          // An empty body + 500/502/504 usually means the backend hasn't
          // finished starting up yet (a race between the Vite proxy and
          // Express on startup), not an actual server error — worth retrying.
          const looksLikeNotReady =
            !errText && [500, 502, 503, 504].includes(response.status);
          if (looksLikeNotReady && attempt < retries) {
            lastErr = new Error(`Server error: ${response.status}`);
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
          throw new Error(errText || `Server error: ${response.status}`);
        }

        return response;
      } catch (error) {
        if (error.name === "AbortError") throw error;
        lastErr = error;
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        throw lastErr;
      }
    }
    throw lastErr;
  }

  async sendMessageStream(message, onDelta, signal) {
    console.log(
      `🧠 ${this.name} stream request #${this.apiCalls + 1}:`,
      message,
    );
    const startTime = Date.now();

    const response = await this._fetchStreamWithRetry(
      {
        message,
        history: this.conversationHistory.slice(-4).map((m) => ({
          role: m.role,
          content: m.content,
        })),
      },
      signal,
    );

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let finalMessage = null;
    let wasTruncated = false;
    let streamError = null;
    let wasAborted = false;

    try {
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

          let evt;
          try {
            evt = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (evt.type === "delta") {
            fullText += evt.text;
            onDelta?.(evt.text, fullText);
          } else if (evt.type === "done") {
            finalMessage = evt.message;
            wasTruncated = evt.wasTruncated || false;
          } else if (evt.type === "error") {
            streamError = evt.error;
          }
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        wasAborted = true;
      } else {
        throw error;
      }
    }

    if (streamError) {
      throw new Error(streamError);
    }

    const responseTime = Date.now() - startTime;
    this.lastResponseTime = responseTime;
    this.apiCalls++;

    let messageText = finalMessage || fullText;
    if (wasAborted && !finalMessage) {
      messageText = fullText; // keep whatever we managed to receive
    }

    this._pushHistory(message, messageText, responseTime, wasTruncated);

    console.log(
      `✅ ${this.name} stream ${wasAborted ? "aborted" : "done"}: ${responseTime}ms`,
    );

    return { message: messageText, responseTime, wasTruncated, wasAborted };
  }

  async sendMessage(message) {
    try {
      const startTime = Date.now();

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          history: this.conversationHistory.slice(-4).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          "The server returned an invalid response. Check whether the backend is running.",
        );
      }

      if (!response.ok || !data.success) {
        throw new Error(data.error || `Server error: ${response.status}`);
      }

      const responseTime = data.responseTime || Date.now() - startTime;
      this.lastResponseTime = responseTime;
      this.apiCalls++;
      this._pushHistory(message, data.message, responseTime, data.wasTruncated);

      return {
        success: true,
        message: data.message,
        responseTime,
        messageId: Date.now().toString(),
        timestamp: data.timestamp || new Date().toISOString(),
        wasTruncated: data.wasTruncated || false,
      };
    } catch (error) {
      console.error(`❌ ${this.name} error:`, error);
      let friendlyMessage = error.message;
      if (
        error.message.includes("fetch") ||
        error.message.includes("Failed to fetch")
      ) {
        friendlyMessage =
          "Could not connect to the server. Make sure the backend is running (server/).";
      }
      return {
        success: false,
        error: friendlyMessage,
        messageId: Date.now().toString(),
        timestamp: new Date().toISOString(),
      };
    }
  }

  clearHistory() {
    this.conversationHistory = [];
    console.log("🗑️ Conversation history cleared");
    return true;
  }

  getHistory() {
    return [...this.conversationHistory];
  }

  getStatus() {
    return {
      name: this.name,
      isInitialized: this.isInitialized,
      apiCalls: this.apiCalls,
      lastResponseTime: this.lastResponseTime,
      conversationLength: this.conversationHistory.length,
      status: this.isInitialized ? "ready" : "not_initialized",
      model: "gemini-3-flash-preview",
      service: "Google Gemini AI (via secure backend, streaming)",
      maxTokens: 8000,
      note: "AI Atticus - your human rights protection assistant",
    };
  }

  async getLawReference(lawName, article) {
    const query = `Provide exact information about ${lawName} article ${article} with references to related norms`;
    return await this.sendMessage(query);
  }

  async testConnection() {
    console.log(`🧪 Testing ${this.name} connection...`);
    const testMessage =
      "What to do if police detained illegally? Provide law references.";
    try {
      const result = await this.sendMessage(testMessage);
      return {
        ...result,
        advisor: this.name,
        testMessage,
        apiCalls: this.apiCalls,
      };
    } catch (error) {
      return {
        success: false,
        advisor: this.name,
        error: error.message,
        apiCalls: this.apiCalls,
      };
    }
  }
}

export const aiService = new AIService();

if (typeof window !== "undefined") {
  window.aiService = aiService;
  console.log(
    `🧠 ${aiService.name} AI advisor ready (streaming, secure backend)!`,
  );
}
