import type { ApiErrorCode, ApiErrorDetail, ApiErrorResponse } from "@agentmesh/shared";
import { ZodError } from "zod";

export class ApiError extends Error {
  public constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly statusCode: number,
    public readonly details?: readonly ApiErrorDetail[]
  ) {
    super(message);
    this.name = new.target.name;
  }

  public toResponse(): ApiErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details })
      }
    };
  }
}

export class RequestValidationError extends ApiError {
  public constructor(message = "Request validation failed", details?: readonly ApiErrorDetail[]) {
    super("validation_error", message, 400, details);
  }

  public static fromZod(error: ZodError): RequestValidationError {
    return new RequestValidationError(
      "Request validation failed",
      error.issues.map((issue) => ({
        path: issue.path,
        message: issue.message
      }))
    );
  }
}

export class NotFoundError extends ApiError {
  public constructor(message = "Resource not found") {
    super("not_found", message, 404);
  }
}

export class OfflineError extends ApiError {
  public constructor(message = "App server is offline") {
    super("offline", message, 409);
  }
}

export class ProtocolError extends ApiError {
  public constructor(message = "Protocol error") {
    super("protocol_error", message, 502);
  }
}

export class SshError extends ApiError {
  public constructor(message = "SSH operation failed") {
    super("ssh_error", message, 502);
  }
}

export class FilesystemError extends ApiError {
  public constructor(message = "Filesystem operation failed") {
    super("filesystem_error", message, 500);
  }
}

export class InternalApiError extends ApiError {
  public constructor(message = "Internal server error") {
    super("internal_error", message, 500);
  }
}
