// src/lib/dossierViolations.js
//
// PORTED (read-only) from dossier-app's src/hooks/useLensViolations.js —
// this app only ever DISPLAYS violations (on the read-only world map on
// HomePage), it never creates/deletes one, so this is a plain async
// function against the public lensClient, not a React hook wrapping a
// wallet-gated mutation API. All violations across all of dossier are
// public Lens posts tagged "violation" — reading them needs no session,
// no wallet, same as dossier's own CountryPage map already does.
import { lensClient } from "./lensLookup";
import { fetchPosts } from "@lens-protocol/client/actions";

const attr = (attributes, key) =>
  attributes.find((a) => a.key === key)?.value || "";

const LEGACY_PRIORITY_TO_SEVERITY = {
  critical: 3,
  high: 3,
  medium: 2,
  normal: 1,
  low: 1,
};

function normalizeLensViolation(lensPost) {
  const metadata = lensPost.metadata || {};
  const attributes = metadata.attributes || [];

  const violationTypeId = attr(attributes, "violationTypeId");
  const categoryId = attr(attributes, "categoryId");
  const rawSeverity = attr(attributes, "severityLevel");

  const severityLevel = rawSeverity
    ? parseInt(rawSeverity, 10)
    : LEGACY_PRIORITY_TO_SEVERITY[attr(attributes, "priority")] || 1;

  return {
    id: lensPost.id,
    lens_post_id: lensPost.id,
    title: metadata.title || metadata.content?.substring(0, 100) || "",
    country_code: attr(attributes, "countryCode"),
    latitude: parseFloat(attr(attributes, "latitude")) || null,
    longitude: parseFloat(attr(attributes, "longitude")) || null,
    violation_date: attr(attributes, "violationDate"),
    category_id: categoryId,
    violation_type_id: violationTypeId,
    severity_level: severityLevel,
    created_at: lensPost.timestamp,
    author: {
      owner_address: lensPost.author?.owner || null,
      wallet_address: lensPost.author?.address || null,
    },
  };
}

// Same as dossier's fetchViolations({}) called with no filters — every
// published violation across the whole app, which is exactly the "all
// violations that exist in dossier" the world map needs. Report-count
// filtering (hide anything with 5+ reports) is ported too, since that's
// about data correctness, not an interactive feature.
export async function fetchAllViolations() {
  // ФІКС: без apps-фільтра запит ішов по ВСЬОМУ спільному Lens testnet і
  // повертав пости з тегом "violation", опубліковані через БУДЬ-ЯКИЙ
  // додаток (включно зі старими тестовими постами з попереднього
  // VITE_LENS_APP_ADDRESS). dossierFeed.js/moderationCheck.js вже
  // скоуплять запити через apps: [...] — цей файл був винятком.
  const filter = {
    metadata: { tags: { oneOf: ["violation"] } },
    apps: [import.meta.env.VITE_LENS_APP_ADDRESS],
  };
  let violations = [];
  let cursor;

  do {
    const result = await fetchPosts(lensClient, {
      filter,
      ...(cursor ? { cursor } : {}),
    });
    if (result.isErr()) throw new Error(result.error.message);

    const { items, pageInfo } = result.value;
    violations.push(...items.map(normalizeLensViolation));
    cursor = pageInfo?.next || undefined;
  } while (cursor);

  const reportCounts = await Promise.all(
    violations.map(async (v) => {
      try {
        const r = await fetchPosts(lensClient, {
          filter: {
            commentOn: { id: v.id },
            metadata: { tags: { oneOf: ["report"] } },
          },
        });
        return r.isOk() ? r.value.items.length : 0;
      } catch {
        return 0;
      }
    }),
  );

  return violations.filter((_, i) => reportCounts[i] < 5);
}