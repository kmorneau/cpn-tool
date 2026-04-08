'use strict';
const express = require('express');
const bcrypt = require('bcrypt');
const path = require('path');
const db = require('../db');

const router = express.Router();
const BCRYPT_ROUNDS = 12;

router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

router.get('/api/users', (req, res) => {
  res.json(db.users.list.all());
});

router.post('/api/users', async (req, res) => {
  const { username, email, password, role = 'user' } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email, and password are required' });
  if (!['user', 'admin'].includes(role))
    return res.status(400).json({ error: 'role must be user or admin' });

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  try {
    const info = db.users.create.run(username, email, hash, role);
    res.status(201).json(db.users.findById.get(info.lastInsertRowid));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'username or email already taken' });
    throw e;
  }
});

router.patch('/api/users/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.users.findById.get(id)) return res.status(404).json({ error: 'Not found' });

  const { role, email, password } = req.body;

  if (role !== undefined) {
    if (!['user', 'admin'].includes(role))
      return res.status(400).json({ error: 'role must be user or admin' });
    if (id === req.session.userId && role !== 'admin')
      return res.status(400).json({ error: 'cannot demote your own account' });
    db.users.updateRole.run(role, id);
  }
  if (email !== undefined) db.users.updateEmail.run(email, id);
  if (password !== undefined) {
    if (password.length < 8)
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    db.users.updatePassword.run(await bcrypt.hash(password, BCRYPT_ROUNDS), id);
  }

  res.json(db.users.findById.get(id));
});

router.delete('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.session.userId)
    return res.status(400).json({ error: 'cannot delete your own account' });
  if (!db.users.findById.get(id)) return res.status(404).json({ error: 'Not found' });
  db.users.delete.run(id);
  res.sendStatus(204);
});

router.get('/api/users/:id/models', (req, res) => {
  res.json(db.models.listForUser.all(parseInt(req.params.id)));
});

module.exports = router;
