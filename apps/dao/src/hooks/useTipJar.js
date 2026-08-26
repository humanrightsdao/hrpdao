// src/hooks/useTipJar.js
//
// A self-contained hook for "tipping" (financially supporting) post
// authors. Does NOT require a prior dao.connect() — previewSplit/
// getTokenInfo work over a public RPC; sendTip requests MetaMask
// itself when needed.
//
// The split depends on the author's SBT status (determined on-chain by the TipJar contract):
//   COUNCIL status → 90% to the author / 10% to the Support Pool (Treasury)
//   SHIELD  status → 80% to the author / 20% to the Support Pool (Treasury)
//   no SBT         → 50% to the author / 50% to the Support Pool (per the tokenomics)
//
// ⚠️ The Support Pool is a separate Treasury contract (a protected
// treasury with withdrawal limits/allowlist), NOT DaoTimelock directly.
//
// Every tip ALSO credits the author with Influence in
// InfluenceRegistry (for the full donation amount, $1 = 1
// Influence) — this is the ONLY source of Influence in the
// system. Influence is a plain integer (like currentInfluence()
// in InfluenceRegistry), NOT an 18-decimal fixed-point value —
// previewRights() below returns a Number directly.
//
// ⚠️ CHANGE: this deployment has ONLY ONE test token (tUSD, 6 decimals)
// — not two (tGHO+tUSDC) as in the previous version. DEFAULT_TIP_TOKEN
// points to it. If the DAO later adds a second token via
// TipJar.setAcceptedToken(), it's enough to add its address to .env —
// the code below doesn't hardcode the number of tokens.

import { useState, useCallback, useRef } from "react";
import { ethers } from "ethers";
import { useAccount } from "wagmi";
import { ACTIVE_CHAIN } from "./useDao";

// ─────────────────────────────────────────────────────────────
//  Contract configuration
// ─────────────────────────────────────────────────────────────

const TIPJAR_ADDRESS =
  import.meta.env.VITE_TIP_JAR || "0x0000000000000000000000000000000000000006";
const TEST_TOKEN_USD =
  import.meta.env.VITE_TEST_TOKEN_USD ||
  "0x0000000000000000000000000000000000000007";

// On testnet we use MockERC20 (tUSD). On mainnet, a real token accepted
// via governance (TipJar.setAcceptedToken()).
export const DEFAULT_TIP_TOKEN = TEST_TOKEN_USD;

// ⚠️ 300_000 turned out to be too little on this network — "Bootloader-based
// tx failed" on mint() due to L2 pubdata cost (the zkSync stack charges
// gas not just for execution but also for publishing data to L1, which
// EVM tooling often underestimates). Raised with headroom; only the gas
// actually consumed is charged, not the whole limit.
const GAS_OPTS = { gasLimit: 900_000n };

// ─────────────────────────────────────────────────────────────
//  ABIs
// ─────────────────────────────────────────────────────────────

const TIPJAR_ABI = [
  "function tip(address author, address token, uint256 amount, bytes32 postRef) external",
  "function acceptedTokens(address token) external view returns (bool)",
  "function minTipAmount(address token) external view returns (uint256)",
  "function previewSplit(address author) external view returns (uint256 bps, string memory tier)",
  "function previewInfluence(address token, uint256 amount) external view returns (uint256)",
  "event TipSent(address indexed from, address indexed author, address indexed token, uint256 receivedAmount, uint256 authorAmount, uint256 poolAmount, uint256 influenceAwarded, bytes32 postRef)",
];

const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function mint(address to, uint256 amount) external", // MockERC20 only (testnet)
];

// ─────────────────────────────────────────────────────────────
//  Hook
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
  // failed immediately with "MetaMask not found". `connector` (the
  // active wagmi connector, works for injected OR WalletConnect) is
  // obtained here so _getWriteContracts below can get an EIP-1193
  // provider from it that works for either connection method.
  const { connector } = useAccount();

  // ── Lazy initialization of read-only contracts (no MetaMask) ───

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

  // ── Lazy write access via the wallet (only when actually needed) ──

  const _getWriteContracts = useCallback(async () => {
    // FIXED: previously `if (!window.ethereum) throw ...`, then every
    // request went through window.ethereum.request(...) directly. Now
    // we get the EIP-1193 provider from the active wagmi connector —
    // connector.getProvider() works uniformly whether the user is
    // using Privy's embedded wallet or a wallet linked THROUGH Privy
    // (desktop extension or WalletConnect/mobile) — it's never
    // window.ethereum specifically.
    // REMOVED the `: window.ethereum` fallback (same issue already
    // fixed in dossier's useTipJar.js) — it was an independent,
    // non-Privy connection path: if `connector` wasn't populated yet
    // (e.g. a race right after a reload), it silently reached for the
    // raw browser-extension API instead of the wallet Privy actually
    // manages, opening a second, unrelated MetaMask permission prompt.
    // There's only one connection now (Privy/wagmi) — if it isn't
    // ready yet, that's a real "not connected" state.
    if (!connector) throw new Error("Wallet not connected");
    const provider = await connector.getProvider();
    if (!provider) throw new Error("Wallet not connected");

    await provider.request({ method: "eth_requestAccounts" });

    // Network check
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

  // ── Preview: how much the author receives / where the rest goes ──

  /**
   * @returns { bps, tier, authorPct, poolPct } e.g. { bps: 9000n, tier: "COUNCIL", authorPct: 90, poolPct: 10 }
   *          tier: "COUNCIL" (Council status) / "SHIELD" (Shield status) / "NONE"
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

  // ── Preview: how much Influence the author earns for this donation ──

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
        const rightsAmount = await tipJarReadRef.current.previewInfluence(
          addr,
          amount,
        );
        // rightsAmount is a plain integer (like currentInfluence() in
        // InfluenceRegistry), NOT an 18-decimal fixed-point value.
        return Number(rightsAmount);
      } catch (e) {
        console.warn("[previewRights] failed:", e);
        return null;
      }
    },
    [_ensureRead],
  );

  // ── Token info (balance/symbol/minimum) ──────────────────────────

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

  // ── Mint test tokens (MockERC20/testnet only) ───────────────────

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

  // ── Main function: tip ────────────────────────────────────────

  /**
   * @param authorAddress  post.author.wallet_address (the author's Lens Account address)
   * @param amountHuman    the amount in "human" format, e.g. "1.5"
   * @param lensPostId     post.lens_post_id / post.id (for postRef)
   */
  const sendTip = useCallback(
    async (authorAddress, amountHuman, lensPostId, tokenAddress) => {
      if (!authorAddress)
        return { success: false, error: "Author address missing" };

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

        // 1. Check the allowlist + dust protection
        const [accepted, minAmount] = await Promise.all([
          tipJarReadRef.current.acceptedTokens(addr),
          tipJarReadRef.current.minTipAmount(addr),
        ]);
        if (!accepted) {
          return { success: false, error: "This token isn't accepted by TipJar" };
        }
        if (amount < minAmount) {
          const minHuman = ethers.formatUnits(minAmount, decimals);
          return {
            success: false,
            error: `Minimum tip amount: ${minHuman}`,
          };
        }

        // 2. Connect to MetaMask (this is the only place a signature is requested)
        const { signer, tipJarWrite } = await _getWriteContracts();
        const tokenWrite = new ethers.Contract(addr, ERC20_ABI, signer);
        const owner = await signer.getAddress();

        if (owner.toLowerCase() === authorAddress.toLowerCase()) {
          return { success: false, error: "Cannot tip your own post" };
        }

        // 3. Check allowance, approve if needed
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
          setProgress("Confirming token spend (approve)...");
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

        // 4. postRef = keccak256(lensPostId) for the off-chain link
        const postRef = lensPostId
          ? ethers.id(String(lensPostId))
          : ethers.ZeroHash;

        // 5. Send the tip
        // ⚠️ tip() writes to far more storage slots than mint()/approve()
        // (transferFrom + 2× transfer + several mapping writes + 2 events),
        // so the static GAS_OPTS (900_000) is systematically too low on
        // the zkSync stack due to pubdata cost — a real estimate showed
        // ~1.72M gas. So here we estimate gas dynamically with headroom,
        // instead of a fixed limit.
        setProgress("Estimating gas...");
        let tipGasOpts = GAS_OPTS;
        try {
          const estimatedGas = await tipJarWrite.tip.estimateGas(
            authorAddress,
            addr,
            amount,
            postRef,
          );
          tipGasOpts = { gasLimit: (estimatedGas * 130n) / 100n }; // +30% headroom
        } catch (estimateErr) {
          console.warn(
            "[sendTip] estimateGas failed, fallback to static GAS_OPTS:",
            estimateErr,
          );
        }

        setProgress("Sending tip...");
        const tx = await tipJarWrite.tip(
          authorAddress,
          addr,
          amount,
          postRef,
          tipGasOpts,
        );
        setProgress(`TX: ${tx.hash.slice(0, 20)}... waiting for block`);
        const receipt = await tx.wait();

        if (receipt.status === 1) {
          setProgress("✓ Tip sent!");
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

  // Backward-compat: the new useTipJar is self-contained, no init needed.
  // Kept as a no-op so old calls to tipJar.initTipJar(signer) don't break.
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
