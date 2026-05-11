import type { ChatMessage } from "@agentmesh/shared";

export const MESSAGE_TEXT_DRAG_MIME = "application/x-agentmesh-message-text";

type DragDataStore = {
  readonly files: { readonly length: number };
  readonly types: ArrayLike<string> | Iterable<string>;
  getData(type: string): string;
};

export function textForMessageDrag(message: ChatMessage): string {
  return message.parts
    .filter((part) => part.type === "markdown")
    .map((part) => part.text)
    .join("\n\n");
}

export function writeMessageTextDrag(dataTransfer: DataTransfer, text: string): void {
  dataTransfer.clearData();
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(MESSAGE_TEXT_DRAG_MIME, text);
  dataTransfer.setData("text/markdown", text);
  dataTransfer.setData("text/plain", text);
}

export function readMessageTextDrop(dataTransfer: DragDataStore | null): string {
  if (dataTransfer === null || hasFiles(dataTransfer)) {
    return "";
  }

  if (!hasType(dataTransfer, MESSAGE_TEXT_DRAG_MIME)) {
    return "";
  }

  return dataTransfer.getData(MESSAGE_TEXT_DRAG_MIME);
}

export function canDropMessageText(dataTransfer: DragDataStore | null): boolean {
  return (
    dataTransfer !== null &&
    !hasFiles(dataTransfer) &&
    hasType(dataTransfer, MESSAGE_TEXT_DRAG_MIME)
  );
}

export function appendDroppedText(existingDraft: string, droppedText: string): string {
  return existingDraft.trim().length === 0 ? droppedText : `${existingDraft}\n\n${droppedText}`;
}

function hasFiles(dataTransfer: DragDataStore): boolean {
  return dataTransfer.files.length > 0 || hasType(dataTransfer, "Files");
}

function hasType(dataTransfer: DragDataStore, type: string): boolean {
  return Array.from(dataTransfer.types).includes(type);
}
