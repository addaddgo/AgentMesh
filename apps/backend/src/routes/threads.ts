import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  CodexCommandApplyResponse,
  CodexEventListResponse,
  ThreadDetailResponse,
  ThreadImportResponse,
  ThreadMessagesResponse,
  ThreadQueueResponse
} from "@agentmesh/shared";

import { CodexEventService } from "../services/codex-events.js";
import { RequestValidationError } from "../errors.js";
import { ThreadImportService } from "../services/thread-import.js";
import { ThreadQueueService } from "../services/thread-queue.js";
import { validateBody, validateParams, validateQuery } from "../validation.js";

const threadParamsSchema = z.object({
  threadId: z.string().min(1)
});

const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const commandApplySchema = z
  .object({
    command: z.string().trim().min(1).max(80),
    option: z.string().trim().min(1).max(200)
  })
  .strict();

const renameThreadSchema = z
  .object({
    name: z.string().trim().min(1).max(120)
  })
  .strict();

export async function registerThreadRoutes(app: FastifyInstance): Promise<void> {
  const service = new ThreadImportService(app.database, app.events);
  const codexEvents = new CodexEventService(app.database);
  const queue = new ThreadQueueService(app.database, app.events);

  app.get(
    "/api/threads/:threadId",
    { preHandler: validateParams(threadParamsSchema) },
    async (request): Promise<ThreadDetailResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      return { thread: service.getThread(threadId) };
    }
  );

  app.get(
    "/api/threads/:threadId/messages",
    { preHandler: validateParams(threadParamsSchema) },
    async (request): Promise<ThreadMessagesResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      return { messages: service.listMessages(threadId) };
    }
  );

  app.get(
    "/api/threads/:threadId/queue",
    { preHandler: validateParams(threadParamsSchema) },
    async (request): Promise<ThreadQueueResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      return { items: queue.listForThread(threadId) };
    }
  );

  app.get(
    "/api/threads/:threadId/codex-events",
    {
      preHandler: [validateParams(threadParamsSchema), validateQuery(eventQuerySchema)]
    },
    async (request): Promise<CodexEventListResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      const { limit } = request.query as z.infer<typeof eventQuerySchema>;
      return { events: codexEvents.listForThread(threadId, { limit }) };
    }
  );

  app.post(
    "/api/threads/:threadId/import",
    { preHandler: validateParams(threadParamsSchema) },
    async (request): Promise<ThreadImportResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      const thread = service.getThread(threadId);
      const requester =
        thread.importedAt === null
          ? app.appServerLifecycle.getTransport(thread.appServerId)
          : undefined;

      return service.importThread(threadId, requester);
    }
  );

  app.patch(
    "/api/threads/:threadId/name",
    { preHandler: [validateParams(threadParamsSchema), validateBody(renameThreadSchema)] },
    async (request): Promise<ThreadDetailResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      const { name } = request.body as z.infer<typeof renameThreadSchema>;
      const thread = service.getThread(threadId);
      return {
        thread: await service.renameThread(
          threadId,
          app.appServerLifecycle.getTransport(thread.appServerId),
          name
        )
      };
    }
  );

  app.post(
    "/api/threads/:threadId/codex-command-selection",
    { preHandler: [validateParams(threadParamsSchema), validateBody(commandApplySchema)] },
    async (request): Promise<CodexCommandApplyResponse> => {
      const { threadId } = request.params as z.infer<typeof threadParamsSchema>;
      const { command, option } = request.body as z.infer<typeof commandApplySchema>;
      const thread = service.getThread(threadId);
      const transport = app.appServerLifecycle.getTransport(thread.appServerId);
      const settings = await resolveCommandSettings(transport, command, option, thread.cwd);
      const now = Date.now();

      app.database.sqlite
        .prepare(
          `
            INSERT INTO thread_settings (
              thread_id,
              model,
              effort,
              approval_policy_json,
              sandbox_policy_json,
              collaboration_mode_json,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id) DO UPDATE SET
              model = COALESCE(excluded.model, thread_settings.model),
              effort = COALESCE(excluded.effort, thread_settings.effort),
              approval_policy_json = COALESCE(excluded.approval_policy_json, thread_settings.approval_policy_json),
              sandbox_policy_json = COALESCE(excluded.sandbox_policy_json, thread_settings.sandbox_policy_json),
              collaboration_mode_json = COALESCE(excluded.collaboration_mode_json, thread_settings.collaboration_mode_json),
              updated_at = excluded.updated_at
          `
        )
        .run(
          threadId,
          settings.model ?? null,
          settings.effort ?? null,
          settings.approvalPolicy === undefined ? null : JSON.stringify(settings.approvalPolicy),
          settings.sandboxPolicy === undefined ? null : JSON.stringify(settings.sandboxPolicy),
          settings.collaborationMode === undefined
            ? null
            : JSON.stringify(settings.collaborationMode),
          now
        );

      return { applied: true };
    }
  );
}

type CommandSettings = {
  readonly model?: string;
  readonly effort?: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
  readonly collaborationMode?: unknown;
};

type CodexRequester = {
  request(method: string, params?: unknown): Promise<unknown>;
};

async function resolveCommandSettings(
  transport: CodexRequester,
  command: string,
  option: string,
  cwd: string | null
): Promise<CommandSettings> {
  switch (normalizeSlashCommand(command)) {
    case "/model":
      return resolveModelSettings(transport, option);
    case "/permissions":
    case "/permission":
      return resolvePermissionSettings(option, cwd);
    case "/collab":
      return resolveCollaborationSettings(transport, option);
    case "/plan":
      return resolvePlanSettings(transport);
    default:
      throw new RequestValidationError(`Unsupported slash command: ${command}`);
  }
}

async function resolveModelSettings(
  transport: CodexRequester,
  option: string
): Promise<CommandSettings> {
  const result = await transport.request("model/list", {});
  const model = findOptionRecord(result, option);
  const effort = stringField(model, ["reasoningEffort", "reasoning_effort"]);
  return effort === null
    ? { model: stringField(model, ["model", "id", "name", "label"]) ?? option }
    : { model: stringField(model, ["model", "id", "name", "label"]) ?? option, effort };
}

function resolvePermissionSettings(option: string, cwd: string | null): CommandSettings {
  const normalized = option.toLowerCase().replace(/[\s_-]+/gu, "-");
  if (normalized === "read-only") {
    return {
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "readOnly", networkAccess: false }
    };
  }
  if (normalized === "default") {
    return {
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: cwd === null ? [] : [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false
      }
    };
  }
  if (normalized === "full-access") {
    return {
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" }
    };
  }

  throw new RequestValidationError(`Unsupported permissions option: ${option}`);
}

async function resolveCollaborationSettings(
  transport: CodexRequester,
  option: string
): Promise<CommandSettings> {
  const result = await transport.request("collaborationMode/list", {});
  const mask = findOptionRecord(result, option);
  const fallbackModel = await defaultModel(transport);
  return {
    collaborationMode: {
      mode: stringField(mask, ["mode"]) ?? "default",
      settings: {
        model: stringField(mask, ["model"]) ?? fallbackModel,
        reasoning_effort: stringField(mask, ["reasoning_effort", "reasoningEffort"]),
        developer_instructions: null
      }
    }
  };
}

async function resolvePlanSettings(transport: CodexRequester): Promise<CommandSettings> {
  const result = await transport.request("collaborationMode/list", {});
  const plan = findOptionRecord(result, "Plan");
  const fallbackModel = await defaultModel(transport);
  return {
    collaborationMode: {
      mode: stringField(plan, ["mode"]) ?? "plan",
      settings: {
        model: stringField(plan, ["model"]) ?? fallbackModel,
        reasoning_effort: stringField(plan, ["reasoning_effort", "reasoningEffort"]) ?? "medium",
        developer_instructions: null
      }
    }
  };
}

async function defaultModel(transport: CodexRequester): Promise<string> {
  const result = await transport.request("model/list", {});
  const options = collectOptionRecords(result);
  return (
    stringField(
      options.find((option) => option.default === true || option.isDefault === true),
      ["model", "id", "name", "label"]
    ) ??
    stringField(options[0], ["model", "id", "name", "label"]) ??
    "gpt-5"
  );
}

function collectOptionRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectOptionRecords(entry));
  }
  if (!isRecord(value)) {
    return [];
  }
  if (stringField(value, ["model", "name", "id", "value", "label", "slug"]) !== null) {
    return [value];
  }
  return ["data", "items", "options", "models", "modes"].flatMap((key) =>
    collectOptionRecords(value[key])
  );
}

function findOptionRecord(value: unknown, option: string): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findOptionRecord(entry, option);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  const label = stringField(value, ["model", "name", "id", "value", "label", "slug"]);
  if (label === option) {
    return value;
  }
  for (const key of ["data", "items", "options", "models", "modes"]) {
    const found = findOptionRecord(value[key], option);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function normalizeSlashCommand(command: string): string {
  const normalized = command.trim();
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function stringField(value: unknown, keys: readonly string[]): string | null {
  if (!isRecord(value)) {
    return null;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
