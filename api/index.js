// Vercel's serverless runtime looks for files under api/ and treats each
// exported handler as its own function. An Express app is already callable
// as (req, res) => {}, so exporting it directly is enough — no adapter
// library needed. createApp() is reused as-is from server/src/app.js; the
// app.listen() call in that file only runs when it's executed directly
// (require.main === module), which is never true here, so nothing tries to
// bind a port the way it would on a traditional server.
const { createApp } = require('../server/src/app');

module.exports = createApp();
