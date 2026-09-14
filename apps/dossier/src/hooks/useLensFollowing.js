// src/hooks/useLensFollowing.js
import { useState, useEffect, useCallback } from "react";
import { lensClient } from "../lib/lens";
import {
  fetchFollowing,
  fetchFollowers,
  fetchAccountStats,
} from "@lens-protocol/client/actions";

// ДОДАНО: спільний резолвер картинки — та сама логіка, що в
// useLensProfile.js (lens:// / ar:// / ipfs:// -> https://). Дублюється
// свідомо, за тим самим принципом, що описаний у коментарях
// useLensProfile.js — кожен хук-файл лишається незалежним.
const resolveLensPicture = (picture) => {
  if (!picture) return null;

  if (typeof picture === "object") {
    picture =
      picture?.optimized?.uri || picture?.raw?.uri || picture?.uri || null;
    if (!picture) return null;
  }

  if (picture.startsWith("lens://")) {
    return `https://api.grove.storage/${picture.replace("lens://", "")}`;
  }
  if (picture.startsWith("ar://")) {
    return `https://arweave.net/${picture.replace("ar://", "")}`;
  }
  if (picture.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${picture.replace("ipfs://", "")}`;
  }

  return picture;
};

// ДОДАНО: мапінг сирого Lens Account (той самий формат, що повертає
// fetchAccount/fetchAccountsAvailable) у легкий профіль для відображення
// в списку — навмисно МЕНШЕ полів, ніж mapAccountToProfile у
// useLensProfile.js (там же й dateOfBirth/isAdult/h3Index тощо), бо в
// списку підписок усе це не показується — лише аватар/ім'я/handle.
const mapAccountToListItem = (account) => {
  if (!account) return null;
  return {
    address: account.address,
    name: account.metadata?.name || null,
    handle: account.username?.localName
      ? `@${account.username.localName}`
      : null,
    avatar: resolveLensPicture(account.metadata?.picture) || null,
    bio: account.metadata?.bio || null,
  };
};

// ДОДАНО: спільна "core"-логіка пагінованого списку (Following/Followers
// — однаковий патерн: завантажити першу сторінку, дозволити
// довантажити наступну через cursor з pageInfo.next). Винесено в
// окрему функцію, а не дубльовано двічі — тут, на відміну від
// resolveLensPicture/mapAccountToProfile вище, дублювання нічого не
// дає (логіка пагінації ідентична byte-in-byte для обох напрямків).
function usePaginatedAccountList(fetchFn, accountAddress, pickAccount) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!accountAddress) {
      setItems([]);
      setHasMore(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    console.log("🔍 useLensFollowing: запит", {
      fn: fetchFn.name,
      account: accountAddress,
    });

    fetchFn(lensClient, { account: accountAddress })
      .then((result) => {
        if (cancelled) return;
        if (result.isErr()) {
          console.error("❌ Lens paginated list error:", result.error.message);
          setError(result.error.message);
          return;
        }
        // ДОДАНО: логуємо сирий результат — щоб бачити, чи API взагалі
        // повернув items (можлива причина "порожньо, хоча підписаний" —
        // лаг індексації testnet після follow-транзакції: транзакція
        // пройшла on-chain, але індексатор Lens ще не встиг її підхопити
        // в GraphQL-відповіді fetchFollowing/fetchFollowers).
        console.log("🔍 useLensFollowing: відповідь", {
          fn: fetchFn.name,
          rawItemsCount: result.value.items.length,
          rawItems: result.value.items,
        });
        const mapped = result.value.items
          .map((item) => mapAccountToListItem(pickAccount(item)))
          .filter(Boolean);
        setItems(mapped);
        setCursor(result.value.pageInfo?.next || null);
        setHasMore(Boolean(result.value.pageInfo?.next));
      })
      .catch((e) => {
        if (!cancelled) {
          console.error("❌ useLensFollowing exception:", e);
          setError(e.message);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountAddress]);

  const loadMore = useCallback(async () => {
    if (!accountAddress || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await fetchFn(lensClient, {
        account: accountAddress,
        cursor,
      });
      if (result.isErr()) {
        console.error(
          "❌ Lens paginated list loadMore error:",
          result.error.message,
        );
        setError(result.error.message);
        return;
      }
      const mapped = result.value.items
        .map((item) => mapAccountToListItem(pickAccount(item)))
        .filter(Boolean);
      setItems((prev) => [...prev, ...mapped]);
      setCursor(result.value.pageInfo?.next || null);
      setHasMore(Boolean(result.value.pageInfo?.next));
    } catch (e) {
      console.error("❌ useLensFollowing loadMore exception:", e);
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, [accountAddress, cursor, loadingMore]);

  return { items, loading, loadingMore, error, hasMore, loadMore };
}

/**
 * ДОДАНО: список акаунтів, на яких підписаний accountAddress.
 * ВИПРАВЛЕНО: fetchFollowing повертає items[].following як САМ Account
 * напряму (немає додаткової вкладеності .account — перевірено по
 * FollowingQuery в @lens-protocol/graphql/dist/index.d.ts).
 */
export function useLensFollowingList(accountAddress) {
  return usePaginatedAccountList(
    fetchFollowing,
    accountAddress,
    (item) => item.following,
  );
}

/**
 * ДОДАНО: список акаунтів, які підписані на accountAddress.
 * fetchFollowers повертає items[].follower — теж сам Account напряму.
 */
export function useLensFollowersList(accountAddress) {
  return usePaginatedAccountList(
    fetchFollowers,
    accountAddress,
    (item) => item.follower,
  );
}

/**
 * ДОДАНО: легкий хук лише для ЧИСЕЛ followers/following — для бейджів
 * на профілі, де список повністю не потрібен. На відміну від
 * useLensFollowingList/useLensFollowersList (які пагіновано тягнуть
 * самі акаунти сторінками по кілька штук), fetchAccountStats повертає
 * точну кількість одним легким запитом — без жодного зв'язку з
 * кількістю завантажених сторінок.
 */
export function useLensFollowCounts(accountAddress) {
  const [counts, setCounts] = useState({ followers: null, following: null });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!accountAddress) {
      setCounts({ followers: null, following: null });
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetchAccountStats(lensClient, { account: accountAddress })
      .then((result) => {
        if (cancelled) return;
        if (result.isErr() || !result.value) {
          console.error(
            "❌ Lens fetchAccountStats error:",
            result.isErr() ? result.error.message : "no stats",
          );
          return;
        }
        setCounts({
          followers: result.value.graphFollowStats.followers,
          following: result.value.graphFollowStats.following,
        });
      })
      .catch((e) => {
        if (!cancelled) console.error("❌ useLensFollowCounts exception:", e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [accountAddress]);

  return { ...counts, loading };
}
