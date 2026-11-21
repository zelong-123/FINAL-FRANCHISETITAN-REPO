import React, { createContext, useContext, useEffect, useMemo } from 'react';

// Light mode is removed: the app always runs in dark mode.
const THEME = 'dark';
const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  useEffect(() => {
    document.documentElement.dataset.theme = THEME;
    document.documentElement.style.colorScheme = THEME;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#070a12');
  }, []);

  const value = useMemo(() => ({ theme: THEME }), []);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used inside ThemeProvider.');
  return context;
}
