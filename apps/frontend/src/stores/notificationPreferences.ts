import { defineStore } from "pinia";

type NotificationPreferencesState = {
  browserEnabled: boolean;
  suppressWhenForeground: boolean;
};

const NOTIFICATION_PREFERENCES_STORAGE_KEY = "symphony.notification-preferences";

export const useNotificationPreferencesStore = defineStore("notificationPreferences", {
  state: (): NotificationPreferencesState => ({
    browserEnabled: true,
    suppressWhenForeground: true
  }),

  actions: {
    loadPersistedPreferences(): void {
      const stored = readStoredPreferences();
      this.browserEnabled = stored?.browserEnabled ?? true;
      this.suppressWhenForeground = stored?.suppressWhenForeground ?? true;
    },

    setBrowserEnabled(enabled: boolean): void {
      this.browserEnabled = enabled;
      this.persist();
    },

    setSuppressWhenForeground(enabled: boolean): void {
      this.suppressWhenForeground = enabled;
      this.persist();
    },

    persist(): void {
      if (typeof window === "undefined") {
        return;
      }

      window.localStorage.setItem(
        NOTIFICATION_PREFERENCES_STORAGE_KEY,
        JSON.stringify({
          browserEnabled: this.browserEnabled,
          suppressWhenForeground: this.suppressWhenForeground
        })
      );
    }
  }
});

function readStoredPreferences(): Partial<NotificationPreferencesState> | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(NOTIFICATION_PREFERENCES_STORAGE_KEY);
  if (raw === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<NotificationPreferencesState> | null;
    return parsed ?? null;
  } catch {
    return null;
  }
}
