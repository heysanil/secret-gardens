import type { Database } from "bun:sqlite";
import {
  generateDek,
  type MasterKey,
  packWrappedDek,
  unpackWrappedDek,
  unwrapDek,
  wrapDek,
} from "@safe/crypto";
import { newId } from "../db";

/**
 * Per-project DEK management: creation, lookup (active + historical
 * versions), and rotation, backed by the `project_keys` table.
 *
 * Caching: unwrapped DEKs are memoized in plain Maps. Everything here is
 * synchronous (bun:sqlite + node:crypto), so there is no single-flight
 * concern. Per @safe/crypto's unwrapDek ownership contract, cached buffers
 * are handed out by reference and must NEVER be zeroed (`fill(0)`) — shares
 * may still be in flight; disposal is left to GC.
 */

export interface DekServiceDeps {
  db: Database;
  masterKey: MasterKey;
}

export interface ProjectDek {
  dek: Buffer;
  version: number;
}

export interface RotatedDek {
  oldVersion: number;
  newVersion: number;
  dek: Buffer;
}

/** Thrown when no matching project_keys row exists. */
export class ProjectKeyNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectKeyNotFoundError";
  }
}

export interface DekService {
  /** Active DEK for the project. */
  getDek(projectId: string): ProjectDek;
  /** A specific (possibly retired) DEK version — decrypts historical records. */
  getDekVersion(projectId: string, version: number): ProjectDek;
  /** First DEK for a new project: inserts the active v1 row. */
  createProjectDek(projectId: string): ProjectDek;
  /** New active version n+1; the old row is marked retired (kept for history). */
  rotateDek(projectId: string): RotatedDek;
  /** Drops all cached DEKs for the project (rotation handles its own cache). */
  invalidate(projectId: string): void;
}

interface ProjectKeyRow {
  version: number;
  wrapped_dek: string;
  wrap_nonce: string;
  wrap_tag: string;
  kek_id: string;
}

const ROW_COLUMNS = "version, wrapped_dek, wrap_nonce, wrap_tag, kek_id";

export function createDekService(deps: DekServiceDeps): DekService {
  const { db, masterKey } = deps;

  /** projectId → active DEK. */
  const activeCache = new Map<string, ProjectDek>();
  /** `${projectId}:${version}` → DEK (active and retired alike). */
  const versionCache = new Map<string, Buffer>();

  function unwrapRow(projectId: string, row: ProjectKeyRow): Buffer {
    const wrapped = unpackWrappedDek({
      wrapped: row.wrapped_dek,
      nonce: row.wrap_nonce,
      tag: row.wrap_tag,
      kekId: row.kek_id,
    });
    return unwrapDek(masterKey, wrapped, projectId);
  }

  function prime(projectId: string, dek: Buffer, version: number): ProjectDek {
    const entry: ProjectDek = { dek, version };
    activeCache.set(projectId, entry);
    versionCache.set(`${projectId}:${version}`, dek);
    return entry;
  }

  function insertKeyRow(projectId: string, dek: Buffer, version: number): void {
    const packed = packWrappedDek(wrapDek(masterKey, dek, projectId));
    db.run(
      `INSERT INTO project_keys
         (id, project_id, version, wrapped_dek, wrap_nonce, wrap_tag, kek_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      [
        newId("pk"),
        projectId,
        version,
        packed.wrapped,
        packed.nonce,
        packed.tag,
        packed.kekId,
      ],
    );
  }

  return {
    getDek(projectId) {
      const cached = activeCache.get(projectId);
      if (cached !== undefined) {
        return cached;
      }
      const row = db
        .query<ProjectKeyRow, [string]>(
          `SELECT ${ROW_COLUMNS} FROM project_keys
           WHERE project_id = ? AND status = 'active'`,
        )
        .get(projectId);
      if (row === null) {
        throw new ProjectKeyNotFoundError(
          `no active DEK for project ${projectId}`,
        );
      }
      return prime(projectId, unwrapRow(projectId, row), row.version);
    },

    getDekVersion(projectId, version) {
      const cacheKey = `${projectId}:${version}`;
      const cached = versionCache.get(cacheKey);
      if (cached !== undefined) {
        return { dek: cached, version };
      }
      const row = db
        .query<ProjectKeyRow, [string, number]>(
          `SELECT ${ROW_COLUMNS} FROM project_keys
           WHERE project_id = ? AND version = ?`,
        )
        .get(projectId, version);
      if (row === null) {
        throw new ProjectKeyNotFoundError(
          `no DEK version ${version} for project ${projectId}`,
        );
      }
      const dek = unwrapRow(projectId, row);
      versionCache.set(cacheKey, dek);
      return { dek, version };
    },

    createProjectDek(projectId) {
      const dek = generateDek();
      insertKeyRow(projectId, dek, 1);
      return prime(projectId, dek, 1);
    },

    rotateDek(projectId) {
      const dek = generateDek();
      let oldVersion = 0;
      const rotate = db.transaction(() => {
        const row = db
          .query<{ version: number }, [string]>(
            `SELECT version FROM project_keys
             WHERE project_id = ? AND status = 'active'`,
          )
          .get(projectId);
        if (row === null) {
          throw new ProjectKeyNotFoundError(
            `no active DEK for project ${projectId}`,
          );
        }
        oldVersion = row.version;
        db.run(
          `UPDATE project_keys SET status = 'retired'
           WHERE project_id = ? AND version = ?`,
          [projectId, oldVersion],
        );
        insertKeyRow(projectId, dek, oldVersion + 1);
      });
      rotate();
      const newVersion = oldVersion + 1;
      // Re-prime: the active entry now points at the new version. Retired
      // version cache entries stay — they still decrypt historical records.
      prime(projectId, dek, newVersion);
      return { oldVersion, newVersion, dek };
    },

    invalidate(projectId) {
      activeCache.delete(projectId);
      const prefix = `${projectId}:`;
      for (const key of versionCache.keys()) {
        if (key.startsWith(prefix)) {
          versionCache.delete(key);
        }
      }
    },
  };
}
