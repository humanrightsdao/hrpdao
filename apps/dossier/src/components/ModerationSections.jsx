// src/components/ModerationSections.jsx
//
// Splits the Управління page into clearly labelled parts — e.g. "Community
// moderation" (reports, votes, decisions by people) and "AI moderation"
// (Atticus Guard) — as tabs with a one-line explanation under the bar.
//
//   <ModerationSections
//     initial="community"
//     sections={[
//       { id: "community", label: "...", description: "...", content: <Queue /> },
//       { id: "ai",        label: "...", description: "...", content: <Panel /> },
//     ]}
//   />
//
// Behaviour worth knowing:
//   • A section is mounted the first time it is opened and then KEPT mounted
//     (just hidden), so switching tabs does not reload the moderation queue
//     or lose what you were looking at.
//   • The open tab is mirrored in the URL hash (#ai / #community), so a link
//     can point straight at a part of the page. An explicit `initial` wins
//     over an absent hash (e.g. a ?case= deep link must open the queue).
//   • Keyboard: ← / → / Home / End move between tabs (WAI-ARIA tabs pattern).

import React, { useRef, useState } from "react";

function readHash(ids) {
  const h = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#/, "");
  return ids.includes(h) ? h : null;
}

export default function ModerationSections({ sections, initial }) {
  const ids = sections.map((s) => s.id);
  const [active, setActive] = useState(() => readHash(ids) || initial || ids[0]);
  const [visited, setVisited] = useState(() => new Set([active]));
  const tabRefs = useRef({});

  const select = (id) => {
    setActive(id);
    setVisited((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    try {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${id}`);
    } catch {
      /* non-browser / sandboxed: the tab still works */
    }
  };

  const onKeyDown = (e) => {
    const i = ids.indexOf(active);
    let next = null;
    if (e.key === "ArrowRight") next = ids[(i + 1) % ids.length];
    else if (e.key === "ArrowLeft") next = ids[(i - 1 + ids.length) % ids.length];
    else if (e.key === "Home") next = ids[0];
    else if (e.key === "End") next = ids[ids.length - 1];
    if (next) {
      e.preventDefault();
      select(next);
      tabRefs.current[next]?.focus();
    }
  };

  const current = sections.find((s) => s.id === active) || sections[0];

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label="moderation sections"
        onKeyDown={onKeyDown}
        className="flex gap-1 p-1 rounded-xl bg-slate-100 dark:bg-white/[0.04] border border-slate-200 dark:border-white/[0.06]"
      >
        {sections.map((s) => {
          const selected = s.id === active;
          return (
            <button
              key={s.id}
              ref={(el) => (tabRefs.current[s.id] = el)}
              type="button"
              role="tab"
              id={`modtab-${s.id}`}
              aria-selected={selected}
              aria-controls={`modpanel-${s.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(s.id)}
              className={`flex-1 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ${
                selected
                  ? "bg-white dark:bg-[#000d1f] text-slate-900 dark:text-white shadow-sm border border-slate-200 dark:border-white/[0.08]"
                  : "text-slate-600 dark:text-white/45 hover:text-slate-900 dark:hover:text-white/75"
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {current?.description && (
        <p className="px-1 text-[12px] leading-relaxed text-slate-600 dark:text-white/40">{current.description}</p>
      )}

      {sections.map((s) =>
        visited.has(s.id) ? (
          <div
            key={s.id}
            role="tabpanel"
            id={`modpanel-${s.id}`}
            aria-labelledby={`modtab-${s.id}`}
            hidden={s.id !== active}
          >
            {s.content}
          </div>
        ) : null,
      )}
    </div>
  );
}
