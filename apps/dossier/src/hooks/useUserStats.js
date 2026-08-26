// hooks/useUserStats.js
import { useState, useCallback } from "react";
import { evmAddress } from "@lens-protocol/client";
import { fetchAppUsers } from "@lens-protocol/client/actions";
import { lensClient } from "../lib/lens";

// Lens API (fetchAppUsers) не повертає totalCount — лише курсорну
// пагінацію (pageInfo.next). Щоб не робити необмежену кількість запитів,
// якщо застосунок виросте до тисяч акаунтів, проходимо максимум
// MAX_PAGES сторінок. Якщо після цього ще лишається next-курсор —
// показуємо наближене число (isApproximate = true), а не точне.
const MAX_PAGES = 10;

// ВИДАЛЕНО: розбивка по країнах (countryUsers). Lens fetchAppUsers не
// підтримує фільтр по country — це наш власний metadata-атрибут
// акаунту, а не поле, яке індексує Lens API для AppUser. Якщо розбивка
// по країнах знову знадобиться — доведеться підняти власний
// індексатор/бекенд, що читає country з account metadata.
export const useUserStats = () => {
  const [totalUsers, setTotalUsers] = useState(null);
  const [isApproximate, setIsApproximate] = useState(false);
  const [loading, setLoading] = useState(false);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const appAddress = import.meta.env.VITE_LENS_APP_ADDRESS;

      let count = 0;
      let cursor;
      let pages = 0;
      let approximate = false;

      do {
        const result = await fetchAppUsers(lensClient, {
          app: evmAddress(appAddress),
          ...(cursor ? { cursor } : {}),
        });

        if (result.isErr()) {
          console.error("fetchAppUsers error:", result.error);
          break;
        }

        const page = result.value;
        if (!page) break;

        count += page.items.length;
        cursor = page.pageInfo.next;
        pages += 1;

        if (pages >= MAX_PAGES && cursor) {
          // Ще є наступні сторінки, але ми зупиняємось — число далі
          // приблизне.
          approximate = true;
          break;
        }
      } while (cursor);

      setTotalUsers(count);
      setIsApproximate(approximate);
    } finally {
      setLoading(false);
    }
  }, []);

  return { totalUsers, isApproximate, loading, loadStats };
};
