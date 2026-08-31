const { UserRepo } = require('../db/repositories/UserRepo');

async function requireLogin(req, res, next) {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    const user = await UserRepo.findById(req.session.userId);
    if (!user || !user.is_active) {
      req.session.destroy(() => {});
      return res.status(401).json({ error: 'Session no longer valid.' });
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(role) {
  if (role !== 'admin') {
    throw new Error(
      `requireRole('${role}') isn't supported — only 'admin' is a global role. ` +
      'Per-Space roles (organizer/member) are checked per-request against space_members, not via this middleware.'
    );
  }
  return [
    requireLogin,
    (req, res, next) => {
      if (!req.user.is_admin) {
        return res.status(403).json({ error: 'Admin access required.' });
      }
      next();
    },
  ];
}

module.exports = { requireLogin, requireRole };
