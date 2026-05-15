import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type {
  AppServerListResponse,
  CodexCommandOptionListResponse,
  CodexCommandListResponse,
  CodexSkillListResponse,
  CodexEventListResponse,
  ThreadCreateResponse,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadSyncResponse,
  WorkspaceEntryListResponse,
  WorkspaceOpenInVscodeRequest,
  WorkspaceOpenInVscodeResponse
} from "@agentmesh/shared";

import { CodexEventService } from "../services/codex-events.js";
import {
  AppServerService,
  type CreateAppServerInput,
  type PatchAppServerInput
} from "../services/app-servers.js";
import type { DatabaseHandle } from "../db/index.js";
import { RequestValidationError } from "../errors.js";
import { ThreadSyncService } from "../services/thread-sync.js";
import { WorkspaceFileService } from "../services/workspace-files.js";
import { WorkspaceOpenService } from "../services/workspace-open.js";
import { SkillService } from "../services/skills.js";
import { validateBody, validateParams, validateQuery } from "../validation.js";

type CodexRequester = Parameters<ThreadSyncService["materializeCodexThread"]>[1];

const appServerParamsSchema = z.object({
  id: z.string().min(1)
});

const appServerThreadParamsSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1)
});

const eventQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const workspaceEntryQuerySchema = z.object({
  query: z.string().max(512).default("")
});

const workspaceOpenBodySchema = z
  .object({
    path: z.string().trim().min(1).max(4096)
  })
  .strict();

const commandOptionQuerySchema = z.object({
  command: z.string().trim().min(1).max(80),
  threadId: z.string().trim().min(1).optional()
});

const createThreadSchema = z
  .object({
    name: z.string().trim().min(1).max(120)
  })
  .strict();

const optionalTextSchema = z.string().trim().min(1).optional();
const environmentSchema = z.record(z.string(), z.string()).optional();

const createAppServerSchema = z
  .object({
    name: optionalTextSchema,
    hostKind: z.enum(["local", "ssh"]),
    host: optionalTextSchema,
    sshUser: optionalTextSchema,
    sshPort: z.number().int().min(1).max(65_535).optional(),
    workspace: z.string().trim().min(1),
    command: optionalTextSchema,
    vscodePath: z.string().trim().min(1).max(4_096).nullable().optional(),
    environment: environmentSchema,
    observationPrompt: z.string().trim().max(8_000).optional(),
    activeObservationSkillNames: z.array(z.string().trim().min(1)).max(64).optional()
  })
  .strict();

const patchAppServerSchema = createAppServerSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: "PATCH body must include at least one field"
  });

export async function registerAppServerRoutes(app: FastifyInstance): Promise<void> {
  const service = new AppServerService(app.database);
  const threadSync = new ThreadSyncService(app.database, app.events, app.threadStatusCache);
  const codexEvents = new CodexEventService(app.database);
  const workspaceFiles = new WorkspaceFileService(app.database);
  const workspaceOpen = new WorkspaceOpenService(app.database);
  const skills = new SkillService(app.database, app.config, app.events);

  app.get(
    "/api/app-servers",
    async (): Promise<AppServerListResponse> => ({
      appServers: service.list()
    })
  );

  app.post(
    "/api/app-servers",
    { preHandler: validateBody(createAppServerSchema) },
    async (request, reply) => {
      const input = request.body as CreateAppServerInput;
      validateObservationSkills(skills, input.activeObservationSkillNames);
      const appServer = service.create(input);
      reply.code(201);
      return appServer;
    }
  );

  app.patch(
    "/api/app-servers/:id",
    {
      preHandler: [validateParams(appServerParamsSchema), validateBody(patchAppServerSchema)]
    },
    async (request) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const input = request.body as PatchAppServerInput;
      validateObservationSkills(skills, input.activeObservationSkillNames);
      return service.update(id, input);
    }
  );

  app.delete(
    "/api/app-servers/:id",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request, reply) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      await app.appServerLifecycle.stop(id);
      service.deleteWorkspaceData(id);
      reply.code(204);
    }
  );

  app.post(
    "/api/app-servers/:id/start",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return app.appServerLifecycle.start(id);
    }
  );

  app.post(
    "/api/app-servers/:id/stop",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return app.appServerLifecycle.stop(id);
    }
  );

  app.post(
    "/api/app-servers/:id/restart",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request) => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return app.appServerLifecycle.restart(id);
    }
  );

  app.get(
    "/api/app-servers/:id/threads",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request): Promise<ThreadListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      return { threads: threadSync.listCurrent(id) };
    }
  );

  app.get(
    "/api/app-servers/:id/workspace/entries",
    {
      preHandler: [validateParams(appServerParamsSchema), validateQuery(workspaceEntryQuerySchema)]
    },
    async (request): Promise<WorkspaceEntryListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const { query } = request.query as z.infer<typeof workspaceEntryQuerySchema>;
      return { entries: workspaceFiles.listEntries(id, query) };
    }
  );

  app.get(
    "/api/app-servers/:id/workspace/search-files",
    {
      preHandler: [validateParams(appServerParamsSchema), validateQuery(workspaceEntryQuerySchema)]
    },
    async (request): Promise<WorkspaceEntryListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const { query } = request.query as z.infer<typeof workspaceEntryQuerySchema>;
      return { entries: workspaceFiles.searchFiles(id, query) };
    }
  );

  app.post(
    "/api/app-servers/:id/workspace/open-in-vscode",
    {
      preHandler: [validateParams(appServerParamsSchema), validateBody(workspaceOpenBodySchema)]
    },
    async (request): Promise<WorkspaceOpenInVscodeResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const { path } = request.body as WorkspaceOpenInVscodeRequest;
      return workspaceOpen.openInVscode(id, path);
    }
  );

  app.get(
    "/api/app-servers/:id/codex-skills",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request): Promise<CodexSkillListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const result = await app.appServerLifecycle.getTransport(id).request("skills/list", {});
      return { skills: normalizeCodexSkills(result) };
    }
  );

  app.get(
    "/api/app-servers/:id/codex-commands",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request): Promise<CodexCommandListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const transport = app.appServerLifecycle.getTransport(id);
      const commands = [];

      commands.push({
        name: "/permissions",
        description: "choose what Codex is allowed to do",
        hasOptions: true
      });
      commands.push({
        name: "/subagents",
        description: "switch subagent threads",
        hasOptions: true
      });

      try {
        await transport.request("model/list", {});
        commands.push({
          name: "/model",
          description: "choose what model and reasoning effort to use",
          hasOptions: true
        });
      } catch {
        // This Codex server does not expose model capabilities.
      }

      try {
        await transport.request("collaborationMode/list", {});
        commands.push({
          name: "/collab",
          description: "change collaboration mode",
          hasOptions: true
        });
        commands.push({
          name: "/plan",
          description: "enter Codex Plan mode",
          hasOptions: false
        });
      } catch {
        // This Codex server does not expose collaboration modes.
      }

      return { commands: commands.sort((left, right) => left.name.localeCompare(right.name)) };
    }
  );

  app.get(
    "/api/app-servers/:id/codex-command-options",
    {
      preHandler: [validateParams(appServerParamsSchema), validateQuery(commandOptionQuerySchema)]
    },
    async (request): Promise<CodexCommandOptionListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const { command, threadId } = request.query as z.infer<typeof commandOptionQuerySchema>;
      const transport = app.appServerLifecycle.getTransport(id);

      switch (normalizeSlashCommand(command)) {
        case "/collab":
          return {
            options: normalizeCodexOptions(await transport.request("collaborationMode/list", {}))
          };
        case "/subagents":
          return {
            options: await listAgentThreadOptions(id, threadId, threadSync, transport, app.database)
          };
        case "/model":
          return {
            options: normalizeCodexOptions(await transport.request("model/list", {}))
          };
        case "/permission":
        case "/permissions":
          return { options: listPermissionOptions() };
        default:
          return { options: [] };
      }
    }
  );

  app.post(
    "/api/app-servers/:id/threads",
    { preHandler: [validateParams(appServerParamsSchema), validateBody(createThreadSchema)] },
    async (request): Promise<ThreadCreateResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const { name } = request.body as z.infer<typeof createThreadSchema>;
      return {
        thread: await threadSync.createThread(id, app.appServerLifecycle.getTransport(id), name)
      };
    }
  );

  app.post(
    "/api/app-servers/:id/threads/:threadId/resume",
    { preHandler: validateParams(appServerThreadParamsSchema) },
    async (request): Promise<ThreadResumeResponse> => {
      const { id, threadId } = request.params as z.infer<typeof appServerThreadParamsSchema>;
      service.get(id);
      return {
        thread: await threadSync.resumeThread(id, app.appServerLifecycle.getTransport(id), threadId)
      };
    }
  );

  app.get(
    "/api/app-servers/:id/codex-events",
    {
      preHandler: [validateParams(appServerParamsSchema), validateQuery(eventQuerySchema)]
    },
    async (request): Promise<CodexEventListResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      const { limit } = request.query as z.infer<typeof eventQuerySchema>;
      return { events: codexEvents.listForAppServer(id, { limit }) };
    }
  );

  app.post(
    "/api/app-servers/:id/threads/sync",
    { preHandler: validateParams(appServerParamsSchema) },
    async (request): Promise<ThreadSyncResponse> => {
      const { id } = request.params as z.infer<typeof appServerParamsSchema>;
      service.get(id);
      const result = await threadSync.sync(id, app.appServerLifecycle.getTransport(id));
      return result;
    }
  );
}

function validateObservationSkills(
  skills: SkillService,
  activeObservationSkillNames: readonly string[] | undefined
): void {
  if (activeObservationSkillNames === undefined) {
    return;
  }

  const available = new Set(skills.list().map((skill) => skill.name));
  for (const skillName of activeObservationSkillNames) {
    if (!available.has(skillName)) {
      throw new RequestValidationError("Observation skill is not available", [
        {
          path: ["activeObservationSkillNames"],
          message: `Unknown observation skill: ${skillName}`
        }
      ]);
    }
  }
}

function normalizeCodexSkills(value: unknown): CodexSkillListResponse["skills"] {
  const data = isRecord(value) && Array.isArray(value.data) ? value.data : [];
  const skills = data.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.skills)) {
      return [];
    }

    return entry.skills.flatMap((skill) => {
      if (!isRecord(skill) || typeof skill.name !== "string") {
        return [];
      }

      return [
        {
          name: skill.name,
          description: typeof skill.description === "string" ? skill.description : ""
        }
      ];
    });
  });
  const seen = new Set<string>();
  return skills
    .filter((skill) => {
      if (seen.has(skill.name)) {
        return false;
      }
      seen.add(skill.name);
      return true;
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeSlashCommand(command: string): string {
  const normalized = command.trim();
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function listPermissionOptions(): CodexCommandOptionListResponse["options"] {
  return [
    {
      label: "Read Only",
      description:
        "Codex can read files in the current workspace. Approval is required to edit files or access the internet."
    },
    {
      label: "Default",
      description:
        "Codex can read and edit files in the current workspace, and run commands. Approval is required to access the internet or edit other files."
    },
    {
      label: "Full Access",
      description:
        "Codex can edit files outside this workspace and access the internet without asking for approval. Exercise caution when using."
    }
  ];
}

async function listAgentThreadOptions(
  appServerId: string,
  threadId: string | undefined,
  threadSync: ThreadSyncService,
  transport: CodexRequester,
  database: DatabaseHandle
): Promise<CodexCommandOptionListResponse["options"]> {
  if (threadId === undefined) {
    return [];
  }

  const currentThread = threadSync.getById(threadId);
  if (currentThread.appServerId !== appServerId) {
    return [];
  }

  await threadSync.sync(appServerId, transport);
  const freshCurrentThread = threadSync.getById(threadId);
  const mainCodexThreadId =
    freshCurrentThread.parentCodexThreadId ??
    findMainCodexThreadId(database, appServerId, freshCurrentThread.codexThreadId) ??
    freshCurrentThread.codexThreadId;
  const mainThread = await threadSync.materializeCodexThread(
    appServerId,
    transport,
    mainCodexThreadId
  );
  const receiverCodexThreadIds = collectStoredSubagentCodexThreadIds(
    database,
    appServerId,
    mainCodexThreadId
  );
  const options: Array<CodexCommandOptionListResponse["options"][number]> = [];
  const seenThreadIds = new Set<string>();

  if (mainThread !== null) {
    options.push({
      label: "Main",
      value: mainThread.id,
      description: mainThread.codexThreadId
    });
    seenThreadIds.add(mainThread.id);
  }

  for (const codexThreadId of receiverCodexThreadIds) {
    const thread = await threadSync.materializeCodexThread(appServerId, transport, codexThreadId);
    if (thread === null || seenThreadIds.has(thread.id)) {
      continue;
    }

    options.push({
      label: thread.agentName ?? agentThreadLabel(thread.rawMetadata),
      value: thread.id,
      description: thread.codexThreadId
    });
  }

  return options;
}

function collectStoredSubagentCodexThreadIds(
  database: DatabaseHandle,
  appServerId: string,
  mainCodexThreadId: string
): string[] {
  const rows = database.sqlite
    .prepare(
      `
        SELECT codex_thread_id
        FROM threads
        WHERE app_server_id = ?
          AND parent_codex_thread_id = ?
          AND agent_kind = 'subagent'
          AND is_current = 1
          AND is_gone = 0
        ORDER BY agent_name ASC, thread_name ASC
      `
    )
    .all(appServerId, mainCodexThreadId) as { readonly codex_thread_id: string }[];

  return rows.map((row) => row.codex_thread_id);
}

function findMainCodexThreadId(
  database: DatabaseHandle,
  appServerId: string,
  receiverCodexThreadId: string
): string | null {
  const rows = database.sqlite
    .prepare(
      `
        SELECT raw_json
        FROM codex_events
        WHERE app_server_id = ?
          AND raw_json LIKE '%receiverThreadIds%'
        ORDER BY created_at DESC
      `
    )
    .all(appServerId) as { readonly raw_json: string }[];

  for (const row of rows) {
    const value = parseJson(row.raw_json);
    const item = readNestedRecord(value, ["params", "item"]);
    if (item === null || readString(item.type) !== "collabAgentToolCall") {
      continue;
    }

    const receiverThreadIds = Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [];
    const isReceiver = receiverThreadIds.some(
      (candidate) => readString(candidate) === receiverCodexThreadId
    );
    if (!isReceiver) {
      continue;
    }

    return readString(item.senderThreadId);
  }

  return null;
}

function agentThreadLabel(rawMetadata: unknown): string {
  const threadSource = readNestedRecord(rawMetadata, ["threadSource"]);
  const nickname =
    readStringField(rawMetadata, ["agentNickname", "agent_nickname"]) ??
    readStringField(threadSource, ["agentNickname", "agent_nickname"]);
  const role =
    readStringField(rawMetadata, ["agentRole", "agent_role"]) ??
    readStringField(threadSource, ["agentRole", "agent_role"]);
  if (nickname !== null && role !== null) {
    return `${nickname} [${role}]`;
  }
  if (nickname !== null) {
    return nickname;
  }
  if (role !== null) {
    return `[${role}]`;
  }
  return "Agent";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readNestedRecord(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  let cursor = value;

  for (const key of path) {
    if (!isRecord(cursor)) {
      return null;
    }
    cursor = cursor[key];
  }

  return isRecord(cursor) ? cursor : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readStringField(value: unknown, keys: readonly string[]): string | null {
  return isRecord(value) ? stringField(value, keys) : null;
}

function normalizeCodexOptions(value: unknown): CodexCommandOptionListResponse["options"] {
  const seen = new Set<string>();
  return extractOptionCandidates(value)
    .filter((option) => {
      if (seen.has(option.label)) {
        return false;
      }
      seen.add(option.label);
      return true;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

function extractOptionCandidates(value: unknown): CodexCommandOptionListResponse["options"] {
  if (typeof value === "string") {
    return [{ label: value, description: "" }];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractOptionCandidates(entry));
  }

  if (!isRecord(value)) {
    return [];
  }

  const label = stringField(value, ["model", "name", "id", "value", "label", "slug"]);
  if (label !== null) {
    return [
      {
        label,
        description: stringField(value, ["description", "detail", "title", "displayName"]) ?? ""
      }
    ];
  }

  return [
    "data",
    "items",
    "options",
    "models",
    "modes",
    "permissions",
    "approvalPolicies",
    "sandboxes"
  ].flatMap((key) => extractOptionCandidates(value[key]));
}

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | null {
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
