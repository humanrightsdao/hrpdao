// src/hooks/useLensProfile.js
import { useState, useEffect } from "react";
import { lensClient } from "../lib/lens";
import {
  fetchAccountsAvailable,
  fetchAccount,
} from "@lens-protocol/client/actions";

const cache = new Map();

// ДОДАНО: конвертація lens:// / ar:// / ipfs:// URI у робочий https:// URL.
// Без цього <img src={lensProfile.avatar}> намагався б відкрити
// "lens://..." напряму — браузер не знає такої схеми
// (помилка в консолі: net::ERR_UNKNOWN_URL_SCHEME), і аватарка
// просто не з'являлась би навіть якщо вона завантажена в Lens.
//
// Це та сама логіка, що вже є в useLensPosts.js (resolveLensPicture) —
// тут окрема копія, бо це інший, незалежний файл/хук, і так простіше
// не заплутатись із залежностями між файлами.
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

  return picture; // вже https://
};

// ДОДАНО: спільний мапінг сирого Lens Account (як повертає й
// fetchAccountsAvailable, і fetchAccount) у плоский профіль-об'єкт.
// Раніше ця логіка (парсинг attributes, резолв аватарки тощо) була
// "вшита" прямо в fetchLensAccountData. Винесено окремо, бо тепер та
// сама логіка потрібна і для fetchLensAccountByAddress — завантаження
// ЧУЖОГО публічного профілю (UserProfilePage) за адресою акаунту,
// без жодного зв'язку з гаманцем чи localStorage.
const mapAccountToProfile = (account) => {
  if (!account) return null;

  const attrs = {};
  for (const attr of account.metadata?.attributes || []) {
    attrs[attr.key] = attr.value;
  }

  return {
    // Ідентифікація
    address: account.address,
    owner: account.owner || null, // EOA-власник, для Shield/Council звірки
    createdAt: account.createdAt,
    localName: account.username?.localName || null,
    handle: account.username?.localName
      ? `@${account.username.localName}`
      : null,

    // Metadata
    name: account.metadata?.name || null,
    bio: account.metadata?.bio || null,
    avatar: resolveLensPicture(account.metadata?.picture) || null,

    // Attributes з блокчейну.
    // ВИПРАВЛЕНО: додано фолбек на "countryCode" — той самий ключ,
    // який використовується при створенні постів (useLensPosts.js).
    // Якщо онбординг писав країну саме під цим ключем, а не "country" —
    // профіль тепер підхопить її коректно. Прибери зайві фолбеки, як
    // тільки підтвердиш реальний ключ через лог вище.
    country: attrs.country || attrs.countryCode || attrs.Country || "EARTH",
    // ДОДАНО: гексагон-код локації (H3 index). Раніше писався в Lens
    // (ProfileEditModal -> updateLensMetadata), але ніде не зчитувався
    // назад — профіль завжди "губив" його після релоаду.
    h3Index: attrs.h3Index || null,
    dateOfBirth: attrs.dateOfBirth
      ? new Date(attrs.dateOfBirth).toISOString().split("T")[0]
      : null,
    isAdult: attrs.isAdult === "true",
    hasAcceptedTerms: attrs.hasAcceptedTerms === "true",
    termsAcceptedAt: attrs.termsAcceptedAt || null,
    // ADDED: the npub linked via useNostrIdentity's
    // linkNostrIdentityToLensAccount() — surfaced here so
    // UserProfilePage.jsx can show a "Message on Nostr" button when
    // present, without needing its own separate metadata fetch.
    nostrNpub: attrs.nostr_npub || null,

    // Онбординг пройдено якщо акаунт існує
    hasCompletedOnboarding: true,
  };
};

// ДОДАНО: на відміну від fetchLensAccountData (яка звужує accountsAvailable
// до ОДНОГО активного акаунту залогіненого юзера через lens_account_address
// у localStorage) — тут повертаємо ВСІ Lens Account, якими володіє/керує
// довільна адреса. Потрібно для GovernancePage.jsx: DisciplineModule
// зберігає лише EOA-адресу таргета санкції (p.target), а не Lens Account,
// тож щоб знайти пост-порушення (violationPostRef — це keccak256(lensPostId),
// односторонній хеш, не розшифровується назад), треба спершу дізнатись усі
// Lens-акаунти цього EOA, а потім перебрати їхні пости.
export async function fetchAllLensAccountsForOwner(ownerAddress) {
  if (!ownerAddress) return [];

  const result = await fetchAccountsAvailable(lensClient, {
    managedBy: ownerAddress,
    includeOwned: true,
  });

  if (result.isErr()) {
    console.error(
      "❌ Lens fetchAccountsAvailable (by owner) error:",
      result.error.message,
    );
    return [];
  }

  return (result.value.items || [])
    .map((item) => item.account)
    .filter(Boolean)
    .map(mapAccountToProfile);
}

/**
 * ВИПРАВЛЕНО: раніше тут був "сирий" fetch на
 * https://api.testnet.lens.xyz/graphql із GraphQL-запитом, що містив
 * ЛИШЕ фрагмент `... on AccountOwned { account {...} }`.
 *
 * Проблема: accountsAvailable повертає union-тип, елементи якого можуть
 * бути різних варіантів володіння акаунтом (власний / делегований через
 * Account Manager). Якщо реальний __typename конкретного запису не
 * співпадав з "AccountOwned", поле account лишалось undefined — і
 * профіль (а отже й країна користувача) завжди "губився", повертаючи
 * лише фолбек "EARTH".
 *
 * Використання офіційної дії fetchAccountsAvailable з SDK прибирає цю
 * проблему — SDK сам коректно типізує й повертає всі варіанти union,
 * незалежно від типу володіння акаунтом, та завжди ходить на правильний
 * ендпоінт testnet (той самий, що й lensClient в lib/lens.js).
 */
export async function fetchLensAccountData(address, options = {}) {
  const { returnPendingSignal = false } = options;

  const result = await fetchAccountsAvailable(lensClient, {
    managedBy: address,
    includeOwned: true,
  });

  if (result.isErr()) {
    console.error(
      "❌ Lens fetchAccountsAvailable error:",
      result.error.message,
    );
    return null;
  }

  const items = result.value.items;

  // ВИПРАВЛЕНО: один гаманець може керувати/володіти кількома Lens-
  // акаунтами одночасно (саме так і сталось: accountsAvailable повернув
  // 2 записи на одну адресу гаманця). Раніше тут бездумно бралось
  // items[0] — перший-ліпший зі списку, БЕЗ перевірки, чи це саме той
  // акаунт, який користувач реально обрав (lens_account_address у
  // localStorage, записується при onboarding/loginWithAccount). Через
  // це CreatePostModal (і будь-хто інший, хто читає цей хук) показував
  // ім'я/аватарку/біо ІНШОГО акаунту того ж гаманця, ніж сторінка
  // профілю — там та сама звірка вже була реалізована окремо, у
  // паралельній копії цієї логіки в useUserInfo.js.
  const savedAccountAddr = localStorage.getItem("lens_account_address");
  const matched = items?.find(
    (i) =>
      i.account?.address?.toLowerCase() === savedAccountAddr?.toLowerCase(),
  );

  if (savedAccountAddr && !matched) {
    if (returnPendingSignal) {
      // useUserInfo.js просить явний сигнал замість тихого фолбеку —
      // там це призводить до retry замість показу "не того" акаунту.
      console.warn(
        "⚠️ fetchLensAccountData: активний акаунт",
        savedAccountAddr,
        "ще не знайдено серед accountsAvailable — сигналізую pending для retry",
      );
      return { pending: true };
    }
    console.warn(
      "⚠️ fetchLensAccountData: активний акаунт",
      savedAccountAddr,
      "ще не знайдено серед accountsAvailable (можливо, не проіндексувався) — тимчасово фолбек на перший зі списку",
    );
  }

  const first = (matched || items?.[0])?.account;
  if (!first) return null;

  return mapAccountToProfile(first);
}

/**
 * ДОДАНО: пряме завантаження ПУБЛІЧНОГО профілю по Lens Account адресі —
 * для UserProfilePage (перегляд профілю БУДЬ-ЯКОГО користувача, не лише
 * свого власного — наприклад, коли заходять за посиланням з
 * post.author.address).
 *
 * На відміну від fetchLensAccountData вище — там акаунт визначається
 * непрямо, через accountsAvailable+managedBy і звірку з
 * lens_account_address залогіненого юзера в localStorage (це питання
 * "який з МОЇХ акаунтів зараз активний"). Тут акаунт і так уже відомий
 * (адреса прийшла з URL), тож просто завантажуємо його напряму через
 * офіційну дію fetchAccount — без жодної прив'язки до гаманця чи
 * залогіненого користувача. Саме тому це окрема функція, а не варіант
 * fetchLensAccountData з іншими параметрами.
 */
export async function fetchLensAccountByAddress(accountAddress) {
  if (!accountAddress) return null;

  const result = await fetchAccount(lensClient, {
    address: accountAddress,
  });

  if (result.isErr()) {
    console.error(
      "❌ Lens fetchAccount (by address) error:",
      result.error.message,
    );
    return null;
  }

  return mapAccountToProfile(result.value);
}

// Старе ім'я лишене як псевдонім — щоб нижче в цьому ж файлі (useLensProfile hook) нічого не довелось переписувати.
const fetchLensProfile = fetchLensAccountData;

export function useLensProfile(walletAddress) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // ДОДАНО: лічильник примусового перезавантаження. Раніше invalidateCache
  // лише видаляв запис із кешу, але useEffect нижче прив'язаний до
  // [walletAddress] — а ця адреса не змінюється після збереження
  // профілю, тож новий fetch ніколи не запускався автоматично. Тепер
  // refetch() і чистить кеш, і змінює refreshIndex — це й тригерить
  // повторний запуск ефекту нижче.
  const [refreshIndex, setRefreshIndex] = useState(0);

  useEffect(() => {
    if (!walletAddress) return;
    const addr = walletAddress.toLowerCase();

    // ВИПРАВЛЕНО: ключ кешу тепер включає й активний lens_account_address,
    // а не лише адресу гаманця. Один гаманець може мати кілька Lens-
    // акаунтів — раніше кеш був спільний на весь гаманець, тож профіль
    // одного акаунту міг "просочитись" і показатись для іншого.
    const activeAccountAddr = (
      localStorage.getItem("lens_account_address") || "default"
    ).toLowerCase();
    const cacheKey = `${addr}::${activeAccountAddr}`;

    if (cache.has(cacheKey)) {
      setProfile(cache.get(cacheKey));
      return;
    }

    setLoading(true);
    fetchLensProfile(walletAddress)
      .then((data) => {
        const result = data || null;
        if (result) cache.set(cacheKey, result);
        setProfile(result);
      })
      .catch((e) => {
        console.error("Lens profile error:", e);
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [walletAddress, refreshIndex]);

  // Очистити кеш при потребі (після оновлення профілю)
  const invalidateCache = () => {
    const addr = walletAddress?.toLowerCase();
    if (!addr) return;
    const activeAccountAddr = (
      localStorage.getItem("lens_account_address") || "default"
    ).toLowerCase();
    cache.delete(`${addr}::${activeAccountAddr}`);
  };

  // ДОДАНО: примусове перезавантаження профілю — викликати після
  // успішного збереження в ProfileEditModal (setAccountMetadata),
  // інакше сторінка лишається зі старими даними аж до перезавантаження.
  const refetch = () => {
    invalidateCache();
    setError(null);
    setRefreshIndex((i) => i + 1);
  };

  return { profile, loading, error, invalidateCache, refetch };
}

// ДОДАНО: окремий кеш для публічних профілів. Свідомо НЕ той самий
// Map, що й `cache` вище — той кешується за `walletAddress::активний
// акаунт цього ж браузера`, що тут не має сенсу (ми дивимось профіль
// ІНШОЇ людини, її активний акаунт нас не стосується). Тут ключ —
// просто адреса Lens-акаунту, який переглядається.
const publicProfileCache = new Map();

/**
 * ДОДАНО: хук для публічної сторінки профілю (UserProfilePage).
 * На відміну від useLensProfile (профіль ВЛАСНОГО залогіненого
 * користувача, прив'язаний до гаманця й localStorage), цей хук просто
 * завантажує дані Lens Account за відомою адресою — підходить для
 * перегляду профілю будь-якого користувача застосунку.
 */
export function useLensPublicProfile(accountAddress) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!accountAddress) {
      setProfile(null);
      setLoading(false);
      setError(null);
      return;
    }

    const addr = accountAddress.toLowerCase();

    if (publicProfileCache.has(addr)) {
      setProfile(publicProfileCache.get(addr));
      return;
    }

    setLoading(true);
    setError(null);
    fetchLensAccountByAddress(accountAddress)
      .then((data) => {
        const result = data || null;
        if (result) publicProfileCache.set(addr, result);
        setProfile(result);
      })
      .catch((e) => {
        console.error("Lens public profile error:", e);
        setError(e.message);
      })
      .finally(() => setLoading(false));
  }, [accountAddress]);

  return { profile, loading, error };
}
