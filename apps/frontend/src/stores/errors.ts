import { ElNotification } from "element-plus";

import { ApiClientError } from "../api/client";
import { notifyErrorEvent } from "../services/notifications";

export function notifyError(error: unknown, title = "Request failed"): void {
  const message = extractErrorMessage(error);

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

export function notifySuccess(message: string, title = "AgentMesh"): void {
  ElNotification({
    title,
    message,
    type: "success",
    duration: 3500
  });
}

function extractErrorMessage(error: unknown): string {
  if (typeof error === "string") {
    const message = error.trim();
    return message.length > 0 ? message : "An unexpected error occurred.";
  }

  if (error instanceof ApiClientError || error instanceof Error) {
    const details = collectErrorDetails(error);
    return details.length > 0 ? details.join("\n") : error.message;
  }

  if (error !== null && typeof error === "object") {
    const details = collectErrorDetails(error);
    if (details.length > 0) {
      return details.join("\n");
    }
  }

  return "An unexpected error occurred.";
}

function collectErrorDetails(source: unknown): string[] {
  const messages = new Set<string>();
  appendErrorDetails(source, messages);
  return [...messages];
}

function appendErrorDetails(source: unknown, messages: Set<string>): void {
  if (source === null || source === undefined) {
    return;
  }

  if (typeof source === "string") {
    const message = source.trim();
    if (message.length > 0) {
      messages.add(message);
    }
    return;
  }

  if (Array.isArray(source)) {
    for (const item of source) {
      appendErrorDetails(item, messages);
    }
    return;
  }

  if (source instanceof ApiClientError) {
    appendErrorDetails(source.message, messages);
    appendErrorDetails(source.body, messages);
    return;
  }

  if (source instanceof Error) {
    appendErrorDetails(source.message, messages);
    const withCause = source as Error & { cause?: unknown };
    appendErrorDetails(withCause.cause, messages);
    return;
  }

  if (typeof source !== "object") {
    return;
  }

  const record = source as Record<string, unknown>;

  appendErrorDetails(record.message, messages);
  appendErrorDetails(record.error, messages);
  appendErrorDetails(record.details, messages);
  appendErrorDetails(record.cause, messages);

  if (record.error !== null && typeof record.error === "object") {
    const nestedError = record.error as Record<string, unknown>;
    appendErrorDetails(nestedError.message, messages);
    appendErrorDetails(nestedError.details, messages);
  }
}
