'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.CPN_TEST_DB || path.join(__dirname, 'data', 'cpn.db');
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    email       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'user',
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    last_login  INTEGER
  );

  CREATE TABLE IF NOT EXISTS models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_models_user_name ON models(user_id, name);
  CREATE INDEX IF NOT EXISTS idx_models_user ON models(user_id);

  CREATE TABLE IF NOT EXISTS idef0_diagrams (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT    NOT NULL,
    content     TEXT    NOT NULL,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_idef0_user_name ON idef0_diagrams(user_id, name);
  CREATE INDEX IF NOT EXISTS idx_idef0_user ON idef0_diagrams(user_id);
`);

module.exports = {
  users: {
    create:          db.prepare(`INSERT INTO users (username, email, password, role) VALUES (?, ?, ?, ?)`),
    findByUsername:  db.prepare(`SELECT * FROM users WHERE username = ?`),
    findByEmail:     db.prepare(`SELECT * FROM users WHERE email = ?`),
    findById:        db.prepare(`SELECT id, username, email, role, created_at, last_login FROM users WHERE id = ?`),
    updateLastLogin: db.prepare(`UPDATE users SET last_login = unixepoch() WHERE id = ?`),
    list:            db.prepare(`
      SELECT u.id, u.username, u.email, u.role, u.created_at, u.last_login,
             COUNT(m.id) AS model_count
      FROM users u
      LEFT JOIN models m ON m.user_id = u.id
      GROUP BY u.id
      ORDER BY u.created_at ASC
    `),
    updateRole:      db.prepare(`UPDATE users SET role = ? WHERE id = ?`),
    updateEmail:     db.prepare(`UPDATE users SET email = ? WHERE id = ?`),
    updatePassword:  db.prepare(`UPDATE users SET password = ? WHERE id = ?`),
    delete:          db.prepare(`DELETE FROM users WHERE id = ?`),
  },
  models: {
    list:        db.prepare(`SELECT id, name, created_at, updated_at FROM models WHERE user_id = ? ORDER BY updated_at DESC`),
    create:      db.prepare(`INSERT INTO models (user_id, name, content) VALUES (?, ?, ?)`),
    findById:    db.prepare(`SELECT * FROM models WHERE id = ? AND user_id = ?`),
    update:      db.prepare(`UPDATE models SET name = COALESCE(?, name), content = COALESCE(?, content), updated_at = unixepoch() WHERE id = ? AND user_id = ?`),
    delete:      db.prepare(`DELETE FROM models WHERE id = ? AND user_id = ?`),
    listForUser: db.prepare(`SELECT id, name, created_at, updated_at FROM models WHERE user_id = ? ORDER BY updated_at DESC`),
  },
  idef0: {
    list:     db.prepare(`SELECT id, name, created_at, updated_at FROM idef0_diagrams WHERE user_id = ? ORDER BY updated_at DESC`),
    create:   db.prepare(`INSERT INTO idef0_diagrams (user_id, name, content) VALUES (?, ?, ?)`),
    findById: db.prepare(`SELECT * FROM idef0_diagrams WHERE id = ? AND user_id = ?`),
    update:   db.prepare(`UPDATE idef0_diagrams SET name = COALESCE(?, name), content = COALESCE(?, content), updated_at = unixepoch() WHERE id = ? AND user_id = ?`),
    delete:   db.prepare(`DELETE FROM idef0_diagrams WHERE id = ? AND user_id = ?`),
  },
};
