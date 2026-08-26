// src/components/ThemeProvider.jsx
import { createContext, useContext } from "react";
import useTheme from "../hooks/useTheme";

const ThemeContext = createContext();

export const useThemeContext = () => useContext(ThemeContext);

export default function ThemeProvider({ children }) {
  const themeHook = useTheme();

  return (
    <ThemeContext.Provider value={themeHook}>{children}</ThemeContext.Provider>
  );
}
