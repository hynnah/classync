const express = require('express');
const { requireLogin } = require('../auth/guard');
const { ItemRepo } = require('../db/repositories/ItemRepo');
const { SpaceRepo } = require('../db/repositories/SpaceRepo');
const { ItemCalendarEventRepo } = require('../db/repositories/ItemCalendarEventRepo');
const sseHub = require('../realtime/sseHub');
const { syncItemForUsers, deleteCalendarEventsForItem } = require('../calendar/sync');

// Notifies everyone with visibility into this item — every open session
// refreshing whatever view they're already on picks up the change the same
// way it already does after a local mutation, just without needing it to be
// their own tab that made the change. Returns the assignee list so callers
// that also need to sync Google Calendar don't have to look it up twice.
async function notifyItemUpdated(itemId, spaceId) {
  const assigneeIds = await ItemRepo.listAssigneeUserIds(itemId);
  sseHub.notifyUsers(assigneeIds, 'item_updated', { itemId, spaceId: spaceId || null });
  return assigneeIds;
}

const router = express.Router();

const PERSONAL_KINDS = ['task', 'note'];
const SPACE_KINDS = ['task', 'event'];
const CATEGORIES = ['Assignment', 'Activity', 'Quiz', 'Project', 'Presentation', 'Exam', 'Others'];
const STATUSES = ['pending', 'completed'];
const COLORS = ['salmon', 'peach', 'butter', 'lime', 'mint', 'seafoam', 'cyan', 'sky', 'periwinkle', 'lavender', 'orchid', 'rose'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

// Shared by POST (create) and PATCH (edit) — everything but kind itself, which is
// only meaningful at creation (see ItemRepo.update's note on why it's not editable).
// A note is just a title and a description — no category, no due date/time, no
// color, no mark-done state (that last part is enforced in the UI, not here). kind
// is passed in explicitly by the caller: POST has it straight from the request
// body, PATCH has to look up the item's existing kind first since it isn't part
// of the payload. spaceId is passed the same way, for the same reason — a Space
// item never gets a color (the picker is a personal-task-only feature; FR-O1
// doesn't list color among what an Organizer sets on a Space task/event).
function validateItemFields({ title, category, dueDate, dueTime, color, kind, spaceId }) {
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
    if (color !== undefined && color !== null && color !== '') {
      return 'notes don\'t have a color.';
    }
    return null;
  }
  if (category !== undefined && category !== null && !CATEGORIES.includes(category)) {
    return `category must be one of: ${CATEGORIES.join(', ')}`;
  }
  if (dueDate !== undefined && dueDate !== null && !DATE_RE.test(dueDate)) {
    return 'dueDate must be in YYYY-MM-DD format.';
  }
  // Unlike a Task (which has an undated home in the Tasks tab/To Do list),
  // an Event only ever surfaces through a date-based view — the calendar,
  // a day panel. Saved with no date, it's invisible everywhere and there's
  // no way back to it through the UI at all. `=== null` (not just falsy)
  // so an update that simply doesn't touch dueDate — leaving it undefined,
  // meaning "no change" — isn't wrongly rejected as if it were clearing it.
  if (kind === 'event' && dueDate === null) {
    return 'Events need a due date.';
  }
  if (dueTime !== undefined && dueTime !== null && !TIME_RE.test(dueTime)) {
    return 'dueTime must be in HH:MM or HH:MM:SS format.';
  }
  if (spaceId) {
    if (color !== undefined && color !== null && color !== '') {
      return 'Space items don\'t have a color.';
    }
  } else if (color !== undefined && color !== null && color !== '' && !COLORS.includes(color)) {
    return `color must be one of: ${COLORS.join(', ')}`;
  }
  return null;
}

router.get('/api/items', requireLogin, async (req, res, next) => {
  try {
    const { from, to, spaceId } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required.' });
    }
    if (spaceId) {
      const membership = await SpaceRepo.getMembership(spaceId, req.user.id);
      if (!membership) {
        return res.status(404).json({ error: 'Space not found.' });
      }
      const items = await ItemRepo.listForSpace({ spaceId, userId: req.user.id, from, to });
      return res.json({ items });
    }
    const items = await ItemRepo.listForUser({ userId: req.user.id, from, to });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.get('/api/items/todo', requireLogin, async (req, res, next) => {
  try {
    const { spaceId } = req.query;
    if (spaceId) {
      const membership = await SpaceRepo.getMembership(spaceId, req.user.id);
      if (!membership) {
        return res.status(404).json({ error: 'Space not found.' });
      }
      const items = await ItemRepo.listSpaceTodo({ spaceId, userId: req.user.id });
      return res.json({ items });
    }
    const items = await ItemRepo.listAllForUser(req.user.id);
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.get('/api/items/all', requireLogin, async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) {
      return res.status(400).json({ error: 'from and to (YYYY-MM-DD) are required.' });
    }
    const items = await ItemRepo.listAllScoped({ userId: req.user.id, from, to });
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

router.get('/api/items/all/todo', requireLogin, async (req, res, next) => {
  try {
    const items = await ItemRepo.listAllScopedTodo(req.user.id);
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

router.get('/api/items/all/urgent', requireLogin, async (req, res, next) => {
  try {
    const { dueToday, dueWeek } = await ItemRepo.listUrgentAllScoped(req.user.id);
    res.json({ dueToday, dueWeek });
  } catch (err) {
    next(err);
  }
});

router.post('/api/items', requireLogin, async (req, res, next) => {
  try {
    const { spaceId, kind, title, description, category, dueDate, dueTime, color, isOpenToAll, assigneeUserIds } = req.body || {};

    if (spaceId) {
      const membership = await SpaceRepo.getMembership(spaceId, req.user.id);
      if (!membership) {
        return res.status(404).json({ error: 'Space not found.' });
      }
      if (membership.role !== 'organizer') {
        return res.status(403).json({ error: 'Only an Organizer can create items in this Space.' });
      }
      if (!SPACE_KINDS.includes(kind)) {
        return res.status(400).json({ error: `kind must be one of: ${SPACE_KINDS.join(', ')}` });
      }
    } else if (!PERSONAL_KINDS.includes(kind)) {
      return res.status(400).json({ error: `kind must be one of: ${PERSONAL_KINDS.join(', ')}` });
    }

    // On create there's no prior value to preserve, so an omitted dueDate
    // means the same thing an explicit null does — normalized here so
    // validateItemFields' undefined-means-unchanged rule (which only makes
    // sense for an update) doesn't let a dateless Event slip through create.
    const fieldError = validateItemFields({
      title, category, dueDate: dueDate === undefined ? null : dueDate, dueTime, color, kind, spaceId,
    });
    if (fieldError) {
      return res.status(400).json({ error: fieldError });
    }

    let normalizedAssignees;
    if (spaceId && !isOpenToAll) {
      if (!Array.isArray(assigneeUserIds) || assigneeUserIds.length === 0) {
        return res.status(400).json({ error: 'Pick at least one assignee, or choose "open to all."' });
      }
      const members = await SpaceRepo.listMembers(spaceId);
      const memberIds = new Set(members.map((m) => m.id));
      normalizedAssignees = assigneeUserIds.map(Number);
      if (normalizedAssignees.some((id) => !memberIds.has(id))) {
        return res.status(400).json({ error: 'One or more assignees are not members of this Space.' });
      }
    }

    const item = await ItemRepo.create({
      createdBy: req.user.id,
      spaceId: spaceId || null,
      kind,
      title: title.trim(),
      description: description || null,
      category: category || null,
      dueDate: dueDate || null,
      dueTime: dueTime || null,
      color: color || null,
      isOpenToAll: spaceId ? !!isOpenToAll : false,
      assigneeUserIds: normalizedAssignees,
    });
    const assigneeIds = await notifyItemUpdated(item.id, item.space_id);
    await syncItemForUsers(item, assigneeIds);
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

router.patch('/api/items/:id', requireLogin, async (req, res, next) => {
  try {
    const { title, description, category, dueDate, dueTime, color } = req.body || {};

    const existing = await ItemRepo.findForUser(req.params.id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    const fieldError = validateItemFields({ title, category, dueDate, dueTime, color, kind: existing.kind, spaceId: existing.space_id });
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
      color,
    });
    if (!item) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    const assigneeIds = await notifyItemUpdated(item.id, item.space_id);
    await syncItemForUsers(item, assigneeIds);
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
    await notifyItemUpdated(item.id, item.space_id);
    res.json({ item });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/items/:id', requireLogin, async (req, res, next) => {
  try {
    // Assignees, space_id, and any synced-calendar-event mapping all have to
    // be read before the delete — the row (and its item_assignments/
    // item_calendar_events, both FK cascade-deleted) won't exist to read from
    // afterward.
    const existing = await ItemRepo.findById(req.params.id);
    const assigneeIds = existing ? await ItemRepo.listAssigneeUserIds(req.params.id) : [];
    const calendarMappings = existing ? await ItemCalendarEventRepo.listForItem(req.params.id) : [];

    const deleted = await ItemRepo.remove({ itemId: req.params.id, userId: req.user.id });
    if (!deleted) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    sseHub.notifyUsers(assigneeIds, 'item_updated', { itemId: Number(req.params.id), spaceId: existing.space_id, deleted: true });
    await deleteCalendarEventsForItem(calendarMappings);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = { itemsRouter: router };
