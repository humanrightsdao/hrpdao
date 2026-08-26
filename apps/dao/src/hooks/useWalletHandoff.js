// src/hooks/useWalletHandoff.js
//
// Якщо людина прийшла на цю сторінку з кнопки "DAO Chronicle I/II"
// в Human Rights Policy DAO (URL виду ?wallet=0xАдреса), пропонуємо
// одразу підключити той самий гаманець — без зайвого кліку.
//
// Використання (у App.jsx, поруч з іншими хуками з useLensAuth()/
// useNostrAuth()):
//
//   import { useWalletHandoff } from "./hooks/useWalletHandoff";
//   ...
//   useWalletHandoff(isConnected, connectWallet, address);
//
import { useEffect, useRef } from "react";

export function useWalletHandoff(isConnected, connectWallet, currentAddress) {
  const triedRef = useRef(false);

  // Крок 1: якщо є ?wallet= і ми ще не підключені — тригеримо
  // MetaMask одразу при заході (сам попап підтвердження від MetaMask
  // прибрати неможливо, це стандартна вимога безпеки гаманця — але
  // зайвий клік по кнопці "Підключити" на самому сайті вже не потрібен).
  useEffect(() => {
    if (triedRef.current || isConnected) return;
    const params = new URLSearchParams(window.location.search);
    const wallet = params.get("wallet");
    if (!wallet) return;

    triedRef.current = true;
    connectWallet();

    // Прибираємо параметр з URL одразу, щоб не тригерити повторно
    // при навігації/refresh.
    params.delete("wallet");
    const newSearch = params.toString();
    const newUrl =
      window.location.pathname +
      (newSearch ? `?${newSearch}` : "") +
      window.location.hash;
    window.history.replaceState({}, "", newUrl);
  }, [isConnected, connectWallet]);

  // Крок 2 (необов'язково, але корисно): якщо після підключення
  // адреса не збіглась з тією, що передав DAO — це не помилка сама
  // по собі (в MetaMask може бути кілька акаунтів), просто лишаємо
  // слід у консолі для діагностики.
  useEffect(() => {
    if (!isConnected || !currentAddress) return;
    const params = new URLSearchParams(window.location.search);
    const expected = params.get("wallet");
    if (expected && expected.toLowerCase() !== currentAddress.toLowerCase()) {
      console.warn(
        "[wallet-handoff] Підключений гаманець відрізняється від переданого з DAO:",
        { expected, connected: currentAddress },
      );
    }
  }, [isConnected, currentAddress]);
}
