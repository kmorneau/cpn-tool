'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../db');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email, and password are required' });
  if (password.length < 8)
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  if (!/^\w+$/.test(username))
    return res.status(400).json({ error: 'username must contain only letters, numbers, and underscores' });

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  let user;
  try {
    const info = db.users.create.run(username, email, hash, 'user');
    user = db.users.findById.get(info.lastInsertRowid);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'username or email already taken' });
    throw e;
  }

  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role;
  db.users.updateLastLogin.run(user.id);

  res.status(201).json({ id: user.id, username: user.username, role: user.role });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'username and password are required' });

  const user = db.users.findByUsername.get(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.role     = user.role;
  db.users.updateLastLogin.run(user.id);

  res.json({ id: user.id, username: user.username, role: user.role });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.sendStatus(204));
});

router.get('/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
});

module.exports = router;
