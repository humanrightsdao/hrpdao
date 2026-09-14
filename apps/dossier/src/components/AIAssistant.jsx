// src/components/AIAssistant.jsx
import React, { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Send,
  Bot,
  User,
  Clock,
  Copy,
  Trash2,
  AlertCircle,
  Check,
  Volume2,
  X,
  Square,
} from "lucide-react";
import { aiService } from "../utils/ai-service";
import useUserInfo from "../hooks/useUserInfo";

const STORAGE_KEY = "atticus_chat_history_v1";

const markdownComponents = {
  p: (props) => <p className="mb-2 last:mb-0" {...props} />,
  strong: (props) => <strong className="font-semibold" {...props} />,
  ul: (props) => <ul className="list-disc pl-5 mb-2 space-y-1" {...props} />,
  ol: (props) => <ol className="list-decimal pl-5 mb-2 space-y-1" {...props} />,
  li: (props) => <li {...props} />,
  a: (props) => (
    <a
      className="underline decoration-1 underline-offset-2 hover:opacity-80"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  code: ({ inline, ...props }) =>
    inline ? (
      <code
        className="px-1 py-0.5 rounded bg-black/10 dark:bg-white/10 text-[0.9em]"
        {...props}
      />
    ) : (
      <code
        className="block p-2 my-1 rounded-lg bg-black/10 dark:bg-white/10 overflow-x-auto text-[0.9em]"
        {...props}
      />
    ),
  blockquote: (props) => (
    <blockquote
      className="border-l-2 border-current/30 pl-3 italic opacity-80 mb-2"
      {...props}
    />
  ),
  h1: (props) => (
    <h3 className="font-semibold text-[15px] mt-2 mb-1" {...props} />
  ),
  h2: (props) => (
    <h3 className="font-semibold text-[15px] mt-2 mb-1" {...props} />
  ),
  h3: (props) => (
    <h4 className="font-semibold text-[14px] mt-2 mb-1" {...props} />
  ),
  hr: () => <hr className="my-2 border-current/15" />,
};

const loadPersistedMessages = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
};

const persistMessages = (messages) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  } catch {
    // ignore
  }
};

const AIAssistant = ({ onClose, isFullPage = false }) => {
  const { t } = useTranslation();
  const { userInfo, getAvatar } = useUserInfo();
  const [messages, setMessages] = useState([]);
  const [inputMessage, setInputMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const abortControllerRef = useRef(null);

  const AVATAR_SIZES = {
    normal: { container: "w-10 h-10", icon: "w-5 h-5" },
    header: { container: "w-12 h-12", icon: "w-6 h-6" },
  };

  const makeWelcomeMessage = (id = "welcome") => ({
    id,
    text:
      t("ai_welcome") ||
      `Hello! I am ${aiService.name} - your AI human rights advisor.\n\nI can help with:\n• Explanation of human rights\n• References to laws and articles\n• Practical advice on rights protection\n• International protection mechanisms\n\nAsk your question!`,
    sender: "ai",
    timestamp: new Date().toISOString(),
    status: "sent",
  });

  useEffect(() => {
    const persisted = loadPersistedMessages();
    if (persisted) {
      setMessages(persisted);
      const restoredHistory = persisted
        .filter(
          (m) =>
            m.id !== "welcome" &&
            m.id !== "welcome_cleared" &&
            m.sender !== "error",
        )
        .map((m) => ({
          role: m.sender === "user" ? "user" : "assistant",
          content: m.text,
          timestamp: m.timestamp,
        }));
      aiService.restoreHistory(restoredHistory);
    } else {
      setMessages([makeWelcomeMessage()]);
    }

    setTimeout(() => inputRef.current?.focus(), 300);
  }, [t]);

  useEffect(() => {
    if (messages.length > 0) {
      persistMessages(messages);
    }
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async (messageText = null) => {
    const textToSend = messageText || inputMessage.trim();
    if (!textToSend || isLoading) return;

    const userMessage = {
      id: `user_${Date.now()}`,
      text: textToSend,
      sender: "user",
      timestamp: new Date().toISOString(),
      status: "sent",
      avatarUrl: getAvatar(),
    };

    const aiMessageId = `ai_${Date.now()}`;
    const aiMessagePlaceholder = {
      id: aiMessageId,
      text: "",
      sender: "ai",
      timestamp: new Date().toISOString(),
      status: "streaming",
    };

    setMessages((prev) => [...prev, userMessage, aiMessagePlaceholder]);
    setInputMessage("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    setIsLoading(true);

    const startTime = Date.now();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await aiService.sendMessageStream(
        textToSend,
        (_chunk, fullTextSoFar) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === aiMessageId ? { ...m, text: fullTextSoFar } : m,
            ),
          );
        },
        controller.signal,
      );

      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMessageId
            ? {
                ...m,
                text: result.wasAborted
                  ? `${m.text}\n\n*[Generation stopped]*`
                  : m.text,
                status: "sent",
                responseTime: Date.now() - startTime,
              }
            : m,
        ),
      );
    } catch (error) {
      console.error("Send error:", error);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMessageId
            ? {
                ...m,
                text: `${t("ai_error") || "Error"}: ${error.message}`,
                sender: "error",
                status: "error",
              }
            : m,
        ),
      );
    } finally {
      setIsLoading(false);
      abortControllerRef.current = null;
      inputRef.current?.focus();
    }
  };

  const stopGeneration = () => {
    abortControllerRef.current?.abort();
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleInputChange = (e) => {
    setInputMessage(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text).then(() => {
      console.log("Text copied");
    });
  };

  const clearChat = () => {
    if (window.confirm(t("ai_clear_confirm") || "Clear chat history?")) {
      aiService.clearHistory();
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
      setMessages([makeWelcomeMessage("welcome_cleared")]);
      setInputMessage("");
      if (inputRef.current) {
        inputRef.current.style.height = "auto";
        inputRef.current.focus();
      }
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  const formatResponseTime = (ms) => {
    if (!ms) return "";
    return `${ms}ms`;
  };

  const getUserAvatar = (message) => {
    if (message.sender === "user" && message.avatarUrl) {
      return message.avatarUrl;
    }
    return null;
  };

  const getAIAvatar = () => "/atticus.png";

  const MessageBubble = ({ message }) => {
    const isUser = message.sender === "user";
    const isError = message.sender === "error";
    const isStreaming = message.status === "streaming";
    const userAvatar = getUserAvatar(message);
    const sizes = AVATAR_SIZES.normal;

    return (
      <div className={`flex gap-3 mb-4 ${isUser ? "flex-row-reverse" : ""}`}>
        <div
          className={`flex-shrink-0 ${sizes.container} rounded-full flex items-center justify-center overflow-hidden ${
            isUser
              ? "bg-blue-100 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700/20"
              : isError
                ? "bg-red-100 dark:bg-red-900/20 border border-red-300 dark:border-red-700/20"
                : "bg-[#0d0415] border border-[#b41e3c]/25"
          }`}
        >
          {userAvatar ? (
            <img
              src={userAvatar}
              alt="User avatar"
              className="w-full h-full object-cover"
              onError={(e) => {
                e.target.style.display = "none";
                e.target.parentNode.innerHTML = `<User class="${sizes.icon} text-blue-600 dark:text-blue-400/70" />`;
              }}
            />
          ) : isUser ? (
            <User
              className={`${sizes.icon} text-blue-600 dark:text-blue-400/70`}
            />
          ) : isError ? (
            <AlertCircle
              className={`${sizes.icon} text-red-600 dark:text-red-400/70`}
            />
          ) : (
            <img
              src={getAIAvatar()}
              alt="AI Avatar"
              className="w-full h-full object-cover"
              onError={(e) => {
                e.target.style.display = "none";
                e.target.parentNode.innerHTML = `<Bot class="${sizes.icon} text-[#c8b8a2]/70" />`;
              }}
            />
          )}
        </div>

        <div className={`flex-1 ${isUser ? "max-w-[80%]" : "max-w-[85%]"}`}>
          <div
            className={`rounded-2xl px-4 py-3 ${
              isUser
                ? "bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 dark:bg-[#2B000A] dark:border-[#b41e3c]/30 dark:text-[#e8a0b0]/90 rounded-br-none"
                : isError
                  ? "bg-red-50 dark:bg-red-900/10 border border-red-300 dark:border-red-700/20 text-red-700 dark:text-red-400/80 rounded-bl-none"
                  : "bg-white dark:bg-[#000d1f] border border-slate-300 dark:border-white/[0.07] text-slate-900 dark:text-white/80 rounded-bl-none"
            }`}
          >
            {isUser || isError ? (
              <div className="whitespace-pre-wrap break-words text-[16px] leading-relaxed">
                {message.text}
              </div>
            ) : (
              <div className="text-[16px] leading-relaxed">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={markdownComponents}
                >
                  {message.text || " "}
                </ReactMarkdown>
                {isStreaming && (
                  <span className="inline-block w-[2px] h-[16px] align-middle ml-0.5 bg-current animate-pulse" />
                )}
              </div>
            )}

            {!isStreaming && (
              <div
                className={`flex items-center justify-between mt-2 text-[14px] ${
                  isUser
                    ? "text-white/70 dark:text-[#e8a0b0]/40"
                    : isError
                      ? "text-red-600/70 dark:text-red-400/40"
                      : "text-slate-600 dark:text-white/40"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Clock className="w-3 h-3" />
                  <span>{formatTime(message.timestamp)}</span>
                  {message.responseTime && (
                    <span className="ml-1 text-slate-600 dark:text-white/40">
                      • {formatResponseTime(message.responseTime)}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {message.sender === "ai" && (
                    <button
                      onClick={() => copyToClipboard(message.text)}
                      className="opacity-40 hover:opacity-100 transition-opacity"
                      title={t("copy") || "Copy"}
                    >
                      <Copy className="w-3 h-3" />
                    </button>
                  )}
                  {message.status === "sent" && (
                    <Check className="w-3 h-3 text-emerald-400/60" />
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      className={`flex flex-col h-full ${isFullPage ? "min-h-screen" : ""} bg-gradient-to-br from-gray-50 to-blue-50 dark:from-gray-800 dark:to-gray-800`}
    >
      <div className="p-4 border-b border-white/[0.06] bg-[#000d1f] flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`${AVATAR_SIZES.header.container} rounded-full flex items-center justify-center overflow-hidden bg-[#0d0415] border border-[#b41e3c]/25`}
            >
              <img
                src={getAIAvatar()}
                alt="AI Avatar"
                className="w-full h-full object-cover"
                onError={(e) => {
                  e.target.style.display = "none";
                  e.target.parentNode.innerHTML = `<Bot class="${AVATAR_SIZES.header.icon} text-[#c8b8a2]/70" />`;
                }}
              />
            </div>
            <div>
              <h2 className="font-cinzel text-[16px] font-medium text-white/70 tracking-wide">
                {aiService.name}
              </h2>
              <p className="text-[14px] text-white/40">
                {t("ai_subtitle") || "AI human rights advisor"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={clearChat}
              className="p-2 rounded-lg hover:bg-white/[0.05] text-white/40 hover:text-white/60 transition-colors"
              title={t("clear_chat") || "Clear chat history"}
            >
              <Trash2 className="w-4 h-4" />
            </button>

            {onClose && (
              <button
                onClick={onClose}
                className="p-2 rounded-lg hover:bg-white/[0.05] text-white/40 hover:text-white/60 transition-colors"
                title={t("close") || "Close"}
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-5 mt-3 text-[14px] text-white/40">
          <div className="flex items-center gap-1.5">
            <span>{t("messages") || "Messages"}:</span>
            <span className="text-white/45 font-medium">
              {messages.length - 1}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 bg-emerald-400/60 rounded-full animate-pulse"></div>
            <span>{t("status") || "Status"}:</span>
            <span className="text-emerald-400/60">
              {t("ai_online") || "Online"}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 bg-gradient-to-br from-gray-50 to-blue-50 dark:from-gray-800 dark:to-gray-800">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="p-4 border-t border-white/[0.06] bg-gradient-to-br from-gray-50 to-blue-50 dark:from-gray-800 dark:to-gray-800 flex-shrink-0">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={inputRef}
              value={inputMessage}
              onChange={handleInputChange}
              onKeyPress={handleKeyPress}
              placeholder={
                t("ai_placeholder") ||
                "Write your question about human rights..."
              }
              disabled={isLoading}
              rows="3"
              className="w-full px-4 py-3 pr-4 bg-white/[0.6] dark:bg-white/[0.03] border border-gray-300 dark:border-white/[0.09] rounded-xl focus:outline-none focus:border-blue-500/50 dark:focus:border-blue-500/35 transition-all resize-none text-gray-900 dark:text-white/70 text-[16px] leading-relaxed placeholder-gray-500 dark:placeholder-white/[0.18] disabled:opacity-40 font-['Inter'] overflow-y-auto"
              style={{ minHeight: "88px", maxHeight: "220px" }}
            />
          </div>

          {isLoading ? (
            <button
              onClick={stopGeneration}
              className="flex-shrink-0 self-end p-2.5 rounded-xl bg-slate-700 border border-slate-600 text-white hover:bg-slate-600 transition-all duration-200"
              title={t("stop_generation") || "Stop generation"}
            >
              <Square className="w-5 h-5" fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={() => sendMessage()}
              disabled={!inputMessage.trim()}
              className="flex-shrink-0 self-end p-2.5 rounded-xl bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35 dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-[#e8a0b0]/80 dark:hover:bg-[#3d0012] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200"
              title={t("send") || "Send"}
            >
              <Send className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="flex items-center justify-between mt-2 text-[11px] text-gray-600 dark:text-white/40">
          <div className="flex items-center gap-4">
            <span>
              {t("ai_tip") || "Press Enter to send, Shift+Enter for a new line"}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Volume2 className="w-3 h-3" />
            <span>
              {t("ai_disclaimer") ||
                "AI can make mistakes. Consult with lawyers."}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AIAssistant;
