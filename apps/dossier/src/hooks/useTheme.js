// src/hooks/useTheme.js
import { useLayoutEffect, useState } from "react";

const useTheme = () => {
  // Initialize theme from localStorage or system preferences
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem("theme");
    if (saved) return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });

  // useLayoutEffect runs SYNCHRONOUSLY before paint
  useLayoutEffect(() => {
    const root = document.documentElement;

    console.log("🎨 Applying theme:", theme);
    console.log("📍 Current classList:", root.classList.toString());

    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    console.log("✅ New classList:", root.classList.toString());

    localStorage.setItem("theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => {
      const newTheme = prev === "dark" ? "light" : "dark";
      console.log("🔄 Toggling theme:", prev, "→", newTheme);
      return newTheme;
    });
  };

  return { theme, toggleTheme };
};

export default useTheme;
