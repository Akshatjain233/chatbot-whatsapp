/* ==========================================================================
   WhatsApp integration tests.

   Two halves:

   1. Payload rendering, tested directly against services/whatsappService.js.
      This is where WhatsApp's limits bite - 3 buttons, 10 list rows, 20 and
      24 character captions - and getting one wrong is a 400 from Meta rather
      than a truncated message.

   2. The webhook itself, tested against a real running server. The three
      behaviours that matter are the verification handshake (without it Meta
      will not save the webhook at all), signature checking (without it anyone
      can file complaints), and replay handling (without it Meta's retries
      file the same complaint twice).

   Everything runs in mock mode - no token, so nothing is posted to Meta.

   Run with:   npm test
   ========================================================================== */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = 3998;
const BASE = 'http://localhost:' + PORT;

const VERIFY_TOKEN = 'a-token-i-invented';
const APP_SECRET = 'a-fake-app-secret';

const CUSTOMER = '919111222333';       // as WhatsApp reports it, with country code

let serverProcess;
let workDir;
let dataFile;

const whatsappService = require('../services/whatsappService');

/* ==========================================================================
   Part 1 - payload rendering (no server needed)
   ========================================================================== */

test('two options render as reply buttons', function () {
  const payload = whatsappService.buildChoice('91999', 'Is this correct?', [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' }
  ]);

  assert.strictEqual(payload.interactive.type, 'button');
  assert.strictEqual(payload.interactive.action.buttons.length, 2);
  assert.strictEqual(payload.interactive.action.buttons[0].reply.id, 'yes');
});

test('four options render as a list, because buttons cap at three', function () {
  const payload = whatsappService.buildChoice('91999', 'Which devices?', [
    { id: 'all', label: 'All devices' },
    { id: 'phone', label: 'Phone' },
    { id: 'laptop', label: 'Laptop' },
    { id: 'tv', label: 'TV' }
  ]);

  assert.strictEqual(payload.interactive.type, 'list');
  assert.strictEqual(payload.interactive.action.sections[0].rows.length, 4);
});

test('every complaint category fits inside one WhatsApp menu', function () {
  const engine = require('../services/conversationEngine');
  const total = engine.CATEGORY_OPTIONS.length;

  // The categories mirror iCRM's reason list, so this count changes whenever
  // the client adds one. WhatsApp caps a list at 10 rows - past that, options
  // would be silently dropped and a customer could not report the issue.
  assert.ok(total <= whatsappService.LIMITS.listRows,
    total + ' categories exceeds WhatsApp\'s ' + whatsappService.LIMITS.listRows +
    ' row limit - they cannot all be offered');

  const payload = whatsappService.buildChoice('91999', 'What type of issue?', engine.CATEGORY_OPTIONS);

  if (total <= whatsappService.LIMITS.buttons) {
    assert.strictEqual(payload.interactive.type, 'button');
    assert.strictEqual(payload.interactive.action.buttons.length, total, 'no category may be dropped');
    return;
  }

  const rows = payload.interactive.action.sections[0].rows;
  assert.strictEqual(payload.interactive.type, 'list');
  assert.strictEqual(rows.length, total, 'no category may be dropped');

  rows.forEach(function (row) {
    assert.ok(row.title.length <= whatsappService.LIMITS.listRowTitle,
      'row title "' + row.title + '" is ' + row.title.length + ' chars, limit is ' +
      whatsappService.LIMITS.listRowTitle);
  });
});

test('every button caption in the whole flow fits WhatsApp\'s 20 characters', function () {
  const engine = require('../services/conversationEngine');

  // Gather every option set the flow can show
  const sets = [engine.CONFIRM_OPTIONS, engine.CLOSING_OPTIONS];
  engine.QUESTIONS.forEach(function (question) {
    if (question.type === 'choice' && Array.isArray(question.options)) {
      sets.push(question.options);
    }
  });

  sets.forEach(function (set) {
    if (set.length > whatsappService.LIMITS.buttons) { return; }   // renders as a list

    const payload = whatsappService.buildChoice('91999', 'q', set);
    payload.interactive.action.buttons.forEach(function (button) {
      assert.ok(button.reply.title.length <= whatsappService.LIMITS.buttonTitle,
        'button "' + button.reply.title + '" is ' + button.reply.title.length +
        ' chars, limit is ' + whatsappService.LIMITS.buttonTitle);
    });
  });
});

test('a long label is shortened rather than sent and rejected', function () {
  const payload = whatsappService.buildChoice('91999', 'q', [
    { id: 'a', label: 'Yes' },
    { id: 'b', label: 'A label far longer than twenty characters' }
  ]);

  const titles = payload.interactive.action.buttons.map(function (b) { return b.reply.title; });
  assert.ok(titles[1].length <= 20);
});

test('a summary longer than the interactive limit is not sent as one', function () {
  // An interactive body caps at 1024 characters, which a long address plus a
  // long description can exceed - which is why the engine sends the summary
  // as its own text message first
  const engine = require('../services/conversationEngine');
  const session = engine.createSession({ mobile: '9876543210' });

  session.formData.name = 'Test User';
  session.formData.address = 'x'.repeat(250);
  session.formData.description = 'y'.repeat(1000);

  const summary = engine.buildSummaryText(session);
  assert.ok(summary.length > whatsappService.LIMITS.interactiveBody,
    'this test is only meaningful if the summary can exceed the interactive limit');

  const asText = whatsappService.buildText('91999', summary);
  assert.ok(asText.text.body.length <= whatsappService.LIMITS.textBody);
});

/* ==========================================================================
   Part 2 - the webhook, against a running server
   ========================================================================== */

/** Signs a body the way Meta does. */
function sign(body) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(body).digest('hex');
}

/** Builds a realistic incoming-message payload. */
function messagePayload(id, from, message) {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: '000',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550001111', phone_number_id: '111' },
          contacts: [{ profile: { name: 'Test' }, wa_id: from }],
          messages: [Object.assign({ from: from, id: id, timestamp: '1700000000' }, message)]
        }
      }]
    }]
  };
}

function textMessage(body) {
  return { type: 'text', text: { body: body } };
}

function tapMessage(optionId, title) {
  return {
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: optionId, title: title || optionId } }
  };
}

function listMessage(optionId, title) {
  return {
    type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: optionId, title: title || optionId } }
  };
}

/** POSTs a payload with a valid signature. */
async function post(payload, options) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };

  if (!options || options.sign !== false) {
    headers['X-Hub-Signature-256'] = (options && options.signature) || sign(body);
  }

  const response = await fetch(BASE + '/webhook/whatsapp', { method: 'POST', headers, body });
  return { status: response.status, body: await response.json().catch(function () { return null; }) };
}

let messageCounter = 0;

/** Reads the customer's place in the conversation, via the test hook. */
async function sessionState() {
  const response = await fetch(BASE + '/health/session/' + CUSTOMER);
  return response.json();
}

/**
 * Sends one message and waits for the bot to finish handling it.
 *
 * The webhook answers 200 before doing the work - deliberately, so Meta does
 * not retry - so a test that asserted immediately would race the bot. It waits
 * on the server's processed counter rather than on a timestamp: the whole
 * conversation runs in a couple of milliseconds, so consecutive turns share a
 * Date.now() value and a timestamp would appear not to have moved.
 */
async function say(message, id) {
  const messageId = id || 'wamid.test.' + (++messageCounter);
  const before = (await sessionState()).processed;

  await post(messagePayload(messageId, CUSTOMER, message));

  for (let attempt = 0; attempt < 100; attempt++) {
    const now = await sessionState();
    if (now.processed > before) {
      return { session: now, complaints: readDataFile() };
    }
    await new Promise(function (resolve) { setTimeout(resolve, 20); });
  }

  throw new Error('the bot never finished handling ' + messageId);
}

/** Waits a beat, for the cases where nothing is expected to change. */
function settle() {
  return new Promise(function (resolve) { setTimeout(resolve, 400); });
}

function readDataFile() {
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch (error) {
    return [];
  }
}

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

before(async function () {
  const projectRoot = path.join(__dirname, '..');

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftth-wa-'));
  fs.copyFileSync(path.join(projectRoot, 'server.js'), path.join(workDir, 'server.js'));

  ['routes', 'services'].forEach(function (folder) {
    fs.cpSync(path.join(projectRoot, folder), path.join(workDir, folder), { recursive: true });
  });

  fs.mkdirSync(path.join(workDir, 'data'));
  dataFile = path.join(workDir, 'data', 'complaints.json');

  serverProcess = spawn(process.execPath, [path.join(workDir, 'server.js')], {
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      NODE_PATH: path.join(projectRoot, 'node_modules'),
      WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
      WHATSAPP_APP_SECRET: APP_SECRET,
      ENABLE_TEST_HOOKS: '1',
      // No API token on purpose: mock mode, nothing reaches Meta
      WHATSAPP_API_TOKEN: '',
      WHATSAPP_PHONE_ID: '',
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

beforeEach(async function () {
  fs.writeFileSync(dataFile, '[]', 'utf8');
  // Forget any conversation from the previous test, so each starts fresh
  await fetch(BASE + '/health/reset', { method: 'POST' });
});

/* --------------------------------------------------------------------------
   The verification handshake

   Meta sends this the moment you paste the URL into the dashboard. Fail it and
   the webhook simply will not save, with no useful error on screen.
   -------------------------------------------------------------------------- */

test('the correct verify token echoes the challenge back, as plain text', async function () {
  const response = await fetch(BASE +
    '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=' + VERIFY_TOKEN + '&hub.challenge=1158201444');

  assert.strictEqual(response.status, 200);
  assert.strictEqual(await response.text(), '1158201444',
    'Meta compares this byte for byte, so it must not be JSON-wrapped');
});

test('a wrong verify token is refused', async function () {
  const response = await fetch(BASE +
    '/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=guessed&hub.challenge=123');

  assert.strictEqual(response.status, 403);
});

test('a verification request with no token at all is refused', async function () {
  const response = await fetch(BASE + '/webhook/whatsapp');
  assert.strictEqual(response.status, 403);
});

/* --------------------------------------------------------------------------
   Signature checking
   -------------------------------------------------------------------------- */

test('an unsigned POST is rejected', async function () {
  const result = await post(messagePayload('wamid.unsigned', CUSTOMER, textMessage('hi')), { sign: false });

  assert.strictEqual(result.status, 401);
  assert.strictEqual(readDataFile().length, 0);
});

test('a POST signed with the wrong secret is rejected', async function () {
  const result = await post(
    messagePayload('wamid.badsig', CUSTOMER, textMessage('hi')),
    { signature: 'sha256=' + '0'.repeat(64) }
  );

  assert.strictEqual(result.status, 401);
});

test('a correctly signed POST is accepted', async function () {
  const result = await post(messagePayload('wamid.goodsig', CUSTOMER, textMessage('hi')));

  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(result.body, { received: true });

  // The webhook replies before it does the work, so wait for the conversation
  // to actually open. Without this the bot finishes AFTER the next test has
  // already reset the sessions, and re-creates one behind its back.
  await settle();
});

/* --------------------------------------------------------------------------
   Payloads that are not messages

   Meta posts delivery and read receipts to the same URL. Treating one as an
   empty message would restart the customer's conversation.
   -------------------------------------------------------------------------- */

test('a delivery status callback is ignored', async function () {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [{
      id: '000',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          statuses: [{ id: 'wamid.x', status: 'delivered', recipient_id: CUSTOMER }]
        }
      }]
    }]
  };

  const result = await post(payload);

  assert.strictEqual(result.status, 200);

  const health = await (await fetch(BASE + '/health')).json();
  assert.strictEqual(health.sessions, 0, 'a receipt must not open a conversation');
});

test('an unrecognised payload shape does not crash the webhook', async function () {
  for (const payload of [{}, { entry: null }, { entry: [{}] }, { entry: [{ changes: 'nope' }] }]) {
    const result = await post(payload);
    assert.strictEqual(result.status, 200);
  }

  // Still alive afterwards
  const response = await fetch(BASE + '/health');
  assert.strictEqual(response.status, 200);
});

/* --------------------------------------------------------------------------
   A whole conversation over the webhook
   -------------------------------------------------------------------------- */

/** Walks a non-technical complaint up to, but not including, the final submit. */
async function conversationToSummary() {
  await say(textMessage('hi'));                                // welcome + user id
  await say(textMessage('ACC-100001'));                        // -> category
  await say(listMessage('speed_issue'));                       // -> description
  await say(textMessage('Internet very slow all day'));        // -> summary
}

test('a full conversation over the webhook registers one complaint', async function () {
  await conversationToSummary();

  assert.strictEqual(readDataFile().length, 0, 'nothing saved before confirming');

  const after = await say(tapMessage('submit'));

  assert.strictEqual(after.complaints.length, 1);
  assert.strictEqual(after.complaints[0].complaintType, 'Speed Issue');
  
  assert.strictEqual(after.complaints[0].mobile, '9111222333',
    'the country code must be stripped so the number matches CRM records');
});

/* --------------------------------------------------------------------------
   The replay problem

   Meta resends a message whenever it is not certain we got it. Without a
   guard, a resent confirmation files a second complaint with a second ID -
   and the customer is told about both.
   -------------------------------------------------------------------------- */

test('a replayed confirmation does NOT file a second complaint', async function () {
  await conversationToSummary();

  const submitId = 'wamid.submit.replayed';

  await say(tapMessage('submit'), submitId);
  assert.strictEqual(readDataFile().length, 1, 'the first submit should register one complaint');

  // Meta sends exactly the same message again
  await post(messagePayload(submitId, CUSTOMER, tapMessage('submit')));
  await settle();

  assert.strictEqual(readDataFile().length, 1,
    'the replay must be ignored, not filed as a second complaint');
});

test('a replayed mid-conversation message does not skip a question', async function () {
  await say(textMessage('hi'));                          // -> user id
  await say(textMessage('ACC-100001'));                  // -> category

  const categoryId = 'wamid.category.replayed';
  await say(listMessage('speed_issue'), categoryId);     // -> description

  /* Meta sends the same category tap again. If it were processed, the bot
     would be sitting on the description question and would take "speed_issue"
     as the description text - so the customer's real answer would end up
     answering the question after it, and everything would shift by one. */
  await post(messagePayload(categoryId, CUSTOMER, listMessage('speed_issue')));
  await settle();

  await say(textMessage('Internet very slow all day'));  // -> summary
  const after = await say(tapMessage('submit'));

  assert.strictEqual(after.complaints.length, 1);
  assert.strictEqual(after.complaints[0].complaintType, 'Speed Issue');
  assert.strictEqual(after.complaints[0].description, 'Internet very slow all day',
    'the replayed tap must not have been stored as the description');
});

/* --------------------------------------------------------------------------
   Message types the bot cannot use
   -------------------------------------------------------------------------- */

test('an unsupported message type gets a polite reply, not a crash', async function () {
  await say(textMessage('hi'));

  const result = await post(messagePayload('wamid.location', CUSTOMER, {
    type: 'location',
    location: { latitude: 30.9, longitude: 75.8 }
  }));

  assert.strictEqual(result.status, 200);
  await settle();

  const response = await fetch(BASE + '/health');
  assert.strictEqual(response.status, 200, 'the server must still be running');
});
