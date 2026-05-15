import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { SendMessageResponse } from "@agentmesh/shared";
import { validateBody } from "../validation.js";

const sendMessageSchema = z.object({
  threadId: z.string().min(1),
  text: z.string().default(""),
  delaySeconds: z.coerce.number().int().min(0).default(0),
  attachments: z
    .array(
      z
        .object({
          kind: z.literal("image"),
          mimeType: z.string().min(1),
          filename: z.string().min(1),
          size: z.number().int().nonnegative(),
          localPath: z.string().min(1),
          createdAt: z.number().int().nonnegative()
        })
        .strict()
    )
    .max(5)
    .default([])
});

export async function registerMessageRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/messages/send",
    { preHandler: validateBody(sendMessageSchema) },
    async (request, reply): Promise<SendMessageResponse> => {
      const { threadId, text, delaySeconds, attachments } = request.body as z.infer<
        typeof sendMessageSchema
      >;
      const response = app.messageDispatchService.dispatch(
        threadId,
        text,
        attachments,
        delaySeconds
      );
      reply.code(202);
      return response;
    }
  );
}
