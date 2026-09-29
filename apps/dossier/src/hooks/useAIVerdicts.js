// src/hooks/useAIVerdicts.js
//
// Display-time AI moderation: given the items currently on screen (feed
// posts, comments), returns a Map of id → verdict for the ones Atticus has
// an opinion about. Items with no verdict yet (still loading, service down,
// too short to scan) are simply absent — callers render them normally
// (fail open, see utils/aiModeration.js).
//
//   const verdicts = useAIVerdicts(
//     comments.map((c) => ({ id: c.id, kind: "comment", text: c.content, context: parentText })),
//   );
//   const flagged = isFlagged(verdicts.get(comment.id));
//
// The server caches verdicts by content, and pre-publish checks warm that
// cache, so re-viewing content is nearly free. This hook only ever asks
// about items not already answered in this browser session.

import { useEffect, useMemo, useState } from "react";
import {
  fetchVerdicts,
  getCachedVerdict,
  isAIModerationEnabled,
  itemKey,
  shouldScan,
} from "../utils/aiModeration";

/** Upper bound of items looked at per render — the rest are picked up as the list grows. */
const MAX_ITEMS = 60;

export function useAIVerdicts(items, { enabled = true } = {}) {
  const active = enabled && isAIModerationEnabled();
  const [version, setVersion] = useState(0);

  const scannable = useMemo(
    () => (active && Array.isArray(items) ? items.filter(shouldScan).slice(0, MAX_ITEMS) : []),
    [items, active],
  );

  // A stable string, so the effect below re-runs only when the CONTENT of the
  // list changes — not on every render, when callers build a fresh array.
  const signature = scannable.map((i) => `${i.id}:${itemKey(i)}`).join("|");

  useEffect(() => {
    const missing = scannable.filter((i) => !getCachedVerdict(i));
    if (missing.length === 0) return undefined;

    let cancelled = false;
    fetchVerdicts(missing).then(() => {
      if (!cancelled) setVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on `signature` (the CONTENT of the list), not on
    // `scannable`, which is a fresh array on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return useMemo(() => {
    const map = new Map();
    for (const item of scannable) {
      const result = getCachedVerdict(item);
      if (result) map.set(item.id, result);
    }
    return map;
    // `version` bumps when fetchVerdicts() resolves; `signature` when the list changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, version]);
}
