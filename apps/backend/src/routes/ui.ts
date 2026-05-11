import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  ThreadDraftListResponse,
  ThreadDraftPutResponse,
  UiLayoutListResponse,
  UiLayoutPutRequest,
  UiLayoutPutResponse
} from "@agentmesh/shared";

import { UiLayoutService } from "../services/ui-layouts.js";
import { validateBody, validateParams } from "../validation.js";

const layoutParamsSchema = z.object({
  id: z.string().min(1)
});

const draftParamsSchema = z.object({
  threadId: z.string().min(1)
});

const splitPaneTreeSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z
      .object({
        type: z.literal("leaf"),
        id: z.string().min(1),
        appServerId: z.string().min(1).optional(),
        threadId: z.string().min(1).optional()
      })
      .strict(),
    z
      .object({
        type: z.literal("split"),
        id: z.string().min(1),
        direction: z.enum(["horizontal", "vertical"]),
        first: splitPaneTreeSchema,
        second: splitPaneTreeSchema,
        ratio: z.number().min(0.1).max(0.9)
      })
      .strict()
  ])
);

const saveLayoutSchema = z
  .object({
    kind: z.enum(["boards", "threads"]),
    ownerId: z.string().min(1),
    layoutJson: splitPaneTreeSchema.nullable()
  })
  .strict();

const saveDraftSchema = z
  .object({
    appServerId: z.string().min(1),
    draftMarkdown: z.string()
  })
  .strict();

export async function registerUiRoutes(app: FastifyInstance): Promise<void> {
  const service = new UiLayoutService(app.database);

  app.get(
    "/api/ui/layouts",
    async (): Promise<UiLayoutListResponse> => ({
      layouts: service.listLayouts()
    })
  );

  app.put(
    "/api/ui/layouts/:id",
    { preHandler: [validateParams(layoutParamsSchema), validateBody(saveLayoutSchema)] },
    async (request): Promise<UiLayoutPutResponse> => {
      const { id } = request.params as z.infer<typeof layoutParamsSchema>;
      const body = request.body as UiLayoutPutRequest;
      return {
        layout: service.saveLayout({
          id,
          kind: body.kind,
          ownerId: body.ownerId,
          layoutJson: body.layoutJson
        })
      };
    }
  );

  app.get(
    "/api/ui/drafts",
    async (): Promise<ThreadDraftListResponse> => ({
      drafts: service.listDrafts()
    })
  );

  app.put(
    "/api/ui/drafts/:threadId",
    { preHandler: [validateParams(draftParamsSchema), validateBody(saveDraftSchema)] },
    async (request): Promise<ThreadDraftPutResponse> => {
      const { threadId } = request.params as z.infer<typeof draftParamsSchema>;
      const { draftMarkdown } = request.body as z.infer<typeof saveDraftSchema>;
      return {
        draft: service.saveDraft(threadId, draftMarkdown)
      };
    }
  );
}
