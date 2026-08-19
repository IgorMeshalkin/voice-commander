import { Pool } from "pg";

export interface AudioFileEntity {
  filename: string;
  savedAt: Date;
  durationMs: number;
  sizeBytes: number;
}

export interface StoredAudioFile extends AudioFileEntity {
  id: string;
}

export interface AudioFilePage {
  items: StoredAudioFile[];
  totalItems: number;
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
        size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0)
      )
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

  async listAudioFiles(
    page: number,
    pageSize: number,
    sort: "asc" | "desc",
  ): Promise<AudioFilePage> {
    const direction = sort === "asc" ? "ASC" : "DESC";
    const offset = (page - 1) * pageSize;
    const [itemsResult, countResult] = await Promise.all([
      this.pool.query<{
        id: string;
        filename: string;
        saved_at: Date;
        duration_ms: string;
        size_bytes: string;
      }>(
        `
          SELECT id, filename, saved_at, duration_ms, size_bytes
          FROM audio_files
          ORDER BY saved_at ${direction}, id ${direction}
          LIMIT $1 OFFSET $2
        `,
        [pageSize, offset],
      ),
      this.pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM audio_files"),
    ]);

    return {
      items: itemsResult.rows.map((row) => ({
        id: row.id,
        filename: row.filename,
        savedAt: row.saved_at,
        durationMs: Number(row.duration_ms),
        sizeBytes: Number(row.size_bytes),
      })),
      totalItems: Number(countResult.rows[0]?.count ?? 0),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
