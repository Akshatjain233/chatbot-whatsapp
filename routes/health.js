/* ==========================================================================
   routes/health.js

   Mounted in server.js at /health, so the '/' below means GET /health.

   Useful during development, and required in production: Render and most
   other hosts poll a URL like this to decide whether a deploy succeeded and
   whether the service is still alive.

   The two extra routes at the bottom exist only for the test suite and are
   switched off unless ENABLE_TEST_HOOKS=1. They are not mounted in normal
   runs, so there is nothing extra exposed in production.
   ========================================================================== */

const express = require('express');
const sessionStore = require('../services/sessionStore');
const whatsappService = require('../services/whatsappService');
const crmService = require('../services/crmService');

const router = express.Router();

/**
 * GET /health
 *
 * Reports whether WhatsApp credentials are present, because "the bot is not
 * replying" is almost always this - the service is up, but running in mock
 * mode with no token, so every reply is logged instead of sent.
 *
 * 200 -> { status: 'ok', whatsapp: 'connected' | 'mock', sessions: 3 }
 */
router.get('/', function (req, res) {
  return res.status(200).json({
    status: 'ok',
    whatsapp: whatsappService.isConfigured() ? 'connected' : 'mock',
    crm: crmService.isConfigured() ? 'connected' : 'not configured',
    sessions: sessionStore.count()
  });
});

/* --------------------------------------------------------------------------
   Test hooks

   The webhook answers Meta before it does any work, so a test that asserted
   straight after posting would race the bot. These let the suite wait for the
   conversation to actually move, and reset between tests.
   -------------------------------------------------------------------------- */

if (process.env.ENABLE_TEST_HOOKS === '1') {

  /**
   * GET /health/session/:key
   *
   * Where that customer is in the conversation, plus `processed` - the count
   * of messages the webhook has finished handling. The suite waits on that
   * counter, because timestamps are too coarse: a whole conversation runs in
   * a couple of milliseconds, so consecutive turns share a Date.now() value.
   */
  router.get('/session/:key', function (req, res) {
    const webhookRoutes = require('./webhook');
    const session = sessionStore.get(req.params.key);
    const processed = webhookRoutes.processedCount();

    if (!session) {
      return res.status(200).json({ exists: false, processed: processed });
    }

    return res.status(200).json({
      exists: true,
      processed: processed,
      stepId: session.stepId,
      updatedAt: session.updatedAt,
      awaitingMedia: session.awaitingMedia,
      formData: session.formData
    });
  });

  /** POST /health/reset -> forget every conversation */
  router.post('/reset', function (req, res) {
    sessionStore.reset();
    return res.status(200).json({ reset: true });
  });

  console.log('[health] test hooks are ENABLED - do not run like this in production');
}

module.exports = router;
