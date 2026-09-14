import { useState, useRef, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { X, Send, Sparkles, AlertCircle } from "lucide-react";
import atticusIcon from "../assets/atticus.png";

// Atticus backend now lives INSIDE this app's own Cloudflare Worker
// (worker/index.js), same pattern as dossier — so this is a same-origin,
// relative call ("" + "/api/chat/stream") and needs no separate host.
// VITE_ATTICUS_API_URL is kept as an optional override only, for local
// dev against a different backend if you ever need it; leave it unset.
const API_BASE = import.meta.env.VITE_ATTICUS_API_URL || "";

export default function AtticusChat({ open, onClose }) {
  const { t } = useTranslation();

  // Re-created whenever the language changes, so a re-opened chat
  // (or a language switch mid-conversation) shows the welcome text
  // in the current language.
  const WELCOME_MESSAGE = useMemo(
    () => ({ role: "atticus", text: t("dao.atticus.welcomeMessage") }),
    [t],
  );

  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const scrollRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open, streaming]);

  useEffect(() => {
    // If the language changes before the person has typed anything,
    // refresh the welcome bubble instead of leaving it in the old
    // language. Once a real conversation has started we leave history alone.
    setMessages((m) =>
      m.length === 1 && m[0].role === "atticus" ? [WELCOME_MESSAGE] : m,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [WELCOME_MESSAGE]);

  useEffect(() => {
    // Abort the stream if the panel is closed mid-response.
    return () => abortRef.current?.abort();
  }, []);

  async function handleSend(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg = { role: "user", text };
    // History for the backend — worker/index.js only takes the last 4
    // and expects the key "content", not "text".
    const history = messages
      .filter((m) => m !== WELCOME_MESSAGE)
      .map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text }));

    setMessages((m) => [...m, userMsg]);
    setInput("");
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // An empty Atticus message that we fill in as delta chunks
    // arrive — a "live typing" effect.
    setMessages((m) => [...m, { role: "atticus", text: "" }]);

    try {
      const res = await fetch(`${API_BASE}/api/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, history }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        throw new Error(t("dao.atticus.serverError", { status: res.status }));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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

          if (parsed.type === "delta") {
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = {
                ...next[next.length - 1],
                text: next[next.length - 1].text + parsed.text,
              };
              return next;
            });
          } else if (parsed.type === "error") {
            setError(parsed.error);
          } else if (parsed.type === "done") {
            setMessages((m) => {
              const next = [...m];
              next[next.length - 1] = { ...next[next.length - 1], text: parsed.message };
              return next;
            });
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        setError(t("dao.atticus.connectionError"));
        // Remove the empty bubble that was left with no text.
        setMessages((m) => (m[m.length - 1]?.text === "" ? m.slice(0, -1) : m));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-screen w-full max-w-sm bg-surface border-l border-hairline z-50 flex flex-col fade-rise">
        <div className="h-16 flex items-center justify-between px-5 border-b border-hairline shrink-0">
          <div className="flex items-center gap-2.5">
            <img
              src={atticusIcon}
              alt="Atticus"
              className="w-8 h-8 rounded-full object-cover border border-hairline"
            />
            <div className="leading-tight">
              <div className="font-display text-sm text-parchment flex items-center gap-1.5">
                Atticus
                <Sparkles size={12} className="text-verdigrisBright" />
              </div>
              <div className="font-mono text-[11px] text-parchmentDim">{t("dao.atticus.subtitle")}</div>
            </div>
          </div>
          <button onClick={onClose} className="text-parchmentDim hover:text-parchment">
            <X size={20} />
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 space-y-4">
          {messages.map((m, i) => (
            <div
              key={i}
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${
                m.role === "atticus"
                  ? "bg-surface2 text-parchment"
                  : "bg-gradient-to-r from-verdigris to-verdigrisDeep text-white ml-auto"
              }`}
            >
              {m.text}
              {m.role === "atticus" && streaming && i === messages.length - 1 && (
                <span className="inline-block w-1.5 h-3.5 bg-verdigrisBright ml-0.5 animate-pulse align-middle" />
              )}
            </div>
          ))}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-seal/40 bg-seal/5 px-3 py-2.5">
              <AlertCircle size={14} className="text-sealBright shrink-0 mt-0.5" />
              <span className="font-mono text-[12px] text-sealBright leading-relaxed">
                {error}
              </span>
            </div>
          )}
        </div>

        <form onSubmit={handleSend} className="p-4 border-t border-hairline flex items-center gap-2 shrink-0">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("dao.atticus.inputPlaceholder")}
            disabled={streaming}
            className="flex-1 bg-surface2 border border-hairline rounded-full px-4 py-2.5 text-sm text-parchment placeholder:text-parchmentDim focus:outline-none focus:border-verdigris disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={streaming || !input.trim()}
            className="w-10 h-10 rounded-full bg-gradient-to-r from-verdigris to-verdigrisDeep flex items-center justify-center shrink-0 hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            <Send size={15} className="text-white" />
          </button>
        </form>
      </div>
    </>
  );
}
