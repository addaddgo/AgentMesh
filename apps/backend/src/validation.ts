import type { FastifyReply, FastifyRequest, HookHandlerDoneFunction } from "fastify";
import type { z, ZodTypeAny } from "zod";

import { RequestValidationError } from "./errors.js";

type RequestPart = "body" | "params" | "query";

export function validateRequestPart<TSchema extends ZodTypeAny>(
  part: RequestPart,
  schema: TSchema
) {
  return (request: FastifyRequest, _reply: FastifyReply, done: HookHandlerDoneFunction): void => {
    const result = schema.safeParse(request[part]);

    if (!result.success) {
      done(RequestValidationError.fromZod(result.error));
      return;
    }

    (request as FastifyRequest & Record<RequestPart, z.infer<TSchema>>)[part] = result.data;
    done();
  };
}

export const validateBody = <TSchema extends ZodTypeAny>(schema: TSchema) =>
  validateRequestPart("body", schema);

export const validateParams = <TSchema extends ZodTypeAny>(schema: TSchema) =>
  validateRequestPart("params", schema);

export const validateQuery = <TSchema extends ZodTypeAny>(schema: TSchema) =>
  validateRequestPart("query", schema);
