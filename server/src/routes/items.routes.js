const express = require('express');
const { requireLogin } = require('../auth/guard');
const { ItemRepo } = require('../db/repositories/ItemRepo');

const router = express.Router();

const PERSONAL_KINDS = ['task', 'note'];
const CATEGORIES = ['Assignment', 'Activity', 'Quiz', 'Project', 'Presentation', 'Exam', 'Others'];
const STATUSES = ['pending', 'completed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

router.get('/api/items', requireLogin, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required.' });
    }
    const items = await ItemRepo.listForUser({ userId: req.user.id, from, to });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.get('/api/items/urgent', requireLogin, async (req, res, next) => {
  try {
    const { dueToday, dueWeek } = await ItemRepo.listUrgentForUser(req.user.id);
    res.json({ dueToday, dueWeek });
  } catch (err) {
    next(err);
  }
});

router.post('/api/items', requireLogin, async (req, res, next) => {
  try {
    const { kind, title, description, category, dueDate, dueTime } = req.body || {};

    if (!PERSONAL_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${PERSONAL_KINDS.join(', ')}` });
    }
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title is required.' });
    }
    if (title.trim().length > 255) {
      return res.status(400).json({ error: 'title must be 255 characters or fewer.' });
    }
    if (category !== undefined && category !== null && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` });
    }
    if (dueDate !== undefined && dueDate !== null && !DATE_RE.test(dueDate)) {
      return res.status(400).json({ error: 'dueDate must be in YYYY-MM-DD format.' });
    }
    if (dueTime !== undefined && dueTime !== null && !TIME_RE.test(dueTime)) {
      return res.status(400).json({ error: 'dueTime must be in HH:MM or HH:MM:SS format.' });
    }

    const item = await ItemRepo.create({
      createdBy: req.user.id,
      kind,
      title: title.trim(),
      description: description || null,
      category: category || null,
      dueDate: dueDate || null,
      dueTime: dueTime || null,
    });
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

router.patch('/api/items/:id/status', requireLogin, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
    }
    const item = await ItemRepo.setStatus({ itemId: req.params.id, userId: req.user.id, status });
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/items/:id', requireLogin, async (req, res, next) => {
  try {
    const deleted = await ItemRepo.remove({ itemId: req.params.id, userId: req.user.id });
    if (!deleted) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = { itemsRouter: router };
