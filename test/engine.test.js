/* ==========================================================================
   Conversation engine tests.

   These drive services/conversationEngine.js directly - no server, no HTTP,
   no WhatsApp - so a whole conversation runs in about a millisecond.

   THE FLOW IS DELIBERATELY SHORT. A Case in iCRM has six fields, and the bot
   supplies four of them without asking:

     Case Title     generated from the category and the reference number
     Mobile No      the WhatsApp number
     Type           derived from the category
     UserID         from iCRM, unless it does not recognise the number

   So the only questions are: which connection (when there are several), the
   category, and a description. Name, address, provider and plan were all
   asked once; none is a Case field, and iCRM holds all four already.

   Run with:   npm test
   ========================================================================== */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const projectRoot = path.join(__dirname, '..');
let workDir;
let engine;
let complaintService;
let categories;

before(function () {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftth-engine-'));

  ['routes', 'services'].forEach(function (folder) {
    fs.cpSync(path.join(projectRoot, folder), path.join(workDir, folder), { recursive: true });
  });
  fs.mkdirSync(path.join(workDir, 'data'));
  fs.writeFileSync(path.join(workDir, 'data', 'complaints.json'), '[]', 'utf8');

  engine = require(path.join(workDir, 'services', 'conversationEngine.js'));
  complaintService = require(path.join(workDir, 'services', 'complaintService.js'));
  categories = require(path.join(workDir, 'services', 'complaintCategories.js'));
});

after(function () {
  if (workDir) { fs.rmSync(workDir, { recursive: true, force: true }); }
});

beforeEach(function () {
  fs.writeFileSync(path.join(workDir, 'data', 'complaints.json'), '[]', 'utf8');
  fs.rmSync(path.join(workDir, 'data', 'pending-cases.json'), { force: true });
});

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

function savedComplaints() {
  return JSON.parse(fs.readFileSync(path.join(workDir, 'data', 'complaints.json'), 'utf8'));
}

function said(replies) {
  return replies.map(function (r) { return r.text; }).join('\n');
}

function menu(replies) {
  const last = replies.filter(function (r) { return r.kind === 'choice'; }).pop();
  return last ? last.options : null;
}

/** A User ID of the shape the portal issues. */
const USER_ID = 'ACC-100001';

/**
 * Drives a conversation. Each step is a string (typed), { tap: id }, or
 * { media: filename }.
 *
 * The User ID question opens every conversation while the CRM lookup is still
 * a stub, and answering it in twenty separate scripts would bury what each
 * test is actually about. So it is answered here - but only when the engine
 * really asked it, because once the CRM identifies the account the question
 * disappears and a stray answer would land on the category instead.
 */
async function converse(script, seed) {
  const opening = await engine.start(seed || { mobile: '9876543210' });

  let session = opening.session;
  const transcript = [said(opening.replies)];
  let replies = opening.replies;

  if (session.stepId === 'CUSTOMER_ID') {
    const answered = await engine.handleIncoming(session, { text: USER_ID });
    session = answered.session;
    replies = answered.replies;
    transcript.push(said(replies));
  }

  for (const step of script) {
    const incoming = typeof step === 'string'
      ? { text: step }
      : step.tap
        ? { text: '', optionId: step.tap }
        : { text: '', media: { filename: step.media } };

    const result = await engine.handleIncoming(session, incoming);
    session = result.session;
    replies = result.replies;
    transcript.push(said(replies));
  }

  return { session, replies, transcript: transcript.join('\n'), lastMenu: menu(replies) };
}


/* --------------------------------------------------------------------------
   The whole conversation
   -------------------------------------------------------------------------- */

test('a complaint takes three questions and registers', async function () {
  const run = await converse([
    { tap: 'speed_issue' },              // category   (converse answers user id)
    'Internet very slow all day',        // description
    { tap: 'submit' }                    // confirm
  ]);

  assert.match(said(run.replies), /registered successfully/);
  assert.match(said(run.replies), /FTX-2026-\d{4}/);

  const saved = savedComplaints();
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].mobile, '9876543210', 'the number comes from the channel');
  assert.strictEqual(saved[0].complaintType, 'Speed Issue');
  assert.strictEqual(saved[0].description, 'Internet very slow all day');
});

/* --------------------------------------------------------------------------
   Identifying the account

   Until the CRM lookup is implemented, nothing tells the bot which account a
   number belongs to. A complaint that reaches the support desk with no User
   ID is one somebody has to chase by hand, so the bot asks - and stops asking
   the moment the CRM can answer for itself.
   -------------------------------------------------------------------------- */

test('the User ID is asked for when the CRM cannot identify the account', async function () {
  const opening = await engine.start({ mobile: '9876543210' });

  assert.match(said(opening.replies), /User ID/i);
  assert.strictEqual(opening.session.stepId, 'CUSTOMER_ID');
});

test('the User ID given is what the complaint is filed against', async function () {
  const run = await converse([
    { tap: 'speed_issue' },
    'Internet very slow all day',
    { tap: 'submit' }
  ]);

  assert.strictEqual(savedComplaints()[0].customerId, USER_ID,
    'without this the support desk has only a phone number to go on');
  assert.match(run.transcript, /Customer ID: ACC-100001/,
    'and the customer sees it in the summary before confirming');
});

test('a customer who cannot find their User ID is not turned away', async function () {
  const opening = await engine.start({ mobile: '9876543210' });
  const skipped = await engine.handleIncoming(opening.session, { text: 'SKIP' });

  assert.match(said(skipped.replies), /type of issue/i, 'the conversation carries on');

  let run = await engine.handleIncoming(skipped.session, { optionId: 'speed_issue', text: '' });
  run = await engine.handleIncoming(run.session, { text: 'Internet very slow all day' });
  run = await engine.handleIncoming(run.session, { optionId: 'submit', text: '' });

  assert.match(said(run.replies), /registered successfully/,
    'a dead line is exactly when the bill is hardest to find');

  const saved = savedComplaints();
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].customerId, '');
  assert.strictEqual(saved[0].mobile, '9876543210', 'the number still identifies them');
});

test('a User ID too short to be real is questioned, not stored', async function () {
  const opening = await engine.start({ mobile: '9876543210' });
  const run = await engine.handleIncoming(opening.session, { text: 'ab' });

  assert.match(said(run.replies), /too short/i);
  assert.strictEqual(run.session.stepId, 'CUSTOMER_ID', 'and it asks again');
  assert.strictEqual(run.session.formData.customerId, '');
});

test('the bot never asks for anything iCRM already holds', async function () {
  const run = await converse([{ tap: 'speed_issue' }, 'Very slow since morning']);

  assert.doesNotMatch(run.transcript, /full name/i, 'the name is on the subscriber record');
  assert.doesNotMatch(run.transcript, /address|landmark/i, 'the address is on the subscriber record');
  assert.doesNotMatch(run.transcript, /internet provider/i, 'the provider is always this ISP');
  assert.doesNotMatch(run.transcript, /plan or account/i, 'the plan is on the subscriber record');
});

test('nothing is asked that the Case form has no field for', async function () {
  const run = await converse([{ tap: 'speed_issue' }, 'Very slow since morning']);

  assert.doesNotMatch(run.transcript, /red light|restarting the router/i);
  assert.doesNotMatch(run.transcript, /all devices|LAN cable/i);
  assert.doesNotMatch(run.transcript, /technician visit|time slot|which day/i);
  assert.doesNotMatch(run.transcript, /alternate contact/i);
  assert.doesNotMatch(run.transcript, /when did you first notice/i);
});

test('the SLA for the chosen category is quoted straight away', async function () {
  const red = await converse([{ tap: 'red_light' }]);
  assert.match(red.transcript, /field team will be assigned within 12 hours/);

  const speed = await converse([{ tap: 'speed_issue' }]);
  assert.match(speed.transcript, /technician will be assigned within 24 hours/);
});

test('every category is reachable and submits', async function () {
  for (const category of categories.CATEGORIES) {
    fs.writeFileSync(path.join(workDir, 'data', 'complaints.json'), '[]', 'utf8');

    const run = await converse([
      { tap: category.id },
      'A description of the problem here',
      { tap: 'submit' }
    ]);

    assert.match(said(run.replies), /registered successfully/, category.label + ' should register');
    assert.strictEqual(savedComplaints()[0].complaintType, category.label);
  }
});

/* --------------------------------------------------------------------------
   The categories must match iCRM
   -------------------------------------------------------------------------- */

test('every category maps to a real iCRM reason and type', function () {
  const icrmReasons = ['Speed Issue', 'Red Light Coming', 'Password Change', 'Voice not Working'];
  const icrmTypes = ['Problem', 'Feedback', 'Question', 'Request'];

  categories.CATEGORIES.forEach(function (category) {
    assert.ok(icrmReasons.indexOf(category.crmReason) !== -1,
      '"' + category.label + '" maps to reason "' + category.crmReason +
      '", which is not in iCRM\'s Select Reason list');
    assert.ok(icrmTypes.indexOf(category.crmType) !== -1,
      '"' + category.label + '" maps to type "' + category.crmType + '", not in iCRM\'s Type list');
  });
});

test('the engine and the validator cannot disagree about categories', function () {
  const allowed = complaintService.ALLOWED_COMPLAINT_TYPES;

  engine.CATEGORY_OPTIONS.forEach(function (option) {
    assert.ok(allowed.indexOf(option.label) !== -1,
      '"' + option.label + '" is offered by the engine but rejected by the validator');
  });
  assert.strictEqual(engine.CATEGORY_OPTIONS.length, allowed.length);
});

/* --------------------------------------------------------------------------
   Answering by typing rather than tapping
   -------------------------------------------------------------------------- */

test('a category can be answered by typing its name', async function () {
  const run = await converse(['Red Light Coming']);
  assert.strictEqual(run.session.formData.complaintType, 'Red Light Coming');
});

test('a category can be answered by its number', async function () {
  const run = await converse(['2']);
  assert.strictEqual(run.session.formData.complaintType, 'Red Light Coming');
});

test('an unrecognised reply re-offers the same options', async function () {
  const run = await converse(['something else entirely']);

  assert.match(said(run.replies), /choose one of these/i);
  assert.strictEqual(run.lastMenu.length, categories.CATEGORIES.length);
});

/* --------------------------------------------------------------------------
   Validation
   -------------------------------------------------------------------------- */

test('a too-short description is re-asked rather than stored', async function () {
  const run = await converse([{ tap: 'speed_issue' }, 'slow']);

  assert.match(said(run.replies), /at least 5 characters/);
  assert.strictEqual(run.session.formData.description, '');
});

test('an over-long description is caught before the server rejects it', async function () {
  const run = await converse([{ tap: 'speed_issue' }, 'x'.repeat(1200)]);

  assert.match(said(run.replies), /bit long/);
  assert.strictEqual(run.session.formData.description, '');
});

/* --------------------------------------------------------------------------
   Confirmation, restart and the closing menu
   -------------------------------------------------------------------------- */

const toSummary = [{ tap: 'speed_issue' }, 'Internet very slow all day'];

test('the summary is shown before anything is saved', async function () {
  const run = await converse(toSummary);

  assert.match(said(run.replies), /Complaint Summary/);
  assert.match(said(run.replies), /Internet very slow all day/);
  assert.strictEqual(savedComplaints().length, 0, 'nothing may be saved before confirming');
});

test('the summary only lists what was actually collected', async function () {
  const run = await converse(toSummary);
  const summary = said(run.replies);

  assert.match(summary, /Complaint Type: Speed Issue/);
  assert.doesNotMatch(summary, /Red Light:/);
  assert.doesNotMatch(summary, /Preferred Slot/);
  assert.doesNotMatch(summary, /Service Address/);
});

test('"start over" clears every answer', async function () {
  const run = await converse(toSummary.concat([{ tap: 'restart' }]));

  assert.strictEqual(run.session.formData.complaintType, '');
  assert.strictEqual(run.session.formData.description, '');
  assert.strictEqual(run.session.formData.mobile, '9876543210', 'but the number is kept');
  assert.strictEqual(savedComplaints().length, 0);
});

test('RESTART works at any point', async function () {
  const run = await converse([{ tap: 'speed_issue' }, 'restart']);

  assert.match(said(run.replies), /Starting again/);
  assert.strictEqual(run.session.formData.complaintType, '');
});

test('replying 9 reaches an agent, at any point', async function () {
  const midway = await converse([{ tap: 'speed_issue' }, '9']);
  assert.match(said(midway.replies), /support agent/);

  const atStart = await converse(['9']);
  assert.match(said(atStart.replies), /support agent/);
});

test('the closing menu can start a second complaint', async function () {
  const run = await converse(toSummary.concat([{ tap: 'submit' }, { tap: 'another' }]));

  assert.match(said(run.replies), /another complaint/);
  assert.strictEqual(run.session.formData.complaintType, '', 'the new one starts empty');
  assert.strictEqual(savedComplaints().length, 1, 'the first one is still saved');
});

test('replying 9 after submitting still reaches an agent', async function () {
  const run = await converse(toSummary.concat([{ tap: 'submit' }, '9']));
  assert.match(said(run.replies), /support agent/);
});

test('the conversation can be closed politely', async function () {
  const run = await converse(toSummary.concat([{ tap: 'submit' }, { tap: 'done' }]));
  assert.match(said(run.replies), /Thank you/);
});
