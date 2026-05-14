import { ElNotification } from "element-plus";

import { ApiClientError } from "../api/client";
import { notifyErrorEvent } from "../services/notifications";

export function notifyError(error: unknown, title = "Request failed"): void {
  const message =
    error instanceof ApiClientError || error instanceof Error
      ? error.message
      : "An unexpected error occurred.";

  ElNotification({
    title,
    message,
    type: "error",
    duration: 0,
    showClose: true
  });

  notifyErrorEvent(title, message, `error:${title}:${message}`);
}

export function notifyErrorMessage(message: string, title = "Request failed"): void {
  ElNotification({
    title,
    message,
    type: "error",
    duration: 0,
    showClose: true
  });

  notifyErrorEvent(title, message, `error:${title}:${message}`);
}

export function notifyInfo(message: string, title = "AgentMesh"): void {
  ElNotification({
    title,
    message,
    type: "info",
    duration: 3500
  });
}
