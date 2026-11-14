# Reporta tu Poste v3.0 (EN CONSTRUCCION)

Estado: codigo y manifiestos escritos; README completo pendiente.
- server.js + db.js: API Node.js 22 sobre PostgreSQL (Cloud SQL). Pruebas: `node tests/api.test.js` (32/32 con adaptador de prueba; NO probado aun contra PostgreSQL real).
- Prueba local con PostgreSQL: `docker compose -f docker-compose.dev.yml up --build` -> http://localhost:1000 (admin: admin@minimuni.local / admin-dev-1234).
- k8s/: namespace, configmap, secret.example, deployment (2 replicas + Cloud SQL Auth Proxy sidecar), service, ingress, pdb, hpa. NO probados en un cluster.
- Variables importantes: PGHOST, PGUSER, PGPASSWORD, PGDATABASE, ADMIN_EMAIL, ADMIN_PASSWORD (obligatoria en produccion), COOKIE_SECURE, TRUST_PROXY, SMTP_*.
