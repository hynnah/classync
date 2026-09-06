// In-process pub/sub for Server-Sent Events. One Node process, one Map —
// this doesn't survive a restart and doesn't span multiple server instances,
// which is fine for where this app is deployed today; a real multi-instance
// deployment would need this backed by something shared (Redis pub/sub or
// similar) instead of an in-memory Map.
const clientsByUserId = new Map();

function subscribe(userId, res) {
  if (!clientsByUserId.has(userId)) {
    clientsByUserId.set(userId, new Set());
  }
  clientsByUserId.get(userId).add(res);
}

function unsubscribe(userId, res) {
  const set = clientsByUserId.get(userId);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clientsByUserId.delete(userId);
}

function sendTo(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function notifyUser(userId, event, data) {
  const set = clientsByUserId.get(userId);
  if (!set) return;
  for (const res of set) sendTo(res, event, data);
}

function notifyUsers(userIds, event, data) {
  for (const userId of userIds) notifyUser(userId, event, data);
}

// Exposed for tests only — the count of currently-open connections for a user.
function connectionCount(userId) {
  return clientsByUserId.get(userId)?.size || 0;
}

module.exports = { subscribe, unsubscribe, notifyUser, notifyUsers, connectionCount };
