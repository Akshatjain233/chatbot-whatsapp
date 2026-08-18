/* ==========================================================================
   whatsappService.js

   Everything that talks to the WhatsApp Cloud API.

   No SDK - the Cloud API is a handful of JSON endpoints and Node has fetch
   built in, so an SDK would only add a dependency and a layer to debug.

   MOCK MODE
   ---------
   With no WHATSAPP_API_TOKEN set, every send is logged instead of posted and
   returns { mock: true }. That is what lets the whole bot be built and tested
   before any Meta account exists - `npm run simulate` and the test suite both
   run in mock mode.

   THE LIMITS THAT SHAPE THIS FILE
   -------------------------------
   WhatsApp has no free-form menus. A question with options must be sent as
   either:

     reply buttons - at most 3 options, title at most 20 characters
     a list        - at most 10 rows, row title at most 24 characters

   and an interactive message body is capped at 1024 characters (plain text
   messages get 4096). Exceeding any of these is a 400 from Meta, not a
   truncation, so renderChoice() below picks the right shape and the engine's
   options carry a `short` caption for the three labels that do not fit.
   ========================================================================== */

const fsp = require('fs').promises;
const path = require('path');
const paths = require('./paths');

const GRAPH_VERSION = 'v21.0';
const GRAPH_ROOT = 'https://graph.facebook.com/' + GRAPH_VERSION;

/* Where downloaded photos and videos go. Deliberately outside public/, so a
   customer's photo of their living room is never reachable over HTTP. */
const UPLOAD_DIR = paths.UPLOAD_DIR;

/* WhatsApp's own caps, quoted here so the reasons are next to the code. */
const LIMITS = {
  buttons: 3,
  buttonTitle: 20,
  listRows: 10,
  listRowTitle: 24,
  listRowDescription: 72,
  interactiveBody: 1024,
  textBody: 4096
};

/* Media larger than this is not downloaded. WhatsApp already caps images at
   5MB and video at 16MB; this is a second line of defence so a hostile or
   buggy payload cannot fill the disk. */
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;

/* --------------------------------------------------------------------------
   Configuration
   -------------------------------------------------------------------------- */

function token() { return process.env.WHATSAPP_API_TOKEN || ''; }
function phoneId() { return process.env.WHATSAPP_PHONE_ID || ''; }

/**
 * True when real credentials are present.
 * Everything below falls back to logging when this is false.
 */
function isConfigured() {
  return Boolean(token() && phoneId());
}

/* --------------------------------------------------------------------------
   The one place that actually posts to Meta
   -------------------------------------------------------------------------- */

/**
 * Posts one message payload to the Cloud API.
 *
 * Retries twice on the failures that are worth retrying - rate limits and
 * server errors - and gives up immediately on a 400, because a malformed
 * message will be just as malformed the second time.
 *
 * @param {Object} payload a complete Cloud API message body
 * @returns {Promise<Object>} { success, ... }
 */
async function send(payload) {
  if (!isConfigured()) {
    console.log('[whatsapp] (mock) ' + describe(payload));
    return { success: true, mock: true, payload: payload };
  }

  const url = GRAPH_ROOT + '/' + phoneId() + '/messages';
  let lastError = 'unknown error';

  for (let attempt = 1; attempt <= 3; attempt++) {
    let response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token()
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000)
      });
    } catch (error) {
      // Network failure or timeout - worth another go
      lastError = error.message;
      await pause(attempt);
      continue;
    }

    if (response.ok) {
      const data = await response.json().catch(function () { return {}; });
      return { success: true, messageId: data?.messages?.[0]?.id || null };
    }

    const body = await response.text().catch(function () { return ''; });
    lastError = response.status + ' ' + body.slice(0, 300);

    // 429 is a rate limit and 5xx is Meta having a bad day; both pass.
    // Anything else (401 bad token, 400 bad payload) will not fix itself.
    if (response.status !== 429 && response.status < 500) {
      console.error('[whatsapp] send rejected: ' + lastError);
      return { success: false, error: lastError };
    }

    await pause(attempt);
  }

  console.error('[whatsapp] send failed after 3 attempts: ' + lastError);
  return { success: false, error: lastError };
}

/** Backs off a little longer each attempt. */
function pause(attempt) {
  return new Promise(function (resolve) { setTimeout(resolve, attempt * 500); });
}

/** One-line summary of a payload, for mock-mode logging. */
function describe(payload) {
  if (payload.type === 'text') {
    return 'text to ' + payload.to + ': ' + payload.text.body.replace(/\n/g, ' | ');
  }
  if (payload.type === 'interactive') {
    const interactive = payload.interactive;
    const body = interactive.body.text.replace(/\n/g, ' | ');

    if (interactive.type === 'button') {
      const titles = interactive.action.buttons.map(function (b) { return b.reply.title; });
      return 'buttons to ' + payload.to + ': ' + body + '  [' + titles.join(' | ') + ']';
    }
    const rows = interactive.action.sections[0].rows.map(function (r) { return r.title; });
    return 'list to ' + payload.to + ': ' + body + '  [' + rows.join(' | ') + ']';
  }
  return payload.type + ' to ' + payload.to;
}

/* --------------------------------------------------------------------------
   Rendering the engine's replies
   -------------------------------------------------------------------------- */

/** Cuts a string to a hard limit without throwing. */
function clamp(value, limit) {
  const clean = String(value === undefined || value === null ? '' : value);
  return clean.length <= limit ? clean : clean.slice(0, limit - 1) + '…';
}

/** The caption WhatsApp shows for an option: its short form, or its label. */
function caption(option, limit) {
  return clamp(option.short || option.label, limit);
}

/**
 * Builds a plain text message.
 * @param {string} to   recipient in international format, e.g. '919876543210'
 * @param {string} body
 */
function buildText(to, body) {
  return {
    messaging_product: 'whatsapp',
    to: to,
    type: 'text',
    text: { body: clamp(body, LIMITS.textBody) }
  };
}

/**
 * Builds an option question as buttons or a list, whichever fits.
 *
 * Three options or fewer become buttons, which appear inline and need one tap.
 * More than that has to be a list, which opens a menu - worse, but it is the
 * only shape WhatsApp offers beyond three.
 *
 * @param {string} to
 * @param {string} body     the question
 * @param {Array}  optionList  [{ id, label, short, description }]
 */
function buildChoice(to, body, optionList) {
  const usable = optionList.slice(0, LIMITS.listRows);

  if (optionList.length > LIMITS.listRows) {
    // Would silently drop options, so make the mistake loud in the log
    console.error('[whatsapp] question has ' + optionList.length +
      ' options but WhatsApp allows ' + LIMITS.listRows + '; extras were dropped');
  }

  const base = {
    messaging_product: 'whatsapp',
    to: to,
    type: 'interactive'
  };

  if (usable.length <= LIMITS.buttons) {
    return Object.assign(base, {
      interactive: {
        type: 'button',
        body: { text: clamp(body, LIMITS.interactiveBody) },
        action: {
          buttons: usable.map(function (option) {
            return {
              type: 'reply',
              reply: { id: option.id, title: caption(option, LIMITS.buttonTitle) }
            };
          })
        }
      }
    });
  }

  return Object.assign(base, {
    interactive: {
      type: 'list',
      body: { text: clamp(body, LIMITS.interactiveBody) },
      action: {
        button: 'Choose',
        sections: [{
          title: 'Options',
          rows: usable.map(function (option) {
            const row = {
              id: option.id,
              title: caption(option, LIMITS.listRowTitle)
            };
            if (option.description) {
              row.description = clamp(option.description, LIMITS.listRowDescription);
            }
            return row;
          })
        }]
      }
    }
  });
}

/**
 * Delivers a batch of replies from the conversation engine, in order.
 *
 * Order matters - the summary must arrive before the "is this correct?"
 * buttons - so these are sent one at a time rather than in parallel.
 *
 * @param {string} to
 * @param {Array}  replies  [{ kind: 'text' | 'choice', ... }]
 * @returns {Promise<Array>} one result per reply
 */
async function sendReplies(to, replies) {
  const results = [];

  for (const reply of replies) {
    const payload = reply.kind === 'choice'
      ? buildChoice(to, reply.text, reply.options)
      : buildText(to, reply.text);

    results.push(await send(payload));
  }

  return results;
}

/**
 * Sends one plain text message. Kept as a named export because the routes and
 * future notification code read better calling this than building a payload.
 */
async function sendTextMessage(to, message) {
  return send(buildText(to, message));
}

/* --------------------------------------------------------------------------
   Templates

   WhatsApp only allows free-form text within 24 hours of the customer's last
   message. The complaint flow is always a reply, so it never needs a template.
   Anything we start ourselves - "your technician is on the way", sent the next
   morning - does, and the template has to be approved in Business Manager
   first.
   -------------------------------------------------------------------------- */

/**
 * Sends a pre-approved template message.
 * @param {string}   to
 * @param {string}   templateName  the approved name, e.g. 'complaint_update'
 * @param {string[]} values        ordered values for the body placeholders
 * @param {string}   [language]    defaults to English
 */
async function sendTemplateMessage(to, templateName, values, language) {
  const parameters = (values || []).map(function (value) {
    return { type: 'text', text: String(value) };
  });

  return send({
    messaging_product: 'whatsapp',
    to: to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: language || 'en' },
      components: parameters.length
        ? [{ type: 'body', parameters: parameters }]
        : []
    }
  });
}

/**
 * Marks an incoming message as read, so the customer sees the blue ticks
 * while the bot is thinking. Cosmetic, and failure is ignored.
 * @param {string} messageId
 */
async function markAsRead(messageId) {
  if (!isConfigured()) { return { success: true, mock: true }; }

  try {
    await fetch(GRAPH_ROOT + '/' + phoneId() + '/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token()
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId
      }),
      signal: AbortSignal.timeout(10000)
    });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/* --------------------------------------------------------------------------
   Incoming media

   A photo arrives as an ID, not as bytes. Turning it into a file takes two
   calls: ask the Graph API where the media lives, then download it with the
   same token. The download URL is short-lived and useless without the token,
   so it is never stored or shown to anyone.
   -------------------------------------------------------------------------- */

/**
 * Downloads one media attachment and stores it outside the served folders.
 *
 * Never throws - a photo that will not download is worth a log line, not a
 * failed complaint.
 *
 * @param {string} mediaId  from message.image.id / message.video.id
 * @param {string} prefix   used in the filename, e.g. the customer's number
 * @returns {Promise<Object|null>} { filename, path, bytes, mimeType } or null
 */
async function downloadMedia(mediaId, prefix) {
  if (!isConfigured()) {
    // In mock mode there is nothing to fetch, but the flow should still see a
    // plausible attachment so the conversation can be tested end to end
    return { filename: 'mock-media-' + mediaId + '.jpg', path: null, bytes: 0, mimeType: 'image/jpeg', mock: true };
  }

  try {
    /* 1. Where does it live? */
    const lookup = await fetch(GRAPH_ROOT + '/' + mediaId, {
      headers: { 'Authorization': 'Bearer ' + token() },
      signal: AbortSignal.timeout(15000)
    });

    if (!lookup.ok) {
      console.error('[whatsapp] media lookup failed: ' + lookup.status);
      return null;
    }

    const info = await lookup.json();

    if (info.file_size && Number(info.file_size) > MAX_MEDIA_BYTES) {
      console.error('[whatsapp] media too large (' + info.file_size + ' bytes), skipped');
      return null;
    }

    /* 2. Fetch the bytes. This URL needs the token too. */
    const download = await fetch(info.url, {
      headers: { 'Authorization': 'Bearer ' + token() },
      signal: AbortSignal.timeout(60000)
    });

    if (!download.ok) {
      console.error('[whatsapp] media download failed: ' + download.status);
      return null;
    }

    const bytes = Buffer.from(await download.arrayBuffer());

    if (bytes.length > MAX_MEDIA_BYTES) {
      console.error('[whatsapp] media too large after download, discarded');
      return null;
    }

    /* 3. Store it under a name we choose, never one the sender chose. */
    const filename = safeName(prefix, info.mime_type);
    await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    const fullPath = path.join(UPLOAD_DIR, filename);
    await fsp.writeFile(fullPath, bytes);

    return {
      filename: filename,
      path: fullPath,
      bytes: bytes.length,
      mimeType: info.mime_type || 'application/octet-stream'
    };

  } catch (error) {
    console.error('[whatsapp] media could not be saved: ' + error.message);
    return null;
  }
}

/**
 * Builds a filename from data we control.
 *
 * The sender's own filename is never used: it can contain path separators,
 * be 300 characters long, or collide with someone else's upload.
 */
function safeName(prefix, mimeType) {
  const cleanPrefix = String(prefix || 'media').replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'media';
  const stamp = Date.now();
  const random = Math.floor(Math.random() * 9000) + 1000;

  const extensions = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/3gpp': '3gp'
  };
  const extension = extensions[String(mimeType || '').split(';')[0]] || 'bin';

  return cleanPrefix + '-' + stamp + '-' + random + '.' + extension;
}

module.exports = {
  isConfigured,
  sendReplies,
  sendTextMessage,
  sendTemplateMessage,
  markAsRead,
  downloadMedia,
  buildText,
  buildChoice,
  UPLOAD_DIR,
  LIMITS
};
