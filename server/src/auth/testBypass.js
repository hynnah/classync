const express = require('express');
const { UserRepo } = require('../db/repositories/UserRepo');
const { getPool } = require('../db/pool');

function mountTestBypass(app) {
  const router = express.Router();

  router.get('/auth/test-bypass', async (req, res, next) => {
    try {
      const email = req.query.email || 'test@example.com';
      const isAdmin = req.query.admin === 'true';
      const googleSub = 'test-bypass:' + email;

      let user = await UserRepo.findByGoogleSub(googleSub);
      if (!user) {
        user = await UserRepo.create({ googleSub, email, firstName: 'Test', lastName: 'User' });
      }
      if (isAdmin !== !!user.is_admin) {
        await getPool().query('UPDATE users SET is_admin = ? WHERE id = ?', [isAdmin, user.id]);
        user = await UserRepo.findById(user.id);
      }

      req.session.userId = user.id;
      res.json({ ok: true, userId: user.id, email: user.email, isAdmin: !!user.is_admin });
    } catch (err) {
      next(err);
    }
  });

  app.use(router);
}

module.exports = { mountTestBypass };
