'use strict';
const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/idef0  — list all diagrams for the current user
router.get('/', (req, res) => {
  res.json(db.idef0.list.all(req.session.userId));
});

// POST /api/idef0  — create a new diagram
router.post('/', (req, res) => {
  const { name, content } = req.body;
  if (!name || !content)
    return res.status(400).json({ error: 'name and content are required' });
  let info;
  try {
    info = db.idef0.create.run(req.session.userId, name, content);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'a diagram with that name already exists' });
    throw e;
  }
  const diagram = db.idef0.findById.get(info.lastInsertRowid, req.session.userId);
  res.status(201).json({ id: diagram.id, name: diagram.name, created_at: diagram.created_at, updated_at: diagram.updated_at });
});

// GET /api/idef0/:id
router.get('/:id', (req, res) => {
  const diagram = db.idef0.findById.get(parseInt(req.params.id), req.session.userId);
  if (!diagram) return res.status(404).json({ error: 'Not found' });
  res.json(diagram);
});

// PUT /api/idef0/:id
router.put('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.idef0.findById.get(id, req.session.userId))
    return res.status(404).json({ error: 'Not found' });
  const { name, content } = req.body;
  try {
    db.idef0.update.run(name || null, content || null, id, req.session.userId);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE')
      return res.status(409).json({ error: 'a diagram with that name already exists' });
    throw e;
  }
  const updated = db.idef0.findById.get(id, req.session.userId);
  res.json({ id: updated.id, name: updated.name, created_at: updated.created_at, updated_at: updated.updated_at });
});

// DELETE /api/idef0/:id
router.delete('/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (!db.idef0.findById.get(id, req.session.userId))
    return res.status(404).json({ error: 'Not found' });
  db.idef0.delete.run(id, req.session.userId);
  res.sendStatus(204);
});

module.exports = router;
