const express = require('express');
const { requireLogin } = require('../auth/guard');
const { ItemRepo } = require('../db/repositories/ItemRepo');
const { SpaceRepo } = require('../db/repositories/SpaceRepo');
const { ItemCalendarEventRepo } = require('../db/repositories/ItemCalendarEventRepo');
const sseHub = require('../realtime/sseHub');
const { syncItemForUsers, deleteCalendarEventsForItem } = require('../calendar/sync');
const { sanitizeNoteHtml } = require('../util/sanitizeNoteHtml');

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

// Whether THIS session has proved the notes PIN yet — used alongside a
// note's own is_locked flag (locking is per-note, not per-view): a locked
// note's content only ever shows once both a PIN exists AND this session has
// verified it. No PIN set at all means pinUnproven is always false — nothing
// to prove, so nothing's ever redacted.
function pinUnproven(req) {
  return !!req.user.notes_pin_hash && !req.session.notesUnlocked;
}

const PERSONAL_KINDS = ['task', 'note'];
const SPACE_KINDS = ['task', 'event'];
const CATEGORIES = ['Assignment', 'Activity', 'Quiz', 'Project', 'Presentation', 'Exam', 'Others'];
const STATUSES = ['pending', 'completed'];
const COLORS = ['salmon', 'peach', 'butter', 'lime', 'mint', 'seafoam', 'cyan', 'sky', 'periwinkle', 'lavender', 'orchid', 'rose'];
// The 20 book plates in client/assets/orn/ (e00.png..e19.png) — a note's
// decorative "plate", picked at random on create when none is given.
const PLATE_IDS = ['e00', 'e01', 'e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08', 'e09', 'e10', 'e11', 'e12', 'e13', 'e14', 'e15', 'e16', 'e17', 'e18', 'e19'];
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
function validateItemFields({ title, category, dueDate, dueTime, color, plate, isLocked, kind, spaceId }) {
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
    if (plate !== undefined && plate !== null && !PLATE_IDS.includes(plate)) {
      return `plate must be one of: ${PLATE_IDS.join(', ')}`;
    }
    if (isLocked !== undefined && typeof isLocked !== 'boolean') {
      return 'isLocked must be true or false.';
    }
    return null;
  }
  if (plate !== undefined && plate !== null && plate !== '') {
    return 'only notes have a plate.';
  }
  if (isLocked !== undefined && isLocked !== null && isLocked !== false) {
    return 'only notes can be locked.';
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
    // This endpoint mixes Personal tasks and notes together (see
    // listAllForUser), but the To Do view only ever wants tasks — Notes has
    // its own dedicated GET /api/notes below. No note, locked or not, needs
    // to be in this response at all.
    res.json({ items: items.filter((i) => i.kind !== 'note') });
  } catch (err) {
    next(err);
  }
});

// The Notes view's own dedicated read. Locking is per-note (items.is_locked),
// not per-view, so this never blocks the whole response — a locked note this
// session hasn't proven the PIN for comes back with its title still intact
// (so the list can show which note it is) but its description redacted to
// null; an explicit `redacted: true` flag is the client's signal for "still
// hidden," not a null check (a genuinely empty, unlocked note also has a
// null description, so that alone can't distinguish the two states).
function redactIfLocked(item, req) {
  if (!item.is_locked || !pinUnproven(req)) return item;
  return { ...item, description: null, redacted: true };
}
router.get('/api/notes', requireLogin, async (req, res, next) => {
  try {
    const items = await ItemRepo.listAllForUser(req.user.id);
    const notes = items.filter((i) => i.kind === 'note').map((n) => redactIfLocked(n, req));
    res.json({ items: notes, hasNotesPin: !!req.user.notes_pin_hash });
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
    const { spaceId, kind, title, description, category, dueDate, dueTime, color, plate, isOpenToAll, assigneeUserIds } = req.body || {};

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

    // A brand-new note is never locked (locking happens after creation, via
    // the editor's lock toggle) — nothing to gate at create time.

    // On create there's no prior value to preserve, so an omitted dueDate
    // means the same thing an explicit null does — normalized here so
    // validateItemFields' undefined-means-unchanged rule (which only makes
    // sense for an update) doesn't let a dateless Event slip through create.
    const fieldError = validateItemFields({
      title, category, dueDate: dueDate === undefined ? null : dueDate, dueTime, color, plate, kind, spaceId,
    });
    if (fieldError) {
      return res.status(400).json({ error: fieldError });
    }
    // New notes get a random plate when the caller doesn't pick one — every
    // note carries one from the moment it exists, never a blank/missing state
    // the client has to guard against.
    const notePlate = kind === 'note' ? (plate || PLATE_IDS[Math.floor(Math.random() * PLATE_IDS.length)]) : null;

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
      // Rich text is a Notes-only feature — a Task/Event's description stays
      // literal plain text (running it through the sanitizer would mangle a
      // legitimate "<" in something like "score < 70 means fail").
      description: kind === 'note' ? sanitizeNoteHtml(description) || null : (description || null),
      category: category || null,
      dueDate: dueDate || null,
      dueTime: dueTime || null,
      color: color || null,
      plate: notePlate,
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
    const { title, description, category, dueDate, dueTime, color, plate, isLocked } = req.body || {};

    const existing = await ItemRepo.findForUser(req.params.id, req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Item not found.' });
    }
    // A currently-locked note this session hasn't proven the PIN for refuses
    // every write, not just reads — content edits, plate changes, and
    // unlocking itself all require the same proof reading it would.
    // Locking a currently-unlocked note is the one write that's always
    // allowed content-wise (no proof needed to protect something going
    // forward), but only once a PIN actually exists to protect it with.
    if (existing.kind === 'note') {
      if (existing.is_locked && pinUnproven(req)) {
        return res.status(423).json({ error: 'This note is locked.' });
      }
      if (isLocked === true && !existing.is_locked && !req.user.notes_pin_hash) {
        return res.status(400).json({ error: 'Set a PIN in Settings before locking a note.' });
      }
    }
    const fieldError = validateItemFields({ title, category, dueDate, dueTime, color, plate, isLocked, kind: existing.kind, spaceId: existing.space_id });
    if (fieldError) {
      return res.status(400).json({ error: fieldError });
    }
    // undefined (not touching description at all) has to survive as
    // undefined — ItemRepo.update's own undefined-means-unchanged check is
    // what makes an autosave that only sent {title} leave the body alone.
    const cleanDescription = existing.kind === 'note' && description !== undefined
      ? sanitizeNoteHtml(description)
      : description;

    const item = await ItemRepo.update({
      itemId: req.params.id,
      userId: req.user.id,
      title: title.trim(),
      description: cleanDescription,
      category,
      dueDate,
      dueTime,
      color,
      plate,
      isLocked,
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
    if (existing && existing.kind === 'note' && existing.created_by === req.user.id && existing.is_locked && pinUnproven(req)) {
      return res.status(423).json({ error: 'This note is locked.' });
    }
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
