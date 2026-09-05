const express = require('express');
const { requireLogin } = require('../auth/guard');
const { ItemRepo } = require('../db/repositories/ItemRepo');

const router = express.Router();

const PERSONAL_KINDS = ['task', 'note'];
const CATEGORIES = ['Assignment', 'Activity', 'Quiz', 'Project', 'Presentation', 'Exam', 'Others'];
const STATUSES = ['pending', 'completed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

// Shared by POST (create) and PATCH (edit) — everything but kind itself, which is
// only meaningful at creation (see ItemRepo.update's note on why it's not editable).
// A note is just a title and a description — no category, no due date/time, no
// mark-done state (that last part is enforced in the UI, not here). kind is passed
// in explicitly by the caller: POST has it straight from the request body, PATCH
// has to look up the item's existing kind first since it isn't part of the payload.
function validateItemFields({ title, category, dueDate, dueTime, kind }) {
  if (typeof title !== 'string' || !title.trim()) {
    return 'title is required.';
  }
  if (title.trim().length > 255) {
    return 'title must be 255 characters or fewer.';
  }
  if (kind === 'note') {
    if (category !== undefined && category !== null && category !== '') {
      return 'notes don\'t have a category.';
    }
    if (dueDate !== undefined && dueDate !== null && dueDate !== '') {
      return 'notes don\'t have a due date.';
    }
    if (dueTime !== undefined && dueTime !== null && dueTime !== '') {
      return 'notes don\'t have a due time.';
    }
    return null;
  }
  if (category !== undefined && category !== null && !CATEGORIES.includes(category)) {
    return `category must be one of: ${CATEGORIES.join(', ')}`;
  }
  if (dueDate !== undefined && dueDate !== null && !DATE_RE.test(dueDate)) {
    return 'dueDate must be in YYYY-MM-DD format.';
  }
  if (dueTime !== undefined && dueTime !== null && !TIME_RE.test(dueTime)) {
    return 'dueTime must be in HH:MM or HH:MM:SS format.';
  }
  return null;
}

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
    const fieldError = validateItemFields({ title, category, dueDate, dueTime, kind });
    if (fieldError) {
      return res.status(400).json({ error: fieldError });
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

router.patch('/api/items/:id', requireLogin, async (req, res, next) => {
  try {
    const { title, description, category, dueDate, dueTime } = req.body || {};

    const existing = await ItemRepo.findForUser(req.params.id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    const fieldError = validateItemFields({ title, category, dueDate, dueTime, kind: existing.kind });
    if (fieldError) {
      return res.status(400).json({ error: fieldError });
    }

    const item = await ItemRepo.update({
      itemId: req.params.id,
      userId: req.user.id,
      title: title.trim(),
      description,
      category,
      dueDate,
      dueTime,
    });
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    res.json({ item });
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
