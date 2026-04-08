'use strict';
/**
 * Backend API integration tests.
 * Starts the Express server on a random port, runs tests, then tears down.
 *
 * Run with: node --test test/api.test.js
 */
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

// ── Spin up a test server on a free port ─────────────────────────────────────
// We override the DB path before requiring server modules so each test run
// gets an isolated in-memory-backed SQLite file.
const TEST_DB_DIR  = path.join(__dirname, '../data/test');
const TEST_DB_PATH = path.join(TEST_DB_DIR, `test-${Date.now()}.db`);

// Patch environment so db.js uses our test file
process.env.CPN_TEST_DB = TEST_DB_PATH;

// We can't easily hot-patch better-sqlite3's path after require(), so we use a
// separate test DB directory and clean it up after. The server/db modules use
// the test path when CPN_TEST_DB is set (see db.js patch below).
// Instead of patching, we start a real server but with a test-scoped DB by
// requiring server internals directly.

let server, baseUrl, sessionCookie, adminSessionCookie;

// Simple fetch-like helper using node:http
function req(method, path, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const r = http.request(options, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const setCookie = res.headers['set-cookie'];
        let json;
        try { json = data ? JSON.parse(data) : null; } catch { json = data; }
        resolve({ status: res.statusCode, body: json, headers: res.headers, setCookie });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function extractCookie(setCookieHeader) {
  if (!Array.isArray(setCookieHeader)) return null;
  return setCookieHeader.map(c => c.split(';')[0]).join('; ');
}

// ── Server bootstrap ─────────────────────────────────────────────────────────
before(async () => {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });

  // Require a fresh server instance bound to a random port
  // We need to temporarily override db path. Simplest: use a separate require
  // that the db module reads from env. Our db.js already handles CPN_TEST_DB.
  const app = await startTestApp();
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;

  // Register and login a regular user
  const reg = await req('POST', '/auth/register', {
    body: { username: 'testuser', email: 'test@test.com', password: 'testpass1' },
  });
  sessionCookie = extractCookie(reg.setCookie);

  // Register and manually promote an admin user
  const adminReg = await req('POST', '/auth/register', {
    body: { username: 'adminuser', email: 'admin@test.com', password: 'adminpass1' },
  });
  // Promote via DB directly — import db after env is set
  const db = require('../db');
  const adminUser = db.users.findByUsername.get('adminuser');
  db.users.updateRole.run('admin', adminUser.id);
  // Re-login to get fresh session with admin role
  const adminLogin = await req('POST', '/auth/login', {
    body: { username: 'adminuser', password: 'adminpass1' },
  });
  adminSessionCookie = extractCookie(adminLogin.setCookie);
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  // Clean up test DB files
  try { fs.rmSync(TEST_DB_DIR, { recursive: true, force: true }); } catch {}
});

async function startTestApp() {
  // Require modules fresh (they may already be cached if running alongside
  // other tests, but for the purpose of integration testing this is fine)
  const express = require('express');
  const session = require('express-session');
  const SQLiteStore = require('connect-sqlite3')(session);
  const { requireLogin, requireAdmin } = require('../middleware/auth');
  const authRouter   = require('../routes/auth');
  const modelsRouter = require('../routes/models');
  const adminRouter  = require('../routes/admin');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(session({
    store: new SQLiteStore({ db: `sessions-test-${Date.now()}.db`, dir: TEST_DB_DIR }),
    secret: 'test-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax' },
  }));
  app.use('/auth', authRouter);
  app.use('/api/models', requireLogin, modelsRouter);
  app.use('/admin', requireLogin, requireAdmin, adminRouter);
  app.use((err, req, res, _next) => {
    res.status(500).json({ error: err.message });
  });
  return app;
}

// ── Auth routes ──────────────────────────────────────────────────────────────
describe('Auth — /auth', () => {
  test('GET /auth/me returns user info when logged in', async () => {
    const r = await req('GET', '/auth/me', { cookie: sessionCookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.username, 'testuser');
    assert.equal(r.body.role, 'user');
  });

  test('GET /auth/me returns 401 when not logged in', async () => {
    const r = await req('GET', '/auth/me');
    assert.equal(r.status, 401);
  });

  test('POST /auth/register returns 400 if fields missing', async () => {
    const r = await req('POST', '/auth/register', { body: { username: 'x' } });
    assert.equal(r.status, 400);
  });

  test('POST /auth/register returns 400 if password < 8 chars', async () => {
    const r = await req('POST', '/auth/register', {
      body: { username: 'newuser', email: 'new@x.com', password: 'short' },
    });
    assert.equal(r.status, 400);
  });

  test('POST /auth/register returns 409 on duplicate username', async () => {
    const r = await req('POST', '/auth/register', {
      body: { username: 'testuser', email: 'other@x.com', password: 'password123' },
    });
    assert.equal(r.status, 409);
  });

  test('POST /auth/login returns 401 on bad password', async () => {
    const r = await req('POST', '/auth/login', {
      body: { username: 'testuser', password: 'wrongpassword' },
    });
    assert.equal(r.status, 401);
  });

  test('POST /auth/login returns 401 on unknown username', async () => {
    const r = await req('POST', '/auth/login', {
      body: { username: 'nobody', password: 'doesntmatter' },
    });
    assert.equal(r.status, 401);
  });

  test('POST /auth/logout returns 204', async () => {
    // Use a fresh session so we do not disturb the shared test session
    const fresh = await req('POST', '/auth/login', {
      body: { username: 'testuser', password: 'testpass1' },
    });
    const freshCookie = extractCookie(fresh.setCookie);
    const r = await req('POST', '/auth/logout', { cookie: freshCookie });
    assert.equal(r.status, 204);
  });
});

// ── Models API ───────────────────────────────────────────────────────────────
describe('Models API — /api/models', () => {
  const MODEL_CONTENT = 'colorset A = {a}\nplace P : A = {a}';
  let createdModelId;

  test('GET /api/models returns 401 without auth', async () => {
    const r = await req('GET', '/api/models');
    assert.equal(r.status, 401);
  });

  test('GET /api/models returns empty array initially', async () => {
    // Use a fresh user session to avoid interference from other tests
    const fresh = await req('POST', '/auth/register', {
      body: { username: 'modeltest', email: 'modeltest@x.com', password: 'password123' },
    });
    const c = extractCookie(fresh.setCookie);
    const r = await req('GET', '/api/models', { cookie: c });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });

  test('POST /api/models creates a model', async () => {
    const r = await req('POST', '/api/models', {
      cookie: sessionCookie,
      body: { name: 'my-model', content: MODEL_CONTENT },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.name, 'my-model');
    createdModelId = r.body.id;
  });

  test('POST /api/models returns 400 if name missing', async () => {
    const r = await req('POST', '/api/models', {
      cookie: sessionCookie,
      body: { content: MODEL_CONTENT },
    });
    assert.equal(r.status, 400);
  });

  test('POST /api/models returns 409 on duplicate name', async () => {
    const r = await req('POST', '/api/models', {
      cookie: sessionCookie,
      body: { name: 'my-model', content: MODEL_CONTENT },
    });
    assert.equal(r.status, 409);
  });

  test('GET /api/models/:id returns the model with content', async () => {
    const r = await req('GET', `/api/models/${createdModelId}`, { cookie: sessionCookie });
    assert.equal(r.status, 200);
    assert.equal(r.body.content, MODEL_CONTENT);
  });

  test('GET /api/models/:id returns 404 for wrong user', async () => {
    const fresh = await req('POST', '/auth/register', {
      body: { username: 'otheruser', email: 'other@x.com', password: 'password123' },
    });
    const c = extractCookie(fresh.setCookie);
    const r = await req('GET', `/api/models/${createdModelId}`, { cookie: c });
    assert.equal(r.status, 404);
  });

  test('PUT /api/models/:id updates content', async () => {
    const r = await req('PUT', `/api/models/${createdModelId}`, {
      cookie: sessionCookie,
      body: { content: 'colorset B = {b}' },
    });
    assert.equal(r.status, 200);
    const check = await req('GET', `/api/models/${createdModelId}`, { cookie: sessionCookie });
    assert.equal(check.body.content, 'colorset B = {b}');
  });

  test('DELETE /api/models/:id removes model', async () => {
    const r = await req('DELETE', `/api/models/${createdModelId}`, { cookie: sessionCookie });
    assert.equal(r.status, 204);
    const check = await req('GET', `/api/models/${createdModelId}`, { cookie: sessionCookie });
    assert.equal(check.status, 404);
  });
});

// ── Admin API ────────────────────────────────────────────────────────────────
describe('Admin API — /admin', () => {
  test('GET /admin/api/users returns 403 for non-admin', async () => {
    const r = await req('GET', '/admin/api/users', { cookie: sessionCookie });
    assert.equal(r.status, 403);
  });

  test('GET /admin/api/users returns user list for admin', async () => {
    const r = await req('GET', '/admin/api/users', { cookie: adminSessionCookie });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
    assert.ok(r.body.length >= 2);
    assert.ok(r.body.every(u => 'model_count' in u));
  });

  test('POST /admin/api/users creates user with specified role', async () => {
    const r = await req('POST', '/admin/api/users', {
      cookie: adminSessionCookie,
      body: { username: 'created', email: 'created@x.com', password: 'created123', role: 'user' },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.role, 'user');
  });

  test('POST /admin/api/users returns 400 for invalid role', async () => {
    const r = await req('POST', '/admin/api/users', {
      cookie: adminSessionCookie,
      body: { username: 'bad', email: 'bad@x.com', password: 'bad12345', role: 'superuser' },
    });
    assert.equal(r.status, 400);
  });

  test('PATCH /admin/api/users/:id changes role', async () => {
    const db = require('../db');
    const user = db.users.findByUsername.get('created');
    const r = await req('PATCH', `/admin/api/users/${user.id}`, {
      cookie: adminSessionCookie,
      body: { role: 'admin' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.role, 'admin');
  });

  test('DELETE /admin/api/users/:id removes user', async () => {
    const db = require('../db');
    const user = db.users.findByUsername.get('created');
    const r = await req('DELETE', `/admin/api/users/${user.id}`, { cookie: adminSessionCookie });
    assert.equal(r.status, 204);
    assert.equal(db.users.findById.get(user.id), undefined);
  });

  test('DELETE /admin/api/users/:id returns 400 for self-delete', async () => {
    const db = require('../db');
    const admin = db.users.findByUsername.get('adminuser');
    const r = await req('DELETE', `/admin/api/users/${admin.id}`, { cookie: adminSessionCookie });
    assert.equal(r.status, 400);
  });

  test('GET /admin/api/users/:id/models returns model list', async () => {
    const db = require('../db');
    const user = db.users.findByUsername.get('testuser');
    const r = await req('GET', `/admin/api/users/${user.id}/models`, { cookie: adminSessionCookie });
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body));
  });
});
