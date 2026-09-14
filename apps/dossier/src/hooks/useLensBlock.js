// src/hooks/useLensBlock.js
import { useState, useEffect, useCallback } from "react";
import { lensClient } from "../lib/lens";
import {
  fetchAccountsBlocked,
  blockAccount,
  unblockAccount,
} from "@lens-protocol/client/actions";

// ВИПРАВЛЕНО: реальні назви експортів з @lens-protocol/client/actions —
// `block`/`unblock`/`fetchAccountBlockedAccounts`, якими цей файл
// користувався раніше, у пакеті просто не існують (звідси
// "does not provide an export named 'block'"). Справжні назви —
// blockAccount / unblockAccount / fetchAccountsBlocked. Перевірено
// напряму по node_modules/@lens-protocol/client/dist/actions/index.d.ts,
// а не лише по документації (вона для v3 неповна щодо блокування).
async function getSessionClient() {
  const resumed = await lensClient.resumeSession();
  if (resumed.isErr()) {
    console.warn(
      "⚠️ useLensBlock: немає активної Lens-сесії — дія недоступна без логіну",
      resumed.error?.message,
    );
    return null;
  }
  return resumed.value;
}

export function useLensBlock(targetAddress) {
  const [isBlocked, setIsBlocked] = useState(false);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState(null);

  // ВИПРАВЛЕНО: fetchAccountsBlocked (не fetchAccountBlockedAccounts) і
  // приймає лише sessionClient — список заблокованих по ВЛАСНОМУ
  // залогіненому акаунту, без параметра account/address у request.
  // Точкового "чи заблокований САМЕ ЦЕЙ" ендпоінту Lens SDK не дає,
  // тож, як і раніше, перевіряємо входження targetAddress у весь список.
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

      const result = await fetchAccountsBlocked(sessionClient);

      if (cancelled) return;

      if (result.isErr()) {
        console.error(
          "❌ Lens fetchAccountsBlocked error:",
          result.error.message,
        );
        setChecking(false);
        return;
      }

      const blocked = result.value.items.some(
        (item) =>
          item.account?.address?.toLowerCase() === targetAddress.toLowerCase(),
      );
      setIsBlocked(blocked);
      setChecking(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [targetAddress]);

  const toggleBlock = useCallback(async () => {
    if (!targetAddress) return;
    setError(null);
    setLoading(true);

    try {
      const sessionClient = await getSessionClient();
      if (!sessionClient) {
        setError("Потрібно увійти, щоб заблокувати користувача");
        return;
      }

      // ДОДАНО: захист на рівні самого хука, незалежно від того, чи
      // встигла сторінка сховати кнопку через isOwnProfile. Lens API
      // все одно відхилив би блокування власного акаунту помилкою, але
      // краще не робити зайвий мережевий виклик і одразу показати
      // зрозумілу причину.
      const userResult = sessionClient.getAuthenticatedUser();
      if (
        userResult.isOk() &&
        userResult.value?.address?.toLowerCase() === targetAddress.toLowerCase()
      ) {
        setError("Не можна заблокувати самого себе");
        return;
      }

      // ВИПРАВЛЕНО: request приймає одну адресу `account`, а не масив
      // `accounts` — раніше це теж було невірно (BlockRequest /
      // UnblockRequest у @lens-protocol/graphql — { account: EvmAddress }).
      const action = isBlocked ? unblockAccount : blockAccount;
      const result = await action(sessionClient, { account: targetAddress });

      if (result.isErr()) {
        console.error("❌ Lens block/unblock error:", result.error.message);
        setError(result.error.message);
        return;
      }

      // ВАЖЛИВО: result.value тут — це ще не підтверджена транзакція, а
      // одна з кількох можливих "operation" відповідей Lens SDK
      // (SponsoredTransactionRequest / SelfFundedTransactionRequest /
      // TransactionWillFail). У повноцінному флоу її ще треба
      // прокинути через handleOperationWith(walletClient) із
      // "@lens-protocol/client/viem" (чи аналог для ethers/іншого
      // підписувача), щоб реально підписати й дочекатись виконання —
      // так само, як це зроблено в офіційних прикладах banGroupAccounts.
      // Тут це свідомо лишено як TODO, бо в проєкті ще не видно файлу
      // з налаштуванням гаманця/signer (той самий, яким підписувались
      // повідомлення при onboarding) — без нього не можна точно
      // підставити правильний walletClient. Як тимчасовий компроміс
      // стан оновлюється оптимістично одразу після успішного виклику.
      setIsBlocked((prev) => !prev);
    } catch (e) {
      console.error("❌ useLensBlock toggleBlock exception:", e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [targetAddress, isBlocked]);

  return { isBlocked, toggleBlock, loading, checking, error };
}
