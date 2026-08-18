/* ==========================================================================
   complaintService.js

   All complaint STORAGE logic lives here, and nowhere else.

   The routes in routes/complaints.js only deal with HTTP (status codes,
   request bodies, responses). They call the functions below whenever they
   need to actually read or save something. That split is what makes the
   project easy to change later: when the JSON file is one day replaced by a
   real database, only this file has to be rewritten.

   Data is stored as a plain JSON array. See services/paths.js for WHERE -
   it is not always inside the project folder.
   ========================================================================== */

const fs = require('fs');                 // sync calls, used once at startup
const fsp = require('fs').promises;       // async calls, used by every request
const path = require('path');
const paths = require('./paths');
const categories = require('./complaintCategories');

/* The file that acts as our database. Its location is configurable so a
   deployment can point it at a persistent volume - see services/paths.js. */
const DATA_FILE = paths.COMPLAINTS_FILE;

/* Written first, then renamed over DATA_FILE, so the real file is never
   left half-written if the process dies mid-save. */
const TEMP_FILE = DATA_FILE + '.tmp';

/* --------------------------------------------------------------------------
   Validation rules

   These are exported too, because the route needs them to decide between a
   400 (the customer sent something invalid) and a 201 (saved successfully).
   -------------------------------------------------------------------------- */

/* The categories, the troubleshooting rule and the visit rule all come from
   services/complaintCategories.js, which mirrors iCRM's "Select Reason" list.
   The bot and this validator therefore cannot disagree: both read the same
   table, so a category added there is accepted here automatically. */
const ALLOWED_COMPLAINT_TYPES = categories.ALLOWED;
const TROUBLESHOOTING_TYPES = categories.TROUBLESHOOTING;
const NO_VISIT_TYPES = categories.NO_VISIT;

/* Answer sets for the button questions. '' is always allowed and means the
   question was skipped for this complaint type. */
const YES_NO = ['Yes', 'No'];
const DEVICE_OPTIONS = ['All devices', 'Phone', 'Laptop', 'TV'];
const CONNECTION_OPTIONS = ['WiFi', 'LAN cable', 'Both'];
const VISIT_SLOTS = ['Morning', 'Afternoon', 'Evening'];

/**
 * True when this complaint type gets the troubleshooting questions.
 * @param {string} complaintType
 */
function usesTroubleshooting(complaintType) {
  return categories.isTechnical(complaintType);
}

/**
 * True when this complaint type can lead to a technician visit.
 * @param {string} complaintType
 */
function usesVisit(complaintType) {
  return categories.needsVisit(complaintType);
}

/* --------------------------------------------------------------------------
   Storage helpers

   Two problems this section exists to prevent:

   1. LOST WRITES. Reading the file, appending, and writing it back is not
      atomic - the awaits give other requests a chance to run in between, so
      two overlapping submissions can each write a version that is missing the
      other's complaint. Everything therefore runs through one promise chain,
      so a second request waits for the first to finish instead of racing it.

   2. A CORRUPT FILE ERASING EVERYTHING. If a read fails and we quietly carry
      on with an empty array, the next save writes that empty array to disk
      and the previous complaints are gone. So a failed read now stops the
      save instead of replacing the data.
   -------------------------------------------------------------------------- */

// Every read-modify-write cycle queues on this, so only one runs at a time
let storageQueue = Promise.resolve();

/**
 * Runs a job with exclusive access to the data file.
 * Whatever the job returns is passed back to the caller.
 * @param {Function} job an async function to run once it is this job's turn
 */
function withStorageLock(job) {
  // Chain onto the previous job, ignoring whether it succeeded, so one failed
  // request never blocks every request after it
  const result = storageQueue.then(job, job);
  storageQueue = result.catch(function () { /* keep the queue alive */ });
  return result;
}

/**
 * Creates data/complaints.json with an empty array if it does not exist yet.
 * Called once by server.js when the server starts.
 */
function initStorage() {
  const dataDir = path.dirname(DATA_FILE);

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log('Created ' + dataDir);
  }

  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, '[]', 'utf8');
    console.log('Created ' + DATA_FILE);
  }
}

/**
 * Reads every complaint from disk.
 * A missing file is fine and means "no complaints yet". Anything else -
 * unreadable, truncated, not an array - is an error, because carrying on
 * would let the next save overwrite data we simply failed to load.
 * @returns {Promise<Array>}
 */
async function readComplaints() {
  let raw;

  try {
    raw = await fsp.readFile(DATA_FILE, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];              // no file yet, an empty list is the truth
    }
    throw error;              // permissions, locked file, disk error
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('data/complaints.json is not valid JSON. Refusing to continue so existing data is not overwritten.');
  }

  if (!Array.isArray(parsed)) {
    throw new Error('data/complaints.json does not contain a JSON array. Refusing to continue.');
  }

  return parsed;
}

/**
 * Writes the list to a temporary file and renames it over the real one.
 * Rename is atomic on the same drive, so a crash mid-save leaves the previous
 * complaints.json intact rather than a half-written file.
 * @param {Array} complaints
 */
async function writeComplaints(complaints) {
  await fsp.writeFile(TEMP_FILE, JSON.stringify(complaints, null, 2), 'utf8');
  await fsp.rename(TEMP_FILE, DATA_FILE);
}

/**
 * Builds a complaint ID in the format FTX-2026-XXXX.
 * Checks the IDs already on file so the same number is not handed out twice.
 * @param {Array} existing
 * @returns {string}
 */
function generateComplaintId(existing) {
  const usedIds = existing.map(function (item) { return item.complaintId; });

  // Try a few random numbers, then fall back to a time-based suffix
  for (let attempt = 0; attempt < 20; attempt++) {
    const random4 = Math.floor(1000 + Math.random() * 9000);
    const candidate = 'FTX-2026-' + random4;
    if (usedIds.indexOf(candidate) === -1) {
      return candidate;
    }
  }
  return 'FTX-2026-' + String(Date.now()).slice(-4);
}

/* --------------------------------------------------------------------------
   Field-level validation helpers

   There are eighteen questions in the chat now, so the checks below are
   written once and reused, rather than repeated per field.
   -------------------------------------------------------------------------- */

/** Reads a field off the body as a trimmed string. Missing becomes ''. */
function field(body, key) {
  return String(body[key] === undefined || body[key] === null ? '' : body[key]).trim();
}

/**
 * Checks a free-text field.
 * @param {string} value    the trimmed value
 * @param {string} label    the name shown to the caller in the error
 * @param {Object} rules    { required, min, max }
 * @returns {string|null}   an error message, or null when the value is fine
 */
function checkText(value, label, rules) {
  if (!value) {
    return rules.required ? label + ' is required.' : null;
  }
  if (rules.min && value.length < rules.min) {
    return label + ' must be at least ' + rules.min + ' characters long.';
  }
  if (rules.max && value.length > rules.max) {
    return label + ' must be ' + rules.max + ' characters or fewer.';
  }
  return null;
}

/**
 * Checks a field that may only hold one of a fixed set of answers.
 * An empty value is always accepted here and means "question skipped" - the
 * separate relevance check below is what decides whether skipping was legal.
 * @param {string}   value
 * @param {string}   label
 * @param {string[]} allowed
 * @returns {string|null}
 */
function checkChoice(value, label, allowed) {
  if (!value) {
    return null;
  }
  if (allowed.indexOf(value) === -1) {
    return label + ' must be one of: ' + allowed.join(', ') + '.';
  }
  return null;
}

/** Digits only, 10 to 15 of them - the rule used for both phone fields. */
function checkPhone(value, label, isRequired) {
  if (!value) {
    return isRequired ? label + ' is required.' : null;
  }
  if (!/^[0-9]{10,15}$/.test(value)) {
    return label + ' must contain digits only and be between 10 and 15 digits long.';
  }
  return null;
}

/* --------------------------------------------------------------------------
   Public API - these are the functions the routes are allowed to call
   -------------------------------------------------------------------------- */

/**
 * Checks an incoming complaint body.
 * Everything except mobile, complaintType and description is optional. The bot
 * no longer asks for the rest - the CRM holds it - but the fields are still
 * accepted so an agent, or an older record, still validates.
 * @param {Object} body
 * @returns {string|null} an error message, or null when the body is valid
 */
function validateComplaint(body) {
  // Guard against a missing or non-object body
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.';
  }

  const complaintType = field(body, 'complaintType');

  /* --- Complaint type first: the rules for everything else depend on it ---- */
  if (!complaintType) {
    return 'Complaint type is required.';
  }
  if (ALLOWED_COMPLAINT_TYPES.indexOf(complaintType) === -1) {
    return 'Complaint type must be one of: ' + ALLOWED_COMPLAINT_TYPES.join(', ') + '.';
  }

  /* --- Who the complaint is for --------------------------------------------
     name, address and provider are optional because the bot no longer asks
     for them: iCRM already holds all three on the subscriber record, and none
     of them is a field on the Case form. They are still accepted, so a record
     created before this change - or by an agent - keeps validating. */
  const checks = [
    checkPhone(field(body, 'mobile'), 'Mobile number', true),
    checkText(field(body, 'customerId'), 'Customer ID', { required: false, max: 40 }),
    checkText(field(body, 'name'), 'Name', { required: false, min: 2, max: 100 }),
    checkText(field(body, 'address'), 'Service address', { required: false, min: 5, max: 250 }),

    /* --- Service details (chat questions 4-6) ------------------------------ */
    checkText(field(body, 'provider'), 'Provider', { required: false, min: 2, max: 100 }),
    checkText(field(body, 'planAccount'), 'Plan / account number', { required: false, max: 60 }),
    checkText(field(body, 'issueStart'), 'Issue start', { required: false, max: 60 }),

    /* --- The complaint itself (chat question 8) ---------------------------- */
    checkText(field(body, 'description'), 'Description', { required: true, min: 5, max: 1000 }),

    /* --- Troubleshooting answers (chat questions 9-12) --------------------- */
    checkChoice(field(body, 'redLight'), 'redLight', YES_NO),
    checkChoice(field(body, 'routerRestarted'), 'routerRestarted', YES_NO),
    checkChoice(field(body, 'devicesAffected'), 'devicesAffected', DEVICE_OPTIONS),
    checkChoice(field(body, 'connectionMode'), 'connectionMode', CONNECTION_OPTIONS),

    /* --- Technician visit (chat questions 13-15) --------------------------- */
    checkChoice(field(body, 'visitAvailable'), 'visitAvailable', YES_NO),
    checkText(field(body, 'visitDate'), 'Visit date', { required: false, max: 60 }),
    checkChoice(field(body, 'visitSlot'), 'visitSlot', VISIT_SLOTS),
    checkPhone(field(body, 'altContact'), 'Alternate contact number', false),

    /* --- Attachment note (chat question 16) -------------------------------- */
    checkText(field(body, 'attachment'), 'Attachment', { required: false, max: 200 })
  ];

  const firstError = checks.find(function (message) { return message !== null; });
  if (firstError) {
    return firstError;
  }

  /* --- Answers must belong to the complaint type they arrived with ---------
     The chat skips these questions for the wrong categories, so a body that
     carries them anyway did not come from the chat. Rejecting keeps the
     stored data honest: a billing complaint can never claim its router was
     restarted. */
  if (!usesTroubleshooting(complaintType)) {
    if (field(body, 'redLight') || field(body, 'routerRestarted') ||
        field(body, 'devicesAffected') || field(body, 'connectionMode')) {
      return 'Troubleshooting answers are only accepted for: ' + TROUBLESHOOTING_TYPES.join(', ') + '.';
    }
  }

  if (!usesVisit(complaintType)) {
    if (field(body, 'visitAvailable') || field(body, 'visitDate') || field(body, 'visitSlot')) {
      return 'Technician visit answers are not accepted for: ' + NO_VISIT_TYPES.join(', ') + '.';
    }
  }

  // A date and a slot only mean something once someone is available to let
  // the technician in
  if (field(body, 'visitAvailable') !== 'Yes' && (field(body, 'visitDate') || field(body, 'visitSlot'))) {
    return 'A visit date or slot is only accepted when visitAvailable is "Yes".';
  }

  return null;
}

/**
 * Saves one complaint and returns the stored record.
 *
 * The caller (routes/complaints.js) is expected to have run validateComplaint
 * first - this function assumes the data is already known to be valid.
 * It adds the two fields the customer does not supply: complaintId and
 * createdAt.
 *
 * @param {Object} data a validated complaint body
 * @returns {Promise<Object>} the saved record, including its new ID
 */
async function createComplaint(data) {
  // Read, append and save as one indivisible job. Any other request that
  // arrives mid-way waits its turn instead of overwriting us.
  return withStorageLock(async function () {
    const complaints = await readComplaints();

    const record = {
      complaintId: generateComplaintId(complaints),      // generated here

      // Customer verification
      mobile:          field(data, 'mobile'),
      customerId:      field(data, 'customerId'),
      name:            field(data, 'name'),
      address:         field(data, 'address'),

      // Service details
      provider:        field(data, 'provider'),
      planAccount:     field(data, 'planAccount'),
      issueStart:      field(data, 'issueStart'),

      // The complaint
      complaintType:   field(data, 'complaintType'),
      description:     field(data, 'description'),

      // Troubleshooting - empty strings when the category skipped them
      redLight:        field(data, 'redLight'),
      routerRestarted: field(data, 'routerRestarted'),
      devicesAffected: field(data, 'devicesAffected'),
      connectionMode:  field(data, 'connectionMode'),

      // Technician visit
      visitAvailable:  field(data, 'visitAvailable'),
      visitDate:       field(data, 'visitDate'),
      visitSlot:       field(data, 'visitSlot'),
      altContact:      field(data, 'altContact'),

      // Attachment the customer said they would send
      attachment:      field(data, 'attachment'),

      status: 'Open',
      createdAt: new Date().toISOString()               // timestamp added here
    };

    complaints.push(record);
    await writeComplaints(complaints);
    return record;
  });
}

/**
 * Returns complaints, newest first.
 *
 * @param {Object} [filters]
 * @param {string} [filters.mobile] only this customer's complaints
 * @param {string} [filters.since]  only complaints created AFTER this ISO
 *                                  timestamp. This is what lets an importer
 *                                  poll without re-reading - and re-filing -
 *                                  everything it has already seen.
 * @param {number} [filters.limit]  at most this many
 * @returns {Promise<Array>}
 */
async function getAllComplaints(filters) {
  const options = filters || {};

  let complaints = await withStorageLock(readComplaints);

  const mobileFilter = String(options.mobile || '').trim();
  if (mobileFilter) {
    complaints = complaints.filter(function (item) {
      return item.mobile === mobileFilter;
    });
  }

  if (options.since) {
    const after = new Date(options.since).getTime();

    // An unparseable timestamp must not silently return everything - that is
    // how an importer ends up creating duplicate cases
    if (!Number.isNaN(after)) {
      complaints = complaints.filter(function (item) {
        return new Date(item.createdAt).getTime() > after;
      });
    }
  }

  // Newest first
  complaints.sort(function (a, b) {
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  const limit = Number(options.limit);
  if (Number.isFinite(limit) && limit > 0) {
    complaints = complaints.slice(0, Math.min(limit, 500));
  }

  return complaints;
}

/**
 * Records the ticket number the client's CRM assigned to a complaint.
 *
 * When they import a complaint and their portal issues its own reference, they
 * post it back here. That is what lets the customer be told the same number
 * their support desk sees, even though the case was created outside the bot.
 *
 * @param {string} complaintId
 * @param {string} ticket
 * @returns {Promise<Object|null>} the updated complaint, or null if unknown
 */
async function setTicketNumber(complaintId, ticket) {
  return withStorageLock(async function () {
    const complaints = await readComplaints();

    const match = complaints.find(function (item) {
      return item.complaintId === complaintId;
    });
    if (!match) { return null; }

    match.crmTicket = String(ticket).trim().slice(0, 60);
    match.crmSyncedAt = new Date().toISOString();

    await writeComplaints(complaints);
    return match;
  });
}

/**
 * Finds one complaint by its ID, for looking up a reference number.
 * @param {string} complaintId
 * @returns {Promise<Object|null>} the complaint, or null when there is no match
 */
async function getComplaintById(complaintId) {
  const complaints = await withStorageLock(readComplaints);

  const match = complaints.find(function (item) {
    return item.complaintId === complaintId;
  });

  return match || null;
}

/* Everything the rest of the app is allowed to use */
module.exports = {
  initStorage,
  validateComplaint,
  createComplaint,
  getAllComplaints,
  getComplaintById,
  setTicketNumber,
  usesTroubleshooting,
  usesVisit,
  ALLOWED_COMPLAINT_TYPES,
  TROUBLESHOOTING_TYPES,
  NO_VISIT_TYPES,
  DEVICE_OPTIONS,
  CONNECTION_OPTIONS,
  VISIT_SLOTS,
  DATA_FILE
};
