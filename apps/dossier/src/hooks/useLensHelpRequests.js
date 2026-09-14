// src/hooks/useLensHelpRequests.js
// Базується на useLensPosts.js — той самий патерн публікації що вже працює.
// StorageClient SDK для Grove, handleOperationWith для підпису транзакцій.

import { useState, useCallback } from "react";
import { lensClient } from "../lib/lens";
import { uri } from "@lens-protocol/client";
import {
  fetchPosts,
  fetchPost,
  deletePost,
  post as postToLens,
} from "@lens-protocol/client/actions";
import { handleOperationWith } from "@lens-protocol/client/viem";
import { StorageClient } from "@lens-chain/storage-client";
import { textOnly, image, video } from "@lens-protocol/metadata";
import { chains } from "@lens-chain/sdk/viem";
import { eip712WalletActions } from "viem/zksync";
import { useLensAuth } from "../context/LensAuthContext";
import { useNostrIdentity } from "./useNostrIdentity";
import { useNostrRelay } from "./useNostrRelay";
import { buildImetaTags } from "../lib/nostrRelay";

// ─── Константи ────────────────────────────────────────────────────────────────

const APP_ID = import.meta.env.VITE_LENS_APP_ADDRESS;

// ─── StorageClient (точно як у useLensPosts.js) ───────────────────────────────

const storageClient = StorageClient.create();

const uploadToGrove = async (metadata) => {
  const { uri: metadataUri } = await storageClient.uploadAsJson(metadata);
  return metadataUri;
};

const uploadFileToGrove = async (file) => {
  // FIXED (Nostr media): see the identical fix in useLensPosts.js —
  // gatewayUrl (a resolvable https:// URL) is needed for Nostr note
  // content; the lens://... uri alone only works within Lens clients.
  const { uri: fileUri, gatewayUrl } = await storageClient.uploadFile(file);
  return { uri: fileUri, gatewayUrl };
};

// ─── viem walletClient (точно як у useLensPosts.js) ──────────────────────────

// FIXED (embedded wallet): this used to fall back to window.ethereum
// directly when no walletClient was passed in — that path required a
// browser-extension wallet (MetaMask) and always threw "MetaMask not
// found" for anyone on an embedded/WalletConnect wallet, since neither
// exposes window.ethereum. There is no MetaMask-specific fallback left
// now: the walletClient must come from LensAuthContext.getWalletClient()
// (the single source of truth — see its own retry logic for why a raw
// useWalletClient() read is unreliable), which resolves correctly for
// the embedded wallet, a linked external wallet, or WalletConnect alike.
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

// ─── Резолв URI аватарки (lens:// / ar:// / ipfs:// → https://) ──────────────
// Та сама логіка що в useLensProfile.js → resolveLensPicture.
// Без цього браузер не може завантажити аватарку автора поста.

const resolveLensPicture = (picture) => {
  if (!picture) return null;
  if (typeof picture === "object") {
    picture =
      picture?.optimized?.uri || picture?.raw?.uri || picture?.uri || null;
    if (!picture) return null;
  }
  if (picture.startsWith("lens://"))
    return `https://api.grove.storage/${picture.replace("lens://", "")}`;
  if (picture.startsWith("ar://"))
    return `https://arweave.net/${picture.replace("ar://", "")}`;
  if (picture.startsWith("ipfs://"))
    return `https://ipfs.io/ipfs/${picture.replace("ipfs://", "")}`;
  return picture;
};

// ─── Нормалізація поста ───────────────────────────────────────────────────────

const attrVal = (attributes, key) =>
  attributes?.find((a) => a.key === key)?.value ?? "";

const normalizeHelpRequest = (post) => {
  const metadata = post.metadata ?? {};
  const attributes = metadata.attributes ?? [];

  let helpTypes = [];
  try {
    helpTypes = JSON.parse(attrVal(attributes, "help_types") || "[]");
  } catch {
    /**/
  }

  const attachments = [];
  if (metadata.image?.item) attachments.push(metadata.image.item);
  if (metadata.video?.item) attachments.push(metadata.video.item);
  (metadata.attachments ?? []).forEach((a) => {
    if (a?.item) attachments.push(a.item);
  });

  // Повний список медіа-вкладень з їх mime-типом (без зміни формату
  // attachments вище, щоб не зламати інших споживачів хука, напр.
  // HelpRequestPage.jsx). Тут може бути картинка, відео або документ —
  // тип беремо з самих метаданих, бо в URI Grove/Arweave немає розширення
  // файлу, за яким можна було б визначити тип по самому рядку URL.
  const media = [];
  if (metadata.image?.item) {
    media.push({
      url: metadata.image.item,
      type: metadata.image.type || "image/*",
    });
  }
  if (metadata.video?.item) {
    media.push({
      url: metadata.video.item,
      type: metadata.video.type || "video/*",
    });
  }
  (metadata.attachments ?? []).forEach((a) => {
    if (a?.item) media.push({ url: a.item, type: a.type || "" });
  });

  const authorAddress = post.author?.address ?? null;
  // ФІКС: owner_address бракувало тут — те саме поле, що вже є в
  // normalizeLensPost() useLensPosts.js. Без нього ReportModal.jsx мав
  // лише Lens Account-смартконтракт як кандидата, а не реальну EOA-
  // адресу, якою мінтили Shield/Senate SBT — звідси хибне "не Shield/
  // Senate" при скарзі на help-запит.
  const ownerAddress = post.author?.owner ?? null;
  const authorUsername =
    post.author?.username?.localName ??
    post.author?.address?.slice(0, 8) ??
    "anonymous";

  const typeAttr = attrVal(attributes, "type");
  const tagsArray = metadata.tags ?? [];
  const isHelpRequest =
    typeAttr === "help_request" || tagsArray.includes("help_request");

  const content = metadata.content ?? "";

  return {
    id: post.id,
    lens_post_id: post.id,
    isHelpRequest,
    description: content,
    title: content.split("\n")[0].slice(0, 100),
    help_types: helpTypes,
    country_code:
      attrVal(attributes, "country_code") || attrVal(attributes, "countryCode"),
    status: attrVal(attributes, "status") || "active",
    attachments,
    media,
    created_at: typeof post.timestamp === "string" ? post.timestamp : null,
    lens_user_id: authorAddress,
    author: {
      id: authorAddress,
      unique_name: authorUsername,
      avatar_url: resolveLensPicture(post.author?.metadata?.picture) ?? null,
      wallet_address: authorAddress,
      owner_address: ownerAddress,
    },
  };
};

// ─── Хук ──────────────────────────────────────────────────────────────────────

export function useLensHelpRequests() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const { sessionClient, getWalletClient } = useLensAuth();
  const { signEvent: signNostrEvent } = useNostrIdentity();
  const { publishToNostr } = useNostrRelay();

  const requireSession = () => {
    if (!sessionClient)
      throw new Error("Lens session not found. Please log in.");
    return sessionClient;
  };

  // ── Завантаження всіх запитів ─────────────────────────────────────────────────
  const loadRequests = useCallback(async ({ countryCode } = {}) => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchPosts(lensClient, {
        filter: {
          apps: [APP_ID],
          postTypes: ["ROOT"],
          metadata: { tags: { oneOf: ["help_request"] } },
        },
      });

      if (result.isErr()) throw new Error(result.error.message);

      const rawItems = result.value.items ?? [];
      let normalized = rawItems
        .map(normalizeHelpRequest)
        .filter((r) => r.isHelpRequest && r.status === "active");

      if (countryCode && countryCode !== "all") {
        normalized = normalized.filter((r) => r.country_code === countryCode);
      }

      setRequests(normalized);
    } catch (err) {
      console.error("[useLensHelpRequests] loadRequests:", err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Завантаження одного запиту за ID ──────────────────────────────────────────
  const fetchRequestById = useCallback(async (postId) => {
    setLoading(true);
    setError("");
    try {
      const result = await fetchPost(lensClient, { post: postId });
      if (result.isErr()) throw new Error(result.error.message);
      if (!result.value) throw new Error("Request not found");
      return { success: true, request: normalizeHelpRequest(result.value) };
    } catch (err) {
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Створення запиту (патерн з useLensPosts.createLensPost) ───────────────────
  const createRequest = useCallback(
    async ({ description, helpTypes = [], countryCode, mediaFiles = [] }) => {
      setError("");
      try {
        const session = requireSession();
        const client = await getWalletClient();
        const txWalletClient = await getViemWalletClient(client);

        // 1. Завантаження медіа через StorageClient SDK (як у useLensPosts)
        const uploadedFiles =
          mediaFiles.length > 0
            ? await Promise.all(
                mediaFiles.map(async (file) => {
                  const { uri, gatewayUrl } = await uploadFileToGrove(file);
                  return { uri, gatewayUrl, type: file.type };
                }),
              )
            : [];

        // 2. Metadata
        const tags = ["help_request", countryCode, ...helpTypes].filter(
          Boolean,
        );
        const attrs = [
          { key: "type", type: "String", value: "help_request" },
          {
            key: "help_types",
            type: "String",
            value: JSON.stringify(helpTypes),
          },
          { key: "countryCode", type: "String", value: countryCode ?? "" },
          { key: "status", type: "String", value: "active" },
        ];

        let metadata;

        if (uploadedFiles.length === 0) {
          metadata = textOnly({
            appId: APP_ID,
            content: description,
            tags,
            attributes: attrs,
          });
        } else if (uploadedFiles[0].type.startsWith("video/")) {
          // attachments не передаємо взагалі, якщо доп. файлів немає —
          // Zod-схема @lens-protocol/metadata вимагає мінімум 1 елемент
          // у масиві, якщо поле присутнє; порожній [] вона не приймає.
          const extraAttachments = uploadedFiles
            .slice(1)
            .map(({ uri: u, type: t }) => ({ item: u, type: t }));
          metadata = video({
            appId: APP_ID,
            content: description,
            tags,
            attributes: attrs,
            video: { item: uploadedFiles[0].uri, type: uploadedFiles[0].type },
            ...(extraAttachments.length > 0
              ? { attachments: extraAttachments }
              : {}),
          });
        } else if (uploadedFiles[0].type.startsWith("image/")) {
          const extraAttachments = uploadedFiles
            .slice(1)
            .map(({ uri: u, type: t }) => ({ item: u, type: t }));
          metadata = image({
            appId: APP_ID,
            content: description,
            tags,
            attributes: attrs,
            image: { item: uploadedFiles[0].uri, type: uploadedFiles[0].type },
            ...(extraAttachments.length > 0
              ? { attachments: extraAttachments }
              : {}),
          });
        } else {
          // Перший файл — документ (pdf тощо), не image і не video.
          // @lens-protocol/metadata валідує mime-type для image()/video()
          // за списком конкретних image/video-типів, тож підставляти туди
          // довільний документ нельзя — впаде з помилкою валідації.
          // Кладемо все (включно з документом) як attachments на базі textOnly().
          metadata = textOnly({
            appId: APP_ID,
            content: description,
            tags,
            attributes: attrs,
            attachments: uploadedFiles.map(({ uri: u, type: t }) => ({
              item: u,
              type: t,
            })),
          });
        }

        // 3. Завантажуємо metadata через StorageClient SDK (як у useLensPosts)
        const metadataUri = await uploadToGrove(metadata);
        console.log("✅ [HelpRequest] metadata uploaded:", metadataUri);

        // 4. Публікуємо — точно як у useLensPosts.createLensPost
        const postResult = await postToLens(session, {
          contentUri: uri(metadataUri),
        });

        if (postResult.isErr()) throw new Error(postResult.error.message);

        if (postResult.value?.__typename === "TransactionWillFail") {
          throw new Error("TransactionWillFail: " + postResult.value.reason);
        }

        let txHash;
        if ("hash" in (postResult.value || {})) {
          // Sponsored
          txHash = postResult.value.hash;
        } else {
          // Unsponsored — підписуємо гаманцем
          const signedResult = await postResult.andThen(
            handleOperationWith(txWalletClient),
          );
          if (signedResult.isErr()) throw new Error(signedResult.error.message);
          txHash = signedResult.value;
        }

        console.log("✅ [HelpRequest] published, txHash:", txHash);

        // ADDED: best-effort Nostr cross-post — isolated in its own
        // try/catch, never blocks/reverts the Lens help request above.
        // Uses fetchPost to resolve the resulting post id for a
        // proper backlink, same pattern as useLensPosts.js.
        let nostrResult = null;
        try {
          const requestResult = await fetchPost(lensClient, { txHash });
          const lensRequestId = requestResult.isOk()
            ? requestResult.value?.id
            : null;
          const postUrl =
            typeof window !== "undefined" && lensRequestId
              ? `${window.location.origin}/help/${lensRequestId}`
              : null;

          const mediaLinks = uploadedFiles
            .map((f) => f.gatewayUrl)
            .filter(Boolean);
          const noteContent = [
            "🆘 Help requested",
            description,
            helpTypes.length ? `Type: ${helpTypes.join(", ")}` : null,
            ...mediaLinks,
            postUrl,
          ]
            .filter(Boolean)
            .join("\n\n");

          const nostrEvent = await signNostrEvent({
            kind: 1,
            content: noteContent,
            tags: [
              ["t", "hrpdao"],
              ["t", "help_request"],
              ...(countryCode ? [["t", countryCode]] : []),
              ...buildImetaTags(uploadedFiles),
              ...(postUrl ? [["r", postUrl]] : []),
            ],
          });

          if (nostrEvent) {
            const relayResults = await publishToNostr(nostrEvent);
            nostrResult = {
              success: relayResults.some((r) => r.ok),
              relays: relayResults,
            };
            console.log(
              "✅ [HelpRequest] cross-posted to Nostr:",
              nostrResult,
            );
          }
        } catch (nostrErr) {
          console.warn(
            "⚠️ Nostr cross-post failed for help request (Lens request is unaffected):",
            nostrErr.message,
          );
        }

        // 5. Чекаємо індексації і оновлюємо список
        await new Promise((res) => setTimeout(res, 8000));
        await loadRequests();
        setTimeout(() => loadRequests(), 15000);

        return { success: true, hash: txHash, nostr: nostrResult };
      } catch (err) {
        console.error("[useLensHelpRequests] createRequest:", err);
        setError(err.message);
        throw err;
      }
    },
    [sessionClient, loadRequests, getWalletClient, signNostrEvent, publishToNostr],
  );

  // ── Видалення запиту ──────────────────────────────────────────────────────────
  const deleteRequest = useCallback(
    async (postId) => {
      setError("");
      try {
        const session = requireSession();
        const client = await getWalletClient();
        const txWalletClient = await getViemWalletClient(client);

        const deleteResult = await deletePost(session, { post: postId });
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

        console.log("✅ [HelpRequest] deleted, txHash:", txHash);
        setRequests((prev) => prev.filter((r) => r.id !== postId));
        return { success: true };
      } catch (err) {
        console.error("[useLensHelpRequests] deleteRequest:", err);
        setError(err.message);
        throw err;
      }
    },
    [sessionClient, getWalletClient],
  );

  return {
    requests,
    loading,
    error,
    loadRequests,
    fetchRequestById,
    createRequest,
    deleteRequest,
  };
}
