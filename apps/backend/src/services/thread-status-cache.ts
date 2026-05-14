import type { ThreadDto } from "@agentmesh/shared";

/**
 * In-memory cache for thread statuses.
 * After a backend restart the cache is empty, so all threads
 * initially appear as "notLoaded" until they are synced or
 * imported from Codex.
 */
export class ThreadStatusCache {
  private readonly statuses = new Map<string, string>();

  /** Set the status for a local thread ID. */
  public set(threadId: string, status: string): void {
    this.statuses.set(threadId, status);
  }

  /** Remove the status entry (thread becomes "notLoaded"). */
  public delete(threadId: string): void {
    this.statuses.delete(threadId);
  }

  public setMany(entries: ReadonlyArray<readonly [threadId: string, status: string]>): void {
    for (const [threadId, status] of entries) {
      this.statuses.set(threadId, status);
    }
  }

  /**
   * Returns the cached status, or `null` if no entry exists
   * (meaning the thread has not been loaded since backend start).
   */
  public get(threadId: string): string | null {
    return this.statuses.get(threadId) ?? null;
  }

  /** Bulk-populate from a list of ThreadDto (used during sync). */
  public populateFromDtos(dtos: readonly ThreadDto[]): void {
    for (const dto of dtos) {
      if (dto.status !== null && dto.status !== "notLoaded") {
        this.statuses.set(dto.id, dto.status);
      }
    }
  }

  public markAllNotLoaded(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      this.statuses.set(threadId, "notLoaded");
    }
  }
}
