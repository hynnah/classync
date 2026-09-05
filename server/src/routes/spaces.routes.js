const express = require('express');
const { requireLogin } = require('../auth/guard');
const { SpaceRepo } = require('../db/repositories/SpaceRepo');
const { UserRepo } = require('../db/repositories/UserRepo');

const router = express.Router();

const JOIN_CODE_RE = /^[A-Z0-9]{6}$/;

function serializeSpace(space, role) {
  return {
    id: space.id,
    name: space.name,
    joinCode: space.join_code,
    role,
    memberCount: space.member_count !== undefined ? Number(space.member_count) : undefined,
  };
}

router.get('/api/spaces', requireLogin, async (req, res, next) => {
  try {
    const spaces = await SpaceRepo.listSpacesForUser(req.user.id);
    res.json({ spaces: spaces.map((s) => serializeSpace(s, s.role)) });
  } catch (err) {
    next(err);
  }
});

router.post('/api/spaces', requireLogin, async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }
    if (name.trim().length > 255) {
      return res.status(400).json({ error: 'name must be 255 characters or fewer.' });
    }
    const space = await SpaceRepo.createSpace({ name: name.trim(), creatorUserId: req.user.id });
    await UserRepo.markOnboarded(req.user.id);
    res.status(201).json({ space: serializeSpace(space, 'organizer') });
  } catch (err) {
    next(err);
  }
});

router.post('/api/spaces/join', requireLogin, async (req, res, next) => {
  try {
    const raw = (req.body && req.body.joinCode) || '';
    const joinCode = raw.trim().toUpperCase();
    if (!JOIN_CODE_RE.test(joinCode)) {
      return res.status(400).json({ error: 'That code doesn\'t look right — codes are 6 letters and numbers.' });
    }
    const result = await SpaceRepo.joinSpace({ joinCode, userId: req.user.id });
    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'No Space found with that code.' });
    }
    if (result.error === 'already_member') {
      await UserRepo.markOnboarded(req.user.id);
      return res.json({ space: serializeSpace(result.space, 'member'), alreadyMember: true });
    }
    await UserRepo.markOnboarded(req.user.id);
    res.status(201).json({ space: serializeSpace(result.space, 'member') });
  } catch (err) {
    next(err);
  }
});

router.get('/api/spaces/:id/members', requireLogin, async (req, res, next) => {
  try {
    const membership = await SpaceRepo.getMembership(req.params.id, req.user.id);
    if (!membership) {
      return res.status(404).json({ error: 'Space not found.' });
    }
    const members = await SpaceRepo.listMembers(req.params.id);
    res.json({
      members: members.map((m) => ({
        id: m.id,
        firstName: m.first_name,
        lastName: m.last_name,
        email: m.email,
        role: m.role,
        joinedAt: m.joined_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/api/spaces/:id', requireLogin, async (req, res, next) => {
  try {
    const { name } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required.' });
    }
    if (name.trim().length > 255) {
      return res.status(400).json({ error: 'name must be 255 characters or fewer.' });
    }
    const result = await SpaceRepo.rename({ spaceId: req.params.id, actingUserId: req.user.id, name: name.trim() });
    if (result.error === 'forbidden') {
      return res.status(403).json({ error: 'Only an Organizer can rename this Space.' });
    }
    res.json({ space: serializeSpace(result.space, 'organizer') });
  } catch (err) {
    next(err);
  }
});

router.post('/api/spaces/:id/members/:userId/promote', requireLogin, async (req, res, next) => {
  try {
    const result = await SpaceRepo.promoteMember({
      spaceId: req.params.id,
      actingUserId: req.user.id,
      targetUserId: Number(req.params.userId),
    });
    if (result.error === 'forbidden') {
      return res.status(403).json({ error: 'Only an Organizer can promote a member.' });
    }
    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'That person isn\'t a member of this Space.' });
    }
    if (result.error === 'already_organizer') {
      return res.status(400).json({ error: 'They\'re already an Organizer.' });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/api/spaces/:id/members/:userId', requireLogin, async (req, res, next) => {
  try {
    const result = await SpaceRepo.removeMember({
      spaceId: req.params.id,
      actingUserId: req.user.id,
      targetUserId: Number(req.params.userId),
    });
    if (result.error === 'forbidden') {
      return res.status(403).json({ error: 'Only an Organizer can remove a member.' });
    }
    if (result.error === 'use_leave_instead') {
      return res.status(400).json({ error: 'Use "Leave Space" to remove yourself.' });
    }
    if (result.error === 'not_found') {
      return res.status(404).json({ error: 'That person isn\'t a member of this Space.' });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/api/spaces/:id/leave', requireLogin, async (req, res, next) => {
  try {
    const result = await SpaceRepo.leaveSpace({ spaceId: req.params.id, userId: req.user.id });
    if (result.error === 'not_a_member') {
      return res.status(404).json({ error: 'You\'re not a member of this Space.' });
    }
    if (result.error === 'sole_organizer') {
      return res.status(400).json({
        error: 'You\'re the only Organizer and other Members remain — promote someone or remove everyone first.',
      });
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

module.exports = { spacesRouter: router };
