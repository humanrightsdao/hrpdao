// src/hooks/usePolicyLink.js
//
// Читає АКТУАЛЬНИЙ (ратифікований, ончейн) URI Human Rights Policy —
// без підключення гаманця, тому працює для будь-якого відвідувача,
// навіть якщо він не залогінений (DocsPage, TokenPage).
//
// Раніше DocsPage.jsx та TokenPage.jsx використовували захардкоджений
// рядок з застарілим IPFS CID ("policy" в MATERIALS / POLICY_URL).
// Це означало, що після кожного успішного proposal.execute(), який
// змінює policyURI() в контракті ShieldSBT, посилання на сайті
// доводилось оновлювати вручну — і воно "відставало" від ончейн
// версії документа. Той самий підхід (з тим самим фіксом гейтвею)
// вже використовується в проєкті dossier (src/components/Navbar.jsx) —
// тут він перенесений 1:1, щоб обидва застосунки завжди показували
// той самий, поточний текст політики.
//
// Використання:
//   import { usePolicyLink } from "../hooks/usePolicyLink";
//   ...
//   const policyLink = usePolicyLink();
//   <a href={policyLink || FALLBACK_URL} ...>
import { useEffect, useState } from "react";
import { ethers } from "ethers";
import { CONTRACTS, ACTIVE_CHAIN } from "./useDao";

// Мінімальний read-only ABI — тут потрібен лише один метод.
const POLICY_READ_ABI = ["function policyURI() external view returns (string)"];

// Ончейн policyURI зберігається як "ipfs://<CID>" (це протокол, а не
// http-посилання) — конвертуємо в клікабельне посилання на гейтвей.
// ipfs.io — публічний гейтвей, що працює в будь-якому браузері;
// dweb.link — резервний варіант, якщо основний повільний/недоступний.
const IPFS_GATEWAYS = [
  (cid) => `https://ipfs.io/ipfs/${cid}`,
  (cid) => `https://dweb.link/ipfs/${cid}`,
];

function ipfsUriToGatewayLink(ipfsUri) {
  if (!ipfsUri || !ipfsUri.startsWith("ipfs://")) return ipfsUri || null;
  const cid = ipfsUri.replace("ipfs://", "");
  return IPFS_GATEWAYS[0](cid);
}

/**
 * Повертає посилання на поточний текст Human Rights Policy (гейтвей-URL),
 * або null, поки ончейн-запит ще виконується / якщо він не вдався.
 */
export function usePolicyLink() {
  const [policyLink, setPolicyLink] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPolicyLink() {
      try {
        const rp = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]);
        const shield = new ethers.Contract(
          CONTRACTS.shieldSBT,
          POLICY_READ_ABI,
          rp,
        );
        const uri = await shield.policyURI();
        if (!cancelled) setPolicyLink(ipfsUriToGatewayLink(uri));
      } catch (e) {
        console.warn("[usePolicyLink] failed to load policyURI:", e);
      }
    }
    loadPolicyLink();
    return () => {
      cancelled = true;
    };
  }, []);

  return policyLink;
}
