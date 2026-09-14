// ./i18n/index.js
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enTranslations from "./locales/en.json";
import ukTranslations from "./locales/uk.json";
import esTranslations from "./locales/es.json";
import frTranslations from "./locales/fr.json";
import deTranslations from "./locales/de.json";
import zhTranslations from "./locales/zh.json";
import hiTranslations from "./locales/hi.json";
import arTranslations from "./locales/ar.json";
import ptTranslations from "./locales/pt.json";
import ruTranslations from "./locales/ru.json";
import jaTranslations from "./locales/ja.json";

const resources = {
  en: { translation: enTranslations },
  uk: { translation: ukTranslations },
  es: { translation: esTranslations },
  fr: { translation: frTranslations },
  de: { translation: deTranslations },
  zh: { translation: zhTranslations },
  hi: { translation: hiTranslations },
  ar: { translation: arTranslations },
  pt: { translation: ptTranslations },
  ru: { translation: ruTranslations },
  ja: { translation: jaTranslations },
};

// ВАЖЛИВО: поле "flag" тепер містить ISO 3166-1 alpha-2 код країни
// (не emoji), щоб LanguageSelector міг побудувати з нього URL
// SVG-іконки прапора. Раніше тут зберігалась emoji ("🇺🇸" тощо),
// яка на системах без кольорового emoji-шрифта (типово — Windows)
// не складалась у прапор, а показувала два звичайні літерні символи
// коду країни поруч із назвою мови.
export const languages = [
  { code: "en", name: "English", flag: "US" },
  { code: "es", name: "Español", flag: "ES" },
  { code: "fr", name: "Français", flag: "FR" },
  { code: "de", name: "Deutsch", flag: "DE" },
  { code: "uk", name: "Українська", flag: "UA" },
  { code: "zh", name: "中文", flag: "CN" },
  { code: "hi", name: "हिन्दी", flag: "IN" },
  { code: "ar", name: "العربية", flag: "SA" },
  { code: "pt", name: "Português", flag: "PT" },
  { code: "ru", name: "Русский", flag: "RU" },
  { code: "ja", name: "日本語", flag: "JP" },
];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en",
    // FIXED: without this, the browser-detected language (via
    // navigator) is usually a full locale like "uk-UA", not "uk".
    // i18next is smart enough to internally fall back to the "uk"
    // resource bundle for translating text (so the page content
    // rendered correctly in Ukrainian) — but i18n.language itself
    // stayed as the full "uk-UA" string. LanguageSelector.jsx compares
    // i18n.language against our short language codes ("uk", "en", ...)
    // with a strict ===, so "uk-UA" never matched "uk" and silently
    // fell back to displaying English — even though the actual content
    // was already in Ukrainian. "languageOnly" makes i18next strip the
    // region subtag right away, so i18n.language is always just "uk",
    // matching our language codes exactly.
    load: "languageOnly",
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
    },
  });

export default i18n;
