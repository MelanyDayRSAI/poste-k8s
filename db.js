'use strict';
// Acceso a PostgreSQL (Cloud SQL). Toda la app usa solo query(), ping(), init() y close().
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT) || 5432,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  max: Number(process.env.PGPOOL_MAX) || 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Con Cloud SQL Auth Proxy (recomendado) el tráfico ya viaja cifrado: no hace falta SSL.
  // Para conexión directa por IP pública usa DB_SSL=true.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});
pool.on('error', (e) => console.error('[db] error en una conexión inactiva:', e.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL DEFAULT '', password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'vecino', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports(
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  photo TEXT NOT NULL, location TEXT NOT NULL, reference TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pendiente', admin_reply TEXT NOT NULL DEFAULT '',
  rating INTEGER, feedback TEXT NOT NULL DEFAULT '', rated_at TEXT,
  created_at TEXT NOT NULL, form_seconds INTEGER NOT NULL DEFAULT 0, resolved_at TEXT);
CREATE TABLE IF NOT EXISTS emails(
  id SERIAL PRIMARY KEY, to_addr TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`;

module.exports = {
  // Devuelve siempre un arreglo de filas.
  query: async (text, params = []) => (await pool.query(text, params)).rows,
  ping: async () => { await pool.query('SELECT 1'); return true; },
  // Crea las tablas. El candado evita que dos réplicas lo hagan a la vez al arrancar.
  init: async () => {
    const c = await pool.connect();
    try {
      await c.query('SELECT pg_advisory_lock(727274)');
      await c.query(SCHEMA);
    } finally {
      try { await c.query('SELECT pg_advisory_unlock(727274)'); } catch { /* nada */ }
      c.release();
    }
  },
  close: () => pool.end(),
};
