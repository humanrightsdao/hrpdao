// src/hooks/useUserInfo.js
import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
// ВИДАЛЕНО: `import { supabase } from "../lib/supabase"` — цей імпорт
// ніде в файлі більше не використовувався (жодного виклику supabase.*),
// це "мертвий" залишок після міграції на Lens. Небезпечний сам по собі:
// якщо lib/supabase.js уже видалили/змінили експорти під час міграції,
// цей рядок падає на завантаженні модуля (import error), а useUserInfo
// імпортується практично з усього застосунку (NotificationsPage,
// Layout тощо) — тобто одна ця стрічка могла обвалити ввесь застосунок
// або окремі сторінки ще ДО того, як встигне спрацювати будь-яка
// сповіщення-логіка.
// Спільна логіка запиту/парсингу Lens-акаунту (GraphQL + resolveLensPicture
// + вибір активного акаунту з кількох на одному гаманці) живе в одному
// місці — useLensProfile.js.
import { fetchLensAccountData } from "./useLensProfile";

// GLOBAL CACHE for all hook instances
let cachedUserInfo = null;
let cacheTimestamp = 0;
// ДОДАНО: ключ акаунту, для якого закешовано cachedUserInfo. Раніше
// кеш вважався "свіжим" виключно за часом (now - cacheTimestamp <
// CACHE_DURATION), без жодної прив'язки до того, ЯКИЙ САМЕ акаунт
// активний. Через це перемикання між кількома Lens-акаунтами одного
// гаманця (lens_account_address у localStorage змінювався) в межах
// 5-хвилинного вікна кешу мовчки показувало дані СТАРОГО акаунту —
// саме та поведінка "перемкнув акаунт, бачу старий, тільки після
// reload бачу новий", бо лише повне перезавантаження сторінки скидає
// цю let-змінну модуля (React-рендери на це не впливають).
let cachedAccountKey = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes caching

// Multiple request guard
let isLoadingInProgress = false;

// ДОДАНО: раніше useState(cachedUserInfo) / useState(!cachedUserInfo)
// нижче брали глобальний кеш НАПРЯМУ, без жодної звірки з тим, хто
// зараз реально залогінений. cachedAccountKey звірявся лише всередині
// loadUserInfo() — а це асинхронний ефект, що спрацьовує ПІСЛЯ першого
// рендеру. Тобто будь-який компонент, що монтує useUserInfo() (або
// лишається змонтованим) одразу після logout()+login() іншим акаунтом,
// у самому першому рендері отримував userInfo СТАРОГО користувача —
// і все, що похідне від нього в цьому першому рендері (напр.
// selectedCountry в CountryPage), встигало "зафіксуватись" на старих
// даних ще до того, як асинхронний loadUserInfo() встигав підвантажити
// й підмінити на правильні. Звідси і був баг "перший раз стара країна,
// після F5 — нова": F5 не виправляв гонку сам по собі, він просто
// давав шанс кешу вже бути валідним (той самий акаунт) до монтування.
// getValidCachedInfo() робить ту саму звірку cacheKey СИНХРОННО, ще до
// першого рендеру, тож застарілий кеш іншого акаунта більше ніколи не
// потрапляє в initial state.
function getValidCachedInfo() {
  const lensAddress = localStorage.getItem("lens_wallet_address");
  const activeAccountAddr = localStorage.getItem("lens_account_address");
  const cacheKey = `${lensAddress || ""}:${activeAccountAddr || ""}`;
  if (
    cachedUserInfo &&
    cachedAccountKey === cacheKey &&
    Date.now() - cacheTimestamp < CACHE_DURATION
  ) {
    return cachedUserInfo;
  }
  return null;
}

export default function useUserInfo() {
  const { t } = useTranslation();
  const [userInfo, setUserInfo] = useState(getValidCachedInfo);
  const [loading, setLoading] = useState(() => !getValidCachedInfo());
  const [error, setError] = useState("");

  // Ref for tracking mounting
  const isMounted = useRef(true);
  // Ref для доступу до актуальної loadUserInfo зі setTimeout/колбеків,
  // де замикання може тримати застарілу версію функції
  const loadUserInfoRef = useRef(null);

  // Function for loading user information
  const loadUserInfo = useCallback(
    async (forceRefresh = false) => {
      console.log("🔄 loadUserInfo started", {
        forceRefresh,
        isLoadingInProgress,
      });

      // Prevent multiple concurrent requests
      if (isLoadingInProgress && !forceRefresh) {
        console.log("⏳ Another load is in progress, skipping...");
        return cachedUserInfo;
      }

      isLoadingInProgress = true;

      const now = Date.now();

      // ВИПРАВЛЕНО: ці два рядки раніше були нижче, ПІСЛЯ перевірки
      // кешу (тобто кеш перевірявся "наосліп", не знаючи навіть, чи
      // змінився активний акаунт). Тепер читаємо їх одразу, рахуємо
      // cacheKey і звіряємо його з cachedAccountKey — кеш вважається
      // дійсним лише якщо І не протух за часом, І належить ТОМУ Ж
      // акаунту, що активний зараз.
      const lensAddress = localStorage.getItem("lens_wallet_address");
      const activeAccountAddr = localStorage.getItem("lens_account_address");
      const cacheKey = `${lensAddress || ""}:${activeAccountAddr || ""}`;

      // Check cache: if there's cached data and it's not older than
      // CACHE_DURATION, AND it belongs to the currently active account
      if (
        !forceRefresh &&
        cachedUserInfo &&
        cachedAccountKey === cacheKey &&
        now - cacheTimestamp < CACHE_DURATION
      ) {
        console.log("💾 Using cached user info");
        if (isMounted.current) {
          setUserInfo(cachedUserInfo);
          setLoading(false);
        }
        isLoadingInProgress = false;
        return cachedUserInfo;
      }

      if (isMounted.current) {
        setLoading(true);
        setError("");
      }

      // ВИПРАВЛЕНО: прапор, що вказує чи функція завершилась через
      // pending/retry (і loading має лишатись true), а не через успіх/помилку.
      // Без цього finally-блок скидав loading:false навіть коли ми щойно
      // виставили loading:true для повторної спроби — аватарка лишалась
      // невидимою назавжди, бо Navbar бачив loading:false + userInfo:null
      // і рендерив fallback-літеру замість очікування результату.
      let pendingRetry = false;

      try {
        // ВИДАЛЕНО: стара гілка email/password автентифікації через
        // supabase.auth.getUser() + таблицю "users" (створення/читання
        // профілю, web3Addr-фолбек тощо). Повна міграція на Lens —
        // інших способів логіну в застосунку більше немає. Якщо
        // lensAddress відсутній — це просто означає "ніхто не залогінений",
        // а не "перевір стару Supabase-сесію".
        if (!lensAddress) {
          console.log("👤 No Lens session found");
          cachedUserInfo = null;
          cacheTimestamp = 0;
          cachedAccountKey = null;
          if (isMounted.current) {
            setUserInfo(null);
            setLoading(false);
          }
          isLoadingInProgress = false;
          return null;
        }

        // Беремо дані з Lens через спільну fetchLensAccountData
        // (useLensProfile.js). returnPendingSignal: true — щоб при
        // щойно створеному/обраному, ще не проіндексованому акаунті
        // отримати явний { pending: true } замість тихого фолбеку на
        // інший акаунт того ж гаманця.
        const lensData = await fetchLensAccountData(lensAddress, {
          returnPendingSignal: true,
        });

        // Lens-індексатор ще не підхопив щойно створений/обраний
        // акаунт. НЕ кешуємо це як остаточний стан і НЕ показуємо
        // fallback з іншим акаунтом — просто плануємо повторну
        // спробу за 2 секунди. forceRefresh=true обходить кеш.
        if (lensData?.pending) {
          isLoadingInProgress = false;
          pendingRetry = true; // ← finally не скидатиме loading
          if (isMounted.current) setLoading(true);
          setTimeout(() => {
            if (isMounted.current) loadUserInfoRef.current?.(true);
          }, 2000);
          return null;
        }

        if (!lensData) {
          // fetchLensProfile повернув null — найімовірніше мережева
          // помилка/таймаут GraphQL, а не "акаунту не існує". Робимо
          // обмежену кількість повторних спроб замість того, щоб
          // лишати userInfo в null назавжди (це блокує всі дії, що
          // потребують авторизації — реакції, коментарі тощо).
          isLoadingInProgress = false;

          const retryCount = (loadUserInfo._retryCount || 0) + 1;
          loadUserInfo._retryCount = retryCount;

          if (retryCount <= 3) {
            console.warn(
              `⚠️ fetchLensProfile returned null, retry ${retryCount}/3 in 1.5s`,
            );
            pendingRetry = true; // ← finally не скидатиме loading
            if (isMounted.current) setLoading(true);
            setTimeout(() => {
              if (isMounted.current) loadUserInfoRef.current?.(true);
            }, 1500);
            return null;
          }

          console.error(
            "❌ fetchLensProfile failed after 3 retries, giving up",
          );
          loadUserInfo._retryCount = 0;
          if (isMounted.current) setLoading(false);
          return null;
        }

        // Успішний результат — скидаємо лічильник повторів
        loadUserInfo._retryCount = 0;

        // ВИДАЛЕНО з цього запиту: social_links, h3_index (мігровано на
        // Lens раніше), і ТЕПЕР ТАКОЖ role/lens_users — систему ролей
        // модерації (isAdmin/isModerator) прибрано повністю, оскільки
        // вона ніде фактично не використовувалась. Це заразом прибирає
        // ОСТАННІЙ Supabase-запит, що виконувався на кожне завантаження
        // профілю — loadUserInfo() тепер взагалі не звертається до
        // Supabase. userInfo.id більше не є UUID з таблиці lens_users —
        // це прямо wallet-адреса, єдиний стабільний ідентифікатор, який
        // у нас лишився. Якщо колись знадобиться country_ratings —
        // прив'язуйте рейтинги напряму до цієї адреси, без окремої
        // таблиці користувачів.
        const userData = {
          id: lensAddress,
          walletAddress: lensAddress,
          // Адреса Lens Smart Account (відрізняється від гаманця!).
          // Саме її показувати на сторінках профілю — не walletAddress.
          lensAccountAddress: lensData.address || activeAccountAddr,
          uniqueName: lensData.localName,
          handle: lensData.handle,
          // ВИПРАВЛЕНО: раніше це поле взагалі не копіювалось сюди з
          // lensData — ProfileEditModal міг очікувати userInfo.name, але
          // завжди отримував undefined, хоча lensData.name уже містив
          // потрібне значення.
          name: lensData.name || null,
          bio: lensData.bio,
          avatarUrl: lensData.avatar || null,
          country: lensData.country,
          // FIXED: same bug pattern as the name/dateOfBirth fixes noted
          // above — lensData.nostrNpub (read from the on-chain
          // "nostr_npub" account attribute, see useLensProfile.js)
          // simply wasn't being copied into userData. SettingsPage.jsx
          // reads userInfo?.nostrNpub specifically to show the npub
          // WITHOUT needing a wallet call (since it's already on Lens),
          // but that value was silently always undefined here — so
          // Settings looked like "not set up yet" and prompted for an
          // explicit "Set up now" action even for accounts that
          // already had it linked on-chain, and it reset to nothing on
          // every reload since it's re-fetched fresh each time.
          nostrNpub: lensData.nostrNpub || null,
          // ДОДАНО: раніше dateOfBirth/age взагалі не потрапляли в
          // userData для Lens-користувачів (були тільки в старій
          // Supabase-гілці, яку ми щойно прибрали) — getDateOfBirth()/
          // getAge() мовчки повертали null для всіх. lensData вже має
          // це поле (з атрибута Lens), просто раніше не копіювалось.
          dateOfBirth: lensData.dateOfBirth || null,
          age: calculateAge(lensData.dateOfBirth),
          isAdult: lensData.isAdult || false,
          hasAcceptedTerms: true,
          hasCompletedOnboarding: true,
          h3Cell: lensData.h3Index || null,
          createdAt: lensData.createdAt,
          authMethod: "lens",
        };

        cachedUserInfo = userData;
        cacheTimestamp = now;
        cachedAccountKey = cacheKey;
        if (isMounted.current) {
          setUserInfo(userData);
          setLoading(false);
        }
        isLoadingInProgress = false;
        return userData;
      } catch (err) {
        console.error("❌ Error loading profile:", err.message || err);
        isLoadingInProgress = false;
        if (isMounted.current) {
          setError(err.message);
          setLoading(false);
        }
        return null;
      } finally {
        // ВИПРАВЛЕНО: скидаємо loading лише якщо це НЕ pending/retry виклик.
        // Якщо pendingRetry=true — loading вже виставлено в true вище і
        // повторна спроба ще не завершилась; скидати його тут означало б
        // показати Navbar у стані "завантаження завершено, даних немає" —
        // аватарка зникала і більше не з'являлась навіть після успішного retry.
        if (!pendingRetry && isMounted.current) {
          setLoading(false);
        }
        console.log("🏁 loadUserInfo completed, pendingRetry:", pendingRetry);
      }
    },
    [t],
  );

  // Синхронізуємо ref з актуальною функцією після кожного рендеру,
  // щоб setTimeout у pending-retry завжди мав свіжу версію
  loadUserInfoRef.current = loadUserInfo;

  // ВИДАЛЕНО: updateUserInfo() / updateUserField(). Раніше єдиним їхнім
  // призначенням був запис "role" (модерація/адмінка) у Supabase — цю
  // функцію повністю прибрано з застосунку (ніде не використовувалась),
  // тож писати в Supabase з цього хука більше НЕМА ЧОГО: усі профільні
  // дані (name/bio/avatar/country/...) уже пишуться напряму в Lens через
  // ProfileEditModal.jsx (setAccountMetadata), а не через цей хук.
  //
  // Якщо колись знадобиться реальне редагування профілю з цього хука —
  // викликайте відповідну Lens-мутацію (як у ProfileEditModal), а не
  // Supabase — тут навмисно більше немає жодного запису в базу.

  // Function for formatting wallet address
  const formatWalletAddress = useCallback(
    (address, startChars = 6, endChars = 4) => {
      if (!address) return "";
      if (address.length <= startChars + endChars) return address;
      return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
    },
    [],
  );

  // Function for getting age from date of birth
  function calculateAge(dateOfBirth) {
    if (!dateOfBirth) return null;
    // Беремо тільки рік, решту ігноруємо
    const birthYear = new Date(dateOfBirth).getFullYear();
    return new Date().getFullYear() - birthYear;
  }

  // Function for getting avatar (with fallback to initials)
  const getAvatar = useCallback(() => {
    if (userInfo?.avatarUrl) {
      return userInfo.avatarUrl;
    }
    return null;
  }, [userInfo]);

  // Function for clearing cache
  const clearCache = useCallback(() => {
    cachedUserInfo = null;
    cacheTimestamp = 0;
    cachedAccountKey = null;
    isLoadingInProgress = false;

    if (isMounted.current) {
      setUserInfo(null);
    }
  }, []);

  // Load information on initialization
  useEffect(() => {
    console.log(
      "🎯 useUserInfo useEffect triggered, cache exists:",
      !!cachedUserInfo,
    );

    // Set mounting
    isMounted.current = true;

    // ВИПРАВЛЕНО: раніше тут був "швидкий шлях" — якщо cachedUserInfo
    // вже існував, стан виставлявся напряму з кеша, в обхід
    // loadUserInfo() і, відповідно, в обхід перевірки cachedAccountKey.
    // Тобто навіть після виправлення самого loadUserInfo() цей блок
    // міг при МОНТУВАННІ нового компонента (напр. перехід на іншу
    // сторінку одразу після перемикання акаунту) показати кеш СТАРОГО
    // акаунту, не звіряючи його з активним. Тепер init завжди йде через
    // loadUserInfo() — вона й так синхронно перевіряє кеш і не робить
    // зайвого мережевого запиту, якщо він валідний саме для поточного
    // акаунту.
    const init = async () => {
      await loadUserInfo();
    };

    init();

    // Cleanup on unmount
    return () => {
      isMounted.current = false;
    };
  }, [loadUserInfo]);

  // ВИДАЛЕНО: слухач supabase.auth.onAuthStateChange(SIGNED_OUT). Це
  // подія СТАРОЇ email/password автентифікації Supabase, якої більше
  // немає — для Lens-сесій вона ніколи не спрацьовувала б, бо логін
  // взагалі не йде через supabase.auth. Якщо потрібно чистити кеш при
  // виході з Lens-акаунту — викликай clearCache() напряму в обробнику
  // onLogout (там, де зараз localStorage.removeItem(...)).

  return {
    // Main data
    userInfo,
    loading,
    error,

    // Methods for working with data
    loadUserInfo,
    // uploadAvatar / deleteAvatar прибрані: аватарка більше не
    // завантажується через Supabase Storage. Заливка в Grove і
    // прив'язка до Lens-акаунту відбувається в ProfileEditModal.jsx
    // (uploadFileToGrove + setAccountMetadata).
    formatWalletAddress,

    // Utility functions
    calculateAge,

    // Quick access to main fields.
    // ВИДАЛЕНО: getEmail(), getSocialLinks() — обидва поля прибрані з
    // userData вище (емейлу в Lens-акаунту просто не існує; соцмережі —
    // окрема видалена фіча, юзер сам пише посилання в Bio).
    getUniqueName: () => userInfo?.uniqueName || "",
    getCountry: () => userInfo?.country || "EARTH",
    getWalletAddress: () => userInfo?.walletAddress || "",
    // Адреса Lens Smart Account (відрізняється від гаманця!).
    // Використовуйте саме цей геттер на сторінках профілю замість
    // getWalletAddress(), щоб показувати адресу акаунту, а не гаманця.
    getLensAccountAddress: () => userInfo?.lensAccountAddress || "",
    getDateOfBirth: () => userInfo?.dateOfBirth || null,
    getAge: () => userInfo?.age || null,
    getAvatarUrl: () => userInfo?.avatarUrl || null,
    getAvatar: getAvatar,

    // State checks
    isAuthenticated: !!userInfo,
    hasWallet: !!userInfo?.walletAddress,
    hasAvatar: !!userInfo?.avatarUrl,
    // ВИДАЛЕНО: getRole()/isAdmin()/isModerator() — уся система ролей
    // модерації прибрана як невикористовувана (жодного виклику в
    // застосунку). Якщо колись знадобиться — повертайте до цього коміту.

    // Caching
    clearCache,
  };
}
