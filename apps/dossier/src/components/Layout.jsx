// src/components/Layout.jsx
import { useState, useEffect, useRef } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Menu,
  X,
  Sparkles,
  Wallet,
  Plus,
  MoreVertical,
  Home,
  Users,
  MessageSquare,
  Bell,
  User,
  Settings,
  Wrench,
} from "lucide-react";
import Sidebar from "./Sidebar";
import RightSidebar from "./RightSidebar";
import Navbar from "./Navbar";

export default function Layout({
  children,
  userProfile,
  walletAddress,
  onLogout,
  loading = false,
  error = null,
  onCreatePost,
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const sidebarRef = useRef(null);
  const rightSidebarRef = useRef(null);
  const contentRef = useRef(null);
  const scrollProxyRef = useRef(null);

  // Mobile menu state
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileRightMenuOpen, setIsMobileRightMenuOpen] = useState(false);
  const [isWalletConnected, setIsWalletConnected] = useState(false);
  const [isMobileMenuExpanded, setIsMobileMenuExpanded] = useState(false);
  const [showMobileNav, setShowMobileNav] = useState(true);
  const lastScrollYRef = useRef(0);
  const [screenWidth, setScreenWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1024,
  );

  // Sync right-edge scroll proxy with central content (desktop only)
  useEffect(() => {
    const content = contentRef.current;
    const proxy = scrollProxyRef.current;
    if (!content || !proxy) return;

    const inner = proxy.querySelector(".scroll-proxy-inner");

    const updateInnerHeight = () => {
      if (inner) inner.style.height = content.scrollHeight + "px";
    };
    updateInnerHeight();

    const ro = new ResizeObserver(updateInnerHeight);
    ro.observe(content);
    // Also watch children mutations (lazy-loaded content)
    const mo = new MutationObserver(updateInnerHeight);
    mo.observe(content, { childList: true, subtree: true });

    // Proxy scrollbar drag → scroll content
    const onProxyScroll = () => {
      if (proxy._scrollingFromContent) return;
      proxy._scrollingFromProxy = true;
      content.scrollTop = proxy.scrollTop;
      proxy._scrollingFromProxy = false;
    };

    // Content scroll (wheel / touch / programmatic) → move proxy thumb
    const onContentScroll = () => {
      if (proxy._scrollingFromProxy) return;
      proxy._scrollingFromContent = true;
      proxy.scrollTop = content.scrollTop;
      proxy._scrollingFromContent = false;
    };

    // Intercept wheel over central area → scroll content, not the page
    const onContentWheel = (e) => {
      e.preventDefault();
      content.scrollTop += e.deltaY;
    };

    proxy.addEventListener("scroll", onProxyScroll);
    content.addEventListener("scroll", onContentScroll);
    content.addEventListener("wheel", onContentWheel, { passive: false });

    return () => {
      proxy.removeEventListener("scroll", onProxyScroll);
      content.removeEventListener("scroll", onContentScroll);
      content.removeEventListener("wheel", onContentWheel);
      ro.disconnect();
      mo.disconnect();
    };
  }, []);

  // Check wallet connection
  useEffect(() => {
    const walletAddr = localStorage.getItem("web3_wallet_address");
    if (walletAddr) {
      setIsWalletConnected(true);
    }
  }, []);

  // Hide mobile top/bottom bars on scroll-down, reveal on scroll-up (mobile only)
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    const handleScroll = () => {
      const currentY = content.scrollTop;
      const lastY = lastScrollYRef.current;
      const delta = currentY - lastY;

      if (currentY < 40) {
        // Always show near the very top of the feed
        setShowMobileNav(true);
      } else if (Math.abs(delta) > 6) {
        // Scrolling down -> hide, scrolling up -> show
        setShowMobileNav(delta < 0);
        if (delta > 0) setIsMobileMenuExpanded(false);
      }

      lastScrollYRef.current = currentY;
    };

    content.addEventListener("scroll", handleScroll, { passive: true });
    return () => content.removeEventListener("scroll", handleScroll);
  }, []);

  // Track screen size change
  useEffect(() => {
    const handleResize = () => {
      setScreenWidth(window.innerWidth);
      // Collapse menu when resizing to larger
      if (window.innerWidth >= 768) {
        setIsMobileMenuExpanded(false);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Determine active menu based on current URL
  const getActiveMenuFromPath = () => {
    const path = location.pathname;
    if (path.includes("/settings")) return "settings";
    if (path.includes("/country")) return "country";
    if (path.includes("/profile")) return "profile";
    if (path.includes("/support")) return "support";
    if (path.includes("/violations") && !path.includes("/violations-map"))
      return "violations";
    if (path.includes("/governance")) return "governance";
    if (path.includes("/notifications")) return "notifications";
    return "country";
  };

  const [activeMenu, setActiveMenu] = useState(getActiveMenuFromPath());
  const [activeRightMenu, setActiveRightMenu] = useState("");

  // Update activeMenu when path changes
  useEffect(() => {
    setActiveMenu(getActiveMenuFromPath());
  }, [location.pathname]);

  // Close mobile menus when route changes
  useEffect(() => {
    setIsMobileMenuOpen(false);
    setIsMobileRightMenuOpen(false);
  }, [location.pathname]);

  const handleMenuClick = (menuItem) => {
    setActiveMenu(menuItem);
    setIsMobileMenuOpen(false);

    const routeMap = {
      country: "/country",
      settings: "/settings",
      support: "/support",
      violations: "/violations-list",
      governance: "/governance",
      profile: "/profile",
      notifications: "/notifications",
    };

    if (routeMap[menuItem]) {
      navigate(routeMap[menuItem]);
    } else {
      alert(t("page_in_development", { page: t(`menu_${menuItem}`) }));
    }
  };

  const handleRightMenuClick = (menuItem) => {
    setActiveRightMenu(menuItem);
    setIsMobileRightMenuOpen(false);

    const rightRouteMap = {
      violations: "/violations-list",
      support: "/support",
      newViolation: "/violations",
      governance: "/governance",
    };

    if (rightRouteMap[menuItem]) {
      navigate(rightRouteMap[menuItem]);
    } else {
      alert(`${t("page_in_development", { page: t(menuItem) })}`);
    }
  };

  const formatWalletAddress = (address) => {
    if (!address) return "";
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const handleWalletClick = () => {
    if (isWalletConnected) {
      const walletAddr = localStorage.getItem("web3_wallet_address");
      alert(`${t("wallet_connected")}: ${formatWalletAddress(walletAddr)}`);
    } else {
      navigate("/connect-wallet");
    }
  };

  const sidebarProps = {
    activeMenu,
    handleMenuClick,
    onCreatePost,
  };

  const mobileMenuItems = [
    {
      key: "country",
      label: t("menu_country"),
      icon: <Home className="w-5 h-5" />,
      priority: 1,
    },
    {
      key: "create",
      label: t("create_post"),
      icon: <Plus className="w-5 h-5" />,
      priority: 1,
      special: true,
    },
    {
      key: "support",
      label: t("menu_support"),
      icon: <Users className="w-5 h-5" />,
      priority: 2,
    },
    {
      key: "violations",
      label: t("menu_violations"),
      icon: <MessageSquare className="w-5 h-5" />,
      priority: 2,
    },
    {
      key: "governance",
      label: t("menu_governance"),
      icon: <Wrench className="w-5 h-5" />,
      priority: 2,
    },
    {
      key: "notifications",
      label: t("menu_notifications"),
      icon: <Bell className="w-5 h-5" />,
      priority: 3,
    },
    {
      key: "profile",
      label: t("menu_profile"),
      icon: <User className="w-5 h-5" />,
      priority: 3,
    },
    {
      key: "settings",
      label: t("menu_settings"),
      icon: <Settings className="w-5 h-5" />,
      priority: 3,
    },
  ];

  const getVisibleItemsCount = () => {
    if (screenWidth < 360) return 3;
    if (screenWidth < 420) return 4;
    if (screenWidth < 480) return 5;
    return 6;
  };

  const visibleItemsCount = getVisibleItemsCount();
  const hasHiddenItems = mobileMenuItems.length > visibleItemsCount;

  const visibleItems = mobileMenuItems.slice(0, visibleItemsCount);
  const hiddenItems = hasHiddenItems
    ? mobileMenuItems.slice(visibleItemsCount)
    : [];

  const handleMobileMenuItemClick = (item) => {
    if (item.key === "create" && onCreatePost) {
      onCreatePost();
      setIsMobileMenuExpanded(false);
      return;
    }

    if (item.type === "right") {
      handleRightMenuClick(item.key);
    } else {
      handleMenuClick(item.key);
    }
    setIsMobileMenuExpanded(false);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-blue-100 dark:from-gray-900 dark:to-gray-800">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-600 dark:border-blue-400"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-300">
            {t("loading_profile")}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-blue-100 dark:from-gray-900 dark:to-gray-800 p-4">
        <div className="max-w-md w-full bg-white dark:bg-gray-800 p-8 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700">
          <div className="text-center">
            <div className="w-16 h-16 bg-red-100 dark:bg-red-900/20 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-red-600 dark:text-red-400"
                fill="currentColor"
                viewBox="0 0 20 20"
              >
                <path
                  fillRule="evenodd"
                  d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              {t("error")}
            </h2>
            <p className="text-gray-600 dark:text-gray-300 mb-6">{error}</p>
            <button
              onClick={() => navigate("/")}
              className="w-full py-3 px-4 bg-gradient-to-r from-blue-600 to-blue-700 dark:from-blue-700 dark:to-blue-800 text-white rounded-xl font-medium hover:from-blue-700 hover:to-blue-800 dark:hover:from-blue-600 dark:hover:to-blue-700 transition-all duration-200"
            >
              {t("back_to_home")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!userProfile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-100 to-blue-100 dark:from-gray-900 dark:to-gray-800">
        <div className="text-center">
          <p className="text-gray-600 dark:text-gray-300">
            {t("profile_not_found_short")}
          </p>
          <button
            onClick={() => navigate("/create-lens-account")}
            className="w-full px-3 py-2.5
                      bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
                      dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3d0012]
                      rounded-xl text-base font-medium flex items-center justify-center gap-3
                      transition-colors"
          >
            {t("complete_registration") || "Complete registration"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800">
      {/* Navbar — renders responsively for both mobile and desktop */}
      <Navbar visible={showMobileNav} />


      {/* Container */}
      <div className="p-0 lg:p-4">
        <div className="max-w-7xl xl:max-w-[88rem] 2xl:max-w-[104rem] mx-auto">
          <div className="flex flex-col lg:flex-row gap-0 min-h-[calc(100vh-8rem)]">
            {/* Mobile menu */}
            {isMobileMenuOpen && (
              <div className="lg:hidden fixed inset-0 z-40 bg-black/50">
                <div className="fixed inset-y-0 left-0 w-64 bg-white dark:bg-[#0d0415] shadow-2xl overflow-y-auto">
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-6">
                      <h2 className="text-lg font-semibold text-gray-900 dark:text-white/90">
                        {t("menu")}
                      </h2>
                      <button
                        onClick={() => setIsMobileMenuOpen(false)}
                        className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-white/[0.06] text-gray-500 dark:text-white/40 hover:text-[#8B1A2A] dark:hover:text-[#e8a0b0] transition-colors"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>
                    <Sidebar {...sidebarProps} />
                  </div>
                </div>
              </div>
            )}

            {/* Left sidebar for desktop — fixed width, doesn't grow with viewport */}
            <div className="hidden lg:block lg:w-64 flex-shrink-0 order-2 lg:order-1 relative">
              <div
                ref={sidebarRef}
                className="h-full sticky top-4 sidebar-scroll custom-scrollbar"
                style={{
                  maxHeight: "calc(100vh - 8rem)",
                  height: "calc(100vh - 8rem)",
                }}
              >
                <Sidebar {...sidebarProps} />
              </div>
            </div>

            {/* Central content */}
            <div className="flex-1 order-1 lg:order-2 relative min-h-[calc(100vh-8rem)]">
              <div className="hidden lg:block absolute top-0 left-3 bottom-0 w-px bg-gradient-to-b from-transparent via-blue-900 dark:via-gray-700 to-transparent"></div>
              <div className="hidden lg:block absolute top-0 right-3 bottom-0 w-px bg-gradient-to-b from-transparent via-blue-900 dark:via-gray-700 to-transparent"></div>

              <div
                ref={contentRef}
                className="h-full content-scroll smooth-scroll overflow-y-auto hide-scrollbar"
                style={{
                  height: "calc(100vh - 8rem)",
                  paddingBottom: "5rem",
                }}
              >
                <div className="px-0 pt-2 lg:px-6 lg:pt-3 xl:px-8 pb-20 lg:pb-6">
                  {children}
                </div>
              </div>
            </div>

            {/* Right sidebar for desktop — fixed width, doesn't grow with viewport */}
            <div className="hidden lg:block lg:w-64 flex-shrink-0 order-3 relative">
              <div
                ref={rightSidebarRef}
                className="h-full sticky top-4 sidebar-scroll custom-scrollbar"
                style={{
                  maxHeight: "calc(100vh - 8rem)",
                  height: "calc(100vh - 8rem)",
                }}
              >
                <RightSidebar
                  activeRightMenu={activeRightMenu}
                  onRightMenuClick={handleRightMenuClick}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile bottom menu - ОДНАКОВІ РОЗМІРИ НА ВСІХ ЕКРАНАХ */}
      <div
        className={`lg:hidden fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-[#00091c] backdrop-blur-md border-t border-gray-200 dark:border-white/[0.06] transition-transform duration-300 ease-in-out ${
          showMobileNav ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="px-1 py-1.5">
          <div className="flex justify-around items-center">
            {visibleItems.map((item) => {
              const isActive =
                item.type === "right"
                  ? activeRightMenu === item.key
                  : activeMenu === item.key;
              const isCreateButton = item.key === "create";

              return (
                <button
                  key={item.key}
                  onClick={() => handleMobileMenuItemClick(item)}
                  className={`flex flex-col items-center p-1.5 rounded-lg transition-all relative ${
                    isCreateButton
                      ? "text-white/95 bg-[#8B1A2A] border border-[#8B1A2A]/40 -mt-4 px-2.5 py-2.5 rounded-full shadow-lg shadow-black/30 dark:text-[#e8a0b0] dark:bg-[#2B000A] dark:border-[#b41e3c]/40"
                      : isActive
                        ? "text-[#8B1A2A] bg-[#8B1A2A]/10 border border-[#8B1A2A]/30 dark:text-[#e8a0b0] dark:bg-[#2B000A] dark:border-[#2B000A]/50"
                        : "text-gray-500 dark:text-white/50 hover:text-gray-800 dark:hover:text-white/80"
                  }`}
                >
                  <div className={`${isCreateButton ? "w-5 h-5" : "w-5 h-5"}`}>
                    {item.icon}
                  </div>
                  <span
                    className={`text-[10px] max-w-[68px] truncate text-center mt-0.5 ${
                      isCreateButton ? "font-medium" : ""
                    }`}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}

            {hasHiddenItems && (
              <button
                onClick={() => setIsMobileMenuExpanded(!isMobileMenuExpanded)}
                className={`flex flex-col items-center p-1.5 rounded-lg transition-all ${
                  isMobileMenuExpanded
                    ? "text-[#8B1A2A] bg-[#8B1A2A]/10 border border-[#8B1A2A]/30 dark:text-[#e8a0b0] dark:bg-[#2B000A] dark:border-[#2B000A]/50"
                    : "text-gray-500 dark:text-white/50 hover:text-gray-800 dark:hover:text-white/80"
                }`}
              >
                <MoreVertical className="w-5 h-5" />
                <span className="text-[10px] max-w-[68px] truncate text-center mt-0.5">
                  {t("more") || "More"}
                </span>
              </button>
            )}
          </div>

          {isMobileMenuExpanded && hiddenItems.length > 0 && (
            <div className="mt-1.5 pt-1.5 border-t border-gray-200 dark:border-white/[0.08] animate-slideUp">
              <div className="flex flex-wrap justify-around items-center gap-1.5">
                {hiddenItems.map((item) => {
                  const isActive =
                    item.type === "right"
                      ? activeRightMenu === item.key
                      : activeMenu === item.key;

                  return (
                    <button
                      key={item.key}
                      onClick={() => handleMobileMenuItemClick(item)}
                      className={`flex flex-col items-center p-1.5 rounded-lg transition-all relative ${
                        isActive
                          ? "text-[#8B1A2A] bg-[#8B1A2A]/10 border border-[#8B1A2A]/30 dark:text-[#e8a0b0] dark:bg-[#2B000A] dark:border-[#2B000A]/50"
                          : "text-gray-500 dark:text-white/50 hover:text-gray-800 dark:hover:text-white/80"
                      }`}
                    >
                      <div className="w-5 h-5">{item.icon}</div>
                      <span className="text-[10px] max-w-[68px] truncate text-center mt-0.5">
                        {item.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Padding for bottom menu  */}
      <div className="lg:hidden pb-20"></div>

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .animate-fadeIn  { animation: fadeIn  0.2s ease-out; }
        .animate-slideUp { animation: slideUp 0.3s ease-out; }

        /* Hide native scrollbar on central content — scroll still works */
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

        /* Style the right-edge proxy scrollbar to match dark theme */
        .scroll-proxy::-webkit-scrollbar {
          width: 6px;
        }
        .scroll-proxy::-webkit-scrollbar-track {
          background: transparent;
        }
        .scroll-proxy::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.15);
          border-radius: 3px;
        }
        .scroll-proxy::-webkit-scrollbar-thumb:hover {
          background: rgba(232, 160, 176, 0.4);
        }
      `}</style>

      {/* Scroll proxy — desktop only, pinned to the very right edge of the viewport */}
      <div
        ref={scrollProxyRef}
        className="scroll-proxy hidden lg:block fixed top-0 right-0 z-[9999] overflow-y-scroll"
        style={{ width: "6px", height: "100vh", background: "transparent" }}
      >
        <div className="scroll-proxy-inner" style={{ width: "1px" }} />
      </div>
    </div>
  );
}
