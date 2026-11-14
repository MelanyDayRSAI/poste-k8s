'use strict';
// Adaptador SOLO PARA PRUEBAS: permite correr la lógica de la app sin PostgreSQL.
// Convierte los parámetros $1,$2 de PostgreSQL a ?1,?2 de SQLite. No se incluye en la imagen de Docker.
const { DatabaseSync } = require('node:sqlite');
const d = new DatabaseSync(process.env.TEST_DB || ':memory:');
const DDL = `
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, phone TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'vecino', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), photo TEXT NOT NULL, location TEXT NOT NULL, reference TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pendiente', admin_reply TEXT NOT NULL DEFAULT '', rating INTEGER, feedback TEXT NOT NULL DEFAULT '', rated_at TEXT, created_at TEXT NOT NULL, form_seconds INTEGER NOT NULL DEFAULT 0, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS emails(id INTEGER PRIMARY KEY AUTOINCREMENT, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
`;
const toSqlite = (sql) => sql.replace(/\$(\d+)/g, '?$1');
module.exports = {
  query: async (sql, params = []) => d.prepare(toSqlite(sql)).all(...params),
  ping: async () => true,
  init: async () => { d.exec('PRAGMA foreign_keys=ON'); d.exec(DDL); },
  close: async () => d.close(),
};
