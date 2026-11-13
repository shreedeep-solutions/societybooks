// Solutions4Society backend — Cloud Functions (2nd gen), same region as the database (Singapore).
// Deployed automatically by .github/workflows/backend.yml when anything in functions/ changes.
const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');

setGlobalOptions({ region: 'asia-southeast1', maxInstances: 2, memory: '256MiB' });

// Health check: open https://asia-southeast1-mysocietybooks.cloudfunctions.net/health
exports.health = onRequest({ cors: true }, (req, res) => {
  res.json({ ok: true, service: 'S4S backend', version: '1.0.0', time: new Date().toISOString() });
});
