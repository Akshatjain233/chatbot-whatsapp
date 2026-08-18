/* ==========================================================================
   The CRM integration slot.

   The client implements the portal calls in services/crmService.js, so these
   tests are really a contract. Half of them prove that a correctly-written
   implementation gets used properly. The other half prove that a missing,
   slow, broken or badly-behaved one never damages the conversation.

   That second half is the important one: it is what protects the customer
   experience while the client is still building.

   Run with:   npm test
   ========================================================================== */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

let workDir;
let engine;
let crmService;
let originals = {};

before(function () {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftth-slot-'));

  ['routes', 'services'].forEach(function (folder) {
    fs.cpSync(path.join(__dirname, '..', folder), path.join(workDir, folder), { recursive: true });
  });
  fs.mkdirSync(path.join(workDir, 'data'));
  fs.writeFileSync(path.join(workDir, 'data', 'complaints.json'), '[]', 'utf8');

  engine = require(path.join(workDir, 'services', 'conversationEngine.js'));
  crmService = require(path.join(workDir, 'services', 'crmService.js'));

  originals = {
    isConfigured: crmService.isConfigured,
    lookupSubscribers: crmService.lookupSubscribers,
    sendToCRM: crmService.sendToCRM
  };
});

after(function () {
  Object.assign(crmService, originals);
  if (workDir) { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5 }); }
});

beforeEach(function () {
  fs.writeFileSync(path.join(workDir, 'data', 'complaints.json'), '[]', 'utf8');
  delete process.env.CRM_API_URL;
  delete process.env.CRM_API_KEY;
  Object.assign(crmService, originals);
});

/* --------------------------------------------------------------------------
   Helpers
   -------------------------------------------------------------------------- */

/** Stands in for the client's implementation. */
function withCRM(impl) {
  crmService.isConfigured = function () { return true; };
  if (impl.lookupSubscribers) { crmService.lookupSubscribers = impl.lookupSubscribers; }
  if (impl.sendToCRM) { crmService.sendToCRM = impl.sendToCRM; }
}

function said(replies) {
  return replies.map(function (r) { return r.text; }).join('\n');
}

function menu(replies) {
  const last = replies.filter(function (r) { return r.kind === 'choice'; }).pop();
  return last ? last.options : null;
}

/**
 * Runs a whole complaint through, returning the final replies.
 *
 * The User ID question only appears when the CRM has not identified the
 * account, so whether it needs answering depends on what the stub returned -
 * which is exactly what these tests vary. Hence the check rather than a fixed
 * script.
 */
async function fileComplaint(session) {
  if (session.stepId === 'CUSTOMER_ID') {
    const identified = await engine.handleIncoming(session, { text: 'skip' });
    session = identified.session;
  }

  let result = await engine.handleIncoming(session, { optionId: 'speed_issue', text: '' });
  result = await engine.handleIncoming(result.session, { text: 'Internet very slow all day' });
  return engine.handleIncoming(result.session, { optionId: 'submit', text: '' });
}

const THREE_CONNECTIONS = [
  { userId: 'ACC-100001', name: 'Test Customer', plan: '100 Mbps', status: 'Active' },
  { userId: 'ACC-100002', name: 'Test Customer', plan: '200 Mbps', status: 'Active' },
  { userId: 'ACC-100003', name: 'Test Customer', plan: '50 Mbps',  status: 'Suspended' }
];

/* --------------------------------------------------------------------------
   Fetching the connections
   -------------------------------------------------------------------------- */

test('several connections are offered for the customer to choose', async function () {
  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: THREE_CONNECTIONS }; }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  const options = menu(opening.replies);

  assert.match(said(opening.replies), /more than one connection/);
  assert.strictEqual(options.length, 3);
  assert.strictEqual(options[0].label, 'ACC-100001');
  assert.match(options[0].description, /100 Mbps - Active/,
    'the plan and status are what let a customer tell their connections apart');
});

test('the chosen connection is what the complaint is filed against', async function () {
  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: THREE_CONNECTIONS }; }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  const result = await engine.handleIncoming(opening.session, { optionId: 'conn_2', text: '' });

  assert.strictEqual(result.session.formData.customerId, 'ACC-100003');
  assert.match(said(result.replies), /type of issue/i, 'and it moves straight on');
});

test('a single connection is adopted without asking', async function () {
  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: [THREE_CONNECTIONS[0]] }; }
  });

  const opening = await engine.start({ mobile: '9876543210' });

  assert.doesNotMatch(said(opening.replies), /more than one connection/);
  assert.strictEqual(opening.session.formData.customerId, 'ACC-100001');
  assert.match(said(opening.replies), /type of issue/i);
  assert.doesNotMatch(said(opening.replies), /User ID/i,
    'the CRM knows the account, so asking would be asking twice');
});

test('more connections than WhatsApp can show are capped, not dropped silently', async function () {
  const many = [];
  for (let i = 0; i < 14; i++) {
    many.push({ userId: 'ACC-1000' + (2270000 + i), plan: 'P', status: 'Active' });
  }
  withCRM({ lookupSubscribers: async function () { return { ok: true, subscribers: many }; } });

  const opening = await engine.start({ mobile: '9876543210' });
  assert.strictEqual(menu(opening.replies).length, 10, 'WhatsApp lists cap at 10 rows');
});

test('the chosen connection reaches the CRM push', async function () {
  let received = null;

  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: THREE_CONNECTIONS }; },
    sendToCRM: async function (complaint) {
      received = complaint;
      return { success: true, ticket: 'TKT500' };
    }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  const picked = await engine.handleIncoming(opening.session, { optionId: 'conn_1', text: '' });
  await fileComplaint(picked.session);

  assert.ok(received, 'sendToCRM must be called');
  assert.strictEqual(received.customerId, 'ACC-100002',
    'the case has to be filed against the connection the customer picked');
  assert.strictEqual(received.mobile, '9876543210');
  assert.strictEqual(received.complaintType, 'Speed Issue');
});

/* --------------------------------------------------------------------------
   The ticket number
   -------------------------------------------------------------------------- */

test('the portal ticket number is what the customer is told', async function () {
  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: [THREE_CONNECTIONS[0]] }; },
    sendToCRM: async function () { return { success: true, ticket: 'TKT448' }; }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  const result = await fileComplaint(opening.session);

  assert.match(said(result.replies), /TKT448/,
    'the customer and the support desk must quote the same reference');
});

test('with no ticket number, the internal reference is used instead', async function () {
  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: [] }; },
    sendToCRM: async function () { return { success: true }; }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  const result = await fileComplaint(opening.session);

  assert.match(said(result.replies), /FTX-2026-\d{4}/, 'the customer still gets a reference');
});

/* --------------------------------------------------------------------------
   A badly-behaved CRM must not damage the conversation

   Everything below is about the client's half being absent or wrong. The bot
   has to keep working regardless, because the customer is real either way.
   -------------------------------------------------------------------------- */

test('an unconfigured CRM does not ask about connections at all', async function () {
  const opening = await engine.start({ mobile: '9876543210' });

  assert.doesNotMatch(said(opening.replies), /more than one connection/);
  assert.match(said(opening.replies), /User ID/i,
    'with no CRM to identify the account, the customer is asked for it');
});

test('a CRM lookup that fails still lets the customer report a fault', async function () {
  withCRM({
    lookupSubscribers: async function () {
      return { ok: false, subscribers: [], error: 'portal is down' };
    }
  });

  const opening = await engine.start({ mobile: '9876543210' });

  assert.match(said(opening.replies), /User ID/i, 'it falls back to asking');
  assert.doesNotMatch(said(opening.replies), /sorry|error|failed/i,
    'a CRM problem is not something to put in front of the customer');
});

test('a CRM lookup that THROWS still lets the customer report a fault', async function () {
  withCRM({
    lookupSubscribers: async function () { throw new Error('a missing try/catch'); }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  assert.match(said(opening.replies), /User ID/i);
});

test('a CRM lookup returning nonsense does not break the picker', async function () {
  const shapes = [null, undefined, {}, { ok: true }, { ok: true, subscribers: null }];

  for (const shape of shapes) {
    withCRM({ lookupSubscribers: async function () { return shape; } });

    const opening = await engine.start({ mobile: '9876543210' });
    assert.match(said(opening.replies), /User ID/i,
      'shape ' + JSON.stringify(shape) + ' must not stall the conversation');
  }
});

test('a push that fails still confirms the complaint to the customer', async function () {
  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: [] }; },
    sendToCRM: async function () { return { success: false, message: 'portal is down' }; }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  const result = await fileComplaint(opening.session);

  assert.match(said(result.replies), /registered successfully/,
    'the complaint is already saved - a CRM fault must not hide that');
});

test('a push that THROWS still confirms the complaint to the customer', async function () {
  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: [] }; },
    sendToCRM: async function () { throw new Error('a missing try/catch'); }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  const result = await fileComplaint(opening.session);

  assert.match(said(result.replies), /registered successfully/);
});

test('a slow CRM does not hold the greeting open indefinitely', async function () {
  withCRM({
    lookupSubscribers: async function () {
      await new Promise(function (resolve) { setTimeout(resolve, 300); });
      return { ok: true, subscribers: [] };
    }
  });

  const started = Date.now();
  const opening = await engine.start({ mobile: '9876543210' });
  const took = Date.now() - started;

  assert.match(said(opening.replies), /User ID/i);
  assert.ok(took < 5000,
    'the greeting waits on this lookup, so it must stay fast - it took ' + took + 'ms');
});

test('the complaint is saved even when the CRM never answers', async function () {
  withCRM({
    lookupSubscribers: async function () { return { ok: true, subscribers: [] }; },
    sendToCRM: async function () { return { success: false, message: 'timed out' }; }
  });

  const opening = await engine.start({ mobile: '9876543210' });
  await fileComplaint(opening.session);

  const saved = JSON.parse(fs.readFileSync(path.join(workDir, 'data', 'complaints.json'), 'utf8'));
  assert.strictEqual(saved.length, 1, 'nothing may be lost because a portal was unreachable');
  assert.strictEqual(saved[0].complaintType, 'Speed Issue');
});
