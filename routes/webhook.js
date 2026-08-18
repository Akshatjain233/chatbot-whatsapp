/* ==========================================================================
   routes/webhook.js

   Where WhatsApp talks to us. Mounted at /webhook/whatsapp.

   Two jobs:

   1. VERIFICATION (the GET). When you register the webhook URL in the Meta
      dashboard, WhatsApp immediately sends a GET carrying hub.mode,
      hub.verify_token and hub.challenge. We must check the token against our
      own and reply with the raw challenge value as plain text. Until that
      works, Meta refuses to save the webhook at all - and the dashboard error
      does not tell you why.

   2. INCOMING MESSAGES (the POST). Every customer message arrives here.

   THREE RULES THAT THE POST HANDLER IS BUILT AROUND

   a. ANSWER 200 IMMEDIATELY. Meta treats a slow or failed response as a
      delivery failure and sends the same message again. Registering a
      complaint, saving a session and calling the Cloud API all take longer
      than we should make Meta wait, so the response goes out first and the
      work happens after.

   b. THE SAME MESSAGE WILL ARRIVE TWICE. Rule (a) reduces retries but cannot
      remove them - a redeploy mid-request, a network blip, or Meta simply
      being cautious all cause replays. Without a guard, one replayed message
      files a SECOND complaint with a second ID. Every message id is therefore
      remembered briefly and repeats are dropped.

   c. MOST DELIVERIES ARE NOT MESSAGES. Meta posts delivery receipts and read
      receipts to this same URL. They have no `messages` array and must be
      ignored silently rather than treated as an empty message.
   ========================================================================== */

const express = require('express');
const crypto = require('crypto');

const engine = require('../services/conversationEngine');
const sessionStore = require('../services/sessionStore');
const whatsappService = require('../services/whatsappService');

const router = express.Router();

/* --------------------------------------------------------------------------
   Replay protection

   Message ids seen recently. Bounded in both directions: entries older than
   the window are dropped, and the map is capped so a flood cannot grow it
   without limit.
   -------------------------------------------------------------------------- */

const SEEN_WINDOW_MS = 10 * 60 * 1000;
const SEEN_MAX = 5000;

const seenMessages = new Map();   // messageId -> timestamp

/* Counts messages that have been handled all the way through, including the
   replies going out. Exposed via the health test hook so the suite can wait
   for the bot to finish rather than guessing with a sleep - the webhook
   answers Meta before it does the work, so there is nothing else to wait on. */
let processedCount = 0;

/**
 * Records a message id and says whether it is new.
 * @param {string} messageId
 * @returns {boolean} true the first time, false for a replay
 */
function isFirstSighting(messageId) {
  const now = Date.now();

  if (seenMessages.has(messageId)) {
    return false;
  }

  // Opportunistic cleanup, so no timer is needed
  if (seenMessages.size >= SEEN_MAX) {
    seenMessages.forEach(function (seenAt, id) {
      if (now - seenAt > SEEN_WINDOW_MS) { seenMessages.delete(id); }
    });
    // Still full of recent entries: drop the oldest to stay bounded
    if (seenMessages.size >= SEEN_MAX) {
      const oldest = seenMessages.keys().next().value;
      seenMessages.delete(oldest);
    }
  }

  seenMessages.set(messageId, now);
  return true;
}

/* --------------------------------------------------------------------------
   Signature verification

   Meta signs every POST with an HMAC-SHA256 of the exact bytes it sent, keyed
   on the app secret. Without this check, anyone who learns the URL can file
   complaints as any phone number they like.

   Needs the RAW body, not the parsed object - re-serialising the JSON would
   produce different bytes and a different hash. server.js captures it.
   -------------------------------------------------------------------------- */

/**
 * @param {Object} req
 * @returns {boolean} true when the request is genuinely from Meta
 */
function hasValidSignature(req) {
  const secret = process.env.WHATSAPP_APP_SECRET || '';

  // Not configured yet: allowed, but say so loudly. This is the state during
  // local development and the first deploy, and it must not be the state in
  // production.
  if (!secret) {
    console.warn('[webhook] WHATSAPP_APP_SECRET is not set - accepting unverified requests');
    return true;
  }

  const header = req.get('X-Hub-Signature-256') || '';
  if (!header.startsWith('sha256=')) {
    return false;
  }

  if (!req.rawBody) {
    console.error('[webhook] raw body missing - signature cannot be checked');
    return false;
  }

  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(req.rawBody)
    .digest('hex');

  // Constant-time compare, so the check cannot be probed byte by byte
  const given = Buffer.from(header);
  const mine = Buffer.from(expected);

  return given.length === mine.length && crypto.timingSafeEqual(given, mine);
}

/* --------------------------------------------------------------------------
   1. Verification handshake
   -------------------------------------------------------------------------- */

/**
 * GET /webhook/whatsapp
 *
 * 200 -> the raw hub.challenge value, when the token matches
 * 403 -> anything else
 */
router.get('/', function (req, res) {
  const mode = req.query['hub.mode'];
  const suppliedToken = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || '';

  if (!expectedToken) {
    console.error('[webhook] WHATSAPP_VERIFY_TOKEN is not set, so verification cannot succeed');
    return res.sendStatus(403);
  }

  if (mode === 'subscribe' && suppliedToken === expectedToken) {
    console.log('[webhook] verified by Meta');
    // Plain text, not JSON - Meta compares the body byte for byte
    return res.status(200).send(String(challenge));
  }

  console.error('[webhook] verification refused (mode=' + mode + ')');
  return res.sendStatus(403);
});

/* --------------------------------------------------------------------------
   2. Incoming messages
   -------------------------------------------------------------------------- */

/**
 * POST /webhook/whatsapp
 *
 * Always 200, unless the signature is wrong. Meta does not read the body.
 */
router.post('/', function (req, res) {
  if (!hasValidSignature(req)) {
    console.error('[webhook] rejected a request with a bad signature');
    return res.sendStatus(401);
  }

  // Rule (a): answer first, work afterwards
  res.status(200).json({ received: true });

  const messages = extractMessages(req.body);

  // Rule (c): status callbacks and other noise
  if (messages.length === 0) {
    return;
  }

  for (const message of messages) {
    // Deliberately not awaited: the response has already gone out
    handleMessage(message)
      .catch(function (error) {
        console.error('[webhook] failed handling ' + message.id + ': ' + error.message);
      })
      .finally(function () {
        processedCount += 1;
      });
  }
});

/**
 * Digs the messages out of Meta's deeply nested payload.
 *
 * Shape:
 *   entry[] -> changes[] -> value -> messages[]
 *
 * Anything unexpected yields an empty list rather than throwing, because a
 * payload we do not recognise must not take the webhook down.
 *
 * @param {Object} body
 * @returns {Array}
 */
function extractMessages(body) {
  const found = [];

  const entries = body && Array.isArray(body.entry) ? body.entry : [];

  for (const entry of entries) {
    const changes = Array.isArray(entry.changes) ? entry.changes : [];

    for (const change of changes) {
      const value = change && change.value;
      const messages = value && Array.isArray(value.messages) ? value.messages : [];

      for (const message of messages) {
        if (message && message.id && message.from) {
          found.push(message);
        }
      }
    }
  }

  return found;
}

/**
 * Runs one customer message through the conversation and sends the replies.
 *
 * @param {Object} message a single entry from the payload's messages[]
 */
async function handleMessage(message) {
  const from = message.from;                    // e.g. '919876543210'

  // Rule (b): never process the same message twice
  if (!isFirstSighting(message.id)) {
    console.log('[webhook] ignoring replay of ' + message.id);
    return;
  }

  // Blue ticks while we think. Failure here does not matter.
  whatsappService.markAsRead(message.id).catch(function () { /* cosmetic */ });

  // One customer's messages are handled one at a time, so two quick messages
  // cannot both answer the same question
  await sessionStore.runExclusive(from, async function () {
    const incoming = await readIncoming(message, from);

    if (!incoming) {
      await whatsappService.sendTextMessage(from,
        'Sorry, I can only read text messages, menu options, photos and videos.');
      return;
    }

    let session = sessionStore.get(from);
    let result;

    if (!session) {
      // First message, or a conversation that expired. The webhook already
      // told us their number, so question 1 is skipped entirely.
      result = await engine.start({ mobile: normaliseNumber(from) });
    } else {
      result = await engine.handleIncoming(session, incoming);
    }

    sessionStore.set(from, result.session);
    await whatsappService.sendReplies(from, result.replies);
  });
}

/**
 * Turns a WhatsApp message into the { text, optionId, media } shape the engine
 * understands. Returns null for message types the bot cannot use.
 *
 * @param {Object} message
 * @param {string} from
 * @returns {Promise<Object|null>}
 */
async function readIncoming(message, from) {
  switch (message.type) {

    case 'text':
      return { text: message.text?.body || '' };

    case 'interactive': {
      // A tapped button or list row. The id is ours - it came from the
      // options the engine sent - so it maps straight back to an answer.
      const interactive = message.interactive || {};
      const reply = interactive.button_reply || interactive.list_reply || {};
      return { text: reply.title || '', optionId: reply.id || '' };
    }

    case 'button':
      // A tap on a template's quick-reply button
      return { text: message.button?.text || '' };

    case 'image':
    case 'video': {
      const media = message[message.type];
      const saved = media && media.id
        ? await whatsappService.downloadMedia(media.id, from)
        : null;

      if (!saved) {
        return { text: '', media: null, mediaFailed: true };
      }
      return { text: media.caption || '', media: { filename: saved.filename } };
    }

    default:
      // Location, contacts, stickers, audio, documents, reactions...
      return null;
  }
}

/**
 * Strips a country code so the number matches what the CRM stores.
 *
 * WhatsApp reports '919876543210'; an Indian ISP's records hold
 * '9876543210'. Keeping the last ten digits makes the account lookup work
 * without asking the customer to retype a number we already have.
 *
 * @param {string} waId
 * @returns {string}
 */
function normaliseNumber(waId) {
  const digits = String(waId || '').replace(/[^0-9]/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

module.exports = router;
module.exports.extractMessages = extractMessages;
module.exports.normaliseNumber = normaliseNumber;
module.exports.isFirstSighting = isFirstSighting;
module.exports.processedCount = function () { return processedCount; };
