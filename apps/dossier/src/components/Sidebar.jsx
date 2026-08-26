// src/components/Sidebar.jsx
import React from "react";
import { useTranslation } from "react-i18next";
import {
  Globe,
  Users,
  MessageSquare,
  Settings,
  Bell,
  User,
  Wrench,
  Plus,
} from "lucide-react";
import { useLocation } from "react-router-dom";

const Sidebar = ({ activeMenu, handleMenuClick, onCreatePost }) => {
  const { t } = useTranslation();
  const location = useLocation();

  const menuItems = [
    { id: "country", icon: <Globe className="w-5 h-5" />, section: "nav" },
    { id: "support", icon: <Users className="w-5 h-5" />, section: "nav" },
    {
      id: "violations",
      icon: <MessageSquare className="w-5 h-5" />,
      section: "nav",
    },
    { id: "governance", icon: <Wrench className="w-5 h-5" />, section: "nav" },
    {
      id: "notifications",
      icon: <Bell className="w-5 h-5" />,
      section: "personal",
    },
    { id: "profile", icon: <User className="w-5 h-5" />, section: "personal" },
    {
      id: "settings",
      icon: <Settings className="w-5 h-5" />,
      section: "personal",
    },
  ];

  // Function to determine whether to show the "Create post" button
  const showCreatePostButton = () => {
    if (!onCreatePost) return false;

    const currentPath = location.pathname;

    // Do not show on these pages
    const excludedPages = ["/", "/login", "/register", "/create-lens-account"];

    return !excludedPages.includes(currentPath);
  };

  return (
    <div className="lg:w-64 w-full mb-6 lg:mb-0">
      <div>
        {/* Navigation */}
        <nav className="mb-6 pt-1">
          {menuItems
            .filter((i) => i.section === "nav")
            .map((item) => (
              <button
                key={item.id}
                onClick={() => handleMenuClick(item.id)}
                className={`
                w-full text-left px-3 py-2.5 rounded-xl font-medium
                transition-all duration-200 flex items-center gap-3 text-base mb-0.5
                ${
                  activeMenu === item.id
                    ? "bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35 dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white dark:hover:bg-[#3D0012]"
                    : "text-gray-600 dark:text-white/40 hover:text-gray-900 dark:hover:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.04]"
                }
              `}
              >
                <span
                  className={`flex-shrink-0 transition-colors ${
                    activeMenu === item.id
                      ? "text-white/70 dark:text-[#e8a0b0]"
                      : "text-gray-500 dark:text-white/30"
                  }`}
                >
                  {item.icon}
                </span>
                {t(`menu_${item.id}`)}
              </button>
            ))}

          {/* Thin divider line instead of "PERSONAL" */}
          <div className="my-3 px-3">
            <div className="h-px bg-gray-200 dark:bg-white/[0.08]"></div>
          </div>

          {menuItems
            .filter((i) => i.section === "personal")
            .map((item) => (
              <button
                key={item.id}
                onClick={() => handleMenuClick(item.id)}
                className={`
                w-full text-left px-3 py-2.5 rounded-xl font-medium
                transition-all duration-200 flex items-center gap-3 text-base mb-0.5
                ${
                  activeMenu === item.id
                    ? "bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35 dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white dark:hover:bg-[#3D0012]"
                    : "text-gray-600 dark:text-white/40 hover:text-gray-900 dark:hover:text-white/70 hover:bg-gray-100 dark:hover:bg-white/[0.04]"
                }
              `}
              >
                <span
                  className={`flex-shrink-0 transition-colors ${
                    activeMenu === item.id
                      ? "text-white/70 dark:text-[#e8a0b0]"
                      : "text-gray-500 dark:text-white/30"
                  }`}
                >
                  {item.icon}
                </span>
                {t(`menu_${item.id}`)}
              </button>
            ))}
        </nav>

        {/* Create post button */}
        {showCreatePostButton() && (
          <div className="mb-6">
            <button
              onClick={onCreatePost}
              className="w-full px-3 py-2.5
                bg-[#8B1A2A] border border-[#8B1A2A]/25 text-white/95 hover:bg-[#9B2232] hover:border-[#8B1A2A]/35
                dark:bg-[#2B000A] dark:border-[#2B000A]/50 dark:text-white/85 dark:hover:bg-[#3d0012]
                rounded-xl text-base font-medium flex items-center gap-3
                transition-colors"
            >
              <Plus className="w-4 h-4 text-white/70 dark:text-[#e8a0b0] flex-shrink-0" />
              {t("create_post") || "Create post"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Sidebar;
