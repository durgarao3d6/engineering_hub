'use strict';
// Hub-owned data only (clearances, later notes/tests). Never touches repos.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const cfg = require('./config');

fs.mkdirSync(cfg.dataDir, { recursive: true });
const DB_FILE = path.join(cfg.dataDir, 'hub.db');

// Never replace a damaged database with an empty one: that would look like "all my data is gone". Stop with instructions instead.
let db;
try {
  db = new DatabaseSync(DB_FILE);
  // WAL: readers and the one writer do not block each other. busy_timeout: a second writer waits instead of failing with "database is locked".
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
  const qc = Object.values(db.prepare('PRAGMA quick_check').get())[0];
  if (qc !== 'ok') throw new Error('integrity check said: ' + qc);
} catch (e) {
  const err = new Error('The hub database (' + DB_FILE + ') is damaged or unreadable: ' + e.message + '. It has NOT been changed. Stop the hub, then restore the newest backup with:  node "' + path.join(cfg.root, 'bin', 'restore.js') + '" --latest');
  err.code = 'DB_DAMAGED';
  throw err;
}

// Numbered migrations. Each runs once, inside a transaction, and the version is stored in the database (PRAGMA user_version).
// Never edit an old migration: add a new one at the end.
const MIGRATIONS = [
  // 1: baseline schema. Everything is IF NOT EXISTS so databases created before versioning upgrade cleanly.
  (d) => {
    d.exec(`
CREATE TABLE IF NOT EXISTS clearances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wt_key TEXT NOT NULL,
  wt_path TEXT NOT NULL,
  branch TEXT,
  repo_key TEXT,
  task_id INTEGER,
  category TEXT NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT,
  cleared_by TEXT NOT NULL,
  cleared_at TEXT NOT NULL,
  head TEXT,
  dirty_files INTEGER,
  where_state TEXT,
  restored_at TEXT,
  restored_by TEXT,
  restore_note TEXT
);
CREATE INDEX IF NOT EXISTS ix_clearances_key ON clearances(wt_key, restored_at);
CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wt_path TEXT NOT NULL, branch TEXT, repo_key TEXT, task_id INTEGER, live_path TEXT,
  prev_live_branch TEXT, started_by TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL,           -- running | done | done-with-warnings | failed | interrupted
  summary TEXT, steps TEXT NOT NULL DEFAULT '[]', patch_path TEXT
);
CREATE TABLE IF NOT EXISTS stashes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  move_id INTEGER, repo_key TEXT, live_path TEXT NOT NULL, stash_hash TEXT NOT NULL, message TEXT,
  prev_branch TEXT, file_count INTEGER, files TEXT, created_at TEXT NOT NULL,
  handled_at TEXT, handled_by TEXT, handled_note TEXT
);
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  section TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_notes_task ON notes(task_id, deleted_at);
CREATE TABLE IF NOT EXISTS plan_days (
  date TEXT PRIMARY KEY,
  raw_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  score_json TEXT
);
CREATE TABLE IF NOT EXISTS plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  pos INTEGER NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task',        -- task | review | meeting | other
  task_id INTEGER,
  confidence REAL,
  status TEXT NOT NULL DEFAULT 'todo',      -- todo | done | skipped
  done_at TEXT,
  skip_reason TEXT,
  carried_from INTEGER,
  draft_type TEXT, draft_title TEXT, draft_body TEXT,
  draft_state TEXT NOT NULL DEFAULT 'none', -- none | drafted | requested | created
  requested_at TEXT,
  created_task_id INTEGER
);
CREATE INDEX IF NOT EXISTS ix_plan_items_date ON plan_items(date, pos);
CREATE TABLE IF NOT EXISTS ai_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL,
  in_tokens INTEGER, out_tokens INTEGER, cache_read INTEGER, cache_write INTEGER,
  usd REAL, ms INTEGER, ok INTEGER NOT NULL, error TEXT
);
CREATE TABLE IF NOT EXISTS scorecard_snapshots (
  week TEXT NOT NULL, area TEXT NOT NULL, score REAL, metrics_json TEXT,
  PRIMARY KEY (week, area)
);`);
  },
  // 2: a plan line can be linked to several worktrees (a task may span repos), stored as JSON.
  (d) => { if (!d.prepare('PRAGMA table_info(plan_items)').all().some((c) => c.name === 'worktrees_json')) d.exec('ALTER TABLE plan_items ADD COLUMN worktrees_json TEXT'); },
  // 3: messages that arrived through the inbox (other programs never open this file), so a message is never applied twice.
  (d) => { d.exec('CREATE TABLE IF NOT EXISTS inbox_seen (msg_id TEXT PRIMARY KEY, at TEXT NOT NULL)'); },
  // 4: what happened to each proposed plan line when it was saved (accepted, changed, removed, added): a free accuracy test set from real use.
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS plan_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL, date TEXT NOT NULL, engine TEXT NOT NULL,
  text TEXT NOT NULL,
  proposed_task INTEGER, final_task INTEGER, confidence REAL,
  proposed_kind TEXT, final_kind TEXT,
  outcome TEXT NOT NULL,            -- accepted | changed | removed | added | no-match-agreed
  draft_edited INTEGER NOT NULL DEFAULT 0,
  wt_proposed INTEGER NOT NULL DEFAULT 0, wt_kept INTEGER NOT NULL DEFAULT 0, wt_added INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_plan_feedback_at ON plan_feedback(at);`);
  },
  // 5: the stash manager's history: every clear, restore, empty-trash and re-work of a git stash, with the reason.
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS stash_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_key TEXT, repo_path TEXT NOT NULL, hash TEXT NOT NULL, message TEXT,
  action TEXT NOT NULL,             -- cleared | restored | purged | reworked
  reason TEXT, patch_path TEXT, trash_ref TEXT, worktree TEXT, task_id INTEGER,
  files TEXT, file_count INTEGER, at TEXT NOT NULL, by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stash_actions_hash ON stash_actions(repo_path, hash);`);
  },
  // 6: the work planner: what a scheduled item looked like when accepted, the Later column, daily revisions, delegations and their history.
  (d) => {
    if (!d.prepare('PRAGMA table_info(plan_items)').all().some((c) => c.name === 'snap_json')) d.exec('ALTER TABLE plan_items ADD COLUMN snap_json TEXT');
    d.exec(`CREATE TABLE IF NOT EXISTS planner_later (task_id INTEGER PRIMARY KEY, added_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS planner_topics (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL COLLATE NOCASE UNIQUE, created_at TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS planner_revisions (date TEXT PRIMARY KEY, at TEXT NOT NULL, new_count INTEGER NOT NULL DEFAULT 0, changed_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS delegations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL, person TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('monitor','fire_and_forget')),
  note TEXT, expect_by TEXT, check_every_days INTEGER, next_check TEXT, wake_after_days INTEGER,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL,
  last_seen_json TEXT, last_seen_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at TEXT, closed_by TEXT, closed_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_delegations_open ON delegations(task_id) WHERE status = 'open';
CREATE TABLE IF NOT EXISTS delegation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delegation_id INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_delegation_events ON delegation_events(delegation_id, id);`);
  },
  // 7: AI auto-planning: cached analyses of work items, a record of each run and what you did with each proposal.
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS ai_analyses (
  task_id INTEGER NOT NULL, fingerprint TEXT NOT NULL, analysis_json TEXT NOT NULL, model TEXT, at TEXT NOT NULL,
  PRIMARY KEY (task_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS planner_ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, mode TEXT NOT NULL,
  items INTEGER NOT NULL DEFAULT 0, applied INTEGER NOT NULL DEFAULT 0, changed INTEGER NOT NULL DEFAULT 0, rejected INTEGER NOT NULL DEFAULT 0, usd REAL
);
CREATE TABLE IF NOT EXISTS planner_ai_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, task_id INTEGER NOT NULL, proposed TEXT, final TEXT, outcome TEXT NOT NULL, at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_planner_ai_feedback_run ON planner_ai_feedback(run_id);`);
  },
  // 8: QA packs prepared for the QA automation repository (what was written where; the files themselves live in the worktree).
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS qa_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT NOT NULL, specs TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL, base TEXT, files_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'prepared'
);`);
  },
  // 9: comment watch (unread comments on followed work items) and asks (who you are waiting on). Local only.
  (d) => {
    d.exec(`CREATE TABLE IF NOT EXISTS comment_watch (
  task_id INTEGER PRIMARY KEY, count_polled INTEGER NOT NULL DEFAULT 0, last_comment_id INTEGER, last_polled_at TEXT,
  user_watch INTEGER NOT NULL DEFAULT 0, title TEXT, state TEXT, suggest_json TEXT, suggest_dismissed INTEGER
);
CREATE TABLE IF NOT EXISTS comment_events (
  task_id INTEGER NOT NULL, comment_id INTEGER NOT NULL, author TEXT, at TEXT, snippet TEXT, reason TEXT, created_at TEXT NOT NULL, read_at TEXT,
  PRIMARY KEY (task_id, comment_id)
);
CREATE INDEX IF NOT EXISTS ix_comment_events_unread ON comment_events(read_at);
CREATE TABLE IF NOT EXISTS asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, person TEXT NOT NULL DEFAULT '', question TEXT NOT NULL, asked_at TEXT NOT NULL,
  nudge_at TEXT NOT NULL, replied_at TEXT, replied_by TEXT, closed_at TEXT, source TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS ix_asks_task ON asks(task_id);`);
  },
];
const SCHEMA_VERSION = MIGRATIONS.length;

const sqlQuote = (s) => String(s).replace(/'/g, "''");
function snapshotTo(file) { // a consistent copy, safe while the hub is running (works with WAL)
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.unlinkSync(file);
  db.exec("VACUUM INTO '" + sqlQuote(file) + "'");
  return file;
}
function migrate() {
  const cur = Number(db.prepare('PRAGMA user_version').get().user_version);
  if (cur > SCHEMA_VERSION) throw new Error('The hub database is from a newer version of the hub (schema ' + cur + ', this hub knows ' + SCHEMA_VERSION + '). Not touching it.');
  if (cur === SCHEMA_VERSION) return { from: cur, to: cur, snapshot: null };
  let snapshot = null;
  const hasData = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n > 0;
  if (hasData) { // an existing database is about to change shape: keep a copy first
    const t = new Date(); const p = (n) => String(n).padStart(2, '0');
    snapshot = snapshotTo(path.join(cfg.backupDir, 'hub-' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '-' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds()) + '-pre-migration.db'));
  }
  for (let v = cur; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN IMMEDIATE');
    try { MIGRATIONS[v](db); db.exec('PRAGMA user_version = ' + (v + 1)); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); throw new Error('Database migration ' + (v + 1) + ' failed and was rolled back: ' + e.message + (snapshot ? ' A copy from before is at ' + snapshot : '')); }
  }
  return { from: cur, to: SCHEMA_VERSION, snapshot };
}
const migration = migrate();
db.prepare("UPDATE moves SET status='interrupted', finished_at=?, summary='Hub stopped while this move was running. Check the live repo with git status.' WHERE status='running'")
  .run(new Date().toISOString());

const rowToObj = (r) => r && ({
  id: r.id, path: r.wt_path, branch: r.branch, repoKey: r.repo_key, taskId: r.task_id,
  category: r.category, reason: r.reason, reference: r.reference,
  clearedBy: r.cleared_by, clearedAt: r.cleared_at, head: r.head, dirtyFiles: r.dirty_files,
  whereState: r.where_state, restoredAt: r.restored_at, restoredBy: r.restored_by, restoreNote: r.restore_note,
});

const keyOf = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();

const COUNT_TABLES = { notes: 'notes WHERE deleted_at IS NULL', planDays: 'plan_days', planItems: 'plan_items', moves: 'moves', stashes: 'stashes', stashActions: 'stash_actions', delegations: 'delegations', aiRuns: 'planner_ai_runs', qaPacks: 'qa_packs', commentEvents: 'comment_events', asks: 'asks', clearances: 'clearances', aiCalls: 'ai_calls' };

module.exports = {
  keyOf,
  dbFile: DB_FILE,
  snapshotTo,
  /* ---- data safety ---- */
  rowCounts() {
    const out = {}; for (const [k, t] of Object.entries(COUNT_TABLES)) out[k] = db.prepare('SELECT COUNT(*) AS n FROM ' + t).get().n; return out;
  },
  health() {
    const p = (x) => Object.values(db.prepare('PRAGMA ' + x).get())[0];
    return { file: DB_FILE, journalMode: p('journal_mode'), busyTimeoutMs: p('busy_timeout'), synchronous: p('synchronous'), schemaVersion: p('user_version'), expectedSchemaVersion: SCHEMA_VERSION,
      quickCheck: p('quick_check'), sizeBytes: p('page_count') * p('page_size'), migration, counts: this.rowCounts() };
  },
  // A plain-text copy of everything that cannot be recreated (notes, plans, moves, stashes, clearances): readable even if the database file is lost.
  exportAll() {
    const all = (t) => db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all();
    return { exportedAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION, notes: all('notes'), planDays: all('plan_days'), planItems: all('plan_items'), moves: all('moves'), stashes: all('stashes'), stashActions: all('stash_actions'), delegations: all('delegations'), delegationEvents: all('delegation_events'), plannerLater: all('planner_later'), plannerTopics: all('planner_topics'), plannerAiRuns: all('planner_ai_runs'), plannerAiFeedback: all('planner_ai_feedback'), qaPacks: all('qa_packs'), commentWatch: all('comment_watch'), commentEvents: all('comment_events'), asks: all('asks'), plannerRevisions: all('planner_revisions'), clearances: all('clearances') };
  },
  /* ---- comment watch ---- */
  cwGet(taskId) { return db.prepare('SELECT * FROM comment_watch WHERE task_id = ?').get(taskId) || null; },
  cwAll() { return db.prepare('SELECT * FROM comment_watch').all(); },
  cwSave(r) {
    db.prepare(`INSERT INTO comment_watch (task_id, count_polled, last_comment_id, last_polled_at, user_watch, title, state, suggest_json, suggest_dismissed) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(task_id) DO UPDATE SET count_polled=excluded.count_polled, last_comment_id=excluded.last_comment_id, last_polled_at=excluded.last_polled_at, user_watch=excluded.user_watch, title=excluded.title, state=excluded.state, suggest_json=excluded.suggest_json, suggest_dismissed=excluded.suggest_dismissed`)
      .run(r.task_id, r.count_polled || 0, r.last_comment_id == null ? null : r.last_comment_id, r.last_polled_at || null, r.user_watch ? 1 : 0, r.title || null, r.state || null, r.suggest_json || null, r.suggest_dismissed == null ? null : r.suggest_dismissed);
  },
  cwUserWatched() { return db.prepare('SELECT task_id FROM comment_watch WHERE user_watch = 1').all().map((r) => r.task_id); },
  cwEventAdd(taskId, e) {
    return Number(db.prepare('INSERT OR IGNORE INTO comment_events (task_id, comment_id, author, at, snippet, reason, created_at) VALUES (?,?,?,?,?,?,?)').run(taskId, e.commentId, e.author || '', e.at || null, e.snippet || '', e.reason || null, new Date().toISOString()).changes);
  },
  cwEvents(taskId, unreadOnly) { return db.prepare('SELECT * FROM comment_events WHERE task_id = ?' + (unreadOnly ? ' AND read_at IS NULL' : '') + ' ORDER BY comment_id DESC LIMIT 50').all(taskId); },
  cwUnreadAll() { return db.prepare('SELECT * FROM comment_events WHERE read_at IS NULL ORDER BY at DESC, comment_id DESC').all(); },
  cwMarkRead(taskId) { const now = new Date().toISOString(); return Number(taskId == null ? db.prepare('UPDATE comment_events SET read_at = ? WHERE read_at IS NULL').run(now).changes : db.prepare('UPDATE comment_events SET read_at = ? WHERE task_id = ? AND read_at IS NULL').run(now, taskId).changes); },
  askAdd(a) {
    return Number(db.prepare('INSERT INTO asks (task_id, person, question, asked_at, nudge_at, source) VALUES (?,?,?,?,?,?)').run(a.taskId, a.person || '', a.question, new Date().toISOString(), a.nudgeAt, a.source || 'user').lastInsertRowid);
  },
  askGet(id) { return db.prepare('SELECT * FROM asks WHERE id = ?').get(id) || null; },
  askList(openOnly, taskId) {
    return db.prepare('SELECT * FROM asks WHERE 1=1' + (openOnly ? ' AND closed_at IS NULL' : '') + (taskId ? ' AND task_id = ' + Number(taskId) : '') + ' ORDER BY asked_at DESC, id DESC LIMIT 500').all();
  },
  askSet(id, f) {
    const cols = ['replied_at', 'replied_by', 'closed_at', 'nudge_at']; const sets = []; const vals = [];
    for (const c of cols) if (c in f) { sets.push(c + ' = ?'); vals.push(f[c]); }
    if (!sets.length) return 0; vals.push(id);
    return Number(db.prepare('UPDATE asks SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals).changes);
  },
  // Used for messages that arrive through the inbox: applied at most once per message id.
  noteAddFromInbox(msgId, taskId, section, body, author) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT 1 FROM inbox_seen WHERE msg_id = ?').get(msgId)) { db.exec('ROLLBACK'); return null; }
      const now = new Date().toISOString();
      const id = Number(db.prepare('INSERT INTO notes (task_id, section, body, author, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(taskId, section, body, author, now, now).lastInsertRowid);
      db.prepare('INSERT INTO inbox_seen (msg_id, at) VALUES (?,?)').run(msgId, now);
      db.exec('COMMIT'); return id;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  activeByKey() {
    const m = new Map();
    for (const r of db.prepare('SELECT * FROM clearances WHERE restored_at IS NULL ORDER BY id').all()) m.set(r.wt_key, rowToObj(r));
    return m;
  },
  list() {
    return db.prepare('SELECT * FROM clearances ORDER BY id DESC').all().map(rowToObj);
  },
  get(id) {
    return rowToObj(db.prepare('SELECT * FROM clearances WHERE id = ?').get(id));
  },
  clear(w, input, user) {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE'); // takes the write lock now and waits for its turn; a plain BEGIN that reads first can be refused instantly under WAL
    try {
      db.prepare(`UPDATE clearances SET restored_at = ?, restored_by = ?, restore_note = ?
                  WHERE wt_key = ? AND restored_at IS NULL`)
        .run(now, user, 'Replaced by a newer clearance', keyOf(w.path));
      const res = db.prepare(`INSERT INTO clearances
        (wt_key, wt_path, branch, repo_key, task_id, category, reason, reference, cleared_by, cleared_at, head, dirty_files, where_state)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(keyOf(w.path), w.path, w.branch || '', w.repoKey || '', w.taskId || null, input.category, input.reason,
          input.reference || null, user, now, w.head || '', w.dirtyFiles || 0, w.where || '');
      db.exec('COMMIT');
      return Number(res.lastInsertRowid);
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  restore(id, note, user) {
    const res = db.prepare(`UPDATE clearances SET restored_at = ?, restored_by = ?, restore_note = ?
                            WHERE id = ? AND restored_at IS NULL`)
      .run(new Date().toISOString(), user, note || null, id);
    return res.changes > 0;
  },

  /* ---- task notes and analysis ---- */
  noteList(taskId) {
    return db.prepare('SELECT * FROM notes WHERE task_id = ? AND deleted_at IS NULL ORDER BY id DESC').all(taskId).map(noteObj);
  },
  noteGet(id) {
    const r = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(id);
    return r && noteObj(r);
  },
  noteAdd(taskId, section, body, author) {
    const now = new Date().toISOString();
    return Number(db.prepare('INSERT INTO notes (task_id, section, body, author, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(taskId, section, body, author, now, now).lastInsertRowid);
  },
  noteUpdate(id, section, body) {
    return db.prepare('UPDATE notes SET section = ?, body = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(section, body, new Date().toISOString(), id).changes > 0;
  },
  noteDelete(id) { // soft delete, so a mistaken delete can be recovered from the database
    return db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(new Date().toISOString(), id).changes > 0;
  },
  noteStats() {
    const m = new Map();
    for (const r of db.prepare('SELECT task_id, COUNT(*) AS c, MAX(updated_at) AS last FROM notes WHERE deleted_at IS NULL GROUP BY task_id').all()) m.set(r.task_id, { count: r.c, last: r.last });
    return m;
  },

  /* ---- model calls made by the hub itself ---- */
  aiCallAdd(c) {
    return Number(db.prepare(`INSERT INTO ai_calls (at, purpose, model, in_tokens, out_tokens, cache_read, cache_write, usd, ms, ok, error)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(new Date().toISOString(), c.purpose, c.model, c.in || 0, c.out || 0, c.cacheRead || 0, c.cacheWrite || 0, c.usd || 0, c.ms || 0, c.ok ? 1 : 0, c.error || null).lastInsertRowid);
  },
  aiCallStats(sinceIso) {
    const r = db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(ok),0) AS ok, COALESCE(SUM(in_tokens),0) AS inT, COALESCE(SUM(out_tokens),0) AS outT,
      COALESCE(SUM(cache_read),0) AS cr, COALESCE(SUM(cache_write),0) AS cw, COALESCE(SUM(usd),0) AS usd FROM ai_calls WHERE at >= ?`).get(sinceIso || '0');
    return { calls: r.calls, ok: r.ok, in: r.inT, out: r.outT, cacheRead: r.cr, cacheWrite: r.cw, usd: r.usd, total: r.inT + r.outT + r.cr + r.cw };
  },
  aiCallList(limit) {
    return db.prepare('SELECT * FROM ai_calls ORDER BY id DESC LIMIT ?').all(limit || 50).map((r) => ({ id: r.id, at: r.at, purpose: r.purpose, model: r.model, in: r.in_tokens, out: r.out_tokens,
      cacheRead: r.cache_read, cacheWrite: r.cache_write, usd: r.usd, ms: r.ms, ok: !!r.ok, error: r.error }));
  },

  /* ---- daily plan ---- */
  planDay(date) {
    const d = db.prepare('SELECT * FROM plan_days WHERE date = ?').get(date);
    if (!d) return null;
    let score = null; try { score = d.score_json ? JSON.parse(d.score_json) : null; } catch { /* keep null */ }
    return { date: d.date, rawText: d.raw_text, createdAt: d.created_at, updatedAt: d.updated_at, closedAt: d.closed_at, score };
  },
  planItems(date) {
    return db.prepare('SELECT * FROM plan_items WHERE date = ? ORDER BY pos, id').all(date).map(planItemObj);
  },
  planItem(id) {
    const r = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
    return r && planItemObj(r);
  },
  // Saves a reviewed proposal. If the day already has a plan, the new lines are appended.
  planSave(date, rawText, items) {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE'); // see clear(): every read-then-write transaction must start IMMEDIATE
    try {
      const have = db.prepare('SELECT raw_text FROM plan_days WHERE date = ?').get(date);
      if (have) db.prepare('UPDATE plan_days SET raw_text = ?, updated_at = ?, closed_at = NULL WHERE date = ?').run(have.raw_text ? have.raw_text + '\n---\n' + rawText : rawText, now, date);
      else db.prepare('INSERT INTO plan_days (date, raw_text, created_at, updated_at) VALUES (?,?,?,?)').run(date, rawText, now, now);
      let pos = (db.prepare('SELECT COALESCE(MAX(pos),0) AS m FROM plan_items WHERE date = ?').get(date).m) || 0;
      const ids = [];
      for (const it of items) {
        const d = it.draft || null;
        ids.push(Number(db.prepare(`INSERT INTO plan_items (date, pos, text, kind, task_id, confidence, carried_from, draft_type, draft_title, draft_body, draft_state, requested_at, worktrees_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(date, ++pos, it.text, it.kind, it.taskId || null, it.confidence == null ? null : it.confidence, it.carriedFrom || null,
          d ? d.type : null, d ? d.title : null, d ? d.body : null, d ? (d.state || 'drafted') : 'none', d && d.requestedAt ? d.requestedAt : null,
          it.worktrees && it.worktrees.length ? JSON.stringify(it.worktrees) : null).lastInsertRowid));
      }
      db.exec('COMMIT');
      return ids;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  planItemUpdate(id, f) {
    const cols = { text: 'text', kind: 'kind', taskId: 'task_id', status: 'status', doneAt: 'done_at', skipReason: 'skip_reason', draftType: 'draft_type', draftTitle: 'draft_title',
      draftBody: 'draft_body', draftState: 'draft_state', requestedAt: 'requested_at', createdTaskId: 'created_task_id' };
    const sets = []; const vals = [];
    for (const [k, c] of Object.entries(cols)) if (f[k] !== undefined) { sets.push(c + ' = ?'); vals.push(f[k]); }
    if (f.worktrees !== undefined) { sets.push('worktrees_json = ?'); vals.push(f.worktrees && f.worktrees.length ? JSON.stringify(f.worktrees) : null); }
    if (f.snap !== undefined) { sets.push('snap_json = ?'); vals.push(f.snap ? JSON.stringify(f.snap) : null); }
    if (!sets.length) return false;
    return db.prepare('UPDATE plan_items SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, id).changes > 0;
  },
  noteRows(sinceIso) {
    return db.prepare('SELECT created_at, section, task_id FROM notes WHERE deleted_at IS NULL AND created_at >= ?').all(sinceIso || '0');
  },
  snapshotUpsert(week, area, score, metrics) {
    db.prepare('INSERT INTO scorecard_snapshots (week, area, score, metrics_json) VALUES (?,?,?,?) ON CONFLICT(week, area) DO UPDATE SET score = excluded.score, metrics_json = excluded.metrics_json')
      .run(week, area, score, JSON.stringify(metrics));
  },
  snapshotList() {
    return db.prepare('SELECT week, area, score FROM scorecard_snapshots ORDER BY week').all();
  },
  planItemsForTask(taskId, limit) {
    return db.prepare('SELECT date, text, status FROM plan_items WHERE task_id = ? ORDER BY date DESC, pos LIMIT ?').all(taskId, limit || 5);
  },
  feedbackAdd(rows) {
    if (!rows.length) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      const st = db.prepare(`INSERT INTO plan_feedback (at, date, engine, text, proposed_task, final_task, confidence, proposed_kind, final_kind, outcome, draft_edited, wt_proposed, wt_kept, wt_added)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      const at = new Date().toISOString();
      for (const r of rows) st.run(at, r.date, r.engine, r.text, r.proposedTask, r.finalTask, r.confidence, r.proposedKind, r.finalKind, r.outcome, r.draftEdited ? 1 : 0, r.wtProposed, r.wtKept, r.wtAdded);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  },
  feedbackList(sinceIso) {
    return db.prepare('SELECT * FROM plan_feedback WHERE at >= ? ORDER BY id').all(sinceIso || '0');
  },
  planDays(sinceDate) {
    return db.prepare('SELECT date, closed_at, score_json FROM plan_days WHERE date >= ? ORDER BY date').all(sinceDate || '0').map((d) => { let s = null; try { s = d.score_json ? JSON.parse(d.score_json) : null; } catch { /* none */ } return { date: d.date, closedAt: d.closed_at, score: s }; });
  },
  usageCounts() { // how much each hub feature has been used (for the ratings page)
    const n = (sql) => db.prepare(sql).get();
    return { notes: n('SELECT COUNT(*) c, MIN(created_at) first, COUNT(DISTINCT task_id) tasks FROM notes WHERE deleted_at IS NULL'), plans: n('SELECT COUNT(*) c, MIN(created_at) first FROM plan_days'),
      closedPlans: n('SELECT COUNT(*) c FROM plan_days WHERE closed_at IS NOT NULL'), moves: n("SELECT COUNT(*) c, MIN(started_at) first FROM moves WHERE status LIKE 'done%'"), clearances: n('SELECT COUNT(*) c, MIN(cleared_at) first FROM clearances'),
      aiCalls: n('SELECT COUNT(*) c, MIN(at) first FROM ai_calls WHERE ok = 1') };
  },
  planItemDelete(id) { return db.prepare('DELETE FROM plan_items WHERE id = ?').run(id).changes > 0; },
  planClose(date, score) {
    return db.prepare('UPDATE plan_days SET closed_at = ?, score_json = ? WHERE date = ?').run(new Date().toISOString(), JSON.stringify(score), date).changes > 0;
  },
  planRecent(n) {
    return db.prepare('SELECT date, closed_at, score_json FROM plan_days WHERE date <= ? ORDER BY date DESC LIMIT ?').all(new Date().toLocaleDateString('en-CA'), n || 14).map((d) => {
      let score = null; try { score = d.score_json ? JSON.parse(d.score_json) : null; } catch { /* keep null */ }
      return { date: d.date, closedAt: d.closed_at, score };
    });
  },

  /* ---- live moves ---- */
  moveStart(m, user) {
    const r = db.prepare(`INSERT INTO moves (wt_path, branch, repo_key, task_id, live_path, prev_live_branch, started_by, started_at, status)
      VALUES (?,?,?,?,?,?,?,?, 'running')`)
      .run(m.wtPath, m.branch, m.repoKey || '', m.taskId || null, m.livePath, m.prevLiveBranch || '', user, new Date().toISOString());
    return Number(r.lastInsertRowid);
  },
  moveUpdate(id, f) {
    const sets = []; const vals = [];
    const map = { status: 'status', summary: 'summary', patchPath: 'patch_path', finishedAt: 'finished_at', steps: 'steps' };
    for (const [k, col] of Object.entries(map)) if (f[k] !== undefined) { sets.push(col + ' = ?'); vals.push(k === 'steps' ? JSON.stringify(f[k]) : f[k]); }
    if (sets.length) db.prepare('UPDATE moves SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals, id);
  },
  moveGet(id) {
    const r = db.prepare('SELECT * FROM moves WHERE id = ?').get(id);
    return r && moveObj(r);
  },
  moveList() {
    return db.prepare('SELECT * FROM moves ORDER BY id DESC LIMIT 200').all().map(moveObj);
  },
  stashAdd(s) {
    const r = db.prepare(`INSERT INTO stashes (move_id, repo_key, live_path, stash_hash, message, prev_branch, file_count, files, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(s.moveId, s.repoKey || '', s.livePath, s.hash, s.message, s.prevBranch || '', s.files.length, JSON.stringify(s.files.slice(0, 200)), new Date().toISOString());
    return Number(r.lastInsertRowid);
  },
  stashList() {
    return db.prepare('SELECT * FROM stashes ORDER BY id DESC').all().map(stashObj);
  },
  stashGet(id) {
    const r = db.prepare('SELECT * FROM stashes WHERE id = ?').get(id);
    return r && stashObj(r);
  },
  stashHandle(id, note, user) {
    return db.prepare('UPDATE stashes SET handled_at = ?, handled_by = ?, handled_note = ? WHERE id = ? AND handled_at IS NULL')
      .run(new Date().toISOString(), user, note || null, id).changes > 0;
  },
  /* ---- work planner ---- */
  // Task ids that already have an open line today or later: they are not offered again.
  plannerScheduledIds(fromDate) {
    return new Set(db.prepare("SELECT DISTINCT task_id FROM plan_items WHERE status = 'todo' AND task_id IS NOT NULL AND date >= ?").all(fromDate).map((r) => r.task_id));
  },
  plannerItems(fromDate, toDate) { // every line of the days shown on the board
    return db.prepare('SELECT * FROM plan_items WHERE date >= ? AND date <= ? ORDER BY date, pos, id').all(fromDate, toDate).map(planItemObj);
  },
  // Puts a work item on a day (a normal plan line, so Today's plan shows it). Returns { id } or { existing } when the task already has an open line from `fromDate` on.
  plannerAdd(date, fromDate, taskId, text, snap, extra) {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const have = db.prepare("SELECT id, date FROM plan_items WHERE status = 'todo' AND task_id = ? AND date >= ? ORDER BY date LIMIT 1").get(taskId, fromDate);
      if (have) { db.exec('ROLLBACK'); return { existing: { id: have.id, date: have.date } }; }
      if (!db.prepare('SELECT 1 FROM plan_days WHERE date = ?').get(date)) db.prepare("INSERT INTO plan_days (date, raw_text, created_at, updated_at) VALUES (?, '', ?, ?)").run(date, now, now);
      const pos = (db.prepare('SELECT COALESCE(MAX(pos),0) AS m FROM plan_items WHERE date = ?').get(date).m || 0) + 1;
      const e = extra || {};
      const id = Number(db.prepare("INSERT INTO plan_items (date, pos, text, kind, task_id, confidence, status, snap_json, carried_from) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(date, pos, text, e.kind || 'task', taskId, null, 'todo', snap ? JSON.stringify(snap) : null, null).lastInsertRowid);
      db.prepare('UPDATE plan_days SET updated_at = ? WHERE date = ?').run(now, date);
      db.exec('COMMIT');
      return { id };
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  },
  // Moves an open line to another day, optionally to a position (1 = first). Lines of the target day are renumbered.
  plannerMove(id, toDate, position) {
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      const it = db.prepare('SELECT * FROM plan_items WHERE id = ?').get(id);
      if (!it) { db.exec('ROLLBACK'); return { error: 'notfound' }; }
      if (it.status !== 'todo') { db.exec('ROLLBACK'); return { error: 'notopen' }; }
      if (!db.prepare('SELECT 1 FROM plan_days WHERE date = ?').get(toDate)) db.prepare("INSERT INTO plan_days (date, raw_text, created_at, updated_at) VALUES (?, '', ?, ?)").run(toDate, now, now);
      const others = db.prepare('SELECT id FROM plan_items WHERE date = ? AND id <> ? ORDER BY pos, id').all(toDate, id).map((r) => r.id);
      const at = position && position >= 1 ? Math.min(position - 1, others.length) : others.length;
      others.splice(at, 0, id);
      db.prepare('UPDATE plan_items SET date = ? WHERE id = ?').run(toDate, id);
      const set = db.prepare('UPDATE plan_items SET pos = ? WHERE id = ?');
      others.forEach((x, i) => set.run(i + 1, x));
      db.prepare('UPDATE plan_days SET updated_at = ?, closed_at = NULL WHERE date = ?').run(now, toDate);
      db.exec('COMMIT');
      return { ok: true, from: it.date };
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  },
  plannerSetOrder(date, orderedIds) { // lines named in orderedIds come first, in that order; the rest keep their relative order after them
    db.exec('BEGIN IMMEDIATE');
    try {
      const rows = db.prepare('SELECT id FROM plan_items WHERE date = ? ORDER BY pos, id').all(date).map((r) => r.id);
      const first = orderedIds.filter((x) => rows.includes(x));
      const all = [...first, ...rows.filter((x) => !first.includes(x))];
      const set = db.prepare('UPDATE plan_items SET pos = ? WHERE id = ?'); all.forEach((x, i) => set.run(i + 1, x));
      db.exec('COMMIT'); return all.length;
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  },
  laterList() { return db.prepare('SELECT task_id, added_at FROM planner_later ORDER BY added_at, task_id').all(); },
  laterAdd(taskId) { return db.prepare('INSERT OR IGNORE INTO planner_later (task_id, added_at) VALUES (?, ?)').run(taskId, new Date().toISOString()).changes > 0; },
  laterRemove(taskId) { return db.prepare('DELETE FROM planner_later WHERE task_id = ?').run(taskId).changes > 0; },
  /* ---- QA packs ---- */
  qaPackAdd(p) { return Number(db.prepare('INSERT INTO qa_packs (at, by, specs, branch, worktree, base, files_json) VALUES (?,?,?,?,?,?,?)').run(new Date().toISOString(), p.by, JSON.stringify(p.specs), p.branch, p.worktree, p.base || null, JSON.stringify(p.files)).lastInsertRowid); },
  qaPackList(n) { return db.prepare('SELECT id, at, by, specs, branch, worktree, base, files_json, status FROM qa_packs ORDER BY id DESC LIMIT ?').all(n || 20).map((r) => ({ id: r.id, at: r.at, by: r.by, specs: JSON.parse(r.specs), branch: r.branch, worktree: r.worktree, base: r.base, files: JSON.parse(r.files_json), status: r.status })); },
  /* ---- AI auto-planning ---- */
  analysisGet(taskId, fingerprint) {
    const r = db.prepare('SELECT analysis_json, model, at FROM ai_analyses WHERE task_id = ? AND fingerprint = ?').get(taskId, fingerprint);
    if (!r) return null;
    try { return { ...JSON.parse(r.analysis_json), _model: r.model, _at: r.at }; } catch { return null; }
  },
  analysisPut(taskId, fingerprint, analysis, model) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO ai_analyses (task_id, fingerprint, analysis_json, model, at) VALUES (?,?,?,?,?) ON CONFLICT(task_id, fingerprint) DO UPDATE SET analysis_json = excluded.analysis_json, model = excluded.model, at = excluded.at')
      .run(taskId, fingerprint, JSON.stringify(analysis), model || null, now);
    db.prepare('DELETE FROM ai_analyses WHERE at < ?').run(new Date(Date.now() - 60 * 86400000).toISOString()); // a cache, kept 60 days
  },
  aiRunAdd(mode, items, usd) { return Number(db.prepare('INSERT INTO planner_ai_runs (at, mode, items, usd) VALUES (?,?,?,?)').run(new Date().toISOString(), mode, items, usd == null ? null : usd).lastInsertRowid); },
  aiRunGet(id) { return db.prepare('SELECT id, at, mode, items, applied, changed, rejected, usd FROM planner_ai_runs WHERE id = ?').get(id) || null; },
  aiRunFinish(id, applied, changed, rejected, rows) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE planner_ai_runs SET applied = ?, changed = ?, rejected = ? WHERE id = ?').run(applied, changed, rejected, id);
      const st = db.prepare('INSERT INTO planner_ai_feedback (run_id, task_id, proposed, final, outcome, at) VALUES (?,?,?,?,?,?)'); const at = new Date().toISOString();
      for (const r of rows) st.run(id, r.taskId, r.proposed || null, r.final || null, r.outcome, at);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  },
  aiRunList(n) { return db.prepare('SELECT id, at, mode, items, applied, changed, rejected, usd FROM planner_ai_runs ORDER BY id DESC LIMIT ?').all(n || 20); },
  aiFeedbackList(runId) { return db.prepare('SELECT task_id AS taskId, proposed, final, outcome FROM planner_ai_feedback WHERE run_id = ? ORDER BY id').all(runId); },
  topicList() { return db.prepare('SELECT id, keyword, created_at AS createdAt, created_by AS createdBy FROM planner_topics ORDER BY keyword').all(); },
  topicAdd(keyword, by, max) { // null when it already exists (any letter case) or the limit is reached
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare('SELECT COUNT(*) AS n FROM planner_topics').get().n >= max) { db.exec('ROLLBACK'); return { full: true }; }
      const r = db.prepare('INSERT OR IGNORE INTO planner_topics (keyword, created_at, created_by) VALUES (?,?,?)').run(keyword, new Date().toISOString(), by);
      db.exec('COMMIT'); return r.changes ? { id: Number(r.lastInsertRowid) } : { exists: true };
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  },
  topicRemove(id) { return db.prepare('DELETE FROM planner_topics WHERE id = ?').run(id).changes > 0; },
  revisionGet(date) { return db.prepare('SELECT date, at, new_count AS newCount, changed_count AS changedCount FROM planner_revisions WHERE date = ?').get(date) || null; },
  revisionSet(date, newCount, changedCount) {
    db.prepare('INSERT INTO planner_revisions (date, at, new_count, changed_count) VALUES (?,?,?,?) ON CONFLICT(date) DO UPDATE SET at = excluded.at, new_count = excluded.new_count, changed_count = excluded.changed_count')
      .run(date, new Date().toISOString(), newCount, changedCount);
  },
  delegationAdd(d, by) { // null when the task already has an open delegation
    const now = d.createdAt || new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      if (db.prepare("SELECT 1 FROM delegations WHERE task_id = ? AND status = 'open'").get(d.taskId)) { db.exec('ROLLBACK'); return null; }
      const id = Number(db.prepare(`INSERT INTO delegations (task_id, person, mode, note, expect_by, check_every_days, next_check, wake_after_days, created_at, created_by, last_seen_json, last_seen_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(d.taskId, d.person, d.mode, d.note || null, d.expectBy || null, d.checkEveryDays || null, d.nextCheck || null, d.wakeAfterDays || null, now, by,
        d.lastSeen ? JSON.stringify(d.lastSeen) : null, d.lastSeen ? now : null).lastInsertRowid);
      db.prepare('INSERT INTO delegation_events (delegation_id, at, kind, detail) VALUES (?,?,?,?)').run(id, now, 'delegated', d.person + ' (' + d.mode + ')' + (d.note ? ': ' + d.note : ''));
      db.exec('COMMIT'); return id;
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  },
  delegationGet(id) { const r = db.prepare('SELECT * FROM delegations WHERE id = ?').get(id); return r && delegationObj(r); },
  delegationList(status) { return db.prepare('SELECT * FROM delegations' + (status ? ' WHERE status = ?' : '') + ' ORDER BY id DESC').all(...(status ? [status] : [])).map(delegationObj); },
  delegationByTask(taskId) { const r = db.prepare("SELECT * FROM delegations WHERE task_id = ? AND status = 'open'").get(taskId); return r && delegationObj(r); },
  delegationUpdate(id, f) {
    const cols = { person: 'person', mode: 'mode', note: 'note', expectBy: 'expect_by', checkEveryDays: 'check_every_days', nextCheck: 'next_check', wakeAfterDays: 'wake_after_days' };
    const sets = []; const vals = [];
    for (const [k, c] of Object.entries(cols)) if (f[k] !== undefined) { sets.push(c + ' = ?'); vals.push(f[k]); }
    if (f.lastSeen !== undefined) { sets.push('last_seen_json = ?', 'last_seen_at = ?'); vals.push(f.lastSeen ? JSON.stringify(f.lastSeen) : null, new Date().toISOString()); }
    if (!sets.length) return false;
    return db.prepare("UPDATE delegations SET " + sets.join(', ') + " WHERE id = ? AND status = 'open'").run(...vals, id).changes > 0;
  },
  delegationClose(id, by, reason) {
    const now = new Date().toISOString();
    const ok = db.prepare("UPDATE delegations SET status = 'closed', closed_at = ?, closed_by = ?, closed_reason = ? WHERE id = ? AND status = 'open'").run(now, by, reason, id).changes > 0;
    if (ok) db.prepare('INSERT INTO delegation_events (delegation_id, at, kind, detail) VALUES (?,?,?,?)').run(id, now, 'closed', reason);
    return ok;
  },
  eventAdd(delegationId, kind, detail) { db.prepare('INSERT INTO delegation_events (delegation_id, at, kind, detail) VALUES (?,?,?,?)').run(delegationId, new Date().toISOString(), kind, detail || null); },
  eventList(delegationId, limit) { return db.prepare('SELECT id, at, kind, detail FROM delegation_events WHERE delegation_id = ? ORDER BY id DESC LIMIT ?').all(delegationId, limit || 50); },
  /* ---- stash manager history ---- */
  stashActionAdd(a) {
    const files = Array.isArray(a.files) ? a.files : [];
    return Number(db.prepare(`INSERT INTO stash_actions (repo_key, repo_path, hash, message, action, reason, patch_path, trash_ref, worktree, task_id, files, file_count, at, by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.repoKey || '', a.repoPath, a.hash, a.message || '', a.action, a.reason || null, a.patchPath || null, a.trashRef || null,
      a.worktree || null, a.taskId || null, JSON.stringify(files.slice(0, 200)), files.length, new Date().toISOString(), a.by).lastInsertRowid);
  },
  stashActionList(limit = 500) {
    return db.prepare('SELECT * FROM stash_actions ORDER BY id DESC LIMIT ?').all(limit).map(stashActionObj);
  },
  // Cleared stashes that were neither restored nor emptied from the trash: still recoverable.
  stashTrash() {
    return db.prepare(`SELECT * FROM stash_actions c WHERE c.action = 'cleared'
      AND NOT EXISTS (SELECT 1 FROM stash_actions x WHERE x.repo_path = c.repo_path AND x.hash = c.hash AND x.id > c.id AND x.action IN ('restored','purged'))
      ORDER BY c.id DESC`).all().map(stashActionObj);
  },
  stashActionsFor(repoPath, hash) {
    return db.prepare('SELECT * FROM stash_actions WHERE repo_path = ? AND hash = ? ORDER BY id').all(repoPath, hash).map(stashActionObj);
  },
  stashByHash(repoPath, hash) {
    const r = db.prepare('SELECT * FROM stashes WHERE live_path = ? AND stash_hash = ? ORDER BY id DESC').get(repoPath, hash);
    return r && stashObj(r);
  },
};

function planItemObj(r) {
  let links = []; try { links = r.worktrees_json ? JSON.parse(r.worktrees_json) : []; } catch { /* keep empty */ }
  let snap = null; try { snap = r.snap_json ? JSON.parse(r.snap_json) : null; } catch { /* none */ }
  return { snap, worktreeLinks: links, id: r.id, date: r.date, pos: r.pos, text: r.text, kind: r.kind, taskId: r.task_id, confidence: r.confidence, status: r.status, doneAt: r.done_at, skipReason: r.skip_reason,
    carriedFrom: r.carried_from, draft: r.draft_state === 'none' && !r.draft_title ? null : { type: r.draft_type, title: r.draft_title, body: r.draft_body, state: r.draft_state, requestedAt: r.requested_at, createdTaskId: r.created_task_id } };
}
function noteObj(r) {
  return { id: r.id, taskId: r.task_id, section: r.section, body: r.body, author: r.author, createdAt: r.created_at, updatedAt: r.updated_at };
}
function moveObj(r) {
  let steps = []; try { steps = JSON.parse(r.steps || '[]'); } catch { /* keep empty */ }
  return { id: r.id, wtPath: r.wt_path, branch: r.branch, repoKey: r.repo_key, taskId: r.task_id, livePath: r.live_path,
    prevLiveBranch: r.prev_live_branch, startedBy: r.started_by, startedAt: r.started_at, finishedAt: r.finished_at,
    status: r.status, summary: r.summary, patchPath: r.patch_path, steps };
}
function delegationObj(r) {
  let lastSeen = null; try { lastSeen = r.last_seen_json ? JSON.parse(r.last_seen_json) : null; } catch { /* none */ }
  return { id: r.id, taskId: r.task_id, person: r.person, mode: r.mode, note: r.note, expectBy: r.expect_by, checkEveryDays: r.check_every_days, nextCheck: r.next_check, wakeAfterDays: r.wake_after_days,
    createdAt: r.created_at, createdBy: r.created_by, lastSeen, lastSeenAt: r.last_seen_at, status: r.status, closedAt: r.closed_at, closedBy: r.closed_by, closedReason: r.closed_reason };
}
function stashActionObj(r) {
  let files = []; try { files = JSON.parse(r.files || '[]'); } catch { /* keep empty */ }
  return { id: r.id, repoKey: r.repo_key, repoPath: r.repo_path, hash: r.hash, message: r.message, action: r.action, reason: r.reason,
    patchPath: r.patch_path, trashRef: r.trash_ref, worktree: r.worktree, taskId: r.task_id, files, fileCount: r.file_count, at: r.at, by: r.by };
}
function stashObj(r) {
  let files = []; try { files = JSON.parse(r.files || '[]'); } catch { /* keep empty */ }
  return { id: r.id, moveId: r.move_id, repoKey: r.repo_key, livePath: r.live_path, hash: r.stash_hash, message: r.message,
    prevBranch: r.prev_branch, fileCount: r.file_count, files, createdAt: r.created_at,
    handledAt: r.handled_at, handledBy: r.handled_by, handledNote: r.handled_note };
}
