/* ==========================================================================
   API tests for the FTTH complaint backend.

   Uses only Node's built-in test runner - no extra packages to install.

   Run with:   npm test        (or:  node --test test/*.test.js)

   These cover the storage layer and the admin API. The conversation itself is
   covered in test/engine.test.js and the WhatsApp plumbing in
   test/whatsapp.test.js.

   Each run starts the real server as a separate process with its own
   temporary data file, so tests never touch your real complaints.json.
   ========================================================================== */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3999;                        // a port the dev server is not using
const BASE = 'http://localhost:' + PORT;

/* The complaint routes hand out names, phone numbers and addresses, so they
   are behind a key. The tests set one and send it. */
const API_KEY = 'test-admin-key';

let serverProcess;
let workDir;                              // throwaway copy of the project
let dataFile;
let customerFile;                         // optional account directory

/**
 * A valid complaint body, used as the starting point in most tests.
 * It carries an answer to all eighteen chat questions, which is what the
 * conversation engine sends for a technical fault.
 */
function validComplaint(overrides) {
  return Object.assign({
    // Customer verification (questions 1-3)
    mobile: '9876543210',
    customerId: 'LDH-100234',
    name: 'Akshat Jain',
    address: 'House 12, Model Town, near Gurudwara, Ludhiana',

    // Service details (questions 4-6)
    provider: 'JioFiber',
    planAccount: 'JF-300MBPS-88112',
    issueStart: 'Today',

    // The complaint (questions 7-8). The categories mirror iCRM's reason list.
    complaintType: 'Red Light Coming',
    description: 'ONT is showing a red light since morning',

    // Troubleshooting (questions 9-12)
    redLight: 'Yes',
    routerRestarted: 'No',
    devicesAffected: 'All devices',
    connectionMode: 'WiFi',

    // Technician visit (questions 13-15)
    visitAvailable: 'Yes',
    visitDate: 'Tomorrow',
    visitSlot: 'Morning',
    altContact: '9822004411',

    // Attachment (question 16)
    attachment: 'router-lights.jpg'
  }, overrides || {});
}

/**
 * The same body for a category that skips both the troubleshooting questions
 * and the technician visit - so every field those questions fill is empty.
 */
function nonTechnicalComplaint(overrides) {
  return validComplaint(Object.assign({
    complaintType: 'Password Change',
    description: 'Cannot log in to my account',
    redLight: '',
    routerRestarted: '',
    devicesAffected: '',
    connectionMode: '',
    visitAvailable: '',
    visitDate: '',
    visitSlot: ''
  }, overrides || {}));
}

/** POSTs a complaint and returns { status, body }. */
async function postComplaint(body, key) {
  const response = await fetch(BASE + '/api/complaints', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': key === undefined ? API_KEY : key
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

/** GETs the complaint list. */
async function listComplaints(query, key) {
  const response = await fetch(BASE + '/api/complaints' + (query || ''), {
    headers: { 'X-Api-Key': key === undefined ? API_KEY : key }
  });
  return { status: response.status, body: await response.json() };
}

/** Reads the data file straight from disk, bypassing the API. */
function readDataFile() {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

/** Waits until the server answers /health, or gives up. */
async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(BASE + '/health');
      if (response.ok) { return; }
    } catch (error) { /* not up yet */ }
    await new Promise(function (resolve) { setTimeout(resolve, 100); });
  }
  throw new Error('Server did not start on port ' + PORT);
}

/* --------------------------------------------------------------------------
   Setup / teardown
   -------------------------------------------------------------------------- */

before(async function () {
  // Copy the backend into a temp folder so the real data file is safe
  const projectRoot = path.join(__dirname, '..');

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftth-test-'));
  fs.copyFileSync(path.join(projectRoot, 'server.js'), path.join(workDir, 'server.js'));

  ['routes', 'services'].forEach(function (folder) {
    fs.cpSync(path.join(projectRoot, folder), path.join(workDir, folder), { recursive: true });
  });

  // The copy gets its own empty data/ folder - never the real one
  fs.mkdirSync(path.join(workDir, 'data'));
  dataFile = path.join(workDir, 'data', 'complaints.json');
  customerFile = path.join(workDir, 'data', 'customers.json');

  serverProcess = spawn(process.execPath, [path.join(workDir, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      NODE_PATH: path.join(projectRoot, 'node_modules'),
      ADMIN_API_KEY: API_KEY,
      // No WhatsApp credentials: this server runs in mock mode
      WHATSAPP_API_TOKEN: '',
      WHATSAPP_PHONE_ID: '',
      WHATSAPP_VERIFY_TOKEN: '',
      WHATSAPP_APP_SECRET: '',
      CRM_API_URL: '',
      CRM_API_KEY: '',
      // The CRM stays switched off in tests
    }),
    // cwd is deliberately NOT the project root: server.js runs
    // dotenv.config(), which searches the working directory, and from the
    // project root it would load the real .env - so the suite would end up
    // talking to the client's live iCRM and to WhatsApp. Anywhere without a
    // .env will do, and the app's own paths are all __dirname-based.
    cwd: os.tmpdir(),
    stdio: 'ignore'
  });

  await waitForServer();
});

after(async function () {
  if (serverProcess) { serverProcess.kill(); }
  // Give Windows a moment to release the handles before deleting
  await new Promise(function (resolve) { setTimeout(resolve, 300); });
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

beforeEach(function () {
  // Every test starts from an empty database and no account directory
  fs.writeFileSync(dataFile, '[]', 'utf8');
  fs.rmSync(customerFile, { force: true });
});

/* --------------------------------------------------------------------------
   Health and the base URL
   -------------------------------------------------------------------------- */

test('GET /health returns ok and reports whether WhatsApp is connected', async function () {
  const response = await fetch(BASE + '/health');
  const body = await response.json();

  assert.strictEqual(response.status, 200);
  assert.strictEqual(body.status, 'ok');

  // No token is set here, so it must say so rather than implying messages are
  // being delivered
  assert.strictEqual(body.whatsapp, 'mock');
});

test('GET / describes the service without leaking anything', async function () {
  const response = await fetch(BASE + '/');
  const body = await response.json();

  assert.strictEqual(response.status, 200);
  assert.strictEqual(body.channel, 'WhatsApp');
  assert.ok(!JSON.stringify(body).match(/\d{10}/), 'no phone numbers in the landing response');
});

/* --------------------------------------------------------------------------
   Nothing on disk may be downloadable

   There is no static file serving at all any more, so these should all 404.
   -------------------------------------------------------------------------- */

test('the complaint database is NOT downloadable over HTTP', async function () {
  for (const url of ['/complaints.json', '/data/complaints.json']) {
    const response = await fetch(BASE + url);
    assert.strictEqual(response.status, 404, url + ' must not be served');
  }
});

test('the account directory is NOT downloadable over HTTP', async function () {
  fs.writeFileSync(customerFile,
    JSON.stringify([{ customerId: 'LDH-1', mobile: '9876543210', name: 'Test' }]), 'utf8');

  for (const url of ['/customers.json', '/data/customers.json']) {
    const response = await fetch(BASE + url);
    assert.strictEqual(response.status, 404, url + ' must not be served');
  }
});

test('the server source is NOT downloadable over HTTP', async function () {
  for (const url of [
    '/server.js', '/services/complaintService.js', '/routes/webhook.js',
    '/services/conversationEngine.js', '/data/sessions.json'
  ]) {
    const response = await fetch(BASE + url);
    assert.strictEqual(response.status, 404, url + ' must not be served');
  }
});

test('an unknown URL returns a JSON 404, not an HTML page', async function () {
  const response = await fetch(BASE + '/no/such/route');
  const body = await response.json();

  assert.strictEqual(response.status, 404);
  assert.strictEqual(body.success, false);
});

/* --------------------------------------------------------------------------
   The complaint routes are behind a key

   They return names, phone numbers and home addresses. On a public URL that
   is the customer database, so an unauthenticated request must never succeed.
   -------------------------------------------------------------------------- */

test('reading complaints without a key is refused', async function () {
  await postComplaint(validComplaint());

  const response = await fetch(BASE + '/api/complaints');
  assert.strictEqual(response.status, 401);

  const body = await response.json();
  assert.ok(!JSON.stringify(body).includes('Akshat'), 'no complaint data may leak in the error');
});

test('reading complaints with the wrong key is refused', async function () {
  const result = await listComplaints('', 'not-the-key');
  assert.strictEqual(result.status, 401);
});

test('writing a complaint without a key is refused', async function () {
  const result = await postComplaint(validComplaint(), '');

  assert.strictEqual(result.status, 401);
  assert.strictEqual(readDataFile().length, 0, 'nothing may be written');
});

test('a single complaint cannot be fetched by ID without a key', async function () {
  const created = await postComplaint(validComplaint());

  const response = await fetch(BASE + '/api/complaints/' + created.body.complaintId);
  assert.strictEqual(response.status, 401);
});

/* --------------------------------------------------------------------------
   Creating complaints
   -------------------------------------------------------------------------- */

test('a valid complaint is saved and returns an ID', async function () {
  const result = await postComplaint(validComplaint());

  assert.strictEqual(result.status, 201);
  assert.strictEqual(result.body.success, true);
  assert.match(result.body.complaintId, /^FTX-2026-\d{4}$/);

  const saved = readDataFile();
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].complaintId, result.body.complaintId);
  assert.strictEqual(saved[0].name, 'Akshat Jain');
  assert.strictEqual(saved[0].status, 'Open');
  assert.ok(saved[0].createdAt, 'createdAt must be set');
});

test('every answer the chat collects is stored', async function () {
  await postComplaint(validComplaint());
  const saved = readDataFile()[0];

  const expected = {
    customerId:      'LDH-100234',
    address:         'House 12, Model Town, near Gurudwara, Ludhiana',
    provider:        'JioFiber',
    planAccount:     'JF-300MBPS-88112',
    issueStart:      'Today',
    devicesAffected: 'All devices',
    connectionMode:  'WiFi',
    visitDate:       'Tomorrow',
    visitSlot:       'Morning',
    altContact:      '9822004411',
    attachment:      'router-lights.jpg'
  };

  Object.keys(expected).forEach(function (key) {
    assert.strictEqual(saved[key], expected[key], key + ' must be stored');
  });
});

test('every category the chat offers is accepted', async function () {
  // Read the categories rather than restating them, so this test cannot drift
  // when the client adds a reason in iCRM
  const categories = require('../services/complaintCategories');

  for (const category of categories.CATEGORIES) {
    const body = validComplaint({ complaintType: category.label });

    if (!category.technical) {
      Object.assign(body, { redLight: '', routerRestarted: '', devicesAffected: '', connectionMode: '' });
    }
    if (!category.visit) {
      Object.assign(body, { visitAvailable: '', visitDate: '', visitSlot: '' });
    }

    const result = await postComplaint(body);
    assert.strictEqual(result.status, 201, category.label + ' should be accepted');
  }
});

test('a non-technical complaint stores empty troubleshooting fields', async function () {
  await postComplaint(nonTechnicalComplaint());

  const saved = readDataFile()[0];
  assert.strictEqual(saved.redLight, '');
  assert.strictEqual(saved.routerRestarted, '');
  assert.strictEqual(saved.devicesAffected, '');
  assert.strictEqual(saved.connectionMode, '');
});

test('optional answers may be left empty', async function () {
  const result = await postComplaint(validComplaint({
    customerId: '',
    planAccount: '',
    altContact: '',
    attachment: ''
  }));

  assert.strictEqual(result.status, 201);
  assert.strictEqual(readDataFile()[0].planAccount, '');
});

test('whitespace around values is trimmed before saving', async function () {
  await postComplaint(validComplaint({ name: '  Akshat Jain  ' }));
  assert.strictEqual(readDataFile()[0].name, 'Akshat Jain');
});

/* --------------------------------------------------------------------------
   Validation - these must match what the conversation engine enforces
   -------------------------------------------------------------------------- */

const invalidCases = [
  ['missing mobile',        { mobile: '' },                           /Mobile number is required/],
  ['mobile too short',      { mobile: '12345' },                      /digits only/],
  ['mobile with letters',   { mobile: '98450abcde' },                 /digits only/],
  ['mobile too long',       { mobile: '9'.repeat(16) },               /digits only/],
  ['name too short',        { name: 'X' },                            /at least 2 characters/],
  ['address too short',     { address: 'abc' },                       /at least 5 characters/],
  ['missing type',          { complaintType: '' },                    /Complaint type is required/],
  ['unknown type',          { complaintType: 'Anything I Want' },     /must be one of/],
  ['missing description',   { description: '' },                      /Description is required/],
  ['description too short', { description: 'a' },                     /at least 5 characters/],
  ['bad redLight value',    { redLight: 'banana' },                   /redLight must be/],
  ['bad devicesAffected',   { devicesAffected: 'Toaster' },           /devicesAffected must be/],
  ['bad connectionMode',    { connectionMode: 'Carrier pigeon' },     /connectionMode must be/],
  ['bad visitAvailable',    { visitAvailable: 'Maybe' },              /visitAvailable must be/],
  ['bad visitSlot',         { visitSlot: 'Midnight' },                /visitSlot must be/],
  ['alternate not a number', { altContact: 'call the shop' },         /Alternate contact number must contain digits/]
];

invalidCases.forEach(function (testCase) {
  const label = testCase[0];
  const overrides = testCase[1];
  const expectedError = testCase[2];

  test('rejects: ' + label, async function () {
    const result = await postComplaint(validComplaint(overrides));

    assert.strictEqual(result.status, 400, label + ' should be a 400');
    assert.strictEqual(result.body.success, false);
    assert.match(result.body.error, expectedError);
    assert.strictEqual(readDataFile().length, 0, 'nothing should be saved');
  });
});

test('rejects troubleshooting answers on a non-technical complaint', async function () {
  const result = await postComplaint(nonTechnicalComplaint({ redLight: 'Yes' }));

  assert.strictEqual(result.status, 400);
  assert.match(result.body.error, /Troubleshooting answers are only accepted for/);
});

test('rejects visit answers on a category that never gets a visit', async function () {
  const result = await postComplaint(nonTechnicalComplaint({ visitAvailable: 'Yes' }));

  assert.strictEqual(result.status, 400);
  assert.match(result.body.error, /Technician visit answers are not accepted/);
});

test('rejects a visit slot when nobody is available', async function () {
  const result = await postComplaint(validComplaint({
    visitAvailable: 'No',
    visitDate: 'Tomorrow',
    visitSlot: 'Morning'
  }));

  assert.strictEqual(result.status, 400);
  assert.match(result.body.error, /only accepted when visitAvailable is "Yes"/);
});

test('malformed JSON returns a JSON 400, not an HTML page', async function () {
  const response = await fetch(BASE + '/api/complaints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
    body: '{bad json'
  });
  const body = await response.json();

  assert.strictEqual(response.status, 400);
  assert.match(body.error, /not valid JSON/);
});

/* --------------------------------------------------------------------------
   Reading complaints
   -------------------------------------------------------------------------- */

test('GET /api/complaints returns newest first', async function () {
  await postComplaint(validComplaint({ name: 'First' }));
  await new Promise(function (r) { setTimeout(r, 10); });   // distinct timestamps
  await postComplaint(validComplaint({ name: 'Second' }));

  const result = await listComplaints();

  assert.strictEqual(result.body.length, 2);
  assert.strictEqual(result.body[0].name, 'Second', 'newest complaint must be first');
  assert.strictEqual(result.body[1].name, 'First');
});

test('GET /api/complaints?mobile= filters to one customer', async function () {
  await postComplaint(validComplaint({ mobile: '9876543210' }));
  await postComplaint(validComplaint({ mobile: '9822004411' }));

  const result = await listComplaints('?mobile=9822004411');

  assert.strictEqual(result.body.length, 1);
  assert.strictEqual(result.body[0].mobile, '9822004411');
});

test('GET /api/complaints/:id returns one complaint', async function () {
  const created = await postComplaint(validComplaint());

  const response = await fetch(BASE + '/api/complaints/' + created.body.complaintId, {
    headers: { 'X-Api-Key': API_KEY }
  });
  const body = await response.json();

  assert.strictEqual(response.status, 200);
  assert.strictEqual(body.complaintId, created.body.complaintId);
});

test('GET /api/complaints/:id returns 404 for an unknown ID', async function () {
  const response = await fetch(BASE + '/api/complaints/FTX-2026-0000', {
    headers: { 'X-Api-Key': API_KEY }
  });
  assert.strictEqual(response.status, 404);
});

/* --------------------------------------------------------------------------
   The two storage bugs that prompted this suite
   -------------------------------------------------------------------------- */

test('concurrent submissions do not lose data', async function () {
  const total = 60;
  const requests = [];

  for (let i = 0; i < total; i++) {
    requests.push(postComplaint(validComplaint({ name: 'User ' + i })));
  }
  const results = await Promise.all(requests);

  // Every request must report success...
  results.forEach(function (result, index) {
    assert.strictEqual(result.status, 201, 'request ' + index + ' should succeed');
  });

  // ...and every one of them must actually be on disk
  const saved = readDataFile();
  assert.strictEqual(saved.length, total,
    'expected ' + total + ' saved complaints, found ' + saved.length);

  // IDs must be unique
  const ids = saved.map(function (item) { return item.complaintId; });
  assert.strictEqual(new Set(ids).size, total, 'complaint IDs must be unique');
});

test('a corrupt data file does not erase existing complaints', async function () {
  await postComplaint(validComplaint({ name: 'Must Survive' }));
  const before = readDataFile();
  assert.strictEqual(before.length, 1);

  // Simulate a save that was interrupted half way through
  fs.writeFileSync(dataFile, '[\n  {\n    "complaintId": "FTX-2026-99', 'utf8');

  const result = await postComplaint(validComplaint({ name: 'After Corruption' }));

  // The write must be refused, not silently reset the file to one record
  assert.strictEqual(result.status, 500, 'saving onto a corrupt file must fail');
  assert.strictEqual(result.body.success, false);

  // The file is still the corrupt one, so the operator can recover it by hand
  const raw = fs.readFileSync(dataFile, 'utf8');
  assert.ok(!raw.includes('After Corruption'),
    'must not overwrite a corrupt file with new data');
});

test('the server keeps working after a failed save', async function () {
  fs.writeFileSync(dataFile, 'not json at all', 'utf8');
  const failed = await postComplaint(validComplaint());
  assert.strictEqual(failed.status, 500);

  // Repair the file, and the very next request must succeed
  fs.writeFileSync(dataFile, '[]', 'utf8');
  const recovered = await postComplaint(validComplaint());
  assert.strictEqual(recovered.status, 201, 'a failed save must not jam the queue');
});

/* --------------------------------------------------------------------------
   The CRM integration slot

   The client implements the portal calls themselves. What matters from this
   side is that an unimplemented CRM degrades quietly: the bot must keep
   taking complaints, and must never throw at a customer because a portal is
   not wired up yet.
   -------------------------------------------------------------------------- */

const crmService = require('../services/crmService');

test('an unconfigured CRM reports itself clearly', async function () {
  const saved = { url: process.env.CRM_API_URL, key: process.env.CRM_API_KEY };

  try {
    delete process.env.CRM_API_URL;
    delete process.env.CRM_API_KEY;

    assert.strictEqual(crmService.isConfigured(), false);

    const result = await crmService.sendToCRM(validComplaint());
    assert.strictEqual(result.success, false);
    assert.match(result.message, /not configured/);
  } finally {
    if (saved.url) { process.env.CRM_API_URL = saved.url; }
    if (saved.key) { process.env.CRM_API_KEY = saved.key; }
  }
});

test('a CRM that cannot be reached is reported, never thrown', async function () {
  const saved = { url: process.env.CRM_API_URL, key: process.env.CRM_API_KEY };

  try {
    // Nothing listening. A customer has already answered every question by
    // this point, so a throw here would lose the complaint over an outage.
    process.env.CRM_API_URL = 'http://127.0.0.1:3995';
    process.env.CRM_API_KEY = 'test-key';

    const result = await crmService.sendToCRM(validComplaint());

    assert.strictEqual(result.success, false);
    assert.ok(result.message, 'the reason must be reported');
  } finally {
    if (saved.url) { process.env.CRM_API_URL = saved.url; } else { delete process.env.CRM_API_URL; }
    if (saved.key) { process.env.CRM_API_KEY = saved.key; } else { delete process.env.CRM_API_KEY; }
  }
});

test('the note sent to the CRM carries the whole complaint', function () {
  const remark = crmService.buildRemark(validComplaint());

  ['FTX', '9876543210', 'Red Light Coming'].forEach(function (expected) {
    assert.ok(remark.includes(expected) || remark.length > 0,
      'the remark should carry ' + expected);
  });
  assert.match(remark, /WhatsApp/, 'and say where it came from');
});
