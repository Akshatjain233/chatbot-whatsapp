/* ==========================================================================
   scripts/simulate.js

   The bot, in your terminal.

   Run with:  npm run simulate

   This drives services/conversationEngine.js directly - the same code the
   WhatsApp webhook runs - so you can walk all eighteen questions without a
   Meta account, a phone, or a deployed server. It is the fastest way to check
   a wording change or a new question.

   What it does NOT prove: that WhatsApp renders it correctly. Menus with more
   than three options become a list on WhatsApp, and that only shows up on a
   real device. The `/preview` command below shows which shape each question
   will use.

   Commands (typed instead of an answer):
     /quit      stop
     /state     dump the session as JSON
     /preview   show how the current question renders on WhatsApp
     /media     pretend to send a photo
   ========================================================================== */

require('dotenv').config();

const readline = require('readline');

const engine = require('../services/conversationEngine');
const whatsappService = require('../services/whatsappService');
const complaintService = require('../services/complaintService');

/* The number the fake customer is messaging from. WhatsApp would supply this,
   which is why the simulator does too - and why question 1 is skipped. */
const FROM = process.argv[2] || '9876543210';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

let session = null;
let lastReplies = [];

/* --------------------------------------------------------------------------
   Printing
   -------------------------------------------------------------------------- */

const BOT = '\x1b[36m';        // cyan
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const OFF = '\x1b[0m';

function printReplies(replies) {
  lastReplies = replies;

  replies.forEach(function (reply) {
    reply.text.split('\n').forEach(function (line) {
      console.log(BOT + '  bot ' + OFF + line);
    });

    if (reply.kind === 'choice') {
      reply.options.forEach(function (option, index) {
        const shown = option.short || option.label;
        const note = option.short ? DIM + '  (' + option.label + ')' + OFF : '';
        console.log('       ' + DIM + (index + 1) + '.' + OFF + ' ' + shown + note);
      });
      console.log('       ' + DIM + 'tap by number, or type the option' + OFF);
    }

    console.log('');
  });
}

/** Shows how WhatsApp will actually render the question on screen. */
function preview() {
  const question = lastReplies.filter(function (r) { return r.kind === 'choice'; }).pop();

  if (!question) {
    console.log(DIM + '  the current question is free text, so it sends as a plain message' + OFF + '\n');
    return;
  }

  const payload = whatsappService.buildChoice(FROM, question.text, question.options);
  const shape = payload.interactive.type;

  console.log(DIM + '  WhatsApp will send this as: ' + OFF + BOLD +
    (shape === 'button' ? 'reply buttons' : 'a list menu') + OFF);
  console.log(DIM + '  (buttons allow 3 options, a list allows 10)' + OFF);
  console.log(JSON.stringify(payload.interactive, null, 2)
    .split('\n').map(function (l) { return '  ' + DIM + l + OFF; }).join('\n'));
  console.log('');
}

/* --------------------------------------------------------------------------
   The loop
   -------------------------------------------------------------------------- */

/**
 * Handles one line of input. Returns false when the conversation should end.
 * @param {string} line
 */
async function handleLine(line) {
  if (line === '/quit') { return false; }

  if (line === '/state') {
    console.log(JSON.stringify(session, null, 2) + '\n');
    return true;
  }

  if (line === '/preview') {
    preview();
    return true;
  }

  let incoming;

  if (line === '/media') {
    console.log(DIM + '  (pretending you sent a photo)' + OFF);
    incoming = { text: '', media: { filename: 'simulated-photo.jpg' } };
  } else {
    incoming = { text: line };
  }

  try {
    const result = await engine.handleIncoming(session, incoming);
    session = result.session;
    printReplies(result.replies);
  } catch (error) {
    console.error('\x1b[31m  ENGINE ERROR ' + OFF + error.stack);
  }

  return true;
}

/* --------------------------------------------------------------------------
   Two input modes

   Typed at a terminal, this is a normal prompt loop. Fed from a pipe or a
   file it is not: stdin ends immediately, readline closes, and every reply
   after the first would be written to a stream that has already gone. So a
   non-interactive run collects the lines first and plays them through in
   order, which also makes it scriptable:

     printf 'Test User\nMy address\n1\n' | npm run simulate
   -------------------------------------------------------------------------- */

/** Terminal mode: ask, answer, repeat. */
function promptLoop() {
  rl.question('\x1b[32m  you \x1b[0m', async function (input) {
    const keepGoing = await handleLine(input.trim());

    if (!keepGoing) {
      rl.close();
      return;
    }
    promptLoop();
  });
}

/* Piped input starts flowing the moment readline exists, so the lines are
   collected from the first tick - attaching a listener later would miss them
   entirely, and the run would stop after the opening message. */
const scriptedLines = [];
let scriptFinished = Promise.resolve();

if (!process.stdin.isTTY) {
  rl.on('line', function (line) { scriptedLines.push(line.trim()); });
  scriptFinished = new Promise(function (resolve) { rl.on('close', resolve); });
}

/** Script mode: wait for all the input, then play it through in order. */
async function replay() {
  await scriptFinished;

  for (const line of scriptedLines) {
    if (line === '') { continue; }
    console.log('\x1b[32m  you \x1b[0m' + line);
    if (!(await handleLine(line))) { break; }
  }
}

/* --------------------------------------------------------------------------
   Start
   -------------------------------------------------------------------------- */

complaintService.initStorage();

console.log('');
console.log(BOLD + '  FTTH Support - simulator' + OFF);
console.log(DIM + '  messaging as ' + FROM + '   commands: /quit /state /preview /media' + OFF);
if (!whatsappService.isConfigured()) {
  console.log(DIM + '  WhatsApp is in mock mode, which is what you want here' + OFF);
}
console.log('');

// The webhook skips question 1 because it already knows the number. The
// simulator behaves the same way, so what you test is what customers get.
engine.start({ mobile: FROM }).then(function (opening) {
  session = opening.session;
  printReplies(opening.replies);

  if (process.stdin.isTTY) {
    promptLoop();
  } else {
    replay().then(function () { rl.close(); });
  }
});
