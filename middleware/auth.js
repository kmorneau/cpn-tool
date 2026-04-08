'use strict';

function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  if (req.accepts('html')) return res.redirect('/login');
  res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
  if (req.session.role === 'admin') return next();
  res.status(403).json({ error: 'Forbidden' });
}

module.exports = { requireLogin, requireAdmin };
