import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

/**
 * 버전별 마이그레이션. 인덱스 + 1 = user_version. 스키마는 docs/PLAN.md, 저장소 결정은 ADR-003.
 * 이후 페이즈는 여기에 항목을 "추가"만 한다(적용된 항목은 수정 금지).
 */
const MIGRATIONS: readonly string[] = [
  // v1 — 텔레그램 update 중복 방지(ADR-004)
  `CREATE TABLE processed_updates (
     update_id INTEGER PRIMARY KEY,
     processed_at TEXT NOT NULL
   )`,
];

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version];
    if (sql === undefined) throw new Error(`Missing migration v${version + 1}`);
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}

export function openDb(file: string): Database.Database {
  const isMemory = file === ":memory:";
  if (!isMemory) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  if (!isMemory) db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

/** 처음 보는 update_id면 기록하고 true, 이미 처리한 것이면 false(ADR-004). */
export function markUpdateProcessed(db: Database.Database, updateId: number, now: Date): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO processed_updates (update_id, processed_at) VALUES (?, ?)")
    .run(updateId, now.toISOString());
  return result.changes === 1;
}
