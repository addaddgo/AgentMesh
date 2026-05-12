import type { WorkspaceUsageDto } from "@agentmesh/shared";

import type { DatabaseHandle } from "../db/index.js";

type DurationRow = {
  readonly app_server_id: string;
  readonly app_server_name: string;
  readonly workspace: string;
  readonly total_duration_ms: number;
  readonly turn_count: number;
};

export class WorkspaceUsageStatsService {
  public constructor(private readonly database: DatabaseHandle) {}

  public computeByWorkspace(): WorkspaceUsageDto[] {
    const rows = this.database.sqlite
      .prepare(
        `
          SELECT
            a.id AS app_server_id,
            a.name AS app_server_name,
            a.workspace,
            COALESCE(SUM(t.completed_at - t.started_at), 0) AS total_duration_ms,
            COUNT(t.id) AS turn_count
          FROM app_servers a
          LEFT JOIN threads th ON th.app_server_id = a.id
          LEFT JOIN turns t ON t.thread_id = th.id
            AND t.status = 'completed'
            AND t.started_at IS NOT NULL
            AND t.completed_at IS NOT NULL
          GROUP BY a.id, a.name, a.workspace
          ORDER BY total_duration_ms DESC, a.name ASC
        `
      )
      .all() as DurationRow[];

    return rows.map(toDto);
  }
}

function toDto(row: DurationRow): WorkspaceUsageDto {
  return {
    appServerId: row.app_server_id,
    appServerName: row.app_server_name,
    workspace: row.workspace,
    totalDurationMs: row.total_duration_ms,
    turnCount: row.turn_count
  };
}
