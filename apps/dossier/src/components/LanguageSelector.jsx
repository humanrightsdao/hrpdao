// ./components/LanguageSelector.jsx
import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { languages } from "../i18n";

// flagcdn.com serves vector (SVG) flags by ISO country code.
// This removes any dependency on the user's system emoji font —
// the flag looks the same on Windows/macOS/Linux/mobile.
const getFlagUrl = (countryCode) =>
  `https://flagcdn.com/${countryCode.toLowerCase()}.svg`;

const FlagIcon = ({ countryCode, className = "w-5 h-[14px]" }) => (
  <img
    src={getFlagUrl(countryCode)}
    alt=""
    aria-hidden="true"
    className={`${className} rounded-[2px] object-cover flex-shrink-0`}
    loading="lazy"
  />
);

const DEFAULT_BUTTON_CLASS =
  "w-full flex items-center justify-between gap-2 rounded-full font-semibold transition-all duration-300 border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent hover:bg-gray-100 dark:hover:bg-gray-600 cursor-pointer";

const DEFAULT_LIST_CLASS =
  "rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800";

const LanguageSelector = ({
  className = "",
  isFloating = false,
  compact = false,
  buttonClassName,
  listClassName,
}) => {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 0 });
  const containerRef = useRef(null);
  const listRef = useRef(null);

  const changeLanguage = (lng) => {
    i18n.changeLanguage(lng);
    setIsOpen(false);
  };

  // DEFENSIVE FIX: the primary fix is `load: "languageOnly"` in
  // i18n/index.js, which normalizes i18n.language to a short code like
  // "uk" instead of "uk-UA". This extra startsWith check is a safety
  // net in case i18n.language ever ends up as a full locale again
  // (e.g. a future language added without updating i18n config) — a
  // strict === match alone would silently fall back to languages[0]
  // (English) instead of showing the actually-active language.
  const currentLanguage =
    languages.find((lang) => lang.code === i18n.language) ||
    languages.find((lang) => i18n.language?.startsWith(`${lang.code}-`)) ||
    languages[0];

  // Close the dropdown on a click outside the button or outside the list
  // (the list may be in a portal, i.e. physically not inside containerRef)
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event) => {
      const insideContainer = containerRef.current?.contains(event.target);
      const insideList = listRef.current?.contains(event.target);
      if (!insideContainer && !insideList) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // For non-floating mode, the list is rendered via a portal into
  // document.body (otherwise overflow-hidden on parent cards on
  // SettingsPage would clip it). So the list's position needs to be
  // computed manually from the button.
  useEffect(() => {
    if (!isOpen || isFloating) return;
    const updatePosition = () => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width });
    };
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [isOpen, isFloating]);

  if (isFloating) {
    return (
      <div
        className={`fixed top-4 right-4 z-50 ${className}`}
        ref={containerRef}
      >
        <div className="relative">
          <button
            type="button"
            className="flex items-center gap-2 px-4 py-3 rounded-full font-semibold text-sm text-white
              bg-gradient-to-r from-gray-900 via-blue-950 to-blue-900
              hover:from-black hover:via-gray-900 hover:to-blue-950
              transition-all duration-300 transform hover:scale-105
              shadow-md hover:shadow-xl ring-2 ring-transparent hover:ring-white hover:ring-opacity-60
              focus:outline-none focus:ring-2 focus:ring-blue-500"
            aria-label={t("select_language")}
            aria-expanded={isOpen}
            onClick={() => setIsOpen((prev) => !prev)}
          >
            <FlagIcon countryCode={currentLanguage.flag} />
            <span>{currentLanguage.code.toUpperCase()}</span>
            <svg
              className={`w-4 h-4 transition-transform ${isOpen ? "rotate-180" : ""}`}
              fill="currentColor"
              viewBox="0 0 20 20"
            >
              <path
                fillRule="evenodd"
                d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>

          {isOpen && (
            <div className="absolute top-full right-0 mt-2">
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 min-w-[180px] overflow-hidden">
                {languages.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => changeLanguage(lang.code)}
                    className={`w-full px-4 py-3 text-left flex items-center gap-3 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors
                      ${i18n.language === lang.code ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300" : "text-gray-700 dark:text-gray-200"}`}
                  >
                    <FlagIcon
                      countryCode={lang.flag}
                      className="w-5 h-[14px]"
                    />
                    <div className="flex flex-col">
                      <span className="font-medium">{lang.name}</span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {lang.code.toUpperCase()}
                      </span>
                    </div>
                    {i18n.language === lang.code && (
                      <svg
                        className="w-5 h-5 ml-auto text-blue-500"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                      >
                        <path
                          fillRule="evenodd"
                          d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                          clipRule="evenodd"
                        />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // A custom dropdown instead of the native <select>.
  // <option> in browsers can't display an <img>/SVG, so displaying flag
  // images requires custom markup — a button + a list.
  // Button/list styles are fully controlled via the buttonClassName/
  // listClassName props — this way the parent page can adapt the look to
  // its own design (previously this was done via the CSS hack
  // "[&_select]:...", which targeted the <select> tag and broke once it
  // was replaced with the custom UI).
  return (
    <div className={`relative ${className}`} ref={containerRef}>
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        className={`${buttonClassName ?? DEFAULT_BUTTON_CLASS} ${
          compact ? "px-3 py-2 text-sm" : "p-3"
        }`}
      >
        <span className="flex items-center gap-2 truncate min-w-0">
          <FlagIcon countryCode={currentLanguage.flag} />
          <span className="truncate">{currentLanguage.name}</span>
        </span>
        <svg
          className="h-5 w-5 fill-current flex-shrink-0 transition-transform"
          style={{ transform: isOpen ? "rotate(180deg)" : undefined }}
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 20 20"
          aria-hidden="true"
        >
          <path d="M9.293 12.95l.707.707L15.657 8l-1.414-1.414L10 10.828 5.757 6.586 4.343 8z" />
        </svg>
      </button>

      {isOpen &&
        createPortal(
          <ul
            ref={listRef}
            role="listbox"
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: position.width,
            }}
            className={`z-[9999] max-h-64 overflow-auto ${listClassName ?? DEFAULT_LIST_CLASS}`}
          >
            {languages.map((lang) => (
              <li
                key={lang.code}
                role="option"
                aria-selected={i18n.language === lang.code}
              >
                <button
                  type="button"
                  onClick={() => changeLanguage(lang.code)}
                  className={`w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-sm
                    ${i18n.language === lang.code ? "bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300" : "text-gray-700 dark:text-gray-200"}`}
                >
                  <FlagIcon countryCode={lang.flag} />
                  <span className="truncate">{lang.name}</span>
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
};

export default LanguageSelector;
