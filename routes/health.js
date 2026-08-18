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
   TEMPORARY deployment diagnostic - delete once the host is confirmed good.

   Reports only whether each credential is PRESENT, never its value, plus the
   two paths that explain most "my variables are ignored" problems on shared
   hosting. The marker proves which build is actually running, which is the
   one thing a restart button cannot tell you.
   -------------------------------------------------------------------------- */

router.get('/diag', function (req, res) {
  const fs = require('fs');
  const path = require('path');
  const envPath = path.join(__dirname, '..', '.env');

  const names = [
    'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_PHONE_ID',
    'WHATSAPP_API_TOKEN', 'ADMIN_API_KEY', 'PARTNER_API_KEY'
  ];

  const present = {};
  names.forEach(function (n) {
    present[n] = Boolean(process.env[n] && String(process.env[n]).trim());
  });

  /* Names only, never values. Every key name here is already published in
     .env.example, so this reveals nothing - but it turns "the file is there
     and nothing loaded" into an answer instead of a guess. */
  let envFile;
  try {
    const buf = fs.readFileSync(envPath);
    const text = buf.toString('utf8');
    const NL = String.fromCharCode(10);

    const keys = [];
    text.split(NL).forEach(function (line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.charAt(0) === '#') { return; }
      const at = trimmed.indexOf('=');
      if (at < 1) { return; }
      keys.push(trimmed.slice(0, at).trim());
    });

    envFile = {
      found: true,
      bytes: buf.length,
      /* A BOM, UTF-16, or a stray fence shows up here immediately */
      firstBytes: buf.slice(0, 4).toString('hex'),
      hasNullBytes: buf.includes(0),
      hasCR: buf.includes(13),
      lines: text.split(NL).length,
      keysFound: keys
    };
  } catch (error) {
    envFile = { found: false, reason: error.code };
  }

  return res.status(200).json({
    marker: 'diag-3',
    /* The questions the loaded engine actually holds. A deploy that has not
       taken effect is indistinguishable from one that has until you can see
       this - the file on disk proves nothing about the running process. */
    questions: require('../services/conversationEngine').QUESTIONS
      .map(function (q) { return q.id; }),
    node: process.version,
    cwd: process.cwd(),
    appDir: path.join(__dirname, '..'),
    envFile: envFile,
    present: present
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
