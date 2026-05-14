import type { AppServerDto, ApprovalDto, ThreadDto } from "@agentmesh/shared";

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
  if (browserNotificationPermission() !== "granted") {
    return;
  }

  new window.Notification("Thread ready for input", {
    body: `${appServer.name} / ${thread.threadName} can accept input again.`,
    tag: `thread-ready:${thread.id}`
  });
}

export function notifyApprovalRequired(
  approval: ApprovalDto,
  thread: ThreadDto | null,
  appServer: AppServerDto | null
): void {
  if (approval.status !== "pending" || browserNotificationPermission() !== "granted") {
    return;
  }

  const workspaceLabel = appServer?.name ?? "Workspace";
  const threadLabel = thread?.threadName ?? "thread";
  new window.Notification("Approval required", {
    body: `${workspaceLabel} / ${threadLabel} is waiting for permission.`,
    tag: `approval-required:${approval.id}`
  });
}
