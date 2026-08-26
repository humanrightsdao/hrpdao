// src/hooks/useCountryRatings.js
//
// ЗАМІНЮЄ Supabase-версію цього хука. Тепер рейтинг країни — це не
// рядок у таблиці country_ratings, а Lens Post із двома тегами:
//   "country_rating"        — щоб відрізняти від звичайних постів
//   "country_<ISO-код>"     — країна, до якої відноситься оцінка
//
// Кожен користувач має НЕ БІЛЬШЕ ОДНОГО такого поста одночасно — при
// повторній оцінці ми РЕДАГУЄМО (editPost) той самий пост замість
// створення нового (див. src/lib/countryRatings.js). Коли юзер міняє
// країну проживання, ProfileEditModal.jsx видаляє цей пост (deletePost)
// — так гарантується вимога "лише актуальні рейтинги враховуються":
// пост фізично не існує для країни, в якій людина вже не живе.
//
// 🛑 КОРІНЬ ПРОБЛЕМИ, ЯКУ ЦЕЙ ФАЙЛ ВИПРАВЛЯЄ: тег країни раніше мав
// формат "country:US" (з двокрапкою). Індексер Lens шукає теги через
// Postgres tsquery, де ":" — оператор ваги лексеми (word:A). Запит з
// "country:US" валився з "syntax error in tsquery" на БУДЬ-якій спробі
// фільтрації — саме тому середні рейтинги ніколи не рахувались. Тег
// змінено на "country_US" (підкреслення) — див. src/lib/countryRatings.js
// (buildRatingMetadata). Обидва місця (запис і читання тега) мають
// лишатись синхронізованими.
//
// ✅ ПЕРЕВІРЕНО (проти типів @lens-protocol/graphql
// 0.0.0-canary-20250430134539): filter.metadata.tags підтримує і
// { oneOf } (OR), і { all } (AND) — обидва синтаксично коректні. Але
// getCountryPosts у useLensPosts.js вже зафіксував коментарем, що
// комбінований AND-фільтр тегів ненадійно поводиться на цьому
// testnet-індексері, тож тут теж використовується перевірений патерн
// "один тег через oneOf + фільтрація на клієнті".
import { useState, useCallback } from "react";
import { lensClient } from "../lib/lens";
import { RATING_TAG, parseRatingAttributes } from "../lib/countryRatings";

const MAX_PAGES = 20; // запобіжник від нескінченної пагінації на дуже "рейтинговій" країні

export default function useCountryRatings() {
  const [ratingsData, setRatingsData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const getAverageRatings = useCallback(async (countryCode) => {
    if (!countryCode || countryCode === "EARTH") {
      setRatingsData(null);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const { fetchPosts } = await import("@lens-protocol/client/actions");

      const sums = {
        human_rights: 0,
        economic_freedom: 0,
        political_freedom: 0,
        freedom_of_speech: 0,
      };
      let count = 0;
      let cursor;

      for (let page = 0; page < MAX_PAGES; page++) {
        // ВИПРАВЛЕНО: тег без двокрапки ("country_US", не "country:US") —
        // двокрапка ламала tsquery-парсер на бекенді Lens-індексера.
        const result = await fetchPosts(lensClient, {
          filter: {
            metadata: {
              tags: { oneOf: [`country_${countryCode}`] },
            },
          },
          cursor,
        });

        if (result.isErr()) {
          throw new Error(result.error.message);
        }

        const { items, pageInfo } = result.value;

        for (const post of items) {
          // AND-умова на клієнті: пост має мати ОБИДВА теги.
          if (!post.metadata?.tags?.includes(RATING_TAG)) continue;

          const parsed = parseRatingAttributes(post);
          if (!parsed) continue; // не наш формат — про всяк випадок пропускаємо

          sums.human_rights += parsed.human_rights;
          sums.economic_freedom += parsed.economic_freedom;
          sums.political_freedom += parsed.political_freedom;
          sums.freedom_of_speech += parsed.freedom_of_speech;
          count += 1;
        }

        if (!pageInfo?.next) break;
        cursor = pageInfo.next;
      }

      if (count === 0) {
        setRatingsData(null);
        return;
      }

      setRatingsData({
        averageRatings: {
          human_rights: sums.human_rights / count,
          economic_freedom: sums.economic_freedom / count,
          political_freedom: sums.political_freedom / count,
          freedom_of_speech: sums.freedom_of_speech / count,
        },
        totalRatings: count,
      });
    } catch (err) {
      console.error("⚠️ getAverageRatings (Lens) error:", err);
      setError(err.message || "Не вдалося завантажити рейтинги");
    } finally {
      setLoading(false);
    }
  }, []);

  const resetRatings = useCallback(() => {
    setRatingsData(null);
    setError("");
  }, []);

  return { ratingsData, loading, error, getAverageRatings, resetRatings };
}
