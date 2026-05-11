import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  FilesystemError,
  NotFoundError,
  OfflineError,
  ProtocolError,
  RequestValidationError,
  SshError
} from "./errors.js";

describe("API errors", () => {
  it("serializes shared API error responses", () => {
    expect(new NotFoundError("Missing").toResponse()).toEqual({
      error: {
        code: "not_found",
        message: "Missing"
      }
    });
  });

  it("maps common domain errors to status codes", () => {
    expect(new RequestValidationError().statusCode).toBe(400);
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new OfflineError().statusCode).toBe(409);
    expect(new ProtocolError().statusCode).toBe(502);
    expect(new SshError().statusCode).toBe(502);
    expect(new FilesystemError().statusCode).toBe(500);
  });

  it("converts Zod issues to validation details", () => {
    const result = z.object({ name: z.string().min(1) }).safeParse({ name: "" });
    expect(result.success).toBe(false);

    if (!result.success) {
      expect(RequestValidationError.fromZod(result.error).toResponse().error.details).toEqual([
        {
          path: ["name"],
          message: "String must contain at least 1 character(s)"
        }
      ]);
    }
  });
});
