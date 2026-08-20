import { Pool } from "pg";

export type TaskStatus = "neutral" | "green" | "yellow" | "red" | "dead";
export type TaskListState = "all" | "in_progress" | "done" | "dead";

export interface AudioFileEntity {
  filename: string;
  savedAt: Date;
  durationMs: number;
  sizeBytes: number;
}

export interface StoredAudioFile extends AudioFileEntity {
  id: string;
  alias: string | null;
  isTranscribed: boolean;
  isReviewed: boolean;
}

export interface AudioFileForReview {
  id: string;
  filename: string;
}

export interface AudioFilePage {
  items: StoredAudioFile[];
  totalItems: number;
  totalSizeBytes: number;
}

export interface TaskEntity {
  id: string;
  title: string;
  description: string;
  links: string[];
  audioFileId: string;
  scheduledAt: Date | null;
  deadlineAt: Date | null;
  estimateDays: number;
  isCompleted: boolean;
}

export interface CreateTaskEntity {
  title: string;
  description: string;
  links: string[];
  audioFileId: string;
  scheduledAt: Date | null;
  deadlineAt: Date | null;
  estimateDays: number;
}

export interface TaskPage {
  items: TaskEntity[];
  totalItems: number;
}

export function calculateTaskStatus(
  task: Pick<TaskEntity, "scheduledAt" | "deadlineAt" | "estimateDays">,
  now = new Date(),
): TaskStatus {
  if (task.deadlineAt && task.deadlineAt.getTime() <= now.getTime()) return "dead";
  if (!task.scheduledAt) return "neutral";

  const remainingMs = task.scheduledAt.getTime() - now.getTime();
  if (remainingMs <= 0) return "red";

  const hourMs = 60 * 60 * 1000;
  const estimateMs = task.estimateDays === 0
    ? hourMs
    : task.estimateDays === 1
      ? 3 * hourMs
      : task.estimateDays === 2
        ? 8 * hourMs
        : (task.estimateDays - 1) * 24 * hourMs;

  if (remainingMs >= estimateMs * 2) return "neutral";
  if (remainingMs > estimateMs) return "green";
  return "yellow";
}

export class DatabaseService {
  private readonly pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://voice_commander:voice_commander@postgres:5432/voice_commander",
  });

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audio_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        filename TEXT NOT NULL UNIQUE,
        saved_at TIMESTAMPTZ NOT NULL,
        duration_ms BIGINT NOT NULL CHECK (duration_ms >= 0),
        size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
        is_transcribed BOOLEAN NOT NULL DEFAULT FALSE,
        is_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
        review_started_at TIMESTAMPTZ,
        reviewed_at TIMESTAMPTZ,
        review_attempts INTEGER NOT NULL DEFAULT 0,
        review_error TEXT,
        alias TEXT
      )
    `);
    await this.pool.query(`
      ALTER TABLE audio_files
      ADD COLUMN IF NOT EXISTS is_transcribed BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await this.pool.query(`
      ALTER TABLE audio_files
        ADD COLUMN IF NOT EXISTS is_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS review_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS review_attempts INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS review_error TEXT,
        ADD COLUMN IF NOT EXISTS alias TEXT
    `);
    await this.pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'audio_files' AND column_name = 'id' AND data_type = 'bigint'
        ) THEN
          ALTER TABLE audio_files DROP CONSTRAINT audio_files_pkey;
          ALTER TABLE audio_files ADD COLUMN id_uuid UUID NOT NULL DEFAULT gen_random_uuid();
          ALTER TABLE audio_files DROP COLUMN id;
          ALTER TABLE audio_files RENAME COLUMN id_uuid TO id;
          ALTER TABLE audio_files ADD PRIMARY KEY (id);
        END IF;

        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'audio_files' AND column_name = 'duration_seconds'
        ) THEN
          ALTER TABLE audio_files ADD COLUMN duration_ms BIGINT;
          UPDATE audio_files SET duration_ms = ROUND(duration_seconds * 1000);
          ALTER TABLE audio_files ALTER COLUMN duration_ms SET NOT NULL;
          ALTER TABLE audio_files ADD CONSTRAINT audio_files_duration_ms_check CHECK (duration_ms >= 0);
          ALTER TABLE audio_files DROP COLUMN duration_seconds;
        END IF;
      END
      $$
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        links TEXT[] NOT NULL DEFAULT '{}',
        audio_file_id UUID NOT NULL REFERENCES audio_files(id) ON DELETE CASCADE,
        scheduled_at TIMESTAMPTZ,
        deadline_at TIMESTAMPTZ,
        estimate_days INTEGER NOT NULL DEFAULT 0 CHECK (estimate_days BETWEEN 0 AND 15),
        is_completed BOOLEAN NOT NULL DEFAULT FALSE
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS tasks_audio_file_id_idx ON tasks (audio_file_id)
    `);
    await this.pool.query(`
      ALTER TABLE tasks
        ALTER COLUMN scheduled_at DROP NOT NULL,
        ALTER COLUMN deadline_at DROP NOT NULL
    `);
    await this.pool.query(`
      ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS estimate_days INTEGER NOT NULL DEFAULT 0
        CHECK (estimate_days BETWEEN 0 AND 15)
    `);
    await this.pool.query(`
      ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_estimate_days_check;
      ALTER TABLE tasks ADD CONSTRAINT tasks_estimate_days_check
        CHECK (estimate_days BETWEEN 0 AND 15)
    `);
    console.log("База данных готова");
  }

  async saveAudioFile(entity: AudioFileEntity): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO audio_files (filename, saved_at, duration_ms, size_bytes)
        VALUES ($1, $2, $3, $4)
      `,
      [entity.filename, entity.savedAt, entity.durationMs, entity.sizeBytes],
    );
  }

  async createTask(entity: CreateTaskEntity): Promise<TaskEntity> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      description: string;
      links: string[];
      audio_file_id: string;
      scheduled_at: Date | null;
      deadline_at: Date | null;
      estimate_days: number;
      is_completed: boolean;
    }>(
      `
        INSERT INTO tasks (title, description, links, audio_file_id, scheduled_at, deadline_at, estimate_days)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, title, description, links, audio_file_id, scheduled_at, deadline_at, estimate_days, is_completed
      `,
      [entity.title, entity.description, entity.links, entity.audioFileId, entity.scheduledAt, entity.deadlineAt, entity.estimateDays],
    );
    const row = result.rows[0];
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      links: row.links,
      audioFileId: row.audio_file_id,
      scheduledAt: row.scheduled_at,
      deadlineAt: row.deadline_at,
      estimateDays: row.estimate_days,
      isCompleted: row.is_completed,
    };
  }

  async getNearestActiveTask(): Promise<TaskEntity | null> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      description: string;
      links: string[];
      audio_file_id: string;
      scheduled_at: Date | null;
      deadline_at: Date | null;
      estimate_days: number;
      is_completed: boolean;
    }>(`
      SELECT id, title, description, links, audio_file_id, scheduled_at, deadline_at,
             estimate_days, is_completed
      FROM tasks
      WHERE NOT is_completed
        AND scheduled_at IS NOT NULL
        AND (deadline_at IS NULL OR deadline_at > NOW())
      ORDER BY ABS(EXTRACT(EPOCH FROM (scheduled_at - NOW()))) ASC, scheduled_at ASC, id ASC
      LIMIT 1
    `);
    const row = result.rows[0];
    return row ? {
      id: row.id,
      title: row.title,
      description: row.description,
      links: row.links,
      audioFileId: row.audio_file_id,
      scheduledAt: row.scheduled_at,
      deadlineAt: row.deadline_at,
      estimateDays: row.estimate_days,
      isCompleted: row.is_completed,
    } : null;
  }

  async listTasks(
    page: number,
    pageSize: number,
    sort: "asc" | "desc",
    dateFrom: string | null,
    dateTo: string | null,
    search: string | null,
    state: TaskListState,
  ): Promise<TaskPage> {
    const direction = sort === "asc" ? "ASC" : "DESC";
    const offset = (page - 1) * pageSize;
    const values = [pageSize, offset, dateFrom, dateTo, search, state];
    const [itemsResult, countResult] = await Promise.all([
      this.pool.query<{
        id: string;
        title: string;
        description: string;
        links: string[];
        audio_file_id: string;
        scheduled_at: Date | null;
        deadline_at: Date | null;
        estimate_days: number;
        is_completed: boolean;
      }>(
        `
          SELECT id, title, description, links, audio_file_id, scheduled_at, deadline_at,
                 estimate_days, is_completed
          FROM tasks
          WHERE ($3::date IS NULL OR scheduled_at >= $3::date)
            AND ($4::date IS NULL OR scheduled_at < $4::date + INTERVAL '1 day')
            AND ($5::text IS NULL OR title ILIKE '%' || $5 || '%' OR description ILIKE '%' || $5 || '%')
            AND ($6::text = 'all'
              OR ($6::text = 'done' AND is_completed)
              OR ($6::text = 'dead' AND NOT is_completed AND deadline_at <= NOW())
              OR ($6::text = 'in_progress' AND NOT is_completed AND (deadline_at IS NULL OR deadline_at > NOW())))
          ORDER BY scheduled_at ${direction} NULLS LAST, id ${direction}
          LIMIT $1 OFFSET $2
        `,
        values,
      ),
      this.pool.query<{ count: string }>(
        `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE ($1::date IS NULL OR scheduled_at >= $1::date)
            AND ($2::date IS NULL OR scheduled_at < $2::date + INTERVAL '1 day')
            AND ($3::text IS NULL OR title ILIKE '%' || $3 || '%' OR description ILIKE '%' || $3 || '%')
            AND ($4::text = 'all'
              OR ($4::text = 'done' AND is_completed)
              OR ($4::text = 'dead' AND NOT is_completed AND deadline_at <= NOW())
              OR ($4::text = 'in_progress' AND NOT is_completed AND (deadline_at IS NULL OR deadline_at > NOW())))
        `,
        [dateFrom, dateTo, search, state],
      ),
    ]);
    return {
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        links: row.links,
        audioFileId: row.audio_file_id,
        scheduledAt: row.scheduled_at,
        deadlineAt: row.deadline_at,
        estimateDays: row.estimate_days,
        isCompleted: row.is_completed,
      })),
      totalItems: Number(countResult.rows[0]?.count ?? 0),
    };
  }

  async updateTaskCompleted(id: string, isCompleted: boolean): Promise<TaskEntity | null> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      description: string;
      links: string[];
      audio_file_id: string;
      scheduled_at: Date | null;
      deadline_at: Date | null;
      estimate_days: number;
      is_completed: boolean;
    }>(
      `
        UPDATE tasks SET is_completed = $2
        WHERE id = $1
        RETURNING id, title, description, links, audio_file_id, scheduled_at, deadline_at,
                  estimate_days, is_completed
      `,
      [id, isCompleted],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      title: row.title,
      description: row.description,
      links: row.links,
      audioFileId: row.audio_file_id,
      scheduledAt: row.scheduled_at,
      deadlineAt: row.deadline_at,
      estimateDays: row.estimate_days,
      isCompleted: row.is_completed,
    } : null;
  }

  async updateTask(id: string, entity: Omit<CreateTaskEntity, "audioFileId">): Promise<TaskEntity | null> {
    const result = await this.pool.query<{
      id: string;
      title: string;
      description: string;
      links: string[];
      audio_file_id: string;
      scheduled_at: Date | null;
      deadline_at: Date | null;
      estimate_days: number;
      is_completed: boolean;
    }>(
      `
        UPDATE tasks
        SET title = $2, description = $3, links = $4, scheduled_at = $5,
            deadline_at = $6, estimate_days = $7
        WHERE id = $1
        RETURNING id, title, description, links, audio_file_id, scheduled_at, deadline_at,
                  estimate_days, is_completed
      `,
      [id, entity.title, entity.description, entity.links, entity.scheduledAt, entity.deadlineAt, entity.estimateDays],
    );
    const row = result.rows[0];
    return row ? {
      id: row.id,
      title: row.title,
      description: row.description,
      links: row.links,
      audioFileId: row.audio_file_id,
      scheduledAt: row.scheduled_at,
      deadlineAt: row.deadline_at,
      estimateDays: row.estimate_days,
      isCompleted: row.is_completed,
    } : null;
  }

  async markAudioFileTranscribed(filename: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `
        UPDATE audio_files
        SET is_transcribed = TRUE
        WHERE filename = $1 AND is_transcribed = FALSE
        RETURNING id
      `,
      [filename],
    );
    return result.rows[0]?.id ?? null;
  }

  async rollbackAudioFileTranscribed(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE audio_files SET is_transcribed = FALSE WHERE id = $1 AND is_reviewed = FALSE",
      [id],
    );
  }

  async markAudioFileReviewStarted(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        UPDATE audio_files
        SET review_started_at = NOW(), review_attempts = review_attempts + 1, review_error = NULL
        WHERE id = $1 AND is_transcribed = TRUE AND is_reviewed = FALSE AND review_attempts < 3
      `,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markAudioFileReviewed(id: string, alias: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE audio_files
        SET is_reviewed = TRUE, reviewed_at = NOW(), review_started_at = NULL,
            review_error = NULL, alias = $2
        WHERE id = $1
      `,
      [id, alias],
    );
  }

  async updateAudioFileAlias(id: string, alias: string): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE audio_files SET alias = $2 WHERE id = $1",
      [id, alias],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getAudioFilesByIds(ids: string[]): Promise<StoredAudioFile[]> {
    const files = await Promise.all(ids.map((id) => this.getAudioFile(id)));
    return files.filter((file): file is StoredAudioFile => file !== null);
  }

  async deleteAudioFiles(ids: string[]): Promise<number> {
    const result = await this.pool.query(
      "DELETE FROM audio_files WHERE id = ANY($1::uuid[])",
      [ids],
    );
    return result.rowCount ?? 0;
  }

  async markAudioFileReviewFailed(id: string, error: string): Promise<void> {
    await this.pool.query(
      `
        UPDATE audio_files
        SET review_started_at = NULL, review_error = $2
        WHERE id = $1
      `,
      [id, error.slice(0, 4000)],
    );
  }

  async listAudioFiles(
    page: number,
    pageSize: number,
    sort: "asc" | "desc",
    dateFrom: string | null,
    dateTo: string | null,
    search: string | null,
  ): Promise<AudioFilePage> {
    const direction = sort === "asc" ? "ASC" : "DESC";
    const offset = (page - 1) * pageSize;
    const [itemsResult, countResult] = await Promise.all([
      this.pool.query<{
        id: string;
        filename: string;
        alias: string | null;
        saved_at: Date;
        duration_ms: string;
        size_bytes: string;
        is_transcribed: boolean;
        is_reviewed: boolean;
      }>(
        `
          SELECT id, filename, alias, saved_at, duration_ms, size_bytes, is_transcribed, is_reviewed
          FROM audio_files
          WHERE ($3::date IS NULL OR saved_at >= $3::date)
            AND ($4::date IS NULL OR saved_at < $4::date + INTERVAL '1 day')
            AND ($5::text IS NULL OR alias ILIKE '%' || $5 || '%' OR filename ILIKE '%' || $5 || '%')
          ORDER BY
            CASE WHEN $5::text IS NOT NULL AND alias ILIKE '%' || $5 || '%' THEN 0 ELSE 1 END,
            saved_at ${direction}, id ${direction}
          LIMIT $1 OFFSET $2
        `,
        [pageSize, offset, dateFrom, dateTo, search],
      ),
      this.pool.query<{ count: string; total_size_bytes: string }>(
        `
          SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total_size_bytes
          FROM audio_files
          WHERE ($1::date IS NULL OR saved_at >= $1::date)
            AND ($2::date IS NULL OR saved_at < $2::date + INTERVAL '1 day')
            AND ($3::text IS NULL OR alias ILIKE '%' || $3 || '%' OR filename ILIKE '%' || $3 || '%')
        `,
        [dateFrom, dateTo, search],
      ),
    ]);

    return {
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        alias: row.alias,
        savedAt: row.saved_at,
        durationMs: Number(row.duration_ms),
        sizeBytes: Number(row.size_bytes),
        isTranscribed: row.is_transcribed,
        isReviewed: row.is_reviewed,
      })),
      totalItems: Number(countResult.rows[0]?.count ?? 0),
      totalSizeBytes: Number(countResult.rows[0]?.total_size_bytes ?? 0),
    };
  }

  async getAudioFile(id: string): Promise<StoredAudioFile | null> {
    const result = await this.pool.query<{
      id: string;
      filename: string;
      alias: string | null;
      saved_at: Date;
      duration_ms: string;
      size_bytes: string;
      is_transcribed: boolean;
      is_reviewed: boolean;
    }>(
      `
        SELECT id, filename, alias, saved_at, duration_ms, size_bytes, is_transcribed, is_reviewed
        FROM audio_files
        WHERE id = $1
      `,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      filename: row.filename,
      alias: row.alias,
      savedAt: row.saved_at,
      durationMs: Number(row.duration_ms),
      sizeBytes: Number(row.size_bytes),
      isTranscribed: row.is_transcribed,
      isReviewed: row.is_reviewed,
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
