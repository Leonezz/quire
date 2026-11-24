use crate::types::{Creator, MaterialMeta};
use rusqlite::{params, Connection};
use std::fs;
use std::path::Path;
use std::sync::Mutex;

pub const SCHEMA_VERSION: i32 = 4;
pub const DATABASE_FILE: &str = "quire.sqlite";

pub struct Db {
    conn: Mutex<Connection>,
}

const SCHEMA_V1: &str = "
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  locator TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  site_url TEXT,
  added_at TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL,
  last_sync_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  paused_at TEXT
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source_title TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  gist TEXT NOT NULL,
  link TEXT NOT NULL,
  published_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  reading_minutes INTEGER NOT NULL,
  signals TEXT NOT NULL,
  summary_only INTEGER NOT NULL,
  state TEXT NOT NULL,
  opened_at TEXT,
  finished_at TEXT,
  queued_at TEXT,
  queue_position INTEGER,
  dismissed_at TEXT,
  material_id TEXT,
  introduced_by TEXT,
  content_reader_schema TEXT,
  content_reader TEXT,
  content_markdown TEXT,
  content_plain TEXT,
  UNIQUE (source_id, external_id)
);
CREATE INDEX IF NOT EXISTS items_source_id ON items (source_id);
CREATE INDEX IF NOT EXISTS items_state ON items (state);
CREATE INDEX IF NOT EXISTS items_queue_position ON items (queue_position);
CREATE TABLE IF NOT EXISTS reading_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reading_events_at ON reading_events (at);
";

const SCHEMA_V2: &str = "
CREATE TABLE IF NOT EXISTS material_meta (
  material_id TEXT PRIMARY KEY,
  title TEXT,
  byline TEXT,
  published_at TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_turns (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  task TEXT,
  tools TEXT,
  status TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_turns_session ON agent_turns (session_id, at);
CREATE INDEX IF NOT EXISTS agent_sessions_updated ON agent_sessions (updated_at);
";

const SCHEMA_V4_META: &str = "
CREATE TABLE IF NOT EXISTS material_meta (
  material_id TEXT PRIMARY KEY,
  overrides TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
";

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for name in names {
        if name.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

fn migrate_to_v2(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "items", "kept_at")? {
        conn.execute_batch("ALTER TABLE items ADD COLUMN kept_at TEXT;")
            .map_err(|e| e.to_string())?;
    }
    conn.execute_batch(SCHEMA_V2).map_err(|e| e.to_string())
}

fn migrate_to_v3(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "agent_turns", "sources")? {
        conn.execute_batch("ALTER TABLE agent_turns ADD COLUMN sources TEXT;")
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn legacy_overrides_of(
    title: Option<String>,
    byline: Option<String>,
    published_at: Option<String>,
    tags_json: &str,
    note: Option<String>,
) -> MaterialMeta {
    let split_re = regex::Regex::new(r",|\band\b").expect("valid regex");
    let creators: Vec<Creator> = byline
        .as_deref()
        .map(|b| {
            split_re
                .split(b)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|name| Creator {
                    role: "author".into(),
                    name: name.into(),
                    given: None,
                    family: None,
                })
                .collect()
        })
        .unwrap_or_default();
    let tags: Vec<String> = serde_json::from_str(tags_json).unwrap_or_default();
    MaterialMeta {
        title: title.filter(|s| !s.is_empty()),
        creators: if creators.is_empty() { None } else { Some(creators) },
        date: published_at.filter(|s| !s.is_empty()),
        tags: if tags.is_empty() { None } else { Some(tags) },
        note: note.filter(|s| !s.is_empty()),
        ..Default::default()
    }
}

fn migrate_to_v4(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "items", "meta")? {
        conn.execute_batch("ALTER TABLE items ADD COLUMN meta TEXT;")
            .map_err(|e| e.to_string())?;
    }
    if has_column(conn, "material_meta", "overrides")? {
        return Ok(());
    }
    let rows: Vec<(String, Option<String>, Option<String>, Option<String>, String, Option<String>, String)> = {
        let mut stmt = conn
            .prepare("SELECT material_id, title, byline, published_at, tags, note, updated_at FROM material_meta")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        mapped.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
    };

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let outcome = (|| -> Result<(), String> {
        conn.execute_batch("DROP TABLE material_meta;")
            .map_err(|e| e.to_string())?;
        conn.execute_batch(SCHEMA_V4_META)
            .map_err(|e| e.to_string())?;
        let mut insert = conn
            .prepare("INSERT INTO material_meta (material_id, overrides, updated_at) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for (material_id, title, byline, published_at, tags, note, updated_at) in rows {
            let overrides = legacy_overrides_of(title, byline, published_at, &tags, note);
            let json = serde_json::to_string(&overrides).map_err(|e| e.to_string())?;
            if json != "{}" {
                insert
                    .execute(params![material_id, json, updated_at])
                    .map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA foreign_keys = ON;")
            .map_err(|e| e.to_string())?;
        Self::init(conn)
    }

    fn init(conn: Connection) -> Result<Self, String> {
        let version: i32 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "The library database is schema version {version}, newer than this build understands ({SCHEMA_VERSION}). Update Quire or restore an older database."
            ));
        }
        if version < 1 {
            conn.execute_batch(SCHEMA_V1).map_err(|e| e.to_string())?;
        }
        if version < 2 {
            migrate_to_v2(&conn)?;
        }
        if version < 3 {
            migrate_to_v3(&conn)?;
        }
        if version < 4 {
            migrate_to_v4(&conn)?;
        }
        if version < SCHEMA_VERSION {
            conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let guard = self.conn.lock().map_err(|_| "Database lock poisoned".to_string())?;
        f(&guard)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_v4_schema_and_migrates_v3_legacy_overrides() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA_V1).unwrap();
        migrate_to_v2(&conn).unwrap();
        migrate_to_v3(&conn).unwrap();
        conn.execute_batch("PRAGMA user_version = 3;").unwrap();
        conn.execute(
            "INSERT INTO material_meta (material_id, title, byline, published_at, tags, note, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params!["0123456789abcdef", "Custom Title", "Ada Lovelace and Alan Turing", "2026-09-19", "[\"ml\",\"systems\"]", "Great paper", "2026-09-19T00:00:00Z"],
        ).unwrap();

        let db = Db::init(conn).unwrap();
        db.with_conn(|c| {
            let v: i32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
            assert_eq!(v, SCHEMA_VERSION);
            let raw: String = c
                .query_row("SELECT overrides FROM material_meta WHERE material_id = '0123456789abcdef'", [], |r| r.get(0))
                .unwrap();
            let parsed: MaterialMeta = serde_json::from_str(&raw).unwrap();
            assert_eq!(parsed.title.as_deref(), Some("Custom Title"));
            assert_eq!(parsed.creators.as_ref().unwrap().len(), 2);
            assert_eq!(parsed.tags.as_ref().unwrap(), &vec!["ml".to_string(), "systems".to_string()]);
            Ok(())
        }).unwrap();
    }
}
