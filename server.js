/* ==========================================================================
   FTTH Support Assistant - server entry point (Phase 4)

   This file is deliberately short. Its only jobs are:

     1. create the Express app
     2. turn on the middleware every request goes through
     3. mount the route files
     4. handle errors
     5. start listening

   The actual behaviour lives in two folders:

     routes/    - HTTP: which URL does what, and which status code comes back
     services/  - logic: storing complaints, talking to WhatsApp, talking to a CRM

   Run with:  npm start     (or:  node server.js)
   ========================================================================== */

// Reads .env into process.env. Must run before anything reads a credential.
// In production (Render and friends) the variables are set in the dashboard
// instead, and there is no .env file - dotenv simply finds nothing and moves
// on, which is why this is safe to call unconditionally.
require('dotenv').config({
  /* An explicit path, not the default. dotenv resolves a bare '.env'
     against process.cwd(), and cwd is not the app folder under every
     host - Phusion Passenger on cPanel is one that can differ. When it
     does, dotenv finds nothing, reports nothing, and every credential
     silently stays unset. Anchoring to __dirname removes the guess. */
  path: require('path').join(__dirname, '.env')
});

const express = require('express');
const cors = require('cors');

// Route files (each one exports an express.Router)
const healthRoutes = require('./routes/health');
const complaintRoutes = require('./routes/complaints');
const webhookRoutes = require('./routes/webhook');

// Services used at startup: one makes sure data/complaints.json exists, the
// other reloads any conversations that were in progress before a restart
const complaintService = require('./services/complaintService');
const sessionStore = require('./services/sessionStore');
const whatsappService = require('./services/whatsappService');
const crmService = require('./services/crmService');

const app = express();

// Port comes from the environment when present, otherwise 3000.
// Render and most other hosts set PORT themselves, so this must be read
// rather than hard-coded or the health check will never pass.
const PORT = process.env.PORT || 3000;

/* --------------------------------------------------------------------------
   Middleware - runs on every request, in this order
   -------------------------------------------------------------------------- */

// There is no browser client any more - the bot lives on WhatsApp, and Meta's
// servers are not subject to CORS. This stays only so that an admin page or
// the client's CRM can call /api/complaints from a browser later; those routes
// need an API key regardless of origin.
app.use(cors());

// Parse incoming JSON request bodies into req.body.
//
// The `verify` hook keeps a copy of the exact bytes that arrived. Meta signs
// its webhooks over those bytes, and re-serialising the parsed object would
// produce different ones - a different key order or spacing is enough to make
// the signature fail. routes/webhook.js reads req.rawBody to check it.
app.use(express.json({
  limit: '256kb',
  verify: function (req, res, buffer) {
    req.rawBody = buffer;
  }
}));

/* --------------------------------------------------------------------------
   Routes

   Each router is mounted under a prefix. A route declared as '/' inside
   routes/health.js therefore answers on /health.

   Nothing is served as static files: there is no frontend. The whole
   conversation happens on WhatsApp, so data/, routes/, services/ and
   server.js are unreachable over HTTP simply because nothing serves them.
   -------------------------------------------------------------------------- */

app.use('/health', healthRoutes);              // GET  /health
app.use('/api/complaints', complaintRoutes);   // GET, POST - needs ADMIN_API_KEY
app.use('/webhook/whatsapp', webhookRoutes);   // GET, POST /webhook/whatsapp

/**
 * GET /
 * A human landing on the base URL should see something other than a 404, but
 * nothing about the customers or the complaints.
 */
app.get('/', function (req, res) {
  res.status(200).json({
    service: 'FTTH Support Assistant',
    channel: 'WhatsApp',
    webhook: '/webhook/whatsapp'
  });
});

/* --------------------------------------------------------------------------
   Error handling - these two must come AFTER every route
   -------------------------------------------------------------------------- */

/**
 * Nothing above matched, so the URL does not exist.
 * Returning JSON keeps API clients from receiving a surprise HTML page.
 */
app.use(function (req, res) {
  res.status(404).json({ success: false, error: 'Not found: ' + req.method + ' ' + req.originalUrl });
});

/**
 * Global error handler. Express recognises it as one because it takes four
 * arguments. Anything thrown in a route (or a bad JSON body) ends up here,
 * so a single malformed request can never take the server down.
 */
app.use(function (error, req, res, next) {
  // express.json() throws this when the body is not parseable JSON
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({ success: false, error: 'Request body is not valid JSON.' });
  }

  console.error('Unhandled error:', error);
  return res.status(500).json({ success: false, error: 'Something went wrong.' });
});

/* --------------------------------------------------------------------------
   Start
   -------------------------------------------------------------------------- */

// Create data/complaints.json if this is the first ever run
complaintService.initStorage();

// Reload conversations that were in progress when the process last stopped,
// and start the sweep that expires abandoned ones
sessionStore.init();

app.listen(PORT, function () {
  console.log('FTTH Support Assistant running on port ' + PORT);
  console.log('Complaints are stored in ' + complaintService.DATA_FILE);

  // The single most common "why is nothing happening" cause, said out loud
  if (whatsappService.isConfigured()) {
    console.log('WhatsApp: connected (phone id ' + process.env.WHATSAPP_PHONE_ID + ')');
  } else {
    console.log('WhatsApp: MOCK MODE - replies are logged, not sent.');
    console.log('          Set WHATSAPP_API_TOKEN and WHATSAPP_PHONE_ID to go live.');
  }

  if (!process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('WARNING: WHATSAPP_VERIFY_TOKEN is not set, so Meta cannot verify the webhook.');
  }

  if (crmService.isConfigured()) {
    console.log('CRM: connected (' + process.env.CRM_API_URL + ')');
  } else {
    console.log('CRM: not configured - complaints are saved but not sent to the portal.');
    console.log('     Set CRM_API_URL and CRM_API_KEY, and implement sendToCRM().');
  }
});

/* --------------------------------------------------------------------------
   Exported for Passenger

   cPanel runs Node apps under Phusion Passenger, which loads this file and
   expects the Express app back rather than starting its own listener. The
   app.listen() above is what every other host needs. Doing both keeps one
   file working in both places.
   -------------------------------------------------------------------------- */

module.exports = app;
