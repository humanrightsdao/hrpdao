// src/hooks/useTipJar.js
//
// Самодостатній хук для "tip" (фінансової підтримки) авторів постів.
// НЕ потребує попереднього dao.connect() — previewSplit/getTokenInfo
// працюють через публічний RPC; sendTip сам запитує MetaMask при потребі.
//
// Split залежить від SBT-статусу автора (визначається on-chain контрактом TipJar):
//   COUNCIL (статус "Консул") → 90% автору / 10% у Support Pool (Treasury)
//   SHIELD  (статус "Захисник") → 80% автору / 20% у Support Pool (Treasury)
//   немає SBT → 50% автору / 50% у Support Pool (узгоджено в токеноміці)
//
// ⚠️ Support Pool — окремий контракт Treasury (захищена казна з лімітами
// виводу/allowlist), а НЕ DaoTimelock напряму.
//
// Кожен tip ТАКОЖ нараховує автору RIGHTS у RightsRegistry (за повною сумою
// донату, $1 = 1 RIGHT) — це ЄДИНЕ джерело RIGHTS у системі.
// RIGHTS — звичайне ціле число (як currentRights() у RightsRegistry), НЕ
// 18-decimal fixed-point — previewRights() нижче повертає Number напряму.
//
// ⚠️ ЗМІНА: цей деплой має ЛИШЕ ОДИН тестовий токен (tUSD, 6 decimals) —
// не два (tGHO+tUSDC), як було в попередній версії. DEFAULT_TIP_TOKEN
// вказує саме на нього. Якщо DAO пізніше додасть другий токен через
// TipJar.setAcceptedToken(), досить дописати його адресу в .env — код
// нижче не хардкодить кількість токенів.

import { useState, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { useAccount } from "wagmi";
import { ACTIVE_CHAIN } from "./useLensDAO";

// ─────────────────────────────────────────────────────────────
//  Конфігурація контрактів
// ─────────────────────────────────────────────────────────────

const TIPJAR_ADDRESS =
  import.meta.env.VITE_TIP_JAR || "0x0000000000000000000000000000000000000006";
const TEST_TOKEN_USD =
  import.meta.env.VITE_TEST_TOKEN_USD ||
  "0x0000000000000000000000000000000000000007";

// На testnet використовуємо MockERC20 (tUSD). На mainnet — реальний токен,
// прийнятий через governance (TipJar.setAcceptedToken()).
export const DEFAULT_TIP_TOKEN = TEST_TOKEN_USD;

// ⚠️ 300_000 виявилось замало на цій мережі — "Bootloader-based tx failed"
// на mint() через L2 pubdata-вартість (zkSync-стек рахує газ не лише за
// виконання, а й за публікацію даних на L1, що EVM-tooling часто недооцінює).
// Піднято з запасом; реально списується лише спожитий газ, не весь ліміт.
const GAS_OPTS = { gasLimit: 900_000n };

// ─────────────────────────────────────────────────────────────
//  ABIs
// ─────────────────────────────────────────────────────────────

const TIPJAR_ABI = [
  "function tip(address author, address token, uint256 amount, bytes32 postRef) external",
  "function acceptedTokens(address token) external view returns (bool)",
  "function minTipAmount(address token) external view returns (uint256)",
  "function previewSplit(address author) external view returns (uint256 bps, string memory tier)",
  "function previewRights(address token, uint256 amount) external view returns (uint256)",
  "event TipSent(address indexed from, address indexed author, address indexed token, uint256 totalAmount, uint256 authorAmount, uint256 poolAmount, uint256 rightsAwarded, bytes32 postRef)",
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function mint(address to, uint256 amount) external", // тільки MockERC20 (testnet)
];

// ─────────────────────────────────────────────────────────────
//  Хук
// ─────────────────────────────────────────────────────────────

export function useTipJar() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState(null);

  const tipJarReadRef = useRef(null);
  const tokenReadRef = useRef(null);

  // FIXED: this whole hook always went straight to window.ethereum for
  // its write path — a browser-extension-only API. On mobile, when the
  // wallet is connected via WalletConnect (see LensAuthContext.jsx /
  // main.jsx), window.ethereum does not exist at all, so sendTip()
  // failed immediately with "MetaMask не знайдено". `connector` (the
  // active wagmi connector, works for injected OR WalletConnect) is
  // obtained here so _getWriteContracts below can get an EIP-1193
  // provider from it that works for either connection method.
  const { connector } = useAccount();

  // ── Лінива ініціалізація read-only контрактів (без MetaMask) ───

  const _ensureRead = useCallback(() => {
    if (tipJarReadRef.current) return;
    const rp = new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]);
    tipJarReadRef.current = new ethers.Contract(TIPJAR_ADDRESS, TIPJAR_ABI, rp);
    tokenReadRef.current = new ethers.Contract(
      DEFAULT_TIP_TOKEN,
      ERC20_ABI,
      rp,
    );
  }, []);

  // ── Lazy write-доступ через гаманець (тільки коли реально потрібен) ──

  const _getWriteContracts = useCallback(async () => {
    // FIXED: previously `if (!window.ethereum) throw ...`, then every
    // request went through window.ethereum.request(...) directly. Now
    // we get the EIP-1193 provider from the active wagmi connector —
    // connector.getProvider() works uniformly whether the user is
    // using Privy's embedded wallet or a wallet linked THROUGH Privy
    // (desktop extension or WalletConnect/mobile) — it's never
    // window.ethereum specifically.
    // REMOVED the `: window.ethereum` fallback that used to sit here —
    // it was the last leftover independent, non-Privy connection path
    // in the app: if `connector` wasn't populated yet (e.g. a race
    // right after a reload), it would silently reach for the raw
    // browser-extension API instead of the wallet Privy actually
    // manages, opening a second, unrelated MetaMask permission prompt.
    // There's only one connection now (Privy/wagmi) — if it isn't
    // ready yet, that's a real "not connected" state, not something to
    // paper over with window.ethereum.
    if (!connector) throw new Error("Гаманець не підключено");
    const provider = await connector.getProvider();
    if (!provider) throw new Error("Гаманець не підключено");

    await provider.request({ method: "eth_requestAccounts" });

    // Перевірка мережі
    const chainId = await provider.request({ method: "eth_chainId" });
    if (chainId !== ACTIVE_CHAIN.chainId) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: ACTIVE_CHAIN.chainId }],
        });
      } catch (e) {
        if (e.code === 4902 || e?.cause?.code === 4902) {
          const chainParams = { ...ACTIVE_CHAIN };
          if (!chainParams.blockExplorerUrls?.length)
            delete chainParams.blockExplorerUrls;
          await provider.request({
            method: "wallet_addEthereumChain",
            params: [chainParams],
          });
          await new Promise((r) => setTimeout(r, 800));
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: ACTIVE_CHAIN.chainId }],
          });
        } else throw e;
      }
    }

    const bp = new ethers.BrowserProvider(provider);
    const signer = await bp.getSigner();

    return {
      signer,
      tipJarWrite: new ethers.Contract(TIPJAR_ADDRESS, TIPJAR_ABI, signer),
      tokenWrite: new ethers.Contract(DEFAULT_TIP_TOKEN, ERC20_ABI, signer),
    };
  }, [connector]);

  // ── Прев'ю: скільки отримає автор / куди йде решта ──────────────

  /**
   * @returns { bps, tier, authorPct, poolPct } напр. { bps: 9000n, tier: "COUNCIL", authorPct: 90, poolPct: 10 }
   *          tier: "COUNCIL" (статус Консула) / "SHIELD" (статус Захисника) / "NONE"
   */
  const previewSplit = useCallback(
    async (authorAddress) => {
      _ensureRead();
      try {
        const [bps, tier] =
          await tipJarReadRef.current.previewSplit(authorAddress);
        const authorPct = Number(bps) / 100;
        return { bps, tier, authorPct, poolPct: 100 - authorPct };
      } catch (e) {
        console.warn("[previewSplit] failed:", e);
        return null;
      }
    },
    [_ensureRead],
  );

  // ── Прев'ю: скільки RIGHTS нарахується автору за цей донат ──────

  const previewRights = useCallback(
    async (amountHuman, tokenAddress) => {
      _ensureRead();
      try {
        const addr = tokenAddress || DEFAULT_TIP_TOKEN;
        const tokenRead = new ethers.Contract(
          addr,
          ERC20_ABI,
          new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]),
        );
        const decimals = Number(await tokenRead.decimals());
        const amount = ethers.parseUnits(String(amountHuman || "0"), decimals);
        const rightsAmount = await tipJarReadRef.current.previewRights(
          addr,
          amount,
        );
        // rightsAmount - звичайне ціле число (як currentRights() у
        // RightsRegistry), НЕ 18-decimal fixed-point.
        return Number(rightsAmount);
      } catch (e) {
        console.warn("[previewRights] failed:", e);
        return null;
      }
    },
    [_ensureRead],
  );

  // ── Інфо про токен (баланс/символ/мінімум) ──────────────────────

  const getTokenInfo = useCallback(
    async (userAddress, tokenAddress) => {
      _ensureRead();
      try {
        const addr = tokenAddress || DEFAULT_TIP_TOKEN;
        const tokenRead = new ethers.Contract(
          addr,
          ERC20_ABI,
          new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]),
        );
        const [balance, decimals, symbol, accepted, minAmount] =
          await Promise.all([
            userAddress
              ? tokenRead.balanceOf(userAddress)
              : Promise.resolve(0n),
            tokenRead.decimals(),
            tokenRead.symbol(),
            tipJarReadRef.current.acceptedTokens(addr),
            tipJarReadRef.current.minTipAmount(addr),
          ]);
        return {
          balance,
          balanceFormatted: ethers.formatUnits(balance, decimals),
          decimals: Number(decimals),
          symbol,
          accepted,
          minAmount,
          minAmountFormatted: ethers.formatUnits(minAmount, decimals),
        };
      } catch (e) {
        console.warn("[getTokenInfo] failed:", e);
        return null;
      }
    },
    [_ensureRead],
  );

  // ── Mint тестових токенів (тільки MockERC20/testnet) ───────────

  const mintTestTokens = useCallback(
    async (userAddress, amountHuman = "100", tokenAddress) => {
      _ensureRead();
      try {
        const { signer } = await _getWriteContracts();
        const addr = tokenAddress || DEFAULT_TIP_TOKEN;
        const tokenWrite = new ethers.Contract(addr, ERC20_ABI, signer);
        const decimals = Number(await tokenWrite.decimals());
        const amount = ethers.parseUnits(amountHuman, decimals);
        const tx = await tokenWrite.mint(userAddress, amount, GAS_OPTS);
        await tx.wait();
        return { success: true, txHash: tx.hash };
      } catch (err) {
        return { success: false, error: err?.reason || err.message };
      }
    },
    [_ensureRead, _getWriteContracts],
  );

  // ── Основна функція: tip ─────────────────────────────────────

  /**
   * @param authorAddress  post.author.wallet_address (адреса Lens Account автора)
   * @param amountHuman    сума у "людському" форматі, напр. "1.5"
   * @param lensPostId     post.lens_post_id / post.id (для postRef)
   */
  const sendTip = useCallback(
    async (authorAddress, amountHuman, lensPostId, tokenAddress) => {
      if (!authorAddress)
        return { success: false, error: "Адреса автора відсутня" };

      _ensureRead();
      setLoading(true);
      setError(null);
      setProgress("");

      try {
        const addr = tokenAddress || DEFAULT_TIP_TOKEN;
        const tokenContract = new ethers.Contract(
          addr,
          ERC20_ABI,
          new ethers.JsonRpcProvider(ACTIVE_CHAIN.rpcUrls[0]),
        );
        const decimals = Number(await tokenContract.decimals());
        const amount = ethers.parseUnits(String(amountHuman), decimals);

        // 1. Перевірка allowlist + dust-protection
        const [accepted, minAmount] = await Promise.all([
          tipJarReadRef.current.acceptedTokens(addr),
          tipJarReadRef.current.minTipAmount(addr),
        ]);
        if (!accepted) {
          return { success: false, error: "Цей токен не прийнятий TipJar" };
        }
        if (amount < minAmount) {
          const minHuman = ethers.formatUnits(minAmount, decimals);
          return {
            success: false,
            error: `Мінімальна сума tip-у: ${minHuman}`,
          };
        }

        // 2. Підключаємось до MetaMask (тільки тут запитується підпис)
        const { signer, tipJarWrite } = await _getWriteContracts();
        const tokenWrite = new ethers.Contract(addr, ERC20_ABI, signer);
        const owner = await signer.getAddress();

        if (owner.toLowerCase() === authorAddress.toLowerCase()) {
          return { success: false, error: "Не можна підтримати власний пост" };
        }

        // 3. Перевірка allowance, approve якщо потрібно
        const tokenReadAsOwner = new ethers.Contract(
          addr,
          ERC20_ABI,
          signer.provider,
        );
        const allowance = await tokenReadAsOwner.allowance(
          owner,
          TIPJAR_ADDRESS,
        );

        if (allowance < amount) {
          setProgress("Підтвердження витрати токенів (approve)...");
          const approveTx = await tokenWrite.approve(
            TIPJAR_ADDRESS,
            amount,
            GAS_OPTS,
          );
          const approveReceipt = await approveTx.wait();
          if (approveReceipt.status !== 1) {
            return { success: false, error: "approve_tx_failed" };
          }
        }

        // 4. postRef = keccak256(lensPostId) для офчейн-зв'язку
        const postRef = lensPostId
          ? ethers.id(String(lensPostId))
          : ethers.ZeroHash;

        // 5. Відправка tip
        // ⚠️ tip() пише в набагато більше storage-слотів, ніж mint()/approve()
        // (transferFrom + 2× transfer + кілька mapping-записів + 2 події),
        // тож статичний GAS_OPTS (900_000) тут систематично замалий на
        // zkSync-стеку через pubdata-вартість — реальна оцінка показала
        // ~1.72M газу. Тому тут оцінюємо газ динамічно з запасом, замість
        // фіксованого ліміту.
        setProgress("Оцінюємо газ...");
        let tipGasOpts = GAS_OPTS;
        try {
          const estimatedGas = await tipJarWrite.tip.estimateGas(
            authorAddress,
            addr,
            amount,
            postRef,
          );
          tipGasOpts = { gasLimit: (estimatedGas * 130n) / 100n }; // +30% запасу
        } catch (estimateErr) {
          console.warn(
            "[sendTip] estimateGas failed, fallback to static GAS_OPTS:",
            estimateErr,
          );
        }

        setProgress("Відправляємо tip...");
        const tx = await tipJarWrite.tip(
          authorAddress,
          addr,
          amount,
          postRef,
          tipGasOpts,
        );
        setProgress(`TX: ${tx.hash.slice(0, 20)}... чекаємо блок`);
        const receipt = await tx.wait();

        if (receipt.status === 1) {
          setProgress("✓ Tip відправлено!");
          return { success: true, txHash: tx.hash };
        }
        return { success: false, error: "tx_reverted" };
      } catch (err) {
        const msg = err?.reason || err?.info?.error?.message || err.message;
        setError(msg);
        return { success: false, error: msg };
      } finally {
        setLoading(false);
      }
    },
    [_ensureRead, _getWriteContracts],
  );

  // Backward-compat: новий useTipJar самодостатній, init не потрібен.
  // Залишено як no-op, щоб старі виклики tipJar.initTipJar(signer) не падали.
  const initTipJar = useCallback(() => {}, []);

  return {
    loading,
    progress,
    error,
    initTipJar,
    previewSplit,
    previewRights,
    getTokenInfo,
    mintTestTokens,
    sendTip,
    DEFAULT_TIP_TOKEN,
  };
}
