import type { AppServerDto, ApprovalDto, ThreadDto, TodoItemDto } from "@agentmesh/shared";

import { useNotificationPreferencesStore } from "../stores/notificationPreferences";

export function browserNotificationsEnabled(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function browserNotificationPermission(): NotificationPermission | "unsupported" {
  if (!browserNotificationsEnabled()) {
    return "unsupported";
  }

  return window.Notification.permission;
}

export async function requestBrowserNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!browserNotificationsEnabled()) {
    return "unsupported";
  }

  if (window.Notification.permission !== "default") {
    return window.Notification.permission;
  }

  return window.Notification.requestPermission();
}

export function notifyThreadReady(thread: ThreadDto, appServer: AppServerDto): void {
  emitBrowserNotification("Thread ready for input", {
    body: `${appServer.name} / ${thread.threadName} can accept input again.`,
    tag: `thread-ready:${thread.id}`
  });
}

export function notifyApprovalRequired(
  approval: ApprovalDto,
  thread: ThreadDto | null,
  appServer: AppServerDto | null
): void {
  if (approval.status !== "pending") {
    return;
  }

  const workspaceLabel = appServer?.name ?? "Workspace";
  const threadLabel = thread?.threadName ?? "thread";
  emitBrowserNotification("Approval required", {
    body: `${workspaceLabel} / ${threadLabel} is waiting for permission.`,
    tag: `approval-required:${approval.id}`
  });
}

export function notifyErrorEvent(title: string, message: string, tag?: string): void {
  emitBrowserNotification(title, {
    body: message,
    tag: tag ?? `error:${title}`
  });
}

export function notifyTodoDeadline(item: TodoItemDto): void {
  if (item.dueAt === null) {
    return;
  }

  emitBrowserNotification("Todo deadline reached", {
    body: item.category === null ? item.name : `${item.category} / ${item.name}`,
    tag: `todo-deadline:${item.id}:${item.dueAt}`
  });
}

export function pageInForeground(): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  return document.visibilityState === "visible" && document.hasFocus();
}

export function shouldSendBrowserNotification(): boolean {
  if (browserNotificationPermission() !== "granted") {
    return false;
  }

  const preferences = useNotificationPreferencesStore();
  if (!preferences.browserEnabled) {
    return false;
  }

  if (preferences.suppressWhenForeground && pageInForeground()) {
    return false;
  }

  return true;
}

export function emitBrowserNotification(
  title: string,
  options: NotificationOptions = {}
): boolean {
  if (!shouldSendBrowserNotification()) {
    return false;
  }

  new window.Notification(title, options);
  return true;
}
