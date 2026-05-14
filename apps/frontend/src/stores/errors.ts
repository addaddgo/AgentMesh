import { ElNotification } from "element-plus";

import { ApiClientError } from "../api/client";

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
}

export function notifyInfo(message: string, title = "AgentMesh"): void {
  ElNotification({
    title,
    message,
    type: "info",
    duration: 3500
  });
}
