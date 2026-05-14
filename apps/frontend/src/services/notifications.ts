import type { AppServerDto, ApprovalDto, ThreadDto, TodoItemDto } from "@agentmesh/shared";

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

export function notifyErrorEvent(title: string, message: string, tag?: string): void {
  if (browserNotificationPermission() !== "granted") {
    return;
  }

  new window.Notification(title, {
    body: message,
    tag: tag ?? `error:${title}`
  });
}

export function notifyTodoDeadline(item: TodoItemDto): void {
  if (browserNotificationPermission() !== "granted" || item.dueAt === null) {
    return;
  }

  new window.Notification("Todo deadline reached", {
    body: item.category === null ? item.name : `${item.category} / ${item.name}`,
    tag: `todo-deadline:${item.id}:${item.dueAt}`
  });
}
