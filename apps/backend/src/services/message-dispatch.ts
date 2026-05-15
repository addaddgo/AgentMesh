import type {
  PendingImageUploadDto,
  ScheduledMessageDto,
  SendMessageResponse
} from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";
import { NotFoundError, RequestValidationError } from "../errors.js";
import { MessageSendService } from "./message-send.js";
import { ScheduledMessageService } from "./scheduled-messages.js";

type ThreadRow = {
  readonly id: string;
  readonly app_server_id: string;
  readonly is_gone: 0 | 1;
};

export class MessageDispatchService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly sends: MessageSendService,
    private readonly scheduled: ScheduledMessageService
  ) {}

  public dispatch(
    threadId: string,
    text: string,
    attachments: readonly PendingImageUploadDto[] = [],
    delaySeconds = 0
  ): SendMessageResponse {
    const normalizedDelaySeconds = Math.max(0, Math.floor(delaySeconds));
    if (normalizedDelaySeconds === 0) {
      return this.sends.sendText(threadId, text, attachments);
    }

    if (attachments.length > 0) {
      throw new RequestValidationError("Delayed messages do not support image attachments yet");
    }

    const thread = this.getThread(threadId);
    if (thread.is_gone === 1) {
      throw new RequestValidationError("Thread is gone and cannot receive delayed messages");
    }

    const item = this.scheduled.create({
      appServerId: thread.app_server_id,
      threadId: thread.id,
      text,
      delaySeconds: normalizedDelaySeconds
    });

    return {
      status: "scheduled",
      item
    };
  }

  private getThread(threadId: string): ThreadRow {
    const row = this.database.sqlite
      .prepare("SELECT id, app_server_id, is_gone FROM threads WHERE id = ?")
      .get(threadId) as ThreadRow | undefined;

    if (row === undefined) {
      throw new NotFoundError("Thread not found");
    }

    return row;
  }
}

export function isScheduledDispatchResponse(
  response: SendMessageResponse
): response is { readonly status: "scheduled"; readonly item: ScheduledMessageDto } {
  return response.status === "scheduled";
}
