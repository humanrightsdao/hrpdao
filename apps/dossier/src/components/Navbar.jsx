// src/components/Navbar.jsx
import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { ethers } from "ethers";
import { Bot, Search, X, FileText } from "lucide-react";
import AIAssistant from "./AIAssistant";
import useUserInfo from "../hooks/useUserInfo";
import { CONTRACTS, ACTIVE_CHAIN } from "../hooks/useLensDAO";

// Minimal read-only ABI - only what's actually needed here.
const POLICY_READ_ABI = ["function policyURI() external view returns (string)"];

// The on-chain policyURI is stored as "ipfs://<CID>" (a protocol, not an
// http link) - we convert it into a clickable gateway link.
//
// FIXED: previously this pointed at "<cid>.ipfs.inbrowser.link", which is
// Brave's internal service-worker IPFS gateway - it only resolves inside
// the Brave browser itself (and Brave deprecated its native IPFS node
// support in 2024), so the link was dead for every visitor not using
// Brave. Switched to ipfs.io, a public gateway that works in any browser,
// with dweb.link as a fallback if the primary gateway is slow/down.
const IPFS_GATEWAYS = [
  (cid) => `https://ipfs.io/ipfs/${cid}`,
  (cid) => `https://dweb.link/ipfs/${cid}`,
];

function ipfsUriToGatewayLink(ipfsUri) {
  if (!ipfsUri || !ipfsUri.startsWith("ipfs://")) return ipfsUri || null;
  const cid = ipfsUri.replace("ipfs://", "");
  return IPFS_GATEWAYS[0](cid);
}

// "inline"  = Variant A — icon expands into an inline input (current)
// "palette" = Variant B — icon opens a ⌘K-style command palette modal (future)
const SEARCH_MODE = "inline";

const Navbar = () => {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { userInfo } = useUserInfo();
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [showAI, setShowAI] = useState(false);
  const [policyLink, setPolicyLink] = useState(null);
  const searchInputRef = useRef(null);
  const mobileSearchInputRef = useRef(null);
  const searchContainerRef = useRef(null);
  const mobileSearchRowRef = useRef(null);

  // Below the `lg` breakpoint (1024px, matches the "hidden lg:block" used
  // elsewhere for desktop-only chrome) the AI modal renders fullscreen
  // instead of as a centered overlay — mirrors what used to be a separate
  // "mobile top panel" duplicated in Layout.jsx.
  const [isMobileViewport, setIsMobileViewport] = useState(
    typeof window !== "undefined" ? window.innerWidth < 1024 : false,
  );
  useEffect(() => {
    const handleResize = () => setIsMobileViewport(window.innerWidth < 1024);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Reads the CURRENT (ratified, on-chain) URI of the Human Rights Policy
  // — read-only, WITHOUT a wallet connection (works for any visitor).
  // Updates automatically right after any setPolicy() proposal's
  // execute() succeeds — no manual link editing is needed anymore.
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
        console.warn("[Navbar] failed to load policyURI:", e);
      }
    }
    loadPolicyLink();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSearch = (e) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setSearchQuery("");
      setIsSearchOpen(false);
    }
  };

  // Toggles the inline search field (Variant A) — clicking the icon while
  // open with text typed also submits, matching common Web3 nav patterns
  const handleSearchIconClick = () => {
    if (isSearchOpen && searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery.trim())}`);
      setSearchQuery("");
      setIsSearchOpen(false);
      return;
    }
    setIsSearchOpen((prev) => !prev);
  };

  // Auto-focus input when it expands open — desktop uses the inline field,
  // mobile uses the separate full-width row rendered below the navbar
  useEffect(() => {
    if (!isSearchOpen) return;
    const ref = isMobileViewport ? mobileSearchInputRef : searchInputRef;
    if (ref.current) ref.current.focus();
  }, [isSearchOpen, isMobileViewport]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!isSearchOpen) return;

    const handleClickOutside = (e) => {
      const insideDesktopForm =
        searchContainerRef.current &&
        searchContainerRef.current.contains(e.target);
      const insideMobileRow =
        mobileSearchRowRef.current &&
        mobileSearchRowRef.current.contains(e.target);
      if (!insideDesktopForm && !insideMobileRow) {
        setIsSearchOpen(false);
      }
    };
    const handleEscape = (e) => {
      if (e.key === "Escape") setIsSearchOpen(false);
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isSearchOpen]);

  const handleDocumentClick = () => {
    if (!policyLink) {
      // In case the chain hasn't responded yet (slow network) or the
      // read-only call failed for some reason.
      alert(
        t("policy_link_loading") ||
          "The policy link is still loading, please try again in a moment.",
      );
      return;
    }
    window.open(policyLink, "_blank");
  };

  const handleAIClick = () => {
    setShowAI(true);
  };

  const handleLogoClick = () => {
    // FIXED: previously this checked the local userProfile, which was
    // only populated via supabase.auth.getUser() — no such session
    // exists in a Lens app, so userProfile was always null, and clicking
    // the logo for already-logged-in users always went to "/" instead of
    // "/country". userInfo (from useUserInfo, already present in this
    // component) correctly reflects the state of the Lens session.
    navigate(userInfo ? "/country" : "/");
  };

  // Tooltip text for user stats
  return (
    <>
      <nav className="sticky top-0 z-50 bg-white dark:bg-[#00091c] border-b border-slate-200 dark:border-white/[0.06] transition-colors duration-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            {/* Left part: Logo and name */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleLogoClick}
                className="flex items-center gap-2.5 hover:opacity-80 transition-opacity"
              >
                <div className="flex-shrink-0">
                  <picture>
                    <source srcSet="/logo.webp" type="image/webp" />
                    <img
                      src="/logo.png"
                      alt="Dossier"
                      width="669"
                      height="800"
                      loading="lazy"
                      className="h-12 w-auto object-contain"
                    />
                  </picture>
                </div>
                {/* Desktop: full name + subtitle, stacked */}
                <div className="hidden md:flex flex-col leading-tight">
                  <span className="font-cinzel text-[20px] font-bold text-[#0f0906] dark:text-[#f5ead6] tracking-wide">
                    Dossier
                  </span>
                  <span className="text-[10px] font-semibold text-slate-600 dark:text-white/30 tracking-[0.12em] uppercase">
                    from HRP DAO
                  </span>
                </div>
                {/* Mobile: short form only */}
                <span className="md:hidden font-cinzel text-base font-bold text-[#0f0906] dark:text-[#f5ead6]">
                  Dossier
                </span>
              </button>
            </div>

            {/* Spacer pushes the right icon group (incl. search) to the end */}
            <div className="flex-1" />

            {/* Right part: Icons */}
            <div className="flex items-center gap-3">
              {/*
                SEARCH_MODE: "inline" (Variant A — current) | "palette" (Variant B — future ⌘K modal)
                To migrate to Variant B later:
                  1. Switch SEARCH_MODE constant to "palette"
                  2. Render <CommandPalette isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
                     instead of the inline expanding input below
                  3. The trigger button (icon + ⌘K hint) and isSearchOpen state are already shared
                     between both modes, so no changes needed there.
              */}
              {SEARCH_MODE === "inline" ? (
                <form
                  onSubmit={handleSearch}
                  ref={searchContainerRef}
                  className="flex items-center"
                >
                  <div
                    className={`flex items-center bg-slate-100 dark:bg-white/[0.04] border rounded-lg overflow-hidden
                    transition-all duration-200 h-10
                    ${isSearchOpen && !isMobileViewport ? "w-32 sm:w-48 border-[#b41e3c]/40 ring-1 ring-[#b41e3c]/20 px-2 mr-1.5" : "w-0 border-transparent px-0 mr-0"}
                    `}
                  >
                    <input
                      ref={searchInputRef}
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder={t("search_placeholder")}
                      tabIndex={isSearchOpen && !isMobileViewport ? 0 : -1}
                      className="w-full bg-transparent text-slate-800 dark:text-white/60 placeholder-slate-400 dark:placeholder-white/20
                        text-xs focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleSearchIconClick}
                    className={`w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-lg
                       bg-slate-100 dark:bg-white/[0.03]
                      hover:bg-slate-200 dark:hover:bg-white/[0.07] text-slate-600 dark:text-white/50 hover:text-slate-800 dark:hover:text-white/80
                      transition-colors duration-150 ${
                        isSearchOpen
                          ? "bg-[#2B000A] border-[#b41e3c]/30 text-[#e8a0b0]"
                          : ""
                      }`}
                    title={t("search") || "Search"}
                  >
                    <Search className="w-5 h-5" />
                  </button>
                </form>
              ) : (
                /* Variant B placeholder — wire up CommandPalette here when migrating */
                <button
                  type="button"
                  onClick={() => setIsSearchOpen(true)}
                  className="w-10 h-10 flex items-center justify-center rounded-lg
                    border border-white/[0.07] bg-slate-100 dark:bg-white/[0.03]
                    hover:bg-slate-200 dark:hover:bg-white/[0.07] text-slate-600 dark:text-white/50 hover:text-slate-800 dark:hover:text-white/80
                    transition-colors duration-150"
                  title={`${t("search_placeholder")} (⌘K)`}
                >
                  <Search className="w-5 h-5" />
                </button>
              )}

              {/* Nostr Chat — replaces the old XMTP "Messages" button
                  that used to live here before XMTP was removed. */}
              <button
                onClick={() => navigate("/nostr-chat")}
                className={`w-10 h-10 flex items-center justify-center rounded-lg
                   bg-slate-100 dark:bg-white/[0.03]
                  hover:bg-slate-200 dark:hover:bg-white/[0.07] text-slate-600 dark:text-white/50 hover:text-slate-800 dark:hover:text-white/80
                  transition-colors duration-150 ${
                    location.pathname.startsWith("/nostr-chat")
                      ? "bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]"
                      : ""
                  }`}
                title={t("nostr_chat") || "Nostr Chat"}
              >
                <svg
                  className="w-5 h-5"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  />
                </svg>
              </button>

              {/* AI */}
              <button
                onClick={handleAIClick}
                className={`w-10 h-10 flex items-center justify-center rounded-lg
                  bg-slate-100 dark:bg-white/[0.03]
                  hover:bg-slate-200 dark:hover:bg-white/[0.07] text-slate-600 dark:text-white/50 hover:text-slate-800 dark:hover:text-white/80
                  transition-colors duration-150 ${
                    showAI
                      ? "bg-[#2B000A] border border-[#b41e3c]/30 text-[#e8a0b0]"
                      : ""
                  }`}
                title={t("ai_assistant")}
              >
                <div className="w-6 h-6 flex items-center justify-center overflow-hidden rounded-full">
                  <img
                    src="/atticus.png"
                    alt="AI Assistant"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.target.style.display = "none";
                      e.target.parentNode.innerHTML = '<Bot class="w-4 h-4" />';
                    }}
                  />
                </div>
              </button>

              {/* Document */}
              <button
                onClick={handleDocumentClick}
                className="w-10 h-10 flex items-center justify-center rounded-lg
                   bg-slate-100 dark:bg-white/[0.03]
                  hover:bg-slate-200 dark:hover:bg-white/[0.07] text-slate-600 dark:text-white/50 hover:text-slate-800 dark:hover:text-white/80
                  transition-colors duration-150"
                title={t("view_document")}
              >
                <FileText className="w-5 h-5" />
              </button>

              {/* Hexagon-shaped avatar — desktop only; mobile already has profile in the bottom menu */}
              <button
                onClick={() => navigate("/profile")}
                className="hidden lg:flex relative w-[43px] h-[48px] flex-shrink-0 p-[1.5px] clip-path-hexagon
                  bg-gradient-to-br from-[#e8a0b0] to-[#2B000A]"
              >
                <div className="relative w-full h-full overflow-hidden bg-[#0d0415] clip-path-hexagon">
                  {userInfo?.avatarUrl ? (
                    <img
                      src={userInfo.avatarUrl}
                      alt={userInfo?.uniqueName || t("user")}
                      className="w-full h-full object-cover"
                      onError={(e) => {
                        e.target.style.display = "none";
                        if (e.target.parentElement) {
                          const fallbackDiv =
                            e.target.parentElement.querySelector(
                              ".avatar-fallback",
                            );
                          if (fallbackDiv) fallbackDiv.style.display = "flex";
                        }
                      }}
                    />
                  ) : null}
                  <div
                    className={`
                      avatar-fallback w-full h-full flex items-center justify-center
                      font-cinzel text-[15px] text-[#c8b8a2] bg-[#0d0415]
                      ${userInfo?.avatarUrl ? "hidden" : "flex"}
                    `}
                  >
                    {userInfo?.uniqueName?.[0]?.toUpperCase() ||
                      userInfo?.email?.[0]?.toUpperCase() ||
                      "U"}
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Mobile search row — opens below the navbar instead of expanding
              inline, since there isn't enough horizontal room next to the
              logo and 3-4 icon buttons on narrow screens */}
          {isSearchOpen && isMobileViewport && (
            <div
              ref={mobileSearchRowRef}
              className="lg:hidden px-4 pb-3"
            >
              <form onSubmit={handleSearch} className="w-full">
                <div className="flex items-center h-10 px-3 bg-slate-100 dark:bg-white/[0.04] border border-[#b41e3c]/40 ring-1 ring-[#b41e3c]/20 rounded-lg">
                  <Search className="w-5 h-5 flex-shrink-0 text-slate-400 dark:text-white/30" />
                  <input
                    ref={mobileSearchInputRef}
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t("search_placeholder")}
                    className="w-full ml-2 bg-transparent text-slate-800 dark:text-white/60 placeholder-slate-400 dark:placeholder-white/20
                      text-sm focus:outline-none"
                  />
                  <button
                    type="submit"
                    className="flex-shrink-0 ml-2 text-slate-500 dark:text-white/50 hover:text-[#8B1A2A] dark:hover:text-[#e8a0b0] transition-colors duration-150"
                  >
                    <Search className="w-5 h-5" />
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      </nav>

      {/* AI Assistant modal window — fullscreen on mobile, centered overlay on desktop */}
      {showAI && (
        <div className="fixed inset-0 z-[100] flex items-start justify-center pt-0 lg:pt-4 pb-0 lg:pb-20 bg-black/50 backdrop-blur-sm overflow-y-auto">
          <div className="relative w-full h-full lg:h-auto lg:max-w-5xl lg:mx-4">
            <div className="bg-white dark:bg-gray-900 shadow-2xl overflow-hidden border border-gray-200 dark:border-gray-700 h-full lg:h-auto lg:rounded-2xl">
              <AIAssistant
                onClose={() => setShowAI(false)}
                isFullPage={isMobileViewport}
              />
            </div>
            <button
              onClick={() => setShowAI(false)}
              className="lg:hidden absolute top-4 right-4 p-2 bg-white/10 dark:bg-gray-800/50 backdrop-blur-sm rounded-full hover:bg-white/20 dark:hover:bg-gray-700/50 transition-colors duration-200"
              title={t("close") || "Close"}
            >
              <X className="w-5 h-5 text-white" />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default Navbar;