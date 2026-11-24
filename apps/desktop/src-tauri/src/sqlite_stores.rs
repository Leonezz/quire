use crate::db::Db;
use crate::types::{
    AgentContext, AgentSession, AgentSessionSummary, AgentToolRow, AgentTurnRecord, Creator,
    ItemRecord, ItemSignals, MaterialMeta, ReaderPayload, ReadingEvent, ReadingStats, SourceRecord,
    TagCount,
};
use chrono::{Datelike, Duration, Local, TimeZone, Utc};
use rand::RngCore;
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub fn random_hex_16() -> String {
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

// ---------------------------------------------------------------------------
// ItemStore
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reader: Option<ReaderPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub markdown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    pub external_id: String,
    pub title: String,
    pub link: String,
    pub published_at: String,
    pub gist: String,
    pub reading_minutes: u32,
    pub signals: ItemSignals,
    pub summary_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<ItemContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<MaterialMeta>,
}

#[derive(Clone)]
pub struct ItemStore {
    db: Arc<Db>,
}

const ITEM_COLS: &str = "id, source_id, source_title, source_kind, external_id, title, gist, link, published_at, fetched_at, reading_minutes, signals, summary_only, opened_at, finished_at, queued_at, queue_position, dismissed_at, material_id, introduced_by, kept_at";

fn item_id_for(source_id: &str, external_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{source_id}\0{external_id}").as_bytes());
    hex::encode(hasher.finalize())[..16].to_string()
}

fn state_of(
    queued_at: &Option<String>,
    dismissed_at: &Option<String>,
    opened_at: &Option<String>,
    kept_at: &Option<String>,
) -> &'static str {
    if queued_at.is_some() {
        "queued"
    } else if dismissed_at.is_some() {
        "dismissed"
    } else if opened_at.is_some() {
        "opened"
    } else if kept_at.is_some() {
        "kept"
    } else {
        "undecided"
    }
}

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<ItemRecord> {
    let signals_raw: String = row.get(11)?;
    let signals: ItemSignals = serde_json::from_str(&signals_raw).unwrap_or_default();
    let summary_int: i64 = row.get(12)?;
    let introduced: Option<String> = row.get(19)?;
    Ok(ItemRecord {
        id: row.get(0)?,
        source_id: row.get(1)?,
        source_title: row.get(2)?,
        source_kind: row.get(3)?,
        title: row.get(5)?,
        gist: row.get(6)?,
        link: row.get(7)?,
        published_at: row.get(8)?,
        fetched_at: row.get(9)?,
        reading_minutes: row.get::<_, i64>(10)?.max(0) as u32,
        signals,
        summary_only: summary_int == 1,
        opened_at: row.get(13)?,
        finished_at: row.get(14)?,
        queued_at: row.get(15)?,
        queue_position: row.get(16)?,
        dismissed_at: row.get(17)?,
        material_id: row.get(18)?,
        introduced_by: introduced.filter(|s| s == "agent"),
        kept_at: row.get(20)?,
    })
}

impl ItemStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    pub fn upsert(&self, source_id: &str, source_title: &str, source_kind: &str, inputs: &[ItemInput]) -> Result<u32, String> {
        let fetched_at = now_iso();
        self.db.with_conn(|conn| {
            let before: i64 = conn
                .query_row("SELECT COUNT(*) FROM items WHERE source_id = ?1", params![source_id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
            let res = (|| -> Result<(), String> {
                let mut stmt = conn
                    .prepare(&format!(
                        "INSERT INTO items ({ITEM_COLS}, state, content_reader_schema, content_reader, content_markdown, content_plain, meta)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'undecided', ?14, ?15, ?16, ?17, ?18)
                         ON CONFLICT (source_id, external_id) DO UPDATE SET
                           source_title = excluded.source_title, title = excluded.title, gist = excluded.gist, link = excluded.link,
                           published_at = excluded.published_at, reading_minutes = excluded.reading_minutes, signals = excluded.signals,
                           summary_only = excluded.summary_only, content_reader_schema = excluded.content_reader_schema,
                           content_reader = excluded.content_reader, content_markdown = excluded.content_markdown,
                           content_plain = excluded.content_plain, meta = excluded.meta"
                    ))
                    .map_err(|e| e.to_string())?;
                for input in inputs {
                    let id = item_id_for(source_id, &input.external_id);
                    let signals_json = serde_json::to_string(&input.signals).unwrap_or_else(|_| "{}".into());
                    let reader_schema = input.content.as_ref().and_then(|c| c.reader.as_ref().map(|r| r.schema.as_str()));
                    let reader_payload = input.content.as_ref().and_then(|c| c.reader.as_ref().map(|r| r.payload.as_str()));
                    let md = input.content.as_ref().and_then(|c| c.markdown.as_deref());
                    let plain = input.content.as_ref().and_then(|c| c.plain.as_deref());
                    let meta_json = input
                        .meta
                        .as_ref()
                        .and_then(|m| serde_json::to_string(m).ok())
                        .filter(|s| s != "{}");
                    stmt.execute(params![
                        id,
                        source_id,
                        source_title,
                        source_kind,
                        input.external_id,
                        input.title,
                        input.gist,
                        input.link,
                        input.published_at,
                        fetched_at,
                        input.reading_minutes as i64,
                        signals_json,
                        if input.summary_only { 1i64 } else { 0i64 },
                        reader_schema,
                        reader_payload,
                        md,
                        plain,
                        meta_json,
                    ])
                    .map_err(|e| e.to_string())?;
                }
                Ok(())
            })();
            match res {
                Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string())?,
                Err(err) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(err);
                }
            }
            let after: i64 = conn
                .query_row("SELECT COUNT(*) FROM items WHERE source_id = ?1", params![source_id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            Ok((after - before).max(0) as u32)
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<ItemRecord>, String> {
        self.db.with_conn(|conn| {
            conn.query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE id = ?1"), params![id], row_to_item)
                .optional()
                .map_err(|e| e.to_string())
        })
    }

    pub fn content(&self, id: &str) -> Result<Option<ItemContent>, String> {
        self.db.with_conn(|conn| {
            let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT content_reader_schema, content_reader, content_markdown, content_plain FROM items WHERE id = ?1",
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((schema, payload, markdown, plain)) = row else {
                return Ok(None);
            };
            let reader = match (schema.as_deref(), payload) {
                (Some("reader.document.v1" | "reader.document.v2"), Some(p)) => Some(ReaderPayload {
                    schema: schema.unwrap(),
                    payload: p,
                }),
                _ => None,
            };
            if reader.is_none() && markdown.is_none() && plain.is_none() {
                return Ok(None);
            }
            Ok(Some(ItemContent { reader, markdown, plain }))
        })
    }

    pub fn meta(&self, id: &str) -> Result<Option<MaterialMeta>, String> {
        self.db.with_conn(|conn| {
            let raw: Option<Option<String>> = conn
                .query_row("SELECT meta FROM items WHERE id = ?1", params![id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            match raw.flatten() {
                Some(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
                None => Ok(None),
            }
        })
    }

    pub fn inbox(&self) -> Result<Vec<ItemRecord>, String> {
        self.db.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!("SELECT {ITEM_COLS} FROM items WHERE state = 'undecided' ORDER BY published_at DESC, id LIMIT 500"))
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], row_to_item).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    }

    pub fn queue(&self) -> Result<Vec<ItemRecord>, String> {
        self.db.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!("SELECT {ITEM_COLS} FROM items WHERE state = 'queued' ORDER BY queue_position ASC, id"))
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], row_to_item).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    }

    fn refresh_state(conn: &rusqlite::Connection, id: &str) -> Result<(), String> {
        let (queued, dismissed, opened, kept): (Option<String>, Option<String>, Option<String>, Option<String>) = conn
            .query_row(
                "SELECT queued_at, dismissed_at, opened_at, kept_at FROM items WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|e| e.to_string())?;
        let state = state_of(&queued, &dismissed, &opened, &kept);
        conn.execute("UPDATE items SET state = ?1 WHERE id = ?2", params![state, id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn decide(&self, id: &str, decision: &str) -> Result<ItemRecord, String> {
        let now = now_iso();
        self.db.with_conn(|conn| {
            let exists: Option<i32> = conn
                .query_row("SELECT 1 FROM items WHERE id = ?1", params![id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if exists.is_none() {
                return Err("ITEM_NOT_FOUND".into());
            }
            match decision {
                "queue" => {
                    let max: Option<i64> = conn
                        .query_row("SELECT MAX(queue_position) FROM items WHERE state = 'queued'", [], |r| r.get(0))
                        .map_err(|e| e.to_string())?;
                    conn.execute(
                        "UPDATE items SET queued_at = COALESCE(queued_at, ?1), queue_position = COALESCE(queue_position, ?2), dismissed_at = NULL WHERE id = ?3",
                        params![now, max.unwrap_or(-1) + 1, id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                "unqueue" => {
                    conn.execute("UPDATE items SET queued_at = NULL, queue_position = NULL WHERE id = ?1", params![id])
                        .map_err(|e| e.to_string())?;
                }
                "dismiss" => {
                    conn.execute(
                        "UPDATE items SET dismissed_at = COALESCE(dismissed_at, ?1), queued_at = NULL, queue_position = NULL WHERE id = ?2",
                        params![now, id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                "undismiss" => {
                    conn.execute("UPDATE items SET dismissed_at = NULL WHERE id = ?1", params![id])
                        .map_err(|e| e.to_string())?;
                }
                _ => return Err("IPC_INVALID_DECISION".into()),
            }
            Self::refresh_state(conn, id)?;
            conn.query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE id = ?1"), params![id], row_to_item)
                .map_err(|e| e.to_string())
        })
    }

    pub fn reorder(&self, ids: &[String]) -> Result<(), String> {
        let current: Vec<String> = self.queue()?.into_iter().map(|i| i.id).collect();
        let unique: HashSet<&String> = ids.iter().collect();
        let same = current.len() == ids.len()
            && unique.len() == ids.len()
            && ids.iter().all(|id| current.contains(id));
        if !same {
            return Err("QUEUE_ORDER_MISMATCH".into());
        }
        self.db.with_conn(|conn| {
            conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
            let res = (|| -> Result<(), String> {
                let mut stmt = conn
                    .prepare("UPDATE items SET queue_position = ?1 WHERE id = ?2")
                    .map_err(|e| e.to_string())?;
                for (pos, id) in ids.iter().enumerate() {
                    stmt.execute(params![pos as i64, id]).map_err(|e| e.to_string())?;
                }
                Ok(())
            })();
            match res {
                Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        })
    }

    pub fn mark_opened(&self, id: &str, material_id: &str) -> Result<ItemRecord, String> {
        let now = now_iso();
        self.db.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE items SET opened_at = COALESCE(opened_at, ?1), material_id = ?2 WHERE id = ?3",
                    params![now, material_id, id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("ITEM_NOT_FOUND".into());
            }
            Self::refresh_state(conn, id)?;
            conn.query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE id = ?1"), params![id], row_to_item)
                .map_err(|e| e.to_string())
        })
    }

    pub fn mark_kept(&self, id: &str, material_id: &str) -> Result<ItemRecord, String> {
        let now = now_iso();
        self.db.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE items SET kept_at = COALESCE(kept_at, ?1), material_id = ?2 WHERE id = ?3",
                    params![now, material_id, id],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("ITEM_NOT_FOUND".into());
            }
            Self::refresh_state(conn, id)?;
            conn.query_row(&format!("SELECT {ITEM_COLS} FROM items WHERE id = ?1"), params![id], row_to_item)
                .map_err(|e| e.to_string())
        })
    }

    pub fn unlink_material(&self, material_id: &str) -> Result<usize, String> {
        self.db.with_conn(|conn| {
            conn.execute("UPDATE items SET material_id = NULL WHERE material_id = ?1", params![material_id])
                .map_err(|e| e.to_string())
        })
    }

    pub fn mark_finished(&self, material_id: &str) -> Result<usize, String> {
        let now = now_iso();
        self.db.with_conn(|conn| {
            conn.execute(
                "UPDATE items SET finished_at = ?1 WHERE material_id = ?2 AND finished_at IS NULL",
                params![now, material_id],
            )
            .map_err(|e| e.to_string())
        })
    }

    pub fn search(&self, query: &str) -> Result<Vec<ItemRecord>, String> {
        let words: Vec<String> = query
            .to_lowercase()
            .split_whitespace()
            .filter(|w| !w.is_empty())
            .take(8)
            .map(String::from)
            .collect();
        if words.is_empty() {
            return Ok(Vec::new());
        }
        let clauses: Vec<String> = (0..words.len())
            .map(|i| {
                let p1 = i * 2 + 1;
                let p2 = i * 2 + 2;
                format!("(LOWER(title) LIKE ?{p1} ESCAPE '\\' OR LOWER(source_title) LIKE ?{p2} ESCAPE '\\')")
            })
            .collect();
        let sql = format!(
            "SELECT {ITEM_COLS} FROM items WHERE {} ORDER BY published_at DESC LIMIT 50",
            clauses.join(" AND ")
        );
        let mut bind_values: Vec<String> = Vec::with_capacity(words.len() * 2);
        for word in words {
            let escaped = word.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
            let pat = format!("%{escaped}%");
            bind_values.push(pat.clone());
            bind_values.push(pat);
        }
        self.db.with_conn(|conn| {
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let params_refs: Vec<&dyn rusqlite::ToSql> = bind_values.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            let rows = stmt.query_map(params_refs.as_slice(), row_to_item).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    }

    pub fn remove_undecided_of(&self, source_id: &str) -> Result<usize, String> {
        self.db.with_conn(|conn| {
            conn.execute(
                "DELETE FROM items WHERE source_id = ?1 AND state = 'undecided'",
                params![source_id],
            )
            .map_err(|e| e.to_string())
        })
    }
}

// ---------------------------------------------------------------------------
// SourceStore
// ---------------------------------------------------------------------------

pub struct SourceHealthUpdate<'a> {
    pub last_sync_at: &'a str,
    pub last_success_at: Option<&'a str>,
    pub last_error: Option<&'a str>,
    pub failure_count: u32,
    pub title: Option<&'a str>,
    pub site_url: Option<&'a str>,
}

#[derive(Clone)]
pub struct SourceStore {
    db: Arc<Db>,
}

const SOURCE_COLS: &str = "id, kind, locator, title, site_url, added_at, interval_minutes, last_sync_at, last_success_at, last_error, failure_count, paused_at";

fn health_of_conn(conn: &rusqlite::Connection, source_id: &str) -> Result<(u32, u32, f64), String> {
    let since = (Utc::now() - Duration::days(28)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let (item_count, kept_count, recent): (i64, Option<i64>, Option<i64>) = conn
        .query_row(
            "SELECT COUNT(*), SUM(material_id IS NOT NULL), SUM(published_at >= ?1) FROM items WHERE source_id = ?2",
            params![since, source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|e| e.to_string())?;
    let weekly = (((recent.unwrap_or(0) as f64) / 4.0) * 10.0).round() / 10.0;
    Ok((item_count.max(0) as u32, kept_count.unwrap_or(0).max(0) as u32, weekly))
}

fn row_to_source(conn: &rusqlite::Connection, row: &rusqlite::Row<'_>) -> Result<SourceRecord, String> {
    let id: String = row.get(0).map_err(|e| e.to_string())?;
    let (item_count, kept_count, weekly_rate) = health_of_conn(conn, &id)?;
    Ok(SourceRecord {
        id,
        kind: row.get(1).map_err(|e| e.to_string())?,
        locator: row.get(2).map_err(|e| e.to_string())?,
        title: row.get(3).map_err(|e| e.to_string())?,
        site_url: row.get(4).map_err(|e| e.to_string())?,
        added_at: row.get(5).map_err(|e| e.to_string())?,
        interval_minutes: row.get::<_, i64>(6).map_err(|e| e.to_string())?.max(1) as u32,
        last_sync_at: row.get(7).map_err(|e| e.to_string())?,
        last_success_at: row.get(8).map_err(|e| e.to_string())?,
        last_error: row.get(9).map_err(|e| e.to_string())?,
        failure_count: row.get::<_, i64>(10).map_err(|e| e.to_string())?.max(0) as u32,
        paused_at: row.get(11).map_err(|e| e.to_string())?,
        item_count,
        kept_count,
        weekly_rate,
    })
}

impl SourceStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    pub fn add(&self, kind: &str, locator: &str, title: &str, site_url: Option<&str>) -> Result<SourceRecord, String> {
        if self.by_locator(locator)?.is_some() {
            let label = if title.is_empty() { locator } else { title };
            return Err(format!("Already subscribed to {label}."));
        }
        let id = random_hex_16();
        let added_at = now_iso();
        self.db.with_conn(|conn| {
            conn.execute(
                &format!("INSERT INTO sources ({SOURCE_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 30, NULL, NULL, NULL, 0, NULL)"),
                params![id, kind, locator, title, site_url, added_at],
            )
            .map_err(|e| e.to_string())?;
            conn.query_row(&format!("SELECT {SOURCE_COLS} FROM sources WHERE id = ?1"), params![id], |r| Ok(row_to_source(conn, r)))
                .map_err(|e| e.to_string())?
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<SourceRecord>, String> {
        self.db.with_conn(|conn| {
            let found = conn
                .query_row(&format!("SELECT {SOURCE_COLS} FROM sources WHERE id = ?1"), params![id], |r| Ok(row_to_source(conn, r)))
                .optional()
                .map_err(|e| e.to_string())?;
            found.transpose()
        })
    }

    pub fn by_locator(&self, locator: &str) -> Result<Option<SourceRecord>, String> {
        self.db.with_conn(|conn| {
            let found = conn
                .query_row(&format!("SELECT {SOURCE_COLS} FROM sources WHERE locator = ?1"), params![locator], |r| Ok(row_to_source(conn, r)))
                .optional()
                .map_err(|e| e.to_string())?;
            found.transpose()
        })
    }

    pub fn list(&self) -> Result<Vec<SourceRecord>, String> {
        self.db.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!("SELECT {SOURCE_COLS} FROM sources ORDER BY added_at, rowid"))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok(row_to_source(conn, r)))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|e| e.to_string())??);
            }
            Ok(out)
        })
    }

    pub fn update_health(&self, id: &str, update: SourceHealthUpdate<'_>) -> Result<SourceRecord, String> {
        self.db.with_conn(|conn| {
            let changed = conn
                .execute(
                    "UPDATE sources SET last_sync_at = ?1, last_success_at = COALESCE(?2, last_success_at), last_error = ?3,
                     failure_count = ?4, title = COALESCE(?5, title), site_url = COALESCE(?6, site_url) WHERE id = ?7",
                    params![
                        update.last_sync_at,
                        update.last_success_at,
                        update.last_error,
                        update.failure_count as i64,
                        update.title,
                        update.site_url,
                        id
                    ],
                )
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("SOURCE_NOT_FOUND".into());
            }
            conn.query_row(&format!("SELECT {SOURCE_COLS} FROM sources WHERE id = ?1"), params![id], |r| Ok(row_to_source(conn, r)))
                .map_err(|e| e.to_string())?
        })
    }

    pub fn pause(&self, id: &str, paused: bool) -> Result<SourceRecord, String> {
        let paused_at = if paused { Some(now_iso()) } else { None };
        self.db.with_conn(|conn| {
            let changed = conn
                .execute("UPDATE sources SET paused_at = ?1 WHERE id = ?2", params![paused_at, id])
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("SOURCE_NOT_FOUND".into());
            }
            conn.query_row(&format!("SELECT {SOURCE_COLS} FROM sources WHERE id = ?1"), params![id], |r| Ok(row_to_source(conn, r)))
                .map_err(|e| e.to_string())?
        })
    }

    pub fn remove(&self, id: &str, items: &ItemStore) -> Result<(), String> {
        if self.get(id)?.is_none() {
            return Err("SOURCE_NOT_FOUND".into());
        }
        items.remove_undecided_of(id)?;
        self.db.with_conn(|conn| {
            conn.execute("DELETE FROM sources WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// EventStore
// ---------------------------------------------------------------------------

#[derive(Clone)]
pub struct EventStore {
    db: Arc<Db>,
}

impl EventStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    pub fn record(&self, kind: &str, reference: &str) -> Result<ReadingEvent, String> {
        let event = ReadingEvent {
            id: random_hex_16(),
            kind: kind.into(),
            r#ref: reference.into(),
            at: now_iso(),
        };
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO reading_events (id, kind, ref, at) VALUES (?1, ?2, ?3, ?4)",
                params![event.id, event.kind, event.r#ref, event.at],
            )
            .map_err(|e| e.to_string())?;
            Ok(event)
        })
    }

    pub fn stats(&self) -> Result<ReadingStats, String> {
        let local_now = Local::now();
        let today_midnight = Local
            .with_ymd_and_hms(local_now.year(), local_now.month(), local_now.day(), 0, 0, 0)
            .earliest()
            .unwrap_or(local_now);
        let offset_days = today_midnight.weekday().num_days_from_monday() as i64;
        let week_start = (today_midnight - Duration::days(offset_days)).with_timezone(&Utc);
        let last_week_start = week_start - Duration::days(7);
        let next_week_start = week_start + Duration::days(7);

        let ws_iso = week_start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let lws_iso = last_week_start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let nws_iso = next_week_start.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        self.db.with_conn(|conn| {
            let between = |kind: &str, from: &str, to: &str| -> Result<u32, String> {
                let n: i64 = conn
                    .query_row(
                        "SELECT COUNT(DISTINCT ref) FROM reading_events WHERE kind = ?1 AND at >= ?2 AND at < ?3",
                        params![kind, from, to],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                Ok(n.max(0) as u32)
            };
            Ok(ReadingStats {
                week_start: ws_iso.clone(),
                finished_this_week: between("finished", &ws_iso, &nws_iso)?,
                finished_last_week: between("finished", &lws_iso, &ws_iso)?,
                opened_this_week: between("opened", &ws_iso, &nws_iso)?,
            })
        })
    }
}

// ---------------------------------------------------------------------------
// MetaStore
// ---------------------------------------------------------------------------

pub const VALID_MATERIAL_KINDS: &[&str] = &[
    "webpage",
    "blogPost",
    "newsletter",
    "newsArticle",
    "journalArticle",
    "preprint",
    "conferencePaper",
    "book",
    "bookSection",
    "report",
    "thesis",
    "document",
    "note",
];

const VALID_CREATOR_ROLES: &[&str] = &["author", "editor", "translator", "contributor"];

pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut kept = Vec::new();
    for raw in tags {
        let trimmed: String = raw.trim().chars().take(40).collect::<String>().trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if seen.insert(lower) {
            kept.push(trimmed);
            if kept.len() == 20 {
                break;
            }
        }
    }
    kept
}

pub fn validate_and_merge_meta(
    current: &MaterialMeta,
    patch: &serde_json::Map<String, serde_json::Value>,
    material_id: &str,
    exists: impl Fn(&str) -> bool,
) -> Result<MaterialMeta, String> {
    let iso_re = Regex::new(r"^\d{4}(?:-\d{2}(?:-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?)?)?$").unwrap();
    let id_re = Regex::new(r"^[a-f0-9]{16}$").unwrap();
    let doi_re = Regex::new(r"(?i)^10\.\d{4,9}/\S+$").unwrap();
    let arxiv_re = Regex::new(r"(?i)^(?:\d{4}\.\d{4,5}|[a-z-]+/\d{7})(?:v\d+)?$").unwrap();
    let isbn_re = Regex::new(r"^[\dXx][\dXx -]{8,15}[\dXx]$").unwrap();
    let issn_re = Regex::new(r"^\d{4}-?\d{3}[\dXx]$").unwrap();

    let mut current_map: serde_json::Map<String, serde_json::Value> = match serde_json::to_value(current).map_err(|e| e.to_string())? {
        serde_json::Value::Object(m) => m,
        _ => serde_json::Map::new(),
    };

    let known = [
        "kind", "title", "shortTitle", "publication", "volume", "issue", "pages", "publisher",
        "place", "edition", "series", "language", "url", "abstract", "note", "extra", "creators",
        "date", "accessed", "doi", "arxivId", "isbn", "issn", "tags", "related",
    ];
    let unknown: Vec<&String> = patch.keys().filter(|k| !known.contains(&k.as_str())).collect();
    if !unknown.is_empty() {
        return Err(format!("Invalid metadata: unknown field(s): {}.", unknown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")));
    }

    for (key, raw) in patch {
        if raw.is_null() {
            continue;
        }
        let check_str = |name: &str, val: &serde_json::Value, max: usize| -> Result<String, String> {
            let s = val.as_str().ok_or_else(|| format!("Invalid metadata: {name} must be a string."))?;
            if s.chars().count() > max {
                return Err(format!("Invalid metadata: {name} is longer than {max} characters."));
            }
            Ok(s.trim().to_string())
        };

        match key.as_str() {
            "kind" => {
                let s = check_str("kind", raw, 64)?;
                if !s.is_empty() && !VALID_MATERIAL_KINDS.contains(&s.as_str()) {
                    return Err(format!("Invalid metadata: kind must be one of {}.", VALID_MATERIAL_KINDS.join(", ")));
                }
                if s.is_empty() {
                    current_map.remove(key);
                } else {
                    current_map.insert(key.clone(), serde_json::Value::String(s));
                }
            }
            "tags" => {
                let arr = raw.as_array().ok_or_else(|| "Invalid metadata: tags must be an array.".to_string())?;
                if arr.len() > 40 {
                    return Err("Invalid metadata: tags has more than 40 entries.".into());
                }
                let mut raw_tags = Vec::new();
                for (i, entry) in arr.iter().enumerate() {
                    raw_tags.push(check_str(&format!("tags[{i}]"), entry, 80)?);
                }
                let norm = normalize_tags(&raw_tags);
                if norm.is_empty() {
                    current_map.remove(key);
                } else {
                    current_map.insert(key.clone(), serde_json::to_value(norm).unwrap());
                }
            }
            "creators" => {
                let arr = raw.as_array().ok_or_else(|| "Invalid metadata: creators must be an array.".to_string())?;
                if arr.len() > 50 {
                    return Err("Invalid metadata: creators has more than 50 entries.".into());
                }
                let mut creators = Vec::new();
                for (i, item) in arr.iter().enumerate() {
                    let obj = item.as_object().ok_or_else(|| format!("Invalid metadata: creators[{i}] must be an object."))?;
                    for k in obj.keys() {
                        if !["role", "name", "given", "family"].contains(&k.as_str()) {
                            return Err(format!("Invalid metadata: creators[{i}] has unknown field(s): {k}."));
                        }
                    }
                    let role = obj.get("role").and_then(|v| v.as_str()).unwrap_or("");
                    if !VALID_CREATOR_ROLES.contains(&role) {
                        return Err(format!("Invalid metadata: creators[{i}].role must be one of {}.", VALID_CREATOR_ROLES.join(", ")));
                    }
                    let name = match obj.get("name") {
                        Some(v) => check_str(&format!("creators[{i}].name"), v, 2000)?,
                        None => String::new(),
                    };
                    if name.is_empty() {
                        return Err(format!("Invalid metadata: creators[{i}].name must not be empty."));
                    }
                    let given = match obj.get("given") {
                        Some(v) if !v.is_null() => {
                            let s = check_str(&format!("creators[{i}].given"), v, 2000)?;
                            if s.is_empty() { None } else { Some(s) }
                        }
                        _ => None,
                    };
                    let family = match obj.get("family") {
                        Some(v) if !v.is_null() => {
                            let s = check_str(&format!("creators[{i}].family"), v, 2000)?;
                            if s.is_empty() { None } else { Some(s) }
                        }
                        _ => None,
                    };
                    creators.push(Creator { role: role.into(), name, given, family });
                }
                if creators.is_empty() {
                    current_map.remove(key);
                } else {
                    current_map.insert(key.clone(), serde_json::to_value(creators).unwrap());
                }
            }
            "related" => {
                let arr = raw.as_array().ok_or_else(|| "Invalid metadata: related must be an array.".to_string())?;
                if arr.len() > 50 {
                    return Err("Invalid metadata: related has more than 50 entries.".into());
                }
                let mut seen = HashSet::new();
                let mut ids = Vec::new();
                for (i, item) in arr.iter().enumerate() {
                    let id = check_str(&format!("related[{i}]"), item, 16)?;
                    if !id_re.is_match(&id) {
                        return Err(format!("Invalid metadata: related contains \"{id}\", which is not a material id."));
                    }
                    if id == material_id {
                        return Err("Invalid metadata: a material cannot relate to itself.".into());
                    }
                    if seen.insert(id.clone()) {
                        ids.push(id);
                    }
                }
                let missing: Vec<&String> = ids.iter().filter(|id| !exists(id)).collect();
                if !missing.is_empty() {
                    return Err(format!(
                        "Invalid metadata: related names material(s) not in the library: {}.",
                        missing.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", ")
                    ));
                }
                if ids.is_empty() {
                    current_map.remove(key);
                } else {
                    current_map.insert(key.clone(), serde_json::to_value(ids).unwrap());
                }
            }
            "date" | "accessed" => {
                let s = check_str(key, raw, 40)?;
                if !s.is_empty() && !iso_re.is_match(&s) {
                    return Err(format!("Invalid metadata: {key} must be YYYY, YYYY-MM, YYYY-MM-DD or an ISO timestamp."));
                }
                if s.is_empty() {
                    current_map.remove(key);
                } else {
                    current_map.insert(key.clone(), serde_json::Value::String(s));
                }
            }
            "doi" | "arxivId" | "isbn" | "issn" => {
                let s = check_str(key, raw, 2000)?;
                if !s.is_empty() {
                    let ok = match key.as_str() {
                        "doi" => doi_re.is_match(&s),
                        "arxivId" => arxiv_re.is_match(&s),
                        "isbn" => isbn_re.is_match(&s),
                        "issn" => issn_re.is_match(&s),
                        _ => true,
                    };
                    if !ok {
                        return Err(format!("Invalid metadata: {key} does not look like a {key}."));
                    }
                }
                if s.is_empty() {
                    current_map.remove(key);
                } else {
                    let val = if key == "doi" { s.to_lowercase() } else { s };
                    current_map.insert(key.clone(), serde_json::Value::String(val));
                }
            }
            _ => {
                let max = if ["abstract", "note", "extra"].contains(&key.as_str()) { 20_000 } else { 2000 };
                let s = check_str(key, raw, max)?;
                if s.is_empty() {
                    current_map.remove(key);
                } else {
                    current_map.insert(key.clone(), serde_json::Value::String(s));
                }
            }
        }
    }

    serde_json::from_value(serde_json::Value::Object(current_map)).map_err(|e| e.to_string())
}

#[derive(Clone)]
pub struct MetaStore {
    db: Arc<Db>,
}

impl MetaStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    pub fn get(&self, material_id: &str) -> Result<Option<MaterialMeta>, String> {
        self.db.with_conn(|conn| {
            let raw: Option<String> = conn
                .query_row(
                    "SELECT overrides FROM material_meta WHERE material_id = ?1",
                    params![material_id],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match raw {
                Some(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
                None => Ok(None),
            }
        })
    }

    pub fn all(&self) -> Result<HashMap<String, MaterialMeta>, String> {
        self.db.with_conn(|conn| {
            let mut stmt = conn
                .prepare("SELECT material_id, overrides FROM material_meta")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            let mut out = HashMap::new();
            for row in rows {
                let (id, raw) = row.map_err(|e| e.to_string())?;
                if let Ok(meta) = serde_json::from_str(&raw) {
                    out.insert(id, meta);
                }
            }
            Ok(out)
        })
    }

    pub fn update(
        &self,
        material_id: &str,
        patch: &serde_json::Map<String, serde_json::Value>,
        exists: impl Fn(&str) -> bool,
    ) -> Result<MaterialMeta, String> {
        let current = self.get(material_id)?.unwrap_or_default();
        let next = validate_and_merge_meta(&current, patch, material_id, exists)?;
        let json = serde_json::to_string(&next).map_err(|e| e.to_string())?;
        if json == "{}" {
            self.remove(material_id)?;
            return Ok(next);
        }
        let updated_at = now_iso();
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO material_meta (material_id, overrides, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT (material_id) DO UPDATE SET overrides = excluded.overrides, updated_at = excluded.updated_at",
                params![material_id, json, updated_at],
            )
            .map_err(|e| e.to_string())?;
            Ok(next)
        })
    }

    pub fn tags(&self) -> Result<Vec<TagCount>, String> {
        let all = self.all()?;
        let mut counts: HashMap<String, u32> = HashMap::new();
        for meta in all.values() {
            if let Some(tags) = &meta.tags {
                for tag in tags {
                    *counts.entry(tag.clone()).or_insert(0) += 1;
                }
            }
        }
        let mut list: Vec<TagCount> = counts
            .into_iter()
            .map(|(tag, count)| TagCount { tag, count })
            .collect();
        list.sort_by(|a, b| {
            b.count
                .cmp(&a.count)
                .then_with(|| a.tag.to_lowercase().cmp(&b.tag.to_lowercase()))
        });
        Ok(list)
    }

    pub fn remove(&self, material_id: &str) -> Result<(), String> {
        self.db.with_conn(|conn| {
            conn.execute("DELETE FROM material_meta WHERE material_id = ?1", params![material_id])
                .map_err(|e| e.to_string())?;
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

pub struct TurnInput {
    pub role: String,
    pub text: String,
    pub task: Option<String>,
    pub tools: Option<Vec<AgentToolRow>>,
    pub sources: Option<Vec<String>>,
    pub status: Option<String>,
}

pub fn session_title_for(task: &str, text: &str, material_title: Option<&str>) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if !collapsed.is_empty() {
        let count = collapsed.chars().count();
        if count > 60 {
            let prefix: String = collapsed.chars().take(59).collect();
            return format!("{}…", prefix.trim_end());
        }
        return collapsed;
    }
    let mut chars = task.chars();
    let cap_task = match chars.next() {
        Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str()),
        None => "Ask".into(),
    };
    format!("{cap_task} · {}", material_title.unwrap_or("Library"))
}

#[derive(Clone)]
pub struct SessionStore {
    db: Arc<Db>,
}

const SESSION_COLS: &str = "s.id, s.title, s.context, s.thread_id, s.created_at, s.updated_at, (SELECT COUNT(*) FROM agent_turns t WHERE t.session_id = s.id) AS turn_count";

impl SessionStore {
    pub fn new(db: Arc<Db>) -> Self {
        Self { db }
    }

    pub fn create(&self, context: &AgentContext, title: &str) -> Result<AgentSession, String> {
        let id = random_hex_16();
        let at = now_iso();
        let clean_title = if title.trim().is_empty() { "Untitled" } else { title.trim() };
        let ctx_json = serde_json::to_string(context).map_err(|e| e.to_string())?;
        self.db.with_conn(|conn| {
            conn.execute(
                "INSERT INTO agent_sessions (id, title, context, thread_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
                params![id, clean_title, ctx_json, at, at],
            )
            .map_err(|e| e.to_string())
        })?;
        self.get(&id)?.ok_or_else(|| "SESSION_NOT_FOUND".into())
    }

    pub fn list(&self) -> Result<Vec<AgentSessionSummary>, String> {
        self.db.with_conn(|conn| {
            let mut stmt = conn
                .prepare(&format!("SELECT {SESSION_COLS} FROM agent_sessions s ORDER BY s.updated_at DESC, s.rowid DESC"))
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    let ctx_raw: String = r.get(2)?;
                    let context: AgentContext = serde_json::from_str(&ctx_raw).unwrap_or(AgentContext::Library);
                    Ok(AgentSessionSummary {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        context,
                        created_at: r.get(4)?,
                        updated_at: r.get(5)?,
                        turn_count: r.get::<_, i64>(6)?.max(0) as u32,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
        })
    }

    pub fn get(&self, id: &str) -> Result<Option<AgentSession>, String> {
        self.db.with_conn(|conn| {
            let session_row: Option<(String, String, String, Option<String>, String, String, i64)> = conn
                .query_row(
                    &format!("SELECT {SESSION_COLS} FROM agent_sessions s WHERE s.id = ?1"),
                    params![id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some((sid, title, ctx_raw, thread_id, created_at, updated_at, turn_count)) = session_row else {
                return Ok(None);
            };
            let context: AgentContext = serde_json::from_str(&ctx_raw).unwrap_or(AgentContext::Library);
            let mut stmt = conn
                .prepare("SELECT id, role, text, task, tools, sources, status, at FROM agent_turns WHERE session_id = ?1 ORDER BY at, rowid")
                .map_err(|e| e.to_string())?;
            let turns = stmt
                .query_map(params![id], |r| {
                    let tools_raw: Option<String> = r.get(4)?;
                    let sources_raw: Option<String> = r.get(5)?;
                    Ok(AgentTurnRecord {
                        id: r.get(0)?,
                        role: r.get(1)?,
                        text: r.get(2)?,
                        task: r.get(3)?,
                        tools: tools_raw.and_then(|s| serde_json::from_str(&s).ok()),
                        sources: sources_raw.and_then(|s| serde_json::from_str(&s).ok()),
                        status: r.get(6)?,
                        at: r.get(7)?,
                    })
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(Some(AgentSession {
                id: sid,
                title,
                context,
                created_at,
                updated_at,
                turn_count: turn_count.max(0) as u32,
                thread_id,
                turns,
            }))
        })
    }

    pub fn append_turn(&self, session_id: &str, turn: TurnInput) -> Result<AgentTurnRecord, String> {
        let id = random_hex_16();
        let at = now_iso();
        let record = AgentTurnRecord {
            id: id.clone(),
            role: turn.role,
            text: turn.text,
            task: turn.task,
            tools: turn.tools,
            sources: turn.sources,
            status: turn.status,
            at: at.clone(),
        };
        self.db.with_conn(|conn| {
            let exists: Option<i32> = conn
                .query_row("SELECT 1 FROM agent_sessions WHERE id = ?1", params![session_id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            if exists.is_none() {
                return Err("SESSION_NOT_FOUND".into());
            }
            conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
            let res = (|| -> Result<(), String> {
                let tools_json = record.tools.as_ref().and_then(|t| serde_json::to_string(t).ok());
                let sources_json = record.sources.as_ref().and_then(|s| serde_json::to_string(s).ok());
                conn.execute(
                    "INSERT INTO agent_turns (id, session_id, role, text, task, tools, sources, status, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![record.id, session_id, record.role, record.text, record.task, tools_json, sources_json, record.status, record.at],
                )
                .map_err(|e| e.to_string())?;
                conn.execute("UPDATE agent_sessions SET updated_at = ?1 WHERE id = ?2", params![at, session_id])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })();
            match res {
                Ok(()) => {
                    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                    Ok(record)
                }
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        })
    }

    pub fn set_thread(&self, session_id: &str, thread_id: &str) -> Result<(), String> {
        self.db.with_conn(|conn| {
            let changed = conn
                .execute("UPDATE agent_sessions SET thread_id = ?1 WHERE id = ?2", params![thread_id, session_id])
                .map_err(|e| e.to_string())?;
            if changed == 0 {
                return Err("SESSION_NOT_FOUND".into());
            }
            Ok(())
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        self.db.with_conn(|conn| {
            conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
            let res = (|| -> Result<(), String> {
                conn.execute("DELETE FROM agent_turns WHERE session_id = ?1", params![id])
                    .map_err(|e| e.to_string())?;
                conn.execute("DELETE FROM agent_sessions WHERE id = ?1", params![id])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })();
            match res {
                Ok(()) => conn.execute_batch("COMMIT").map_err(|e| e.to_string()),
                Err(e) => {
                    let _ = conn.execute_batch("ROLLBACK");
                    Err(e)
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ItemSignals;

    #[test]
    fn source_and_item_decisions_roundtrip() {
        let db = Arc::new(Db::open_in_memory().unwrap());
        let sources = SourceStore::new(db.clone());
        let items = ItemStore::new(db.clone());

        let src = sources.add("feed", "https://example.com/feed.xml", "Example", Some("https://example.com")).unwrap();
        let added = items
            .upsert(
                &src.id,
                &src.title,
                &src.kind,
                &[ItemInput {
                    external_id: "post-1".into(),
                    title: "First Post".into(),
                    link: "https://example.com/1".into(),
                    published_at: "2026-10-01T00:00:00.000Z".into(),
                    gist: "Hello world".into(),
                    reading_minutes: 3,
                    signals: ItemSignals::default(),
                    summary_only: false,
                    content: None,
                    meta: None,
                }],
            )
            .unwrap();
        assert_eq!(added, 1);
        let inbox = items.inbox().unwrap();
        assert_eq!(inbox.len(), 1);

        let queued = items.decide(&inbox[0].id, "queue").unwrap();
        assert!(queued.queued_at.is_some());
        assert_eq!(items.inbox().unwrap().len(), 0);
        assert_eq!(items.queue().unwrap().len(), 1);
    }
}
