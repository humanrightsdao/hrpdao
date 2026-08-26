// src/hooks/useLensFollow.js
import { useState, useEffect, useCallback } from "react";
import { lensClient } from "../lib/lens";
import {
  fetchFollowStatus,
  follow,
  unfollow,
} from "@lens-protocol/client/actions";

// ДОДАНО: хук підписки/відписки на Lens Account.
//
// На відміну від useLensPublicProfile (lensClient — публічний клієнт,
// читання без авторизації), дії follow/unfollow — це підписані
// транзакції, тож тут обов'язково потрібна авторизована сесія
// (sessionClient), а не голий lensClient. Сесія відновлюється через
// lensClient.resumeSession() — той самий механізм, яким користується
// логін-флоу застосунку (саме звідти бере активний акаунт і
// useLensProfile.js, дивись lens_account_address у localStorage).
async function getSessionClient() {
  const resumed = await lensClient.resumeSession();
  if (resumed.isErr()) {
    console.warn(
      "⚠️ useLensFollow: немає активної Lens-сесії — дія недоступна без логіну",
      resumed.error?.message,
    );
    return null;
  }
  return resumed.value;
}

export function useLensFollow(targetAddress) {
  const [isFollowing, setIsFollowing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(null);

  // Перевірка поточного статусу підписки при завантаженні сторінки.
  // Якщо немає сесії (гість, не залогінений) — просто лишаємо
  // isFollowing = false і не показуємо помилку, кнопка нижче в
  // UserProfilePage сама ховається для незалогінених.
  //
  // ВИПРАВЛЕНО: fetchFollowStatus вимагає в КОЖНІЙ парі обов'язкові
  // ОБИДВА поля — account (кого перевіряємо) і follower (хто перевіряє,
  // тобто залогінений Lens Account). Раніше передавався лише account —
  // запит проходив повз TypeScript (бо хук писаний на чистому JS), але
  // на рівні GraphQL-запиту follower є required полем у FollowStatusRequest,
  // тож такий виклик або падав з помилкою валідації, або повертав
  // непередбачувані дані. follower береться з sessionClient.getAuthenticatedUser()
  // — це синхронний виклик, що повертає AuthenticatedUser.address —
  // адресу залогіненого Lens Account (Account Owner/Manager), а не гаманця.
  useEffect(() => {
    let cancelled = false;

    if (!targetAddress) {
      setChecking(false);
      return;
    }

    (async () => {
      setChecking(true);
      const sessionClient = await getSessionClient();
      if (!sessionClient) {
        if (!cancelled) setChecking(false);
        return;
      }

      const userResult = sessionClient.getAuthenticatedUser();
      if (userResult.isErr() || !userResult.value?.address) {
        console.warn(
          "⚠️ useLensFollow: не вдалось визначити адресу залогіненого акаунту",
          userResult.isErr() ? userResult.error?.message : undefined,
        );
        if (!cancelled) setChecking(false);
        return;
      }

      const result = await fetchFollowStatus(sessionClient, {
        pairs: [{ account: targetAddress, follower: userResult.value.address }],
      });

      if (cancelled) return;

      if (result.isErr()) {
        console.error("❌ Lens fetchFollowStatus error:", result.error.message);
        setChecking(false);
        return;
      }

      setIsFollowing(Boolean(result.value?.[0]?.isFollowing?.onChain));
      setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [targetAddress]);

  const toggleFollow = useCallback(async () => {
    if (!targetAddress) return;
    setError(null);
    setLoading(true);

    try {
      const sessionClient = await getSessionClient();
      if (!sessionClient) {
        setError("Потрібно увійти, щоб підписатись");
        return;
      }

      // ДОДАНО: захист на рівні самого хука, незалежно від того, чи
      // встигла сторінка сховати кнопку через isOwnProfile. Lens API
      // все одно відхилив би follow на власний акаунт помилкою, але
      // краще не робити зайвий мережевий виклик і одразу показати
      // зрозумілу причину.
      const userResult = sessionClient.getAuthenticatedUser();
      if (
        userResult.isOk() &&
        userResult.value?.address?.toLowerCase() === targetAddress.toLowerCase()
      ) {
        setError("Не можна підписатись на самого себе");
        return;
      }

      // ДОДАНО: явно логуємо, ВІД ІМЕНІ ЯКОГО саме Lens Account
      // реально виконається follow — це і є sessionAddress, а НЕ
      // обов'язково той акаунт, що зараз показаний як "активний" у
      // localStorage.lens_account_address (особливо при кількох
      // AccountOwned на один гаманець — перемикання активного акаунту
      // в UI могло не переавторизувати сесію).
      console.log("🔍 useLensFollow: follow буде від імені", {
        sessionAddress: userResult.value?.address,
        targetAddress,
      });

      const action = isFollowing ? unfollow : follow;
      const result = await action(sessionClient, { account: targetAddress });

      if (result.isErr()) {
        console.error("❌ Lens follow/unfollow error:", result.error.message);
        setError(result.error.message);
        return;
      }

      // ВАЖЛИВО: follow/unfollow повертає або підтверджену транзакцію,
      // або один з варіантів "operation"-відповіді Lens SDK
      // (SponsoredTransactionRequest / SelfFundedTransactionRequest /
      // TransactionWillFail) — її ще треба прокинути через
      // handleOperationWith(walletClient) з "@lens-protocol/client/viem"
      // (або еквівалент для вашого signer), щоб реально підписати й
      // дочекатись виконання on-chain. Той самий TODO, що й у
      // useLensBlock.js — без видимого файлу з налаштуванням
      // гаманця/signer цього проєкту тут не можна точно підставити
      // правильний walletClient. Поки що стан оновлюється оптимістично
      // одразу після успішного виклику дії.
      setIsFollowing((prev) => !prev);
    } catch (e) {
      console.error("❌ useLensFollow toggleFollow exception:", e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [targetAddress, isFollowing]);

  return { isFollowing, toggleFollow, loading, checking, error };
}
