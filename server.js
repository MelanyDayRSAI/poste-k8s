'use strict';
// Reporta tu Poste v3.0 - servidor HTTP (Node 22) sobre PostgreSQL (Cloud SQL), listo para Kubernetes.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
// En producción es ./db (PostgreSQL). Las pruebas locales pueden indicar otro adaptador con DB_ADAPTER.
const db = require(process.env.DB_ADAPTER || './db');

const PROD = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 500;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'admin@minimuni.local').toLowerCase();
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';   // true cuando se sirve por HTTPS
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';       // true detrás de un Ingress / balanceador
const SMTP = {
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT) || 465,
  user: process.env.SMTP_USER || '',
  pass: process.env.SMTP_PASS || '',
  from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
};
SMTP.secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : SMTP.port === 465;
const SMTP_ON = !!(SMTP.host && SMTP.from);
const SESSION_MS = 7 * 24 * 3600 * 1000;
const ESTADOS = ['Pendiente', 'En revisión', 'Resuelto'];

// ---------- utilidades ----------
const q = (sql, params = []) => db.query(sql, params);
const one = async (sql, params = []) => (await q(sql, params))[0];
const now = () => new Date().toISOString();
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const phoneOk = (p) => /^[\d\s+\-()]+$/.test(p) && p.replace(/\D/g, '').length >= 8 && p.length <= 20;
const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const codeOf = (id) => 'BDM-P-' + String(id).padStart(4, '0');
const log = (o) => console.log(JSON.stringify({ t: now(), ...o }));

function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [s, h] = stored.split(':');
  const hh = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  return crypto.timingSafeEqual(hh, Buffer.from(h, 'hex'));
}

// ---------- correo (SMTP minimo, TLS) ----------
function smtpSend({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    let sock, buf = '', pending = null, finished = false;
    const fail = (e) => {
      if (finished) return;
      finished = true;
      try { sock && sock.destroy(); } catch { /* nada */ }
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const replyEnd = () => {
      let pos = 0;
      for (;;) {
        const nl = buf.indexOf('\r\n', pos);
        if (nl < 0) return -1;
        const line = buf.slice(pos, nl);
        pos = nl + 2;
        if (/^\d{3}( |$)/.test(line)) return pos;
      }
    };
    const flush = () => {
      if (!pending) return;
      const end = replyEnd();
      if (end < 0) return;
      const t = buf.slice(0, end);
      buf = buf.slice(end);
      const p = pending; pending = null; p(t);
    };
    const attach = (s) => {
      sock = s;
      s.setTimeout(20000, () => fail(new Error('SMTP: tiempo agotado')));
      s.on('error', fail);
      s.on('data', (d) => { buf += d.toString('utf8'); flush(); });
    };
    const read = (codes) => new Promise((res, rej) => {
      pending = (t) => (codes.includes(t.slice(0, 3)) ? res(t) : rej(new Error('SMTP: ' + t.trim().slice(0, 200))));
      flush();
    });
    const send = (l) => sock.write(l + '\r\n');
    (async () => {
      try {
        await new Promise((res, rej) => {
          const s = SMTP.secure
            ? tls.connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host }, res)
            : net.connect({ host: SMTP.host, port: SMTP.port }, res);
          s.once('error', rej);
          attach(s);
        });
        await read(['220']);
        send('EHLO poste.local'); await read(['250']);
        if (!SMTP.secure) {
          send('STARTTLS'); await read(['220']);
          const raw = sock; buf = '';
          await new Promise((res, rej) => {
            const s = tls.connect({ socket: raw, servername: SMTP.host }, res);
            s.once('error', rej);
            raw.removeAllListeners('data');
            attach(s);
          });
          send('EHLO poste.local'); await read(['250']);
        }
        if (SMTP.user) {
          send('AUTH LOGIN'); await read(['334']);
          send(Buffer.from(SMTP.user).toString('base64')); await read(['334']);
          send(Buffer.from(SMTP.pass).toString('base64')); await read(['235']);
        }
        const fromAddr = (SMTP.from.match(/<([^>]+)>/) || [null, SMTP.from])[1];
        send(`MAIL FROM:<${fromAddr}>`); await read(['250']);
        send(`RCPT TO:<${to}>`); await read(['250', '251']);
        send('DATA'); await read(['354']);
        const body = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
        const msg = [
          `From: ${SMTP.from}`, `To: ${to}`,
          `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
          `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@poste.local>`,
          'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
        ].join('\r\n');
        sock.write(msg + '\r\n.\r\n'); await read(['250']);
        send('QUIT'); finished = true; sock.end(); resolve();
      } catch (e) { fail(e); }
    })();
  });
}

async function queueMail(to, subject, text) {
  const rows = await q('INSERT INTO emails(to_addr,subject,body,status,created_at) VALUES($1,$2,$3,$4,$5) RETURNING id',
    [to, subject, text, SMTP_ON ? 'pendiente' : 'simulado', now()]);
  if (!SMTP_ON) return;
  const id = rows[0].id;
  try {
    await smtpSend({ to, subject, text });
    await q("UPDATE emails SET status='enviado' WHERE id=$1", [id]);
  } catch (e) {
    await q("UPDATE emails SET status='error', error=$1 WHERE id=$2", [String(e.message).slice(0, 300), id]);
  }
}

// ---------- http ----------
const json = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
};
const readBody = (req, limit = 3 * 1024 * 1024) => new Promise((resolve, reject) => {
  let size = 0; const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > limit) { reject(Object.assign(new Error('El archivo es demasiado grande'), { status: 413 })); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
    catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
  });
  req.on('error', reject);
});
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const clientIp = (req) => (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';
const cookieFlags = () => `HttpOnly; SameSite=Lax; Path=/${COOKIE_SECURE ? '; Secure' : ''}`;

async function sessionUser(req) {
  const m = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const key = sha(m[1]);
  const row = await one('SELECT u.id,u.name,u.email,u.phone,u.role,s.created_at AS sc FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1', [key]);
  if (!row) return null;
  if (Date.now() - Date.parse(row.sc) > SESSION_MS) { await q('DELETE FROM sessions WHERE token=$1', [key]); return null; }
  return row;
}
const pubUser = (u) => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });
async function startSession(userId, extra) {
  const token = crypto.randomBytes(32).toString('hex');
  await q('INSERT INTO sessions(token,user_id,created_at) VALUES($1,$2,$3)', [sha(token), userId, now()]);
  return { 'Set-Cookie': `sid=${token}; ${cookieFlags()}; Max-Age=${SESSION_MS / 1000}`, ...extra };
}

// limitador de intentos (en memoria de cada réplica)
const attempts = new Map();
const WINDOW = 15 * 60e3;
const throttled = (k, max) => { const a = attempts.get(k); return !!a && Date.now() - a.t < WINDOW && a.n >= max; };
const noteFail = (k) => { const a = attempts.get(k); if (!a || Date.now() - a.t >= WINDOW) attempts.set(k, { n: 1, t: Date.now() }); else a.n++; };
setInterval(() => { for (const [k, a] of attempts) if (Date.now() - a.t >= WINDOW) attempts.delete(k); }, 5 * 60e3).unref();

const reportOut = (r) => ({
  id: r.id, code: codeOf(r.id), user_id: r.user_id, user_name: r.user_name, location: r.location, reference: r.reference,
  note: r.note, name: r.name, phone: r.phone, email: r.email, status: r.status, admin_reply: r.admin_reply,
  rating: r.rating, feedback: r.feedback, rated_at: r.rated_at, created_at: r.created_at,
  form_seconds: r.form_seconds, resolved_at: r.resolved_at,
});
const REPORT_COLS = 'r.id,r.user_id,u.name AS user_name,r.location,r.reference,r.note,r.name,r.phone,r.email,r.status,r.admin_reply,r.rating,r.feedback,r.rated_at,r.created_at,r.form_seconds,r.resolved_at';
const reportById = (id) => one(`SELECT ${REPORT_COLS} FROM reports r JOIN users u ON u.id=r.user_id WHERE r.id=$1`, [id]);

function validateContact(b) {
  const name = clean(b.name, 80), phone = clean(b.phone, 20), email = clean(b.email, 120).toLowerCase();
  if (name.length < 3 || !/[A-Za-zÁÉÍÓÚáéíóúÑñ]/.test(name)) throw bad('Escribe tu nombre (mínimo 3 letras).');
  if (!phoneOk(phone)) throw bad('Escribe un teléfono válido (mínimo 8 dígitos).');
  if (!EMAIL_RE.test(email)) throw bad('Escribe un correo válido.');
  return { name, phone, email };
}
async function createUser(c, pw, role) {
  const rows = await q('INSERT INTO users(name,email,phone,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO NOTHING RETURNING id',
    [c.name, c.email, c.phone, hashPw(pw), role, now()]);
  if (!rows.length) throw bad('Ese correo ya tiene una cuenta.', 409);
  return Number(rows[0].id);
}

async function handleApi(req, res, p, m) {
  if (m === 'GET' && p === '/api/health') return json(res, 200, { ok: true });            // liveness
  if (m === 'GET' && p === '/api/ready') {                                                  // readiness (revisa la base)
    try { await db.ping(); return json(res, 200, { ok: true, db: true }); }
    catch { return json(res, 503, { ok: false, db: false }); }
  }
  let body = {};
  if (m !== 'GET') {
    if (!/application\/json/.test(req.headers['content-type'] || '')) throw bad('Se requiere JSON', 415);
    body = await readBody(req);
  }
  const me = await sessionUser(req);
  const needUser = () => { if (!me) throw bad('Debes iniciar sesión.', 401); return me; };
  const needAdmin = () => { if (needUser().role !== 'admin') throw bad('Solo para el administrador.', 403); return me; };
  const ip = clientIp(req);
  let g;

  if (m === 'GET' && p === '/api/config') return json(res, 200, { smtp: SMTP_ON });
  if (m === 'GET' && p === '/api/me') return json(res, 200, { user: me ? pubUser(me) : null });

  if (m === 'POST' && p === '/api/register') {
    const rk = 'reg|' + ip;
    if (throttled(rk, 20)) throw bad('Demasiados registros desde esta red. Espera unos minutos.', 429);
    noteFail(rk);
    const c = validateContact(body);
    const pw = String(body.password || '');
    if (pw.length < 6) throw bad('La contraseña debe tener al menos 6 caracteres.');
    const id = await createUser(c, pw, 'vecino');
    return json(res, 201, { user: { id, name: c.name, email: c.email, phone: c.phone, role: 'vecino' } }, await startSession(id));
  }
  if (m === 'POST' && p === '/api/login') {
    const email = clean(body.email, 120).toLowerCase(), pw = String(body.password || '');
    const key = 'login|' + ip + '|' + email;
    if (throttled(key, 8)) throw bad('Demasiados intentos. Espera unos minutos.', 429);
    const u = await one('SELECT * FROM users WHERE email=$1', [email]);
    if (!u || !checkPw(pw, u.password_hash)) { noteFail(key); throw bad('Correo o contraseña incorrectos.', 401); }
    attempts.delete(key);
    return json(res, 200, { user: pubUser(u) }, await startSession(u.id));
  }
  if (m === 'POST' && p === '/api/logout') {
    const mm = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '');
    if (mm) await q('DELETE FROM sessions WHERE token=$1', [sha(mm[1])]);
    return json(res, 200, { ok: true }, { 'Set-Cookie': `sid=; ${cookieFlags()}; Max-Age=0` });
  }

  if (m === 'GET' && p === '/api/reports') {
    const u = needUser();
    const rows = u.role === 'admin'
      ? await q(`SELECT ${REPORT_COLS} FROM reports r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC`)
      : await q(`SELECT ${REPORT_COLS} FROM reports r JOIN users u ON u.id=r.user_id WHERE r.user_id=$1 ORDER BY r.id DESC`, [u.id]);
    return json(res, 200, { reports: rows.map(reportOut) });
  }
  if (m === 'POST' && p === '/api/reports') {
    const u = needUser();
    const c = validateContact(body);
    const location = clean(body.location, 200), reference = clean(body.reference, 200), note = clean(body.note, 300);
    if (location.length < 3) throw bad('Falta la ubicación (mínimo 3 caracteres).');
    if (reference.length < 3) throw bad('Falta la referencia del lugar (mínimo 3 caracteres).');
    const photo = String(body.photo || '');
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo) || photo.length > 1_500_000) throw bad('Falta la foto del poste (imagen válida).');
    const secs = Math.max(0, Math.min(86400, Math.round(Number(body.form_seconds) || 0)));
    const ins = await q(`INSERT INTO reports(user_id,photo,location,reference,note,name,phone,email,status,created_at,form_seconds)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [u.id, photo, location, reference, note, c.name, c.phone, c.email, 'Pendiente', now(), secs]);
    const id = Number(ins[0].id);
    const code = codeOf(id);
    queueMail(c.email, `Recibimos tu reporte ${code}`,
      `Hola ${c.name},\n\nTu reporte ${code} fue recibido por la Mini Muni de Boca del Monte.\n\nUbicación: ${location}\nReferencia: ${reference}\nEstado: Pendiente\n\nTe avisaremos cuando cambie su estado.\n\nGracias por ayudar a mantener iluminado nuestro barrio.`).catch(() => {});
    if (NOTIFY_EMAIL && EMAIL_RE.test(NOTIFY_EMAIL)) {
      queueMail(NOTIFY_EMAIL, `Nuevo reporte ${code}`,
        `Nuevo reporte de poste apagado\n\nCódigo: ${code}\nUbicación: ${location}\nReferencia: ${reference}\nReportado por: ${c.name}\nTeléfono: ${c.phone}\nCorreo: ${c.email}\nNota: ${note || '-'}`).catch(() => {});
    }
    return json(res, 201, { report: reportOut(await reportById(id)), mail: SMTP_ON ? 'smtp' : 'simulado' });
  }
  if (m === 'GET' && (g = /^\/api\/reports\/(\d+)\/photo$/.exec(p))) {
    const u = needUser();
    const r = await one('SELECT user_id,photo FROM reports WHERE id=$1', [Number(g[1])]);
    if (!r || (u.role !== 'admin' && r.user_id !== u.id)) throw bad('No encontrado', 404);
    const mm = /^data:(image\/[a-z]+);base64,(.*)$/.exec(r.photo);
    res.writeHead(200, { 'Content-Type': mm[1], 'Cache-Control': 'private, max-age=3600' });
    return res.end(Buffer.from(mm[2], 'base64'));
  }
  if (m === 'PATCH' && (g = /^\/api\/reports\/(\d+)$/.exec(p))) {
    needAdmin();
    const id = Number(g[1]);
    const r = await one('SELECT * FROM reports WHERE id=$1', [id]);
    if (!r) throw bad('No encontrado', 404);
    const status = String(body.status || '');
    if (!ESTADOS.includes(status)) throw bad('Estado no válido.');
    const reply = clean(body.reply, 500);
    const resolvedAt = status === 'Resuelto' ? (r.resolved_at || now()) : null;
    await q('UPDATE reports SET status=$1, admin_reply=$2, resolved_at=$3 WHERE id=$4', [status, reply, resolvedAt, id]);
    if (status !== r.status || reply !== r.admin_reply) {
      queueMail(r.email, `Tu reporte ${codeOf(id)} ahora está: ${status}`,
        `Hola ${r.name},\n\nTu reporte ${codeOf(id)} (${r.location}) cambió de estado a: ${status}.\n${reply ? '\nMensaje de la Mini Muni:\n' + reply + '\n' : ''}\n${status === 'Resuelto' ? 'Entra a la app para calificar la atención y dejarnos tus comentarios.\n' : ''}\nGracias por tu reporte.`).catch(() => {});
    }
    return json(res, 200, { report: reportOut(await reportById(id)) });
  }
  if (m === 'POST' && (g = /^\/api\/reports\/(\d+)\/rating$/.exec(p))) {
    const u = needUser();
    const id = Number(g[1]);
    const r = await one('SELECT * FROM reports WHERE id=$1', [id]);
    if (!r || r.user_id !== u.id) throw bad('No encontrado', 404);
    if (r.status !== 'Resuelto') throw bad('Solo puedes calificar un reporte resuelto.');
    const rating = Math.round(Number(body.rating));
    if (!(rating >= 1 && rating <= 5)) throw bad('Elige de 1 a 5 estrellas.');
    await q('UPDATE reports SET rating=$1, feedback=$2, rated_at=$3 WHERE id=$4', [rating, clean(body.feedback, 500), now(), id]);
    return json(res, 200, { report: reportOut(await reportById(id)) });
  }

  if (m === 'GET' && p === '/api/users') {
    needAdmin();
    const rows = await q('SELECT u.id,u.name,u.email,u.phone,u.role,u.created_at,(SELECT CAST(COUNT(*) AS INTEGER) FROM reports r WHERE r.user_id=u.id) AS reports FROM users u ORDER BY u.id');
    return json(res, 200, { users: rows });
  }
  if (m === 'POST' && p === '/api/users') {
    needAdmin();
    const c = validateContact(body);
    const pw = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'vecino';
    if (pw.length < 6) throw bad('La contraseña debe tener al menos 6 caracteres.');
    const id = await createUser(c, pw, role);
    return json(res, 201, { user: { id, name: c.name, email: c.email, phone: c.phone, role } });
  }
  if (m === 'GET' && p === '/api/emails') {
    needAdmin();
    return json(res, 200, { emails: await q('SELECT id,to_addr,subject,status,error,created_at FROM emails ORDER BY id DESC LIMIT 100'), smtp: SMTP_ON });
  }
  throw bad('No encontrado', 404);
}

const INDEX = path.join(__dirname, 'public', 'index.html');
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
  if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.on('finish', () => { if (!req.url.startsWith('/api/health') && !req.url.startsWith('/api/ready')) log({ m: req.method, u: req.url.split('?')[0], s: res.statusCode, ms: Date.now() - t0 }); });
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(INDEX));
    }
    if (!p.startsWith('/api/')) return json(res, 404, { error: 'No encontrado' });
    await handleApi(req, res, p, req.method);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Error interno del servidor' : e.message });
  }
});

async function boot() {
  await db.init();
  if (!(await one("SELECT id FROM users WHERE role='admin' LIMIT 1"))) {
    let pw = process.env.ADMIN_PASSWORD;
    if (!pw) {
      if (PROD) throw new Error('Falta ADMIN_PASSWORD (es obligatoria en producción para crear el administrador)');
      pw = 'admin1234';
      console.warn('[init] ADMIN_PASSWORD no definida: se usa una clave de desarrollo');
    }
    if (PROD && pw.length < 8) throw new Error('ADMIN_PASSWORD debe tener al menos 8 caracteres');
    await q('INSERT INTO users(name,email,phone,password_hash,role,created_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (email) DO NOTHING',
      ['Administrador Mini Muni', ADMIN_EMAIL, '', hashPw(pw), 'admin', now()]);
    log({ evento: 'admin_creado', email: ADMIN_EMAIL });
  }
  server.listen(PORT, () => log({ evento: 'escuchando', puerto: PORT, smtp: SMTP_ON ? 'activo' : 'simulado', db: process.env.DB_ADAPTER ? 'adaptador de pruebas' : 'postgresql' }));
}
const shutdown = (sig) => {
  log({ evento: 'apagando', senal: sig });
  server.close(() => db.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
boot().catch((e) => { console.error('[fatal]', e.message); process.exit(1); });
