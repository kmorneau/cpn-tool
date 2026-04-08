'use strict';
const express = require('express');
const session = require('express-session');
const path = require('path');

const SQLiteStore = require('connect-sqlite3')(session);
const { requireLogin, requireAdmin } = require('./middleware/auth');
const authRouter   = require('./routes/auth');
const modelsRouter = require('./routes/models');
const idef0Router  = require('./routes/idef0');
const adminRouter  = require('./routes/admin');

const PORT           = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'cpntool-dev-secret-change-in-production';

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: './data' }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.use('/auth', authRouter);
app.use('/api/models', requireLogin, modelsRouter);
app.use('/api/idef0',  requireLogin, idef0Router);
app.use('/admin', requireLogin, requireAdmin, adminRouter);

app.get('/', requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'cpn-tool.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`CPN Tool running at http://localhost:${PORT}`);
});
