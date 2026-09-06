const { ItemRepo } = require('../db/repositories/ItemRepo');
const { CalendarTokenRepo } = require('../db/repositories/CalendarTokenRepo');
const { ItemCalendarEventRepo } = require('../db/repositories/ItemCalendarEventRepo');
const { clientForRefreshToken, revokeToken } = require('./googleCalendar');

const CALENDAR_ID = 'primary';

// No per-user timezone is stored anywhere in the schema — the rest of the app
// already treats due_date/due_time as naive local values with no timezone
// concept at all, so this picks one fixed zone rather than inventing a
// per-user setting Day 7 doesn't otherwise need. Same class of documented
// simplification as sseHub's single-process pub/sub.
const DEFAULT_TIME_ZONE = 'Asia/Manila';

function pad(n) {
  return String(n).padStart(2, '0');
}

// Adds a fixed duration to a naive "YYYY-MM-DDTHH:MM:SS" wall-clock string by
// doing the arithmetic in UTC and formatting the result back the same way —
// correct regardless of real-world DST because the value is never actually
// interpreted as UTC, only used as a scratch epoch for calendar math.
function addWallClock(dueDate, dueTime, ms) {
  const [y, m, d] = dueDate.split('-').map(Number);
  const [h, min, s] = dueTime.split(':').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d, h, min, s || 0) + ms);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}T${pad(next.getUTCHours())}:${pad(next.getUTCMinutes())}:${pad(next.getUTCSeconds())}`;
}

function addDays(dueDate, days) {
  const [y, m, d] = dueDate.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

// Only a dated task or an event (always dated) is calendar-shaped — a note
// and an undated task have nothing to sync. Exported for direct unit testing
// without a DB or network call.
function buildEventResource(item) {
  if (!item.due_date) return null;
  const resource = {
    summary: item.title,
    description: item.description || undefined,
  };
  if (item.due_time) {
    resource.start = { dateTime: `${item.due_date}T${item.due_time}`, timeZone: DEFAULT_TIME_ZONE };
    resource.end = { dateTime: addWallClock(item.due_date, item.due_time, 60 * 60 * 1000), timeZone: DEFAULT_TIME_ZONE };
  } else {
    // Google Calendar all-day events use an exclusive end date.
    resource.start = { date: item.due_date };
    resource.end = { date: addDays(item.due_date, 1) };
  }
  return resource;
}

function isGoneError(err) {
  return err && (err.code === 404 || err.code === 410);
}

async function deleteGoogleEvent(calendar, eventId) {
  try {
    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
  } catch (err) {
    if (!isGoneError(err)) throw err;
  }
}

async function syncItemForUser(item, userId) {
  const token = await CalendarTokenRepo.getForUser(userId);
  if (!token || !token.is_connected || !token.encrypted_refresh_token) return;

  const resource = buildEventResource(item);
  const existing = await ItemCalendarEventRepo.getForItemUser(item.id, userId);
  const calendar = clientForRefreshToken(token.encrypted_refresh_token);

  if (!resource) {
    // e.g. a task's due date was edited away to nothing — nothing left to
    // place on a calendar, so any previously-synced event is torn down.
    if (existing) {
      await deleteGoogleEvent(calendar, existing.google_event_id);
      await ItemCalendarEventRepo.remove(item.id, userId);
    }
    return;
  }

  if (existing) {
    try {
      await calendar.events.update({ calendarId: CALENDAR_ID, eventId: existing.google_event_id, requestBody: resource });
      return;
    } catch (err) {
      if (!isGoneError(err)) throw err;
      // The event was removed on the Google side independently (the user
      // deleted it themselves in their own calendar) — fall through and
      // recreate rather than erroring out a routine item edit over it.
    }
  }
  const created = await calendar.events.insert({ calendarId: CALENDAR_ID, requestBody: resource });
  await ItemCalendarEventRepo.upsert(item.id, userId, created.data.id);
}

// One assignee's failed sync (revoked token, API outage) never blocks the
// others or the item mutation itself — logged, not thrown.
async function syncItemForUsers(item, userIds) {
  await Promise.allSettled(userIds.map((userId) => syncItemForUser(item, userId).catch((err) => {
    console.error(`Calendar sync failed for item ${item.id}, user ${userId}:`, err.message);
  })));
}

// Called after the item row (and its cascade-deleted item_calendar_events
// rows) is already gone — mappings must be read by the caller beforehand.
async function deleteCalendarEventsForItem(mappings) {
  await Promise.allSettled(mappings.map(async ({ user_id: userId, google_event_id: googleEventId }) => {
    try {
      const token = await CalendarTokenRepo.getForUser(userId);
      if (!token || !token.encrypted_refresh_token) return;
      await deleteGoogleEvent(clientForRefreshToken(token.encrypted_refresh_token), googleEventId);
    } catch (err) {
      console.error(`Calendar event delete failed for user ${userId}:`, err.message);
    }
  }));
}

// Runs once right after a fresh connect — pushes every pre-existing dated
// item the user can already see, not just ones touched from now on.
async function backfillForUser(userId) {
  const items = await ItemRepo.listAllDatedForUser(userId);
  await Promise.allSettled(items.map((item) => syncItemForUser(item, userId).catch((err) => {
    console.error(`Calendar backfill failed for item ${item.id}, user ${userId}:`, err.message);
  })));
}

// Disconnect deletes the token row outright (not just a flag), so anything
// that needs the token — deleting synced events, revoking the grant — has to
// happen first, using the token that's about to disappear.
async function disconnectAndCleanup(userId) {
  const token = await CalendarTokenRepo.getForUser(userId);
  if (token && token.encrypted_refresh_token) {
    const mappings = await ItemCalendarEventRepo.listForUser(userId);
    const calendar = clientForRefreshToken(token.encrypted_refresh_token);
    await Promise.allSettled(mappings.map(async ({ item_id: itemId, google_event_id: googleEventId }) => {
      try {
        await deleteGoogleEvent(calendar, googleEventId);
      } catch (err) {
        console.error(`Calendar event delete failed during disconnect for user ${userId}:`, err.message);
      }
      // Not cascade-deleted by the token row going away (item_calendar_events
      // has no FK to google_calendar_tokens) — cleared explicitly so a stale
      // mapping doesn't linger pointing at an event that no longer exists.
      await ItemCalendarEventRepo.remove(itemId, userId);
    }));
    await revokeToken(token.encrypted_refresh_token).catch((err) => {
      console.error(`Calendar token revoke failed for user ${userId}:`, err.message);
    });
  }
  await CalendarTokenRepo.disconnect(userId);
}

module.exports = {
  buildEventResource,
  syncItemForUser,
  syncItemForUsers,
  deleteCalendarEventsForItem,
  backfillForUser,
  disconnectAndCleanup,
};
