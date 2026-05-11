import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type { AppServerDto, SkillDto, SkillSyncResultDto, TargetSkillDto } from "@agentmesh/shared";

import type { BackendConfig } from "../config.js";
import type { DatabaseHandle } from "../db/index.js";
import { FilesystemError, NotFoundError, RequestValidationError, SshError } from "../errors.js";
import type { EventService } from "./events.js";
import { assertPathInside, assertSafePathSegment } from "./filesystem-safety.js";

const SKILL_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

type SkillRecord = SkillDto & {
  readonly sourcePath: string;
};

export type SkillCopyTarget = Pick<
  AppServerDto,
  "id" | "hostKind" | "host" | "sshUser" | "sshPort" | "workspace"
>;

export interface SkillDirectoryCopier {
  copySkill(sourcePath: string, target: SkillCopyTarget, skillName: string): string;
}

export class DefaultSkillDirectoryCopier implements SkillDirectoryCopier {
  public copySkill(sourcePath: string, target: SkillCopyTarget, skillName: string): string {
    validateSkillName(skillName);

    if (target.hostKind === "ssh") {
      return copySkillToRemote(sourcePath, target, skillName);
    }

    return copySkillToLocal(sourcePath, target.workspace, skillName);
  }
}

export class SkillService {
  public constructor(
    private readonly database: DatabaseHandle,
    private readonly config: BackendConfig,
    private readonly events: EventService,
    private readonly copier: SkillDirectoryCopier = new DefaultSkillDirectoryCopier()
  ) {}

  public list(): SkillDto[] {
    return this.scanSkills().map(({ name, description }) => ({ name, description }));
  }

  public sync(input: {
    readonly skillNames: readonly string[];
    readonly appServerIds: readonly string[];
  }): SkillSyncResultDto[] {
    if (input.skillNames.length === 0) {
      throw new RequestValidationError("At least one skill is required", [
        { path: ["skillNames"], message: "Select at least one skill" }
      ]);
    }

    if (input.appServerIds.length === 0) {
      throw new RequestValidationError("At least one app server is required", [
        { path: ["appServerIds"], message: "Select at least one app server" }
      ]);
    }

    const skills = this.skillsByName();
    const targets = input.appServerIds.map((id) => this.getAppServer(id));
    const results: SkillSyncResultDto[] = [];

    for (const skillName of input.skillNames) {
      validateSkillName(skillName);
      const skill = skills.get(skillName);

      if (skill === undefined) {
        throw new NotFoundError(`Skill not found: ${skillName}`);
      }

      for (const target of targets) {
        results.push(this.syncOne(skill, target));
      }
    }

    this.events.publish({
      type: "skill.sync_completed",
      payload: { results }
    });

    return results;
  }

  public listTargetSkills(appServerId: string): TargetSkillDto[] {
    const target = this.getAppServer(appServerId);
    return target.hostKind === "ssh" ? listRemoteTargetSkills(target) : listLocalTargetSkills(target.workspace);
  }

  public deleteTargetSkill(appServerId: string, skillName: string): void {
    validateSkillName(skillName);
    const target = this.getAppServer(appServerId);
    if (target.hostKind === "ssh") {
      deleteRemoteTargetSkill(target, skillName);
      return;
    }

    deleteLocalTargetSkill(target.workspace, skillName);
  }

  private syncOne(skill: SkillRecord, target: SkillCopyTarget): SkillSyncResultDto {
    try {
      assertPathInside(
        this.config.skillsRoot,
        skill.sourcePath,
        "Skill source must be under configured skills root"
      );
      const targetPath = this.copier.copySkill(skill.sourcePath, target, skill.name);
      return {
        skillName: skill.name,
        appServerId: target.id,
        status: "synced",
        targetPath,
        error: null
      };
    } catch (error) {
      return {
        skillName: skill.name,
        appServerId: target.id,
        status: "failed",
        targetPath: targetSkillPath(target.workspace, skill.name),
        error: error instanceof Error ? error.message : "Skill sync failed"
      };
    }
  }

  private scanSkills(): SkillRecord[] {
    let entries: fs.Dirent[];

    try {
      entries = fs.readdirSync(this.config.skillsRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return [];
      }

      throw new FilesystemError(errorMessage(error));
    }

    const skills = entries
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => this.readSkill(entry.name));

    return skills.sort((left, right) => left.name.localeCompare(right.name));
  }

  private readSkill(directoryName: string): SkillRecord[] {
    assertSafePathSegment(directoryName, "skillDirectory", "Skill directory is invalid");
    const sourcePath = path.join(this.config.skillsRoot, directoryName);
    const skillFile = path.join(sourcePath, "SKILL.md");

    if (!isImmediateChild(this.config.skillsRoot, sourcePath) || !fs.existsSync(skillFile)) {
      return [];
    }

    let markdown: string;

    try {
      markdown = fs.readFileSync(skillFile, "utf8");
    } catch (error) {
      throw new FilesystemError(errorMessage(error));
    }

    const frontMatter = parseFrontMatter(markdown);
    const name = normalizeSkillName(frontMatter.name, directoryName);

    return [
      {
        name,
        description: frontMatter.description ?? "",
        sourcePath
      }
    ];
  }

  private skillsByName(): Map<string, SkillRecord> {
    const map = new Map<string, SkillRecord>();

    for (const skill of this.scanSkills()) {
      if (map.has(skill.name)) {
        throw new RequestValidationError(`Duplicate skill name: ${skill.name}`);
      }

      map.set(skill.name, skill);
    }

    return map;
  }

  private getAppServer(id: string): SkillCopyTarget {
    const row = this.database.sqlite
      .prepare(
        `
          SELECT id, host_kind, host, ssh_user, ssh_port, workspace
          FROM app_servers
          WHERE id = ?
        `
      )
      .get(id) as
      | {
          readonly id: string;
          readonly host_kind: AppServerDto["hostKind"];
          readonly host: string;
          readonly ssh_user: string | null;
          readonly ssh_port: number | null;
          readonly workspace: string;
        }
      | undefined;

    if (row === undefined) {
      throw new NotFoundError("App server not found");
    }

    return {
      id: row.id,
      hostKind: row.host_kind,
      host: row.host,
      sshUser: row.ssh_user,
      sshPort: row.ssh_port,
      workspace: row.workspace
    };
  }
}

function copySkillToLocal(sourcePath: string, workspace: string, skillName: string): string {
  const destination = targetSkillPath(workspace, skillName);

  try {
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(sourcePath, destination, { recursive: true, force: false, errorOnExist: true });
  } catch (error) {
    throw new FilesystemError(errorMessage(error));
  }

  return destination;
}

function copySkillToRemote(sourcePath: string, target: SkillCopyTarget, skillName: string): string {
  const destination = targetSkillPath(target.workspace, skillName);
  const parent = path.posix.dirname(destination);
  const sshTarget = remoteTarget(target);
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(target.sshPort === null ? [] : ["-p", String(target.sshPort)]),
    sshTarget,
    `rm -rf ${shellQuote(destination)} && mkdir -p ${shellQuote(parent)}`
  ];
  const scpArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(target.sshPort === null ? [] : ["-P", String(target.sshPort)]),
    "-r",
    sourcePath,
    `${sshTarget}:${shellQuote(destination)}`
  ];

  runRemoteCommand("ssh", sshArgs);
  runRemoteCommand("scp", scpArgs);
  return destination;
}

function listLocalTargetSkills(workspace: string): TargetSkillDto[] {
  const root = targetSkillsRoot(workspace);
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw new FilesystemError(errorMessage(error));
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => SKILL_NAME_PATTERN.test(entry.name))
    .map((entry) => {
      const skillPath = path.posix.join(root, entry.name);
      return { name: entry.name, path: skillPath, description: readLocalSkillDescription(skillPath) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function listRemoteTargetSkills(target: SkillCopyTarget): TargetSkillDto[] {
  const root = targetSkillsRoot(target.workspace);
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      ...(target.sshPort === null ? [] : ["-p", String(target.sshPort)]),
      remoteTarget(target),
      `if [ -d ${shellQuote(root)} ]; then find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n'; fi`
    ],
    { encoding: "utf8" }
  );

  if (result.error !== undefined) {
    throw new SshError(result.error.message);
  }
  if (result.status !== 0) {
    throw new SshError(result.stderr.trim() || "ssh failed while listing target skills");
  }

  return result.stdout
    .split(/\r?\n/u)
    .filter((name) => name.length > 0 && SKILL_NAME_PATTERN.test(name))
    .map((name) => {
      const skillPath = path.posix.join(root, name);
      return { name, path: skillPath, description: readRemoteSkillDescription(target, skillPath) };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function readLocalSkillDescription(skillPath: string): string {
  const skillFile = path.join(skillPath, "SKILL.md");

  try {
    return parseFrontMatter(fs.readFileSync(skillFile, "utf8")).description ?? "";
  } catch (error) {
    if (isNotFound(error)) {
      return "";
    }
    throw new FilesystemError(errorMessage(error));
  }
}

function readRemoteSkillDescription(target: SkillCopyTarget, skillPath: string): string {
  const result = spawnSync(
    "ssh",
    [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      ...(target.sshPort === null ? [] : ["-p", String(target.sshPort)]),
      remoteTarget(target),
      `if [ -f ${shellQuote(path.posix.join(skillPath, "SKILL.md"))} ]; then cat ${shellQuote(
        path.posix.join(skillPath, "SKILL.md")
      )}; fi`
    ],
    { encoding: "utf8" }
  );

  if (result.error !== undefined || result.status !== 0) {
    return "";
  }

  return parseFrontMatter(result.stdout).description ?? "";
}

function deleteLocalTargetSkill(workspace: string, skillName: string): void {
  const root = targetSkillsRoot(workspace);
  const destination = targetSkillPath(workspace, skillName);
  assertPathInside(root, destination, "Target skill must be under workspace .codex/skills");

  try {
    fs.rmSync(destination, { recursive: true, force: true });
  } catch (error) {
    throw new FilesystemError(errorMessage(error));
  }
}

function deleteRemoteTargetSkill(target: SkillCopyTarget, skillName: string): void {
  const root = targetSkillsRoot(target.workspace);
  const destination = targetSkillPath(target.workspace, skillName);
  const sshArgs = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    ...(target.sshPort === null ? [] : ["-p", String(target.sshPort)]),
    remoteTarget(target),
    `case ${shellQuote(destination)} in ${shellQuote(root)}/*) rm -rf ${shellQuote(destination)} ;; *) exit 2 ;; esac`
  ];
  runRemoteCommand("ssh", sshArgs);
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

function targetSkillPath(workspace: string, skillName: string): string {
  validateSkillName(skillName);
  return path.posix.join(targetSkillsRoot(workspace), skillName);
}

function targetSkillsRoot(workspace: string): string {
  return path.posix.join(workspace, ".codex", "skills");
}

function remoteTarget(target: SkillCopyTarget): string {
  return target.sshUser === null || target.sshUser.length === 0
    ? target.host
    : `${target.sshUser}@${target.host}`;
}

function validateSkillName(name: string): void {
  if (name.length === 0 || !SKILL_NAME_PATTERN.test(name) || name === "." || name === "..") {
    throw new RequestValidationError("Skill name is invalid", [
      {
        path: ["skillNames"],
        message: "Skill names must contain only letters, numbers, dots, underscores, or hyphens"
      }
    ]);
  }
}

function normalizeSkillName(frontMatterName: string | undefined, directoryName: string): string {
  const name = frontMatterName?.trim() || directoryName;
  validateSkillName(name);
  return name;
}

function parseFrontMatter(markdown: string): {
  readonly name?: string;
  readonly description?: string;
} {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) {
    return {};
  }

  const endMatch = /\r?\n---\r?\n/u.exec(markdown.slice(4));
  if (endMatch === null) {
    return {};
  }

  const body = markdown.slice(4, 4 + endMatch.index);
  const parsed: { name?: string; description?: string } = {};

  for (const line of body.split(/\r?\n/u)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/u.exec(line);

    if (match === null) {
      continue;
    }

    const key = match[1] ?? "";
    const value = unquoteYamlString((match[2] ?? "").trim());

    if (key === "name") {
      parsed.name = value;
    } else if (key === "description") {
      parsed.description = value;
    }
  }

  return parsed;
}

function unquoteYamlString(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function isImmediateChild(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Filesystem operation failed";
}
