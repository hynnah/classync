const express = require('express');
const { requireRole } = require('../auth/guard');
const { AdminRepo } = require('../db/repositories/AdminRepo');

const router = express.Router();

// Applied per-route below (matching every other router in this codebase),
// not via a path-less router.use() — a router mounted with app.use(router)
// (no prefix) runs its own router.use() middleware for ANY request that
// falls through to it, not just ones actually meant for this router. That
// bit once already: it silently gated /auth/test-bypass (mounted later in
// app.js) behind requireRole('admin') too, since an unmatched request just
// falls through routers in mount order.
const adminOnly = requireRole('admin');

function serializeUser(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    isAdmin: !!user.is_admin,
    isActive: !!user.is_active,
    createdAt: user.created_at,
  };
}

function serializeSpace(space) {
  return {
    id: space.id,
    name: space.name,
    joinCode: space.join_code,
    isActive: !!space.is_active,
    memberCount: Number(space.member_count),
    createdAt: space.created_at,
  };
}

function serializeActivity(row) {
  const actorName = row.actor_first_name
    ? `${row.actor_first_name} ${row.actor_last_name}`.trim()
    : (row.actor_email || null);
  return {
    id: row.id,
    actorName,
    actionType: row.action_type,
    targetType: row.target_type,
    targetId: row.target_id,
    targetLabel: row.target_label,
    createdAt: row.created_at,
  };
}

router.get('/api/admin/stats', ...adminOnly, async (req, res, next) => {
  try {
    res.json(await AdminRepo.getDashboardStats());
  } catch (err) {
    next(err);
  }
});

router.get('/api/admin/users', ...adminOnly, async (req, res, next) => {
  try {
    const users = await AdminRepo.listUsers({ search: req.query.search });
    res.json({ users: users.map(serializeUser) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/admin/users/:id/deactivate', ...adminOnly, async (req, res, next) => {
  try {
    const result = await AdminRepo.setUserActive({ userId: req.params.id, isActive: false, actingAdminId: req.user.id });
    if (result.error === 'self') {
      return res.status(400).json({ error: "You can't deactivate your own account." });
    }
    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'User not found.' });
    }
    await AdminRepo.logActivity({
      actorUserId: req.user.id,
      actionType: 'user_deactivated',
      targetType: 'user',
      targetId: result.user.id,
      targetLabel: result.user.email,
    });
    res.json({ user: serializeUser(result.user) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/admin/users/:id/activate', ...adminOnly, async (req, res, next) => {
  try {
    const result = await AdminRepo.setUserActive({ userId: req.params.id, isActive: true, actingAdminId: req.user.id });
    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'User not found.' });
    }
    await AdminRepo.logActivity({
      actorUserId: req.user.id,
      actionType: 'user_activated',
      targetType: 'user',
      targetId: result.user.id,
      targetLabel: result.user.email,
    });
    res.json({ user: serializeUser(result.user) });
  } catch (err) {
    next(err);
  }
});

router.get('/api/admin/spaces', ...adminOnly, async (req, res, next) => {
  try {
    const spaces = await AdminRepo.listSpaces({ search: req.query.search });
    res.json({ spaces: spaces.map(serializeSpace) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/admin/spaces/:id/deactivate', ...adminOnly, async (req, res, next) => {
  try {
    const result = await AdminRepo.setSpaceActive({ spaceId: req.params.id, isActive: false });
    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'Space not found.' });
    }
    await AdminRepo.logActivity({
      actorUserId: req.user.id,
      actionType: 'space_deactivated',
      targetType: 'space',
      targetId: result.space.id,
      targetLabel: result.space.name,
    });
    res.json({ space: serializeSpace(result.space) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/admin/spaces/:id/activate', ...adminOnly, async (req, res, next) => {
  try {
    const result = await AdminRepo.setSpaceActive({ spaceId: req.params.id, isActive: true });
    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'Space not found.' });
    }
    await AdminRepo.logActivity({
      actorUserId: req.user.id,
      actionType: 'space_activated',
      targetType: 'space',
      targetId: result.space.id,
      targetLabel: result.space.name,
    });
    res.json({ space: serializeSpace(result.space) });
  } catch (err) {
    next(err);
  }
});

router.get('/api/admin/activity', ...adminOnly, async (req, res, next) => {
  try {
    const activity = await AdminRepo.listActivity({ limit: req.query.limit, range: req.query.range });
    res.json({ activity: activity.map(serializeActivity) });
  } catch (err) {
    next(err);
  }
});

module.exports = { adminRouter: router };
