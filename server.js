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
const ENV_FILE = require('path').join(__dirname, '.env');

/* An explicit path, not dotenv's default. dotenv resolves a bare '.env'
   against process.cwd(), and cwd is not the app folder under every host -
   Phusion Passenger and LiteSpeed on cPanel are two that can differ. When
   they do, dotenv finds nothing, reports nothing, and every credential
   silently stays unset.

   The fallback matters just as much. On shared hosting a half-finished
   `npm install` is common and there is often no shell to fix it with, and a
   missing module here would stop the whole service on its first line - so
   the credentials would be unreadable for the most trivial reason possible.
   Reading a KEY=value file needs no library, so losing dotenv costs us
   nothing but a log line. */
try {
  require('dotenv').config({ path: ENV_FILE });
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') { throw error; }
  console.warn('[env] dotenv is not installed - using the built-in reader');
  readEnvFile(ENV_FILE);
}

/**
 * The smallest thing that can read a .env: KEY=value a line at a time.
 *
 * Deliberately matches dotenv on the two rules that matter - blank lines and
 * `#` comments are skipped, and a variable already set in the real
 * environment always wins, so the host's own settings are never overwritten.
 *
 * No file is not an error. Most hosts set variables in a dashboard and have
 * no .env at all, which is exactly how this is meant to run in production.
 */
function readEnvFile(file) {
  let contents;
  try {
    contents = require('fs').readFileSync(file, 'utf8');
  } catch (error) {
    return;
  }

  /* Split on newlines only - trim() below removes any carriage return */
  contents.split(String.fromCharCode(10)).forEach(function (line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.charAt(0) === '#') { return; }

    const split = trimmed.indexOf('=');
    if (split < 1) { return; }

    const key = trimmed.slice(0, split).trim();
    let value = trimmed.slice(split + 1).trim();

    // Strip one matching pair of surrounding quotes, if present
    const quoted = value.length > 1 &&
      (value.charAt(0) === '"' || value.charAt(0) === "'") &&
      value.charAt(value.length - 1) === value.charAt(0);
    if (quoted) { value = value.slice(1, -1); }

    if (process.env[key] === undefined) { process.env[key] = value; }
  });
}

const express = require('express');

/* Same reasoning as dotenv above: cors is a convenience, not a requirement,
   and it must not be able to take the service down. Nothing in the WhatsApp
   flow needs CORS at all - Meta's servers do not send an Origin - so the
   fallback below is only here for a future admin page. */
let cors;
try {
  cors = require('cors');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') { throw error; }
  console.warn('[cors] the cors package is not installed - using a minimal stand-in');
  cors = function () {
    return function (req, res, next) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') { return res.sendStatus(204); }
      return next();
    };
  };
}

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
