// src/hooks/useLensViolations.js
import { useState, useCallback } from "react";
import { lensClient } from "../lib/lens";
import {
  fetchPosts,
  fetchPost,
  deletePost,
} from "@lens-protocol/client/actions";
import { handleOperationWith } from "@lens-protocol/client/viem";
import { chains } from "@lens-chain/sdk/viem";
import { eip712WalletActions } from "viem/zksync";
import { useLensAuth } from "../context/LensAuthContext";

// ─── viem walletClient (точно як у useLensHelpRequests.js / useLensPosts.js) ──
//
// FIXED (embedded wallet): the window.ethereum-only fallback is
// removed entirely — it required a browser-extension wallet
// (MetaMask) and always threw "MetaMask not found" for anyone on an
// embedded or WalletConnect wallet. The walletClient must now come
// from LensAuthContext.getWalletClient() (see below), which resolves
// correctly regardless of signer type.
const getViemWalletClient = async (externalWalletClient) => {
  // MIGRATED to Lens Mainnet.
  const lensChain = chains.mainnet;

  if (!externalWalletClient) {
    throw new Error("Wallet not connected");
  }

  if (externalWalletClient.chain?.id !== lensChain.id) {
    try {
      await externalWalletClient.switchChain({ id: lensChain.id });
    } catch (err) {
      throw new Error(
        "Please switch your wallet's network to Lens Mainnet and try again.",
      );
    }
  }
  return externalWalletClient.extend(eip712WalletActions());
};

const attr = (attributes, key) =>
  attributes.find((a) => a.key === key)?.value || "";

// Фолбек для постів, опублікованих ДО переходу на класифікатор
// violationTypes.js (у них є лише старий атрибут "priority").
const LEGACY_PRIORITY_TO_SEVERITY = {
  critical: 3,
  high: 3,
  medium: 2,
  normal: 1,
  low: 1,
};

const extractEvidenceFiles = (metadata) => {
  const attachmentFiles = (metadata?.attachments || []).map((a) => ({
    url: a.item,
    type: a.type,
    name: a.altTag || "evidence",
  }));

  // Documents (PDFs) are stored separately as a JSON attribute — see
  // ViolationsPage.jsx's uploadFilesToGrove/article() — because Lens's
  // `attachments` schema has no document type. Fold them back in here so
  // they show up in the same Evidence gallery as photos/videos.
  const documentsRaw = attr(metadata?.attributes || [], "documents");
  let documentFiles = [];
  if (documentsRaw) {
    try {
      const parsed = JSON.parse(documentsRaw);
      if (Array.isArray(parsed)) {
        documentFiles = parsed.map((d) => ({
          url: d.item,
          type: d.type || "application/pdf",
          name: d.name || "document.pdf",
        }));
      }
    } catch (err) {
      console.error("❌ Failed to parse 'documents' attribute:", err);
    }
  }

  return [...attachmentFiles, ...documentFiles];
};

const normalizeLensViolation = (lensPost) => {
  const metadata = lensPost.metadata || {};
  const attributes = metadata.attributes || [];

  const violationTypeId = attr(attributes, "violationTypeId");
  const categoryId = attr(attributes, "categoryId");
  const rawSeverity = attr(attributes, "severityLevel");

  // Нові пости завжди мають severityLevel, розрахований на боці форми
  // (config/violationTypes.js). Старі пости (до переходу на
  // класифікатор) мають лише "priority" — мапимо його на 1–3 для
  // сумісності, щоб UI не лишався без бейджа тяжкості.
  const severityLevel = rawSeverity
    ? parseInt(rawSeverity, 10)
    : LEGACY_PRIORITY_TO_SEVERITY[attr(attributes, "priority")] || 1;

  return {
    id: lensPost.id,
    lens_post_id: lensPost.id,
    title: metadata.title || metadata.content?.substring(0, 100) || "",
    violation_description: metadata.content || "",
    country_code: attr(attributes, "countryCode"),
    address: attr(attributes, "address"),
    latitude: parseFloat(attr(attributes, "latitude")) || null,
    longitude: parseFloat(attr(attributes, "longitude")) || null,
    city: attr(attributes, "city"),
    region: attr(attributes, "region"),
    violation_date: attr(attributes, "violationDate"),
    category_id: categoryId,
    violation_type_id: violationTypeId,
    severity_level: severityLevel,
    is_anonymous: attr(attributes, "isAnonymous") === "true",
    status: "published",
    created_at: lensPost.timestamp,
    views: lensPost.stats?.collects || 0,
    upvotes: lensPost.stats?.upvotes || 0,
    comments_count: lensPost.stats?.comments || 0,
    evidence_files: extractEvidenceFiles(metadata),
    author: {
      id: lensPost.author?.address,
      unique_name:
        lensPost.author?.username?.localName ||
        lensPost.author?.address?.slice(0, 8),
      avatar_url: lensPost.author?.metadata?.picture || null,
      wallet_address: lensPost.author?.address,
      // ФІКС: те саме, що в useLensHelpRequests.js/useLensPosts.js —
      // без цього ReportModal.jsx мав лише Lens Account-смартконтракт як
      // кандидата, не реальну EOA-адресу, якою мінтили Shield/Senate SBT.
      owner_address: lensPost.author?.owner || null,
    },
  };
};

export default function useLensViolations() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const { sessionClient, getWalletClient } = useLensAuth();

  const requireSession = () => {
    if (!sessionClient)
      throw new Error("Lens session not found. Please log in.");
    return sessionClient;
  };

  const fetchViolations = useCallback(
    async ({
      countryCode = null,
      severityLevel = null,
      searchQuery = null,
      cursor = null,
    } = {}) => {
      setLoading(true);
      setError("");

      try {
        const filter = {
          metadata: {
            tags: { oneOf: ["violation"] },
          },
          // ФІКС: без apps-фільтра запит ішов по ВСЬОМУ спільному Lens
          // testnet і повертав пости з тегом "violation", опубліковані
          // через БУДЬ-ЯКИЙ додаток (включно зі старими тестовими постами
          // з попереднього VITE_LENS_APP_ADDRESS). Усі інші хуки
          // (useLensPosts.js, useLensHelpRequests.js) вже скоуплять
          // запити через apps: [...] — цей хук був винятком.
          apps: [import.meta.env.VITE_LENS_APP_ADDRESS],
        };

        const result = await fetchPosts(lensClient, {
          filter,
          ...(cursor ? { cursor } : {}),
        });

        if (result.isErr()) throw new Error(result.error.message);

        const { items, pageInfo } = result.value;
        let violations = items.map(normalizeLensViolation);

        // ФІКС: раніше тут намагались фільтрувати по країні через
        // `tags: { oneOf: [countryCode, "violation"] }`, але oneOf — це
        // логічне АБО, а не І. Оскільки кожна скарга й так має тег
        // "violation", ця умова задовольнялась для БУДЬ-ЯКОЇ країни, і
        // фільтр по країні фактично нічого не відсіював. Фільтруємо на
        // клієнті по нормалізованому country_code — так само, як
        // severityLevel нижче.
        if (countryCode && countryCode !== "all") {
          violations = violations.filter((c) => c.country_code === countryCode);
        }
        // Фільтруємо скарги з забагатьма репортами
        // Отримуємо кількість репортів для кожної скарги
        const { fetchPosts: fetchReports } =
          await import("@lens-protocol/client/actions");

        const reportCounts = await Promise.all(
          violations.map(async (c) => {
            try {
              const r = await fetchReports(lensClient, {
                filter: {
                  commentOn: { id: c.id },
                  metadata: { tags: { oneOf: ["report"] } },
                },
              });
              return r.isOk() ? r.value.items.length : 0;
            } catch {
              return 0;
            }
          }),
        );

        // Ховаємо скарги з 5+ репортами
        violations = violations.filter((_, i) => reportCounts[i] < 5);

        if (severityLevel && severityLevel !== "all") {
          violations = violations.filter(
            (c) => c.severity_level === parseInt(severityLevel, 10),
          );
        }

        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          violations = violations.filter(
            (c) =>
              c.title?.toLowerCase().includes(q) ||
              c.violation_description?.toLowerCase().includes(q) ||
              c.address?.toLowerCase().includes(q),
          );
        }

        return {
          success: true,
          violations,
          nextCursor: pageInfo?.next || null,
          hasMore: !!pageInfo?.next,
        };
      } catch (err) {
        console.error("❌ Error fetching violations:", err);
        setError(err.message);
        return { success: false, violations: [], error: err.message };
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const fetchViolationById = useCallback(async (lensPostId) => {
    setLoading(true);
    setError("");

    try {
      const result = await fetchPost(lensClient, { post: lensPostId });

      if (result.isErr()) throw new Error(result.error.message);
      if (!result.value) throw new Error("Violation not found");

      return {
        success: true,
        violation: normalizeLensViolation(result.value),
      };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Видалення власної скарги (точно за патерном deleteRequest у
  // useLensHelpRequests.js) ─────────────────────────────────────────────────
  const deleteViolation = useCallback(
    async (lensPostId) => {
      setError("");
      try {
        const session = requireSession();
        const client = await getWalletClient();
        const txWalletClient = await getViemWalletClient(client);

        const deleteResult = await deletePost(session, { post: lensPostId });
        if (deleteResult.isErr()) throw new Error(deleteResult.error.message);

        let txHash;
        if ("hash" in (deleteResult.value || {})) {
          txHash = deleteResult.value.hash;
        } else {
          const signedResult = await deleteResult.andThen(
            handleOperationWith(txWalletClient),
          );
          if (signedResult.isErr()) throw new Error(signedResult.error.message);
          txHash = signedResult.value;
        }

        console.log("✅ [Violation] deleted, txHash:", txHash);
        return { success: true };
      } catch (err) {
        console.error("[useLensViolations] deleteViolation:", err);
        setError(err.message);
        return { success: false, error: err.message };
      }
    },
    [sessionClient, getWalletClient],
  );

  return {
    loading,
    error,
    fetchViolations,
    fetchViolationById,
    deleteViolation,
  };
}
