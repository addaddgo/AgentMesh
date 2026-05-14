import type {
  ApiErrorResponse,
  TodoItemDto,
  TodoCreateRequest,
  TodoCategoryListResponse,
  TodoUpdateRequest,
  TodoReorderRequest,
  ScheduledMessageCreateRequest,
  ScheduledMessageDeleteResponse,
  ScheduledMessageDto,
  ScheduledMessageListResponse,
  ScheduledMessageUpdateRequest,
  AppServerDto,
  AppServerListResponse,
  AccountUsageDto,
  AccountUsageResponse,
  ApprovalDecision,
  ApprovalDto,
  ApprovalListResponse,
  ApprovalRespondResponse,
  ChatMessage,
  CodexCommandDto,
  CodexCommandApplyRequest,
  CodexCommandApplyResponse,
  CodexCommandListResponse,
  CodexCommandOptionDto,
  CodexCommandOptionListResponse,
  CodexEventDto,
  CodexEventListResponse,
  CodexSkillListResponse,
  SendMessageResponse,
  SendTextMessageRequest,
  SkillDto,
  SkillListResponse,
  SkillSyncRequest,
  SkillSyncResponse,
  ThreadDetailResponse,
  ThreadDraftListResponse,
  ThreadDraftPutRequest,
  ThreadDraftPutResponse,
  ThreadCreateRequest,
  ThreadCreateResponse,
  ThreadDto,
  ThreadImportResponse,
  ThreadListResponse,
  ThreadMessagesResponse,
  ThreadQueueResponse,
  ThreadResumeResponse,
  ThreadStopResponse,
  ThreadSyncResponse,
  TargetSkillDto,
  TargetSkillListResponse,
  TargetSkillDeleteResponse,
  UiLayoutListResponse,
  UiLayoutPutRequest,
  UiLayoutPutResponse,
  WorkspaceEntryDto,
  WorkspaceEntryListResponse,
  WorkspaceOpenInVscodeRequest,
  WorkspaceOpenInVscodeResponse,
  UploadImageResponse,
  WorkspaceUsageDto,
  WorkspaceUsageResponse
} from "@agentmesh/shared";

export class ApiClientError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export type CreateAppServerPayload = {
  readonly name?: string;
  readonly hostKind: "local" | "ssh";
  readonly host?: string;
  readonly sshUser?: string;
  readonly sshPort?: number;
  readonly workspace: string;
  readonly command?: string;
  readonly environment?: Record<string, string>;
  readonly observationPrompt?: string;
  readonly activeObservationSkillNames?: readonly string[];
};

export type PatchAppServerPayload = Partial<CreateAppServerPayload>;

const defaultHeaders = {
  Accept: "application/json"
} as const;

export class ApiClient {
  public constructor(private readonly baseUrl = "") {}

  public async listAppServers(): Promise<readonly AppServerDto[]> {
    const response = await this.request<AppServerListResponse>("/api/app-servers");
    return response.appServers;
  }

  public createAppServer(payload: CreateAppServerPayload): Promise<AppServerDto> {
    return this.request<AppServerDto>("/api/app-servers", {
      method: "POST",
      body: payload
    });
  }

  public updateAppServer(id: string, payload: PatchAppServerPayload): Promise<AppServerDto> {
    return this.request<AppServerDto>(`/api/app-servers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: payload
    });
  }

  public async deleteAppServer(id: string): Promise<void> {
    await this.request<void>(`/api/app-servers/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  public startAppServer(id: string): Promise<AppServerDto> {
    return this.request<AppServerDto>(`/api/app-servers/${encodeURIComponent(id)}/start`, {
      method: "POST"
    });
  }

  public stopAppServer(id: string): Promise<AppServerDto> {
    return this.request<AppServerDto>(`/api/app-servers/${encodeURIComponent(id)}/stop`, {
      method: "POST"
    });
  }

  public restartAppServer(id: string): Promise<AppServerDto> {
    return this.request<AppServerDto>(`/api/app-servers/${encodeURIComponent(id)}/restart`, {
      method: "POST"
    });
  }

  public async listThreads(appServerId: string): Promise<readonly ThreadDto[]> {
    const response = await this.request<ThreadListResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/threads`
    );
    return response.threads;
  }

  public async listWorkspaceEntries(
    appServerId: string,
    query: string
  ): Promise<readonly WorkspaceEntryDto[]> {
    const response = await this.request<WorkspaceEntryListResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/workspace/entries?query=${encodeURIComponent(query)}`
    );
    return response.entries;
  }

  public async searchWorkspaceFiles(
    appServerId: string,
    query: string
  ): Promise<readonly WorkspaceEntryDto[]> {
    const response = await this.request<WorkspaceEntryListResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/workspace/search-files?query=${encodeURIComponent(query)}`
    );
    return response.entries;
  }

  public openWorkspaceFileInVscode(
    appServerId: string,
    payload: WorkspaceOpenInVscodeRequest
  ): Promise<WorkspaceOpenInVscodeResponse> {
    return this.request<WorkspaceOpenInVscodeResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/workspace/open-in-vscode`,
      {
        method: "POST",
        body: payload
      }
    );
  }

  public async listCodexSkills(appServerId: string): Promise<readonly SkillDto[]> {
    const response = await this.request<CodexSkillListResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/codex-skills`
    );
    return response.skills;
  }

  public async listCodexCommands(appServerId: string): Promise<readonly CodexCommandDto[]> {
    const response = await this.request<CodexCommandListResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/codex-commands`
    );
    return response.commands;
  }

  public async listCodexCommandOptions(
    appServerId: string,
    command: string,
    threadId?: string
  ): Promise<readonly CodexCommandOptionDto[]> {
    const params = new URLSearchParams({ command });
    if (threadId !== undefined) {
      params.set("threadId", threadId);
    }

    const response = await this.request<CodexCommandOptionListResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/codex-command-options?${params.toString()}`
    );
    return response.options;
  }

  public async applyCodexCommandSelection(
    threadId: string,
    payload: CodexCommandApplyRequest
  ): Promise<CodexCommandApplyResponse> {
    return this.request<CodexCommandApplyResponse>(
      `/api/threads/${encodeURIComponent(threadId)}/codex-command-selection`,
      {
        method: "POST",
        body: payload
      }
    );
  }

  public syncThreads(appServerId: string): Promise<ThreadSyncResponse> {
    return this.request<ThreadSyncResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/threads/sync`,
      { method: "POST" }
    );
  }

  public async createThread(appServerId: string, payload: ThreadCreateRequest): Promise<ThreadDto> {
    const response = await this.request<ThreadCreateResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/threads`,
      {
        method: "POST",
        body: payload
      }
    );
    return response.thread;
  }

  public async resumeThread(appServerId: string, threadId: string): Promise<ThreadDto> {
    const response = await this.request<ThreadResumeResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/threads/${encodeURIComponent(threadId)}/resume`,
      { method: "POST" }
    );
    return response.thread;
  }

  public async getThread(threadId: string): Promise<ThreadDto> {
    const response = await this.request<ThreadDetailResponse>(
      `/api/threads/${encodeURIComponent(threadId)}`
    );
    return response.thread;
  }

  public async renameThread(threadId: string, name: string): Promise<ThreadDto> {
    const response = await this.request<ThreadDetailResponse>(
      `/api/threads/${encodeURIComponent(threadId)}/name`,
      {
        method: "PATCH",
        body: { name }
      }
    );
    return response.thread;
  }

  public importThread(threadId: string): Promise<ThreadImportResponse> {
    return this.request<ThreadImportResponse>(
      `/api/threads/${encodeURIComponent(threadId)}/import`,
      {
        method: "POST"
      }
    );
  }

  public async listMessages(threadId: string): Promise<readonly ChatMessage[]> {
    const response = await this.request<ThreadMessagesResponse>(
      `/api/threads/${encodeURIComponent(threadId)}/messages`
    );
    return response.messages;
  }

  public async listThreadQueue(threadId: string): Promise<ThreadQueueResponse> {
    return this.request<ThreadQueueResponse>(`/api/threads/${encodeURIComponent(threadId)}/queue`);
  }

  public stopThread(threadId: string): Promise<ThreadStopResponse> {
    return this.request<ThreadStopResponse>(`/api/threads/${encodeURIComponent(threadId)}/stop`, {
      method: "POST"
    });
  }

  public async listThreadCodexEvents(
    threadId: string,
    limit = 100
  ): Promise<readonly CodexEventDto[]> {
    const response = await this.request<CodexEventListResponse>(
      `/api/threads/${encodeURIComponent(threadId)}/codex-events?${new URLSearchParams({
        limit: String(limit)
      }).toString()}`
    );
    return response.events;
  }

  public async getWorkspaceUsage(): Promise<readonly WorkspaceUsageDto[]> {
    const response = await this.request<WorkspaceUsageResponse>("/api/stats/workspace-usage");
    return response.workspaces;
  }

  public async getAccountUsage(): Promise<readonly AccountUsageDto[]> {
    const response = await this.request<AccountUsageResponse>("/api/stats/account-usage");
    return response.usage;
  }

  public sendMessage(payload: SendTextMessageRequest): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>("/api/messages/send", {
      method: "POST",
      body: payload
    });
  }

  public async listApprovals(
    params: {
      readonly threadId?: string;
      readonly status?: ApprovalDto["status"];
    } = {}
  ): Promise<readonly ApprovalDto[]> {
    const search = new URLSearchParams();
    if (params.threadId !== undefined) {
      search.set("threadId", params.threadId);
    }
    if (params.status !== undefined) {
      search.set("status", params.status);
    }

    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    const response = await this.request<ApprovalListResponse>(`/api/approvals${suffix}`);
    return response.approvals;
  }

  public async respondApproval(id: string, decision: ApprovalDecision): Promise<ApprovalDto> {
    const response = await this.request<ApprovalRespondResponse>(
      `/api/approvals/${encodeURIComponent(id)}/respond`,
      {
        method: "POST",
        body: { decision }
      }
    );
    return response.approval;
  }

  public async uploadImage(file: File): Promise<UploadImageResponse> {
    const form = new FormData();
    form.set("file", file);

    return this.request<UploadImageResponse>("/api/uploads/images", {
      method: "POST",
      form
    });
  }

  public async listSkills(): Promise<readonly SkillDto[]> {
    const response = await this.request<SkillListResponse>("/api/skills");
    return response.skills;
  }

  public syncSkills(payload: SkillSyncRequest): Promise<SkillSyncResponse> {
    return this.request<SkillSyncResponse>("/api/skills/sync", {
      method: "POST",
      body: payload
    });
  }

  public async listTargetSkills(appServerId: string): Promise<readonly TargetSkillDto[]> {
    const response = await this.request<TargetSkillListResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/target-skills`
    );
    return response.skills;
  }

  public deleteTargetSkill(
    appServerId: string,
    skillName: string
  ): Promise<TargetSkillDeleteResponse> {
    return this.request<TargetSkillDeleteResponse>(
      `/api/app-servers/${encodeURIComponent(appServerId)}/target-skills/${encodeURIComponent(skillName)}`,
      { method: "DELETE" }
    );
  }

  public async listUiLayouts(): Promise<UiLayoutListResponse> {
    return this.request<UiLayoutListResponse>("/api/ui/layouts");
  }

  public async saveUiLayout(id: string, payload: UiLayoutPutRequest): Promise<UiLayoutPutResponse> {
    return this.request<UiLayoutPutResponse>(`/api/ui/layouts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: payload
    });
  }

  public async listDrafts(): Promise<ThreadDraftListResponse> {
    return this.request<ThreadDraftListResponse>("/api/ui/drafts");
  }

  public async saveDraft(
    threadId: string,
    payload: ThreadDraftPutRequest
  ): Promise<ThreadDraftPutResponse> {
    return this.request<ThreadDraftPutResponse>(`/api/ui/drafts/${encodeURIComponent(threadId)}`, {
      method: "PUT",
      body: payload
    });
  }
  public async listTodos(): Promise<readonly TodoItemDto[]> {
    const response = await this.request<{ readonly items: readonly TodoItemDto[] }>("/api/todos");
    return response.items;
  }

  public async listTodoCategories(): Promise<readonly string[]> {
    const response = await this.request<TodoCategoryListResponse>("/api/todos/categories");
    return response.categories;
  }

  public async createTodo(payload: TodoCreateRequest): Promise<TodoItemDto> {
    const response = await this.request<{ readonly item: TodoItemDto }>("/api/todos", {
      method: "POST",
      body: payload
    });
    return response.item;
  }

  public async updateTodo(id: string, payload: TodoUpdateRequest): Promise<TodoItemDto> {
    const response = await this.request<{ readonly item: TodoItemDto }>(
      `/api/todos/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: payload
      }
    );
    return response.item;
  }

  public async deleteTodo(id: string): Promise<void> {
    await this.request<void>(`/api/todos/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  public async reorderTodos(payload: TodoReorderRequest): Promise<readonly TodoItemDto[]> {
    const response = await this.request<{ readonly items: readonly TodoItemDto[] }>(
      "/api/todos/reorder",
      {
        method: "PUT",
        body: payload
      }
    );
    return response.items;
  }

  public async listScheduledMessages(): Promise<readonly ScheduledMessageDto[]> {
    const response = await this.request<ScheduledMessageListResponse>("/api/scheduled-messages");
    return response.items;
  }

  public async createScheduledMessage(
    payload: ScheduledMessageCreateRequest
  ): Promise<ScheduledMessageDto> {
    const response = await this.request<{ readonly item: ScheduledMessageDto }>(
      "/api/scheduled-messages",
      {
        method: "POST",
        body: payload
      }
    );
    return response.item;
  }

  public async updateScheduledMessage(
    id: string,
    payload: ScheduledMessageUpdateRequest
  ): Promise<ScheduledMessageDto> {
    const response = await this.request<{ readonly item: ScheduledMessageDto }>(
      `/api/scheduled-messages/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: payload
      }
    );
    return response.item;
  }

  public async cancelScheduledMessage(id: string): Promise<ScheduledMessageDto> {
    const response = await this.request<{ readonly item: ScheduledMessageDto }>(
      `/api/scheduled-messages/${encodeURIComponent(id)}/cancel`,
      {
        method: "POST"
      }
    );
    return response.item;
  }

  public async acknowledgeScheduledMessage(id: string): Promise<ScheduledMessageDto> {
    const response = await this.request<{ readonly item: ScheduledMessageDto }>(
      `/api/scheduled-messages/${encodeURIComponent(id)}/acknowledge`,
      {
        method: "POST"
      }
    );
    return response.item;
  }

  public async deleteScheduledMessage(id: string): Promise<ScheduledMessageDeleteResponse> {
    return this.request<ScheduledMessageDeleteResponse>(
      `/api/scheduled-messages/${encodeURIComponent(id)}`,
      {
        method: "DELETE"
      }
    );
  }

  private async request<T>(
    path: string,
    options: {
      readonly method?: string;
      readonly body?: unknown;
      readonly form?: FormData;
    } = {}
  ): Promise<T> {
    const headers = new Headers(defaultHeaders);
    let body: BodyInit | undefined;

    if (options.form !== undefined) {
      body = options.form;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }

    const init: RequestInit = {
      method: options.method ?? "GET",
      headers
    };
    if (body !== undefined) {
      init.body = body;
    }

    const response = await fetch(`${this.baseUrl}${path}`, init);

    if (response.status === 204) {
      return undefined as T;
    }

    const data = await parseJson(response);
    if (!response.ok) {
      throw new ApiClientError(getErrorMessage(data, response.statusText), response.status, data);
    }

    return data as T;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function getErrorMessage(data: unknown, fallback: string): string {
  const error = data as Partial<ApiErrorResponse> | undefined;
  return error?.error?.message ?? fallback;
}

export const apiClient = new ApiClient();
