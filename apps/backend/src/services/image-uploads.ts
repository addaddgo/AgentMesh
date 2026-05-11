import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

import type { ImageAttachmentDto } from "@agentmesh/shared";

import type { BackendConfig } from "../config.js";
import type { DatabaseHandle } from "../db/index.js";
import { FilesystemError, RequestValidationError, SshError } from "../errors.js";
import {
  assertPathInside,
  assertSafePathSegment,
  assertPosixPathInside
} from "./filesystem-safety.js";

export const MAX_IMAGES_PER_MESSAGE = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

type AttachmentRow = {
  readonly id: string;
  readonly kind: "image";
  readonly mime_type: string;
  readonly filename: string;
  readonly size: number;
  readonly local_path: string;
  readonly workspace_path: string | null;
  readonly created_at: number;
};

export type WorkspaceCopyTarget = {
  readonly hostKind: "local" | "ssh";
  readonly host: string;
  readonly sshUser: string | null;
  readonly sshPort: number | null;
  readonly workspace: string;
};

export class ImageUploadService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly config: BackendConfig
  ) {}

  public storeUpload(input: {
    readonly buffer: Buffer;
    readonly mimeType: string;
  }): ImageAttachmentDto {
    const ext = extensionForMime(input.mimeType);

    if (input.buffer.length > MAX_IMAGE_BYTES) {
      throw new RequestValidationError("Image exceeds maximum size");
    }

    const id = randomUUID();
    const filename = `${id}.${ext}`;
    const uploadDir = path.join(this.config.uploadDir, "images");
    const localPath = path.join(uploadDir, filename);
    const now = Date.now();

    assertPathInside(
      this.config.dataDir,
      uploadDir,
      "Images must be stored under backend data dir"
    );
    assertPathInside(
      this.config.dataDir,
      localPath,
      "Images must be stored under backend data dir"
    );

    try {
      fs.mkdirSync(uploadDir, { recursive: true });
      fs.writeFileSync(localPath, input.buffer, { flag: "wx" });
    } catch (error) {
      throw new FilesystemError(errorMessage(error));
    }

    this.database.sqlite
      .prepare(
        `
          INSERT INTO attachments (
            id,
            kind,
            mime_type,
            filename,
            size,
            local_path,
            workspace_path,
            created_at
          ) VALUES (?, 'image', ?, ?, ?, ?, NULL, ?)
        `
      )
      .run(id, input.mimeType, filename, input.buffer.length, localPath, now);

    return this.get(id);
  }

  public get(id: string): ImageAttachmentDto {
    const row = this.database.sqlite.prepare("SELECT * FROM attachments WHERE id = ?").get(id) as
      | AttachmentRow
      | undefined;

    if (row === undefined) {
      throw new RequestValidationError(`Unknown attachment: ${id}`);
    }

    return toDto(row);
  }

  public getMany(ids: readonly string[]): readonly ImageAttachmentDto[] {
    return ids.map((id) => this.get(id));
  }

  public copyToWorkspace(
    attachment: ImageAttachmentDto,
    target: WorkspaceCopyTarget
  ): ImageAttachmentDto {
    assertSafePathSegment(attachment.filename, "filename", "Uploaded filename is invalid");
    assertPathInside(
      this.config.dataDir,
      attachment.localPath,
      "Image source must be under backend data dir"
    );

    const imageRoot = path.posix.join(target.workspace, ".agentmesh", "images");
    const workspacePath = path.posix.join(imageRoot, attachment.filename);

    assertPosixPathInside(imageRoot, workspacePath, "Images must be copied to .agentmesh/images");

    if (target.hostKind === "ssh") {
      copyImageToRemote(attachment.localPath, workspacePath, target);
      this.database.sqlite
        .prepare("UPDATE attachments SET workspace_path = ? WHERE id = ?")
        .run(workspacePath, attachment.id);

      return { ...attachment, workspacePath };
    }

    try {
      fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
      fs.copyFileSync(attachment.localPath, workspacePath);
    } catch (error) {
      throw new FilesystemError(errorMessage(error));
    }

    this.database.sqlite
      .prepare("UPDATE attachments SET workspace_path = ? WHERE id = ?")
      .run(workspacePath, attachment.id);

    return { ...attachment, workspacePath };
  }
}

function copyImageToRemote(
  localPath: string,
  workspacePath: string,
  target: WorkspaceCopyTarget
): void {
  const parent = path.posix.dirname(workspacePath);
  const sshTarget = remoteTarget(target);
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(target.sshPort === null ? [] : ["-p", String(target.sshPort)]),
    sshTarget,
    `mkdir -p ${shellQuote(parent)}`
  ];
  const scpArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(target.sshPort === null ? [] : ["-P", String(target.sshPort)]),
    localPath,
    `${sshTarget}:${shellQuote(workspacePath)}`
  ];

  runRemoteCommand("ssh", sshArgs);
  runRemoteCommand("scp", scpArgs);
}

function runRemoteCommand(command: "ssh" | "scp", args: readonly string[]): void {
  const result = spawnSync(command, args, { encoding: "utf8" });

  if (result.error !== undefined) {
    throw new SshError(result.error.message);
  }

  if (result.status !== 0) {
    throw new SshError(
      `${command} failed${result.stderr.length > 0 ? `: ${result.stderr.trim()}` : ""}`
    );
  }
}

function remoteTarget(target: WorkspaceCopyTarget): string {
  return target.sshUser === null || target.sshUser.length === 0
    ? target.host
    : `${target.sshUser}@${target.host}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function validateImageMimeType(mimeType: string): void {
  extensionForMime(mimeType);
}

export function validateUploadedFilename(filename: string): void {
  assertSafePathSegment(filename, "filename", "Uploaded filename is invalid");

  try {
    assertSafePathSegment(decodeURIComponent(filename), "filename", "Uploaded filename is invalid");
  } catch (error) {
    if (error instanceof URIError) {
      throw new RequestValidationError("Uploaded filename is invalid", [
        { path: ["filename"], message: "filename must be a single safe path segment" }
      ]);
    }

    throw error;
  }
}

function extensionForMime(mimeType: string): string {
  const ext = IMAGE_MIME_EXTENSIONS.get(mimeType.toLowerCase());

  if (ext === undefined) {
    throw new RequestValidationError("Unsupported image MIME type");
  }

  return ext;
}

function toDto(row: AttachmentRow): ImageAttachmentDto {
  return {
    id: row.id,
    kind: row.kind,
    mimeType: row.mime_type,
    filename: row.filename,
    size: row.size,
    localPath: row.local_path,
    workspacePath: row.workspace_path,
    createdAt: row.created_at
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Filesystem operation failed";
}
