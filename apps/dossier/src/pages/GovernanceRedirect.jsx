// src/pages/GovernanceRedirect.jsx
//
// ЗАМІНА для старої GovernancePage.jsx. DAO-функціонал тепер живе в
// окремому застосунку (apps/dao) — щоб не дублювати ту саму логіку
// в трьох місцях. Ця сторінка більше нічого не рендерить сама, лише
// одразу передає на DAO-сайт, з адресою гаманця в URL (якщо гаманець
// уже підключений у цьому застосунку) — apps/dao сам підхопить її
// й одразу спробує з'єднання (useWalletHandoff на боці DAO).
import { useEffect } from "react";
import { useAccount } from "wagmi";

// Локально — порт дефолтний (5175); на проді підставте реальний домен
// через .env (VITE_DAO_APP_URL).
const DAO_APP_URL = import.meta.env.VITE_DAO_APP_URL || "http://localhost:5175";

export default function GovernanceRedirect() {
  // CHANGED (embedded wallet): window.ethereum.selectedAddress only
  // ever reflected a browser-extension wallet (MetaMask) — with an
  // embedded/WalletConnect wallet window.ethereum doesn't exist at
  // all, so this always silently redirected without the ?wallet=
  // param. useAccount().address reflects whichever wallet is actually
  // connected (embedded, linked external, or WalletConnect), same as
  // everywhere else in the app.
  const { address } = useAccount();

  useEffect(() => {
    const url = address ? `${DAO_APP_URL}?wallet=${address}` : DAO_APP_URL;
    window.location.href = url;
  }, [address]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#000d1f]">
      <div className="text-center">
        <div className="inline-block w-12 h-12 rounded-full border-2 border-blue-600/40 border-t-blue-400 animate-spin" />
        <p className="mt-4 text-[14px] text-slate-600 dark:text-white/40">
          Перехід на DAO…
        </p>
      </div>
    </div>
  );
}
