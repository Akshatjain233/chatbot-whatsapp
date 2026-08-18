/* ==========================================================================
   crmService.js

   THE ONE PLACE THAT TALKS TO THE CRM.

   The client is handling the portal integration themselves, so this file is
   deliberately a single, clearly-marked slot: fill in the two environment
   variables and the body of sendToCRM(), and every complaint the bot takes
   starts flowing into the portal. Nothing else in the codebase needs to
   change - the conversation, the storage and the WhatsApp plumbing all stay
   exactly as they are.

   WHAT THE BOT GIVES YOU
   ----------------------
   sendToCRM() is called once per registered complaint, with the saved record:

     {
       complaintId:   'FTX-2026-1234',       generated here, unique
       mobile:        '9876543210',          10 digits, country code stripped
       customerId:    'ACC-100001',          the account - see the note below
       complaintType: 'Speed Issue',         one of the categories below
       description:   'Internet very slow',  what the customer typed
       status:        'Open',
       createdAt:     '2026-08-17T15:00:00.000Z'
     }

   customerId CAN BE EMPTY, and your code has to cope with that. It is filled
   in one of two ways: from lookupSubscribers() below once you implement it,
   or - until then, and afterwards whenever the lookup finds nothing - by
   asking the customer to read it off their bill. A customer who cannot find
   it is allowed to skip, because somebody with a dead line reporting a fault
   is not a complaint worth refusing. The mobile number is always present, so
   an unmatched case can still be linked by hand.

   The categories are in services/complaintCategories.js and already mirror the
   portal's reason list, each carrying the portal's own numeric ids:

     Speed Issue        reason 10192   type 331 (Problem)
     Red Light Coming   reason 10217   type 331 (Problem)
     Voice not Working  reason 10220   type 331 (Problem)
     Password Change    reason 10219   type 334 (Request)

   Use categories.crmMapping(complaint.complaintType) to get them.

   WHAT TO RETURN
   --------------
     { success: true,  ticket: 'TKT448' }   filed - the ticket number is
                                            optional, but when you return one
                                            the bot quotes it to the customer
                                            instead of its own reference
     { success: false, message: 'why' }     not filed - logged, and the
                                            complaint stays saved locally

   TWO RULES
   ---------
   1. NEVER THROW. A CRM outage must not break a conversation. The customer has
      already answered the questions; losing that because a server is down
      would be absurd. Catch everything and return success:false.
   2. DO NOT BLOCK THE REPLY for long. This is awaited before the bot confirms
      to the customer, so anything slow should be fired off in the background
      and reported later rather than made to wait.

   HOW TO CHECK YOUR WORK
   ----------------------
   Run `npm test`. test/crm-slot.test.js is written as a contract for this
   file and needs no portal to run: half of it proves a correct implementation
   is used properly - the chosen connection reaches the case, the ticket
   number reaches the customer - and half proves that one which is missing,
   slow, failing or returning nonsense still leaves the bot able to take a
   complaint. If those pass, you are done.

   To try it end to end without WhatsApp, run `npm run simulate` and hold the
   conversation in your terminal.
   ========================================================================== */

const categories = require('./complaintCategories');

/* The subscriber lookup runs before the bot's first reply, so the customer is
   waiting on it. Kept deliberately short: a slow CRM should cost a missing
   connection list, never a chat that appears dead. */
const LOOKUP_TIMEOUT_MS = 4000;

/** Reads the CRM settings. See .env.example. */
function config() {
  return {
    apiUrl: (process.env.CRM_API_URL || '').replace(/\/+$/, ''),
    apiKey: process.env.CRM_API_KEY || ''
  };
}

/**
 * True once the CRM has been configured.
 * With this false the bot still works - complaints are taken and saved, they
 * simply do not reach the portal - which is the correct state until the
 * client's integration is in place.
 */
function isConfigured() {
  const c = config();
  return Boolean(c.apiUrl && c.apiKey);
}

/**
 * Sends one complaint to the portal.
 *
 * >>> THIS IS THE PART TO IMPLEMENT <<<
 *
 * @param {Object} complaint the saved record - see the header for its shape
 * @returns {Promise<Object>} { success, ticket?, message? }
 */
async function sendToCRM(complaint) {
  const c = config();

  if (!isConfigured()) {
    return { success: false, message: 'CRM is not configured (set CRM_API_URL and CRM_API_KEY)' };
  }

  // The portal's own ids for this complaint's category
  const mapping = categories.crmMapping(complaint.complaintType);

  try {
    /* ------------------------------------------------------------------
       REPLACE THIS with the portal's actual call. The shape below is a
       guess at a typical REST API - field names will differ.

       Node has fetch built in, so no SDK and no axios are needed.
       ------------------------------------------------------------------ */

    const response = await fetch(c.apiUrl + '/cases', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + c.apiKey
      },
      body: JSON.stringify({
        title:       complaint.complaintType + ' - ' + complaint.complaintId,
        mobile:      complaint.mobile,
        // May be '' - see the note on customerId in the header
        userId:      complaint.customerId,
        reasonId:    mapping.reasonId,      // e.g. '10192'
        typeId:      mapping.typeId,        // e.g. '331'
        remark:      buildRemark(complaint),
        externalRef: complaint.complaintId
      }),
      // Bounded, so a hanging CRM cannot hold up the customer's reply
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      const detail = await response.text().catch(function () { return ''; });
      return { success: false, message: 'CRM returned ' + response.status + ' ' + detail.slice(0, 200) };
    }

    const data = await response.json().catch(function () { return {}; });

    return {
      success: true,
      // If the portal returns its own ticket number, hand it back and the bot
      // will give the customer that instead of the internal reference
      ticket: data.ticketNumber || data.ticket || ''
    };

  } catch (error) {
    // Rule 1: never throw. A CRM problem is not the customer's problem.
    return { success: false, message: 'CRM call failed: ' + error.message };
  }
}

/**
 * Builds the free-text note that goes with the case.
 *
 * Everything the bot collected that has no field of its own belongs here, so
 * the agent picking the ticket up sees the whole story.
 *
 * @param {Object} complaint
 * @returns {string}
 */
function buildRemark(complaint) {
  const lines = [];

  function row(label, value) {
    if (value) { lines.push(label + ': ' + value); }
  }

  row('Complaint ID', complaint.complaintId);
  row('Raised via', 'WhatsApp bot');
  row('Reported', complaint.createdAt);
  lines.push('');
  row('Mobile', complaint.mobile);
  row('User ID', complaint.customerId);
  row('Category', complaint.complaintType);
  row('Reported problem', complaint.description);

  return lines.join('\n');
}

/**
 * Finds every connection registered to a mobile number.
 *
 * >>> THIS IS THE SECOND PART TO IMPLEMENT <<<
 *
 * WHY IT MATTERS
 * One phone number often holds several connections, and a case belongs to
 * exactly one of them. When this returns more than one, the bot asks the
 * customer which connection the complaint is about and puts their answer in
 * `complaint.customerId`, so the case is filed against the right account
 * instead of a guess.
 *
 * Implementing this also removes a question: while it returns nothing, the
 * bot has to ask the customer to read their User ID off their bill. Once it
 * answers, that question stops being asked and the conversation gets shorter.
 *
 * WHAT TO RETURN
 *
 *   { ok: true, subscribers: [
 *       { userId: 'ACC-100001', name: 'Test Customer',
 *         plan: '100 Mbps', status: 'Active' },
 *       ...
 *   ]}
 *
 *   userId  REQUIRED - the account id the case is filed against
 *   name    optional - shown to the customer if there is no plan or status
 *   plan    optional - shown under the option, to tell connections apart
 *   status  optional - same
 *
 * On failure return { ok: false, subscribers: [], error: 'why' }. The bot
 * carries on and takes the complaint anyway; it simply cannot attach a
 * connection, and an agent links it by hand.
 *
 * TWO RULES, both learned the hard way
 * 1. NEVER THROW.
 * 2. BE QUICK, and always bounded by a timeout. This runs before the bot says
 *    anything at all, so whatever it costs is time the customer spends staring
 *    at an empty chat. An earlier version of this called a portal that took
 *    90 seconds, and the conversation looked broken. Anything beyond a couple
 *    of seconds belongs behind a cache or should be skipped entirely.
 *
 * @param {string} mobile 10 digits, country code already stripped
 * @returns {Promise<Object>} { ok, subscribers, error? }
 */
async function lookupSubscribers(mobile) {
  if (!isConfigured()) {
    // No network call, no delay - the conversation starts instantly
    return { ok: false, subscribers: [], error: 'CRM is not configured' };
  }

  const c = config();

  try {
    /* ------------------------------------------------------------------
       REPLACE THIS with the portal's actual lookup. Field names will differ.
       ------------------------------------------------------------------ */

    const response = await fetch(c.apiUrl + '/subscribers?mobile=' + encodeURIComponent(mobile), {
      headers: { 'Authorization': 'Bearer ' + c.apiKey },
      // Deliberately short - see rule 2 above
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
    });

    if (!response.ok) {
      return { ok: false, subscribers: [], error: 'CRM returned ' + response.status };
    }

    const data = await response.json().catch(function () { return {}; });
    const rows = Array.isArray(data) ? data : (data.subscribers || data.data || []);

    return {
      ok: true,
      subscribers: rows.map(function (row) {
        return {
          userId: String(row.userId || row.user_id || row.id || ''),
          name:   String(row.name || ''),
          plan:   String(row.plan || row.planName || ''),
          status: String(row.status || '')
        };
      }).filter(function (row) { return row.userId; })
    };

  } catch (error) {
    // Rule 1. A lookup failing must never stop somebody reporting a fault.
    return { ok: false, subscribers: [], error: 'CRM lookup failed: ' + error.message };
  }
}

module.exports = {
  isConfigured,
  sendToCRM,
  lookupSubscribers,
  buildRemark
};
