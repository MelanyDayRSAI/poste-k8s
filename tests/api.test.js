'use strict';
// Pruebas funcionales y de permisos de la API. Sin dependencias (Node 22+).
// Uso:  BASE_URL=http://localhost:1000 ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/api.test.js
// Es repetible: crea usuarios con correos únicos en cada corrida.
const BASE = process.env.BASE_URL || 'http://localhost:500';
const ADMIN = { email: (process.env.ADMIN_EMAIL || 'admin@minimuni.local'), password: process.env.ADMIN_PASSWORD || 'admin1234' };
const RUN = Date.now();
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const R = []; let cat = '', last = 0;
const C = (c) => { cat = c; };
const t = (name, ok) => { R.push({ cat, name, ok: !!ok, ms: last }); console.log((ok ? 'OK    ' : 'FALLA ') + `[${cat}] ${name} (${last} ms)`); };

async function call(method, url, body, cookie, raw) {
  const t0 = Date.now();
  const r = await fetch(BASE + url, { method,
    headers: { ...(raw ? { 'Content-Type': 'text/plain' } : method !== 'GET' ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: method !== 'GET' ? (raw ? '{}' : JSON.stringify(body || {})) : undefined });
  const ct = r.headers.get('content-type') || '';
  const d = ct.includes('json') ? await r.json() : null; if (!d) await r.arrayBuffer();
  last = Date.now() - t0; const sc = r.headers.get('set-cookie');
  return { s: r.status, d: d || {}, ck: sc ? sc.split(';')[0] : null, ct };
}

(async () => {
  const mail = (n) => `${n}.${RUN}@prueba.test`;
  const good = { photo: JPG, location: 'Calle Real, Boca del Monte', reference: 'Frente a la farmacia', note: 'parpadea', name: 'María Pérez', phone: '5555 1234', email: mail('maria'), form_seconds: 48 };

  C('Disponibilidad');
  let r = await call('GET', '/api/health'); t('Liveness: /api/health responde 200', r.s === 200);
  r = await call('GET', '/api/ready'); t('Readiness: /api/ready confirma conexión a la base de datos', r.s === 200 && r.d.db === true);

  C('Autenticación');
  r = await call('POST', '/api/login', ADMIN); t('Administrador inicia sesión', r.s === 200 && r.d.user.role === 'admin'); const A = r.ck;
  r = await call('POST', '/api/login', { email: ADMIN.email, password: 'incorrecta' }); t('Contraseña incorrecta es rechazada', r.s === 401);
  r = await call('POST', '/api/register', { name: 'María Pérez', phone: '5555 1234', email: mail('maria'), password: 'secreto1' }); t('Un vecino puede registrarse', r.s === 201); const U = r.ck;
  r = await call('POST', '/api/register', { name: 'María Pérez', phone: '5555 1234', email: mail('maria'), password: 'secreto1' }); t('Correo duplicado es rechazado', r.s === 409);
  r = await call('POST', '/api/register', { name: 'Ana', phone: '12', email: 'x', password: '1' }); t('Registro con datos inválidos es rechazado', r.s === 400);

  C('Validaciones');
  r = await call('POST', '/api/reports', { ...good, phone: 'abc' }, U); t('Teléfono inválido es rechazado', r.s === 400);
  r = await call('POST', '/api/reports', { ...good, email: 'no-es-correo' }, U); t('Correo inválido es rechazado', r.s === 400);
  r = await call('POST', '/api/reports', { ...good, photo: 'hola' }, U); t('Foto inválida es rechazada', r.s === 400);
  r = await call('POST', '/api/reports', { ...good, location: '' }, U); t('Ubicación vacía es rechazada', r.s === 400);

  C('Reportes');
  r = await call('POST', '/api/reports', good, U);
  t('Reporte válido se guarda con número BDM-P-#### y estado Pendiente', r.s === 201 && /^BDM-P-\d{4}$/.test(r.d.report.code) && r.d.report.status === 'Pendiente' && r.d.report.form_seconds === 48);
  const id = r.d.report && r.d.report.id;
  r = await call('GET', '/api/reports', null, U); t('El vecino ve su reporte', r.d.reports.length === 1);
  r = await call('GET', `/api/reports/${id}/photo`, null, U); t('El dueño puede ver la foto', r.s === 200 && r.ct.includes('image/jpeg'));
  r = await call('GET', '/api/reports', null, A); t('La Mini Muni (admin) ve el reporte recibido', r.d.reports.some((x) => x.id === id && x.user_name === 'María Pérez'));

  C('Permisos');
  r = await call('POST', '/api/reports', good); t('Sin sesión no se puede reportar', r.s === 401);
  r = await call('POST', '/api/register', { name: 'Otro Vecino', phone: '5555 9999', email: mail('otro'), password: 'secreto2' }); const O = r.ck;
  r = await call('GET', `/api/reports/${id}/photo`, null, O); t('Otro vecino no ve la foto ajena', r.s === 404);
  r = await call('GET', '/api/reports', null, O); t('Otro vecino no ve reportes ajenos', r.d.reports.length === 0);
  r = await call('PATCH', `/api/reports/${id}`, { status: 'Resuelto' }, U); t('El vecino no puede cambiar el estado', r.s === 403);
  r = await call('GET', '/api/users', null, U); t('El vecino no puede listar usuarios', r.s === 403);
  r = await call('POST', '/api/reports', good, null, true); t('Solicitudes que no son JSON son rechazadas', r.s === 415);

  C('Estados y calificación');
  r = await call('POST', `/api/reports/${id}/rating`, { rating: 5 }, U); t('No se califica un reporte sin resolver', r.s === 400);
  r = await call('PATCH', `/api/reports/${id}`, { status: 'En revisión', reply: 'Cuadrilla en camino' }, A); t('Admin cambia a «En revisión» con mensaje', r.s === 200 && r.d.report.status === 'En revisión' && !r.d.report.resolved_at);
  r = await call('PATCH', `/api/reports/${id}`, { status: 'Resuelto', reply: 'Poste reparado' }, A); t('Admin resuelve y se registra la hora de resolución', r.s === 200 && !!r.d.report.resolved_at);
  r = await call('POST', `/api/reports/${id}/rating`, { rating: 9 }, U); t('Calificación fuera de 1–5 es rechazada', r.s === 400);
  r = await call('POST', `/api/reports/${id}/rating`, { rating: 4, feedback: 'Rápido, gracias' }, U); t('El vecino califica con estrellas y comentario', r.s === 200 && r.d.report.rating === 4);
  r = await call('POST', `/api/reports/${id}/rating`, { rating: 5 }, O); t('Otro vecino no puede calificar el reporte', r.s === 404);

  C('Usuarios');
  r = await call('POST', '/api/users', { name: 'Carlos Gómez', phone: '5555 7777', email: mail('carlos'), password: 'clave123', role: 'vecino' }, A); t('Admin crea un usuario', r.s === 201);
  r = await call('POST', '/api/login', { email: mail('carlos'), password: 'clave123' }); t('El usuario creado inicia sesión', r.s === 200);
  r = await call('GET', '/api/users', null, A); t('Admin lista usuarios con su número de reportes', r.s === 200 && r.d.users.find((u) => u.email === mail('maria')).reports === 1);

  C('Correos');
  r = await call('GET', '/api/emails', null, A); t('Se registran los correos (confirmación y cambios de estado)', r.d.emails.filter((e) => e.to_addr === mail('maria')).length >= 3);

  C('Sesión');
  await call('POST', '/api/logout', {}, U); r = await call('GET', '/api/me', null, U); t('Cerrar sesión invalida la sesión', r.d.user === null);

  const ok = R.filter((x) => x.ok).length;
  if (process.env.RESULTS_FILE) require('node:fs').writeFileSync(process.env.RESULTS_FILE, JSON.stringify(R));
  console.log(`\n${ok}/${R.length} pruebas aprobadas`);
  process.exit(ok === R.length ? 0 : 1);
})().catch((e) => { console.error('ERROR EN LAS PRUEBAS:', e.message); process.exit(2); });
