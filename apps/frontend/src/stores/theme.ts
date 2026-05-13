import { defineStore } from "pinia";

export type ThemeMode = "light" | "dark";

type ThemeState = {
  theme: ThemeMode;
};

const THEME_STORAGE_KEY = "symphony.theme";

export const useThemeStore = defineStore("theme", {
  state: (): ThemeState => ({
    theme: "light"
  }),

  actions: {
    loadPersistedTheme(): void {
      const stored = readStoredTheme();
      this.theme = stored ?? "light";
      this.applyTheme();
    },

    setTheme(theme: ThemeMode): void {
      this.theme = theme;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(THEME_STORAGE_KEY, theme);
      }
      this.applyTheme();
    },

    toggleTheme(): void {
      this.setTheme(this.theme === "light" ? "dark" : "light");
    },

    applyTheme(): void {
      if (typeof document === "undefined") {
        return;
      }
      document.documentElement.dataset.theme = this.theme;
      document.documentElement.style.colorScheme = this.theme;
    }
  }
});

function readStoredTheme(): ThemeMode | null {
  if (typeof window === "undefined") {
    return null;
  }
  const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : null;
}
