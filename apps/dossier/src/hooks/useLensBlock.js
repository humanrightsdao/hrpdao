// src/hooks/useLensBlock.js
import { useState, useEffect, useCallback } from "react";
import { lensClient } from "../lib/lens";
// ADDED: blockAccount/unblockAccount only return an operation — it still
// has to be signed and sent (see lib/lensTransaction.js). The wallet
// comes from the auth context, like the callers of useLensPosts.
import { useLensAuth } from "../context/LensAuthContext";
import { sendLensOperation } from "../lib/lensTransaction";
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
  const { getWalletClient } = useLensAuth();
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
      // FIXED: blockAccount()/unblockAccount() only build an "operation"
      // (SponsoredTransactionRequest / SelfFundedTransactionRequest /
      // TransactionWillFail). It used to be discarded — the button just
      // flipped, and reloading the page showed the account as NOT
      // blocked, because nothing had ever been sent to Lens.
      // sendLensOperation() now signs and sends it the same way
      // useLensPosts does for posts (handleOperationWith(walletClient)
      // -> txHash -> wait for indexing). The state flips only after the
      // transaction was really sent; failures (wallet rejected, Lens
      // refused, TransactionWillFail ...) are shown via `error`.
      const action = isBlocked ? unblockAccount : blockAccount;
      const { indexed } = await sendLensOperation({
        sessionClient,
        getWalletClient,
        action: () => action(sessionClient, { account: targetAddress }),
      });
      if (!indexed) {
        console.warn(
          "⚠️ useLensBlock: транзакцію відправлено, але Lens ще не проіндексував її — статус може оновитись із затримкою",
        );
      }

      setIsBlocked((prev) => !prev);
    } catch (e) {
      console.error("❌ useLensBlock toggleBlock exception:", e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [targetAddress, isBlocked, getWalletClient]);

  return { isBlocked, toggleBlock, loading, checking, error };
}
