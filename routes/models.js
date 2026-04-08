'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(db.models.list.all(req.session.userId));
});

router.post('/', (req, res) => {
  const { name, content } = req.body;
  if (!name || !content)
    return res.status(400).json({ error: 'name and content are required' });
  let info;
  try {
    info = db.models.create.run(req.session.userId, name, content);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'a model with that name already exists' });
    throw e;
  }
  const model = db.models.findById.get(info.lastInsertRowid, req.session.userId);
  res.status(201).json({ id: model.id, name: model.name, created_at: model.created_at, updated_at: model.updated_at });
});

router.get('/:id', (req, res) => {
  const model = db.models.findById.get(parseInt(req.params.id), req.session.userId);
  if (!model) return res.status(404).json({ error: 'Not found' });
  res.json(model);
});

router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.models.findById.get(id, req.session.userId))
    return res.status(404).json({ error: 'Not found' });
  const { name, content } = req.body;
  try {
    db.models.update.run(name || null, content || null, id, req.session.userId);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'a model with that name already exists' });
    throw e;
  }
  const updated = db.models.findById.get(id, req.session.userId);
  res.json({ id: updated.id, name: updated.name, created_at: updated.created_at, updated_at: updated.updated_at });
});

router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.models.findById.get(id, req.session.userId))
    return res.status(404).json({ error: 'Not found' });
  db.models.delete.run(id, req.session.userId);
  res.sendStatus(204);
});

module.exports = router;
