/* ==========================================================================
   sessionStore.js

   Remembers where each customer is in the conversation.

   A browser could hold the answers in a variable on the page. WhatsApp cannot:
   every message arrives as a separate HTTP request with nothing but a phone
   number attached, so the server has to remember question 3's answer until
   question 4 arrives. That is all this file does.

   THREE PROBLEMS IT EXISTS TO PREVENT

   1. INTERLEAVED MESSAGES. A customer who sends two messages quickly produces
      two overlapping webhook requests. Both would read the same session, both
      would answer the same question, and one answer would be lost. So work for
      a given customer is serialised through runExclusive() - a second message
      waits for the first to finish rather than racing it.

   2. SESSIONS LIVING FOREVER. Someone who abandons the chat halfway would
      otherwise be stuck on question 9 forever, and a busy number would grow
      the map without limit. Sessions expire after IDLE_LIMIT_MS, and expired
      ones are swept periodically.

   3. LOSING EVERYTHING ON RESTART. Deploys and crashes wipe an in-memory map,
      dropping every half-finished complaint. Sessions are therefore mirrored
      to data/sessions.json and reloaded at startup. This is deliberately
      best-effort: a failed write is logged, not thrown, because losing a
      half-typed session is annoying while dropping the customer's message is
      worse.
   ========================================================================== */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const paths = require('./paths');

const SESSION_FILE = paths.SESSIONS_FILE;
const TEMP_FILE = SESSION_FILE + '.tmp';

/* A conversation nobody has touched for this long is treated as abandoned.
   Matched to WhatsApp's 24 hour service window: past it we could not reply
   with free-form text anyway without a paid template. */
const IDLE_LIMIT_MS = 24 * 60 * 60 * 1000;

/* How often to sweep expired sessions out of memory. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/* customerKey -> session */
const sessions = new Map();

/* customerKey -> promise, so one customer's messages run one at a time */
const locks = new Map();

let sweepTimer = null;
let writeQueue = Promise.resolve();

/* --------------------------------------------------------------------------
   Persistence
   -------------------------------------------------------------------------- */

/**
 * Loads any sessions left over from the last run.
 * Called once at startup. Never throws: a missing or corrupt file just means
 * everybody starts their conversation again, which is recoverable, whereas
 * refusing to boot is not.
 */
function load() {
  let raw;
  try {
    raw = fs.readFileSync(SESSION_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.log('[sessions] could not be read, starting empty: ' + error.message);
    }
    return;
  }

  try {
    const saved = JSON.parse(raw);
    const now = Date.now();
    let restored = 0;

    Object.keys(saved).forEach(function (key) {
      const session = saved[key];
      // Do not restore anything that would expire immediately anyway
      if (session && now - (session.updatedAt || 0) < IDLE_LIMIT_MS) {
        sessions.set(key, session);
        restored += 1;
      }
    });

    if (restored) {
      console.log('[sessions] restored ' + restored + ' conversation(s) from disk');
    }
  } catch (error) {
    console.log('[sessions] file was not valid JSON, starting empty');
  }
}

/**
 * Mirrors the map to disk.
 *
 * Writes are queued and best-effort. The conversation must not wait on a disk
 * write, so callers do not await this.
 */
function persist() {
  writeQueue = writeQueue.then(async function () {
    try {
      const snapshot = {};
      sessions.forEach(function (session, key) { snapshot[key] = session; });

      await fsp.writeFile(TEMP_FILE, JSON.stringify(snapshot), 'utf8');
      await fsp.rename(TEMP_FILE, SESSION_FILE);
    } catch (error) {
      console.log('[sessions] could not be saved: ' + error.message);
    }
  });

  return writeQueue;
}

/* --------------------------------------------------------------------------
   Expiry
   -------------------------------------------------------------------------- */

/** Drops sessions nobody has touched inside the idle limit. */
function sweep() {
  const now = Date.now();
  let removed = 0;

  sessions.forEach(function (session, key) {
    if (now - (session.updatedAt || 0) >= IDLE_LIMIT_MS) {
      sessions.delete(key);
      removed += 1;
    }
  });

  if (removed) {
    console.log('[sessions] expired ' + removed + ' idle conversation(s)');
    persist();
  }
}

/* --------------------------------------------------------------------------
   Public API
   -------------------------------------------------------------------------- */

/**
 * Loads saved sessions and starts the expiry sweep.
 * Called once by server.js at startup.
 */
function init() {
  load();

  if (!sweepTimer) {
    sweepTimer = setInterval(sweep, SWEEP_INTERVAL_MS);
    // Do not hold the process open just for the sweep
    if (typeof sweepTimer.unref === 'function') { sweepTimer.unref(); }
  }
}

/**
 * Reads one customer's session, or null when there is none or it has expired.
 * @param {string} key usually the WhatsApp ID
 * @returns {Object|null}
 */
function get(key) {
  const session = sessions.get(key);
  if (!session) { return null; }

  if (Date.now() - (session.updatedAt || 0) >= IDLE_LIMIT_MS) {
    sessions.delete(key);
    return null;
  }

  return session;
}

/**
 * Saves one customer's session.
 * @param {string} key
 * @param {Object} session
 */
function set(key, session) {
  session.updatedAt = Date.now();
  sessions.set(key, session);
  persist();
}

/**
 * Forgets one customer's conversation.
 * @param {string} key
 */
function clear(key) {
  sessions.delete(key);
  persist();
}

/**
 * Runs a job with exclusive access to one customer's session, so two messages
 * from the same person cannot both answer the same question.
 *
 * Messages from *different* customers still run in parallel - the lock is per
 * key, not global.
 *
 * @param {string}   key
 * @param {Function} job an async function
 * @returns {Promise<*>} whatever the job returns
 */
function runExclusive(key, job) {
  const previous = locks.get(key) || Promise.resolve();

  // Chain onto the previous job whether it succeeded or failed, so one error
  // does not jam every later message from that customer
  const result = previous.then(job, job);

  // Keep a settled version in the map, and tidy up once nothing is queued
  const settled = result.catch(function () { /* keep the chain alive */ });
  locks.set(key, settled);

  settled.then(function () {
    if (locks.get(key) === settled) {
      locks.delete(key);
    }
  });

  return result;
}

/** Number of live conversations. Used by tests and the health endpoint. */
function count() {
  return sessions.size;
}

/** Wipes everything. Tests only. */
function reset() {
  sessions.clear();
  locks.clear();
}

module.exports = {
  init,
  get,
  set,
  clear,
  runExclusive,
  count,
  reset,
  persist,
  SESSION_FILE,
  IDLE_LIMIT_MS
};
