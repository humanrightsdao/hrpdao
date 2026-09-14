// ./components/LanguageSelector.jsx
// Same component/logic as in hrpdaolens/hrpdaonostr (flags via
// flagcdn.com, a portal for the dropdown list) — only the colors were
// switched to this app's dark brand palette.
import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { languages } from "../i18n";
import { Check, ChevronDown } from "lucide-react";

const getFlagUrl = (countryCode) => `https://flagcdn.com/${countryCode.toLowerCase()}.svg`;

const FlagIcon = ({ countryCode, className = "w-5 h-[14px]" }) => (
  <img
    src={getFlagUrl(countryCode)}
    alt=""
    aria-hidden="true"
    className={`${className} rounded-[2px] object-cover flex-shrink-0`}
    loading="lazy"
  />
);

export default function LanguageSelector({ compact = true }) {
  const { i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  const containerRef = useRef(null);
  const listRef = useRef(null);

  const changeLanguage = (lng) => {
    i18n.changeLanguage(lng);
    setIsOpen(false);
  };

  const currentLanguage =
    languages.find((l) => l.code === i18n.language) ||
    languages.find((l) => i18n.language?.startsWith(`${l.code}-`)) ||
    languages[0];

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e) => {
      const insideContainer = containerRef.current?.contains(e.target);
      const insideList = listRef.current?.contains(e.target);
      if (!insideContainer && !insideList) setIsOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const updatePosition = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 6, left: rect.right - 220, width: 220 });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [isOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`flex items-center gap-1.5 border border-hairline rounded-full text-parchmentDim hover:text-parchment hover:border-hairlineStrong transition-colors ${
          compact ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm"
        }`}
      >
        <FlagIcon countryCode={currentLanguage.flag} />
        <span className="font-mono">{currentLanguage.code.toUpperCase()}</span>
        <ChevronDown
          size={12}
          className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      </button>

      {isOpen &&
        createPortal(
          <ul
            ref={listRef}
            role="listbox"
            style={{ position: "fixed", top: position.top, left: position.left, width: position.width }}
            className="z-[9999] max-h-72 overflow-auto rounded-xl border border-hairline bg-surface shadow-2xl py-1"
          >
            {languages.map((lang) => (
              <li key={lang.code} role="option" aria-selected={i18n.language === lang.code}>
                <button
                  type="button"
                  onClick={() => changeLanguage(lang.code)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-2.5 hover:bg-surface2 transition-colors text-sm ${
                    i18n.language === lang.code ? "text-verdigrisBright" : "text-parchment"
                  }`}
                >
                  <FlagIcon countryCode={lang.flag} />
                  <span className="truncate flex-1">{lang.name}</span>
                  {i18n.language === lang.code && <Check size={14} className="shrink-0" />}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
