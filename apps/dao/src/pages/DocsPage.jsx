import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, ExternalLink, ChevronDown, FileText, Sigma, Feather, Library, FileCode2 } from "lucide-react";

// ── Project document types ──────────────────────────────────
// Explains the difference between Whitepaper/Yellow Paper/Litepaper/
// Docs/Spec — so it's clear what to look for and where. url: "#" =
// the document hasn't been written yet, will be added later.
const DOCUMENT_TYPES = [
  { key: "whitepaper", icon: FileText, url: "#" },
  { key: "yellowpaper", icon: Sigma, url: "#" },
  { key: "litepaper", icon: Feather, url: "#" },
  { key: "docs", icon: Library, url: "#" },
  { key: "spec", icon: FileCode2, url: "#" },
];

const MATERIALS = [
  { key: "policy", url: "https://ipfs.io/ipfs/QmfZ4Qg1XiR6Y1Lnm4fnykWi6EhpwmkVSzzVNiiQS6YMSF/" },
  { key: "governor", url: "#" },
  { key: "discipline", url: "#" },
  { key: "verification", url: "#" },
];

export default function DocsPage() {
  const { t } = useTranslation();
  const [openType, setOpenType] = useState(0);

  return (
    <div className="fade-rise max-w-2xl">
      <div className="font-mono text-xs tracking-[0.2em] text-verdigrisBright uppercase mb-2">
        {t("dao.docs.governance")}
      </div>
      <h1 className="font-display font-semibold text-3xl text-parchment mb-2 flex items-center gap-3">
        <BookOpen size={26} className="text-verdigrisBright" />
        {t("dao.docs.title")}
      </h1>
      <p className="text-parchmentDim text-sm mb-8">
        {t("dao.docs.description")}
      </p>

      <h2 className="font-display text-sm uppercase tracking-widest text-parchmentDim mb-3">
        {t("dao.docs.documentTypes")}
      </h2>
      <div className="rounded-2xl border border-hairline overflow-hidden mb-8">
        {DOCUMENT_TYPES.map((doc, i) => {
          const Icon = doc.icon;
          const open = openType === i;
          const available = doc.url !== "#";
          const title = t(`dao.docs.types.${doc.key}.title`);
          const desc = t(`dao.docs.types.${doc.key}.desc`);
          return (
            <div key={doc.key} className="border-b border-hairline last:border-b-0">
              <button
                onClick={() => setOpenType(open ? -1 : i)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left hover:bg-surface2/50 transition-colors"
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <Icon size={16} className="text-verdigrisBright shrink-0" />
                  <span className="text-sm text-parchment truncate">{title}</span>
                  {!available && (
                    <span className="font-mono text-[11px] px-2 py-0.5 rounded-full bg-surface2 text-parchmentDim shrink-0">
                      {t("dao.docs.comingSoon")}
                    </span>
                  )}
                </span>
                <ChevronDown
                  size={16}
                  className={`text-parchmentDim shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
                />
              </button>
              {open && (
                <div className="px-4 pb-4">
                  <p className="text-parchmentDim text-sm leading-relaxed">{desc}</p>
                  {available && (
                    <a
                      href={doc.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 mt-3 font-mono text-xs text-verdigris hover:text-verdigrisBright"
                    >
                      {t("dao.docs.open")} <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <h2 className="font-display text-sm uppercase tracking-widest text-parchmentDim mb-3">
        {t("dao.docs.materials")}
      </h2>
      <div className="space-y-2">
        {MATERIALS.map((d) => {
          const title = t(`dao.docs.materialsList.${d.key}.title`);
          const desc = t(`dao.docs.materialsList.${d.key}.desc`);
          return (
            <a
              key={d.key}
              href={d.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-3 rounded-xl border border-hairline p-4 hover:border-hairlineStrong hover:bg-surface2/40 transition-colors"
            >
              <div>
                <div className="text-sm text-parchment">{title}</div>
                <div className="text-xs text-parchmentDim mt-0.5">{desc}</div>
              </div>
              <ExternalLink size={14} className="text-parchmentDim shrink-0" />
            </a>
          );
        })}
      </div>
    </div>
  );
}
