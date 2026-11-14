import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { config } from './config.js';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  /** All of it happens, or none of it does. Money moves only inside one of these. */
  transaction<T>(work: (tx: Pick<Db, 'query'>) => Promise<T>): Promise<T>;
}

/**
 * PGlite is a single-process database, so two processes opening the same folder
 * would corrupt it. This lock turns that mistake into a clear error message.
 */
function acquireLock(): () => void {
  fs.mkdirSync(path.dirname(config.lockFile), { recursive: true });
  if (fs.existsSync(config.lockFile)) {
    const pid = Number(fs.readFileSync(config.lockFile, 'utf8'));
    let alive = false;
    if (pid && pid !== process.pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new Error(`The database is in use by process ${pid}. Stop the PeerBeats server first, then try again.`);
    }
  }
  fs.writeFileSync(config.lockFile, String(process.pid));
  return () => fs.rmSync(config.lockFile, { force: true });
}

async function openPglite(): Promise<Db> {
  const release = acquireLock();
  fs.mkdirSync(config.pgliteDir, { recursive: true });
  const client = new PGlite(config.pgliteDir);
  await client.waitReady;
  return {
    query: async <T,>(sql: string, params: unknown[] = []) => {
      const result = await client.query<T>(sql, params as any[]);
      return { rows: result.rows };
    },
    exec: async (sql) => {
      await client.exec(sql);
    },
    transaction: async <T,>(work: (tx: Pick<Db, 'query'>) => Promise<T>) =>
      (await client.transaction(async (tx) =>
        work({
          query: async <R,>(sql: string, params: unknown[] = []) => {
            const result = await tx.query<R>(sql, params as any[]);
            return { rows: result.rows };
          },
        }),
      )) as T,
    close: async () => {
      await client.close();
      release();
    },
  };
}

async function openPostgres(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url });
  return {
    query: async <T,>(sql: string, params: unknown[] = []) => {
      const result = await pool.query(sql, params as any[]);
      return { rows: result.rows as T[] };
    },
    exec: async (sql) => {
      await pool.query(sql);
    },
    transaction: async <T,>(work: (tx: Pick<Db, 'query'>) => Promise<T>) => {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await work({
          query: async <R,>(sql: string, params: unknown[] = []) => {
            const res = await client.query(sql, params as any[]);
            return { rows: res.rows as R[] };
          },
        });
        await client.query('commit');
        return result;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    close: async () => {
      await pool.end();
    },
  };
}

export async function openDb(): Promise<Db> {
  const db = config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite();
  await db.exec(fs.readFileSync(config.schemaFile, 'utf8'));
  return db;
}
