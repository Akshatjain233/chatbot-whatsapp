/* ==========================================================================
   conversationEngine.js

   The complaint conversation, with no idea what a browser or a webhook is.

   Give it the state of one customer's conversation and the message they just
   sent; it gives back the state afterwards and the replies to deliver. It
   never touches HTTP, never touches WhatsApp, and never waits for a timer -
   which is what makes it testable in milliseconds and reusable from both the
   webhook and the terminal simulator.

   HOW THE FLOW IS BUILT
   ---------------------
   The questions live in one ordered table (QUESTIONS, below), and each entry
   may carry a `when` test. The engine walks the table top to bottom and skips
   any question whose `when` returns false. That is the whole skip logic -
   there are no special cases anywhere else.

   The flow is deliberately short. A case in the CRM needs a category and a
   description; the mobile number comes from WhatsApp, and the CRM looks the
   account up from it. The only other question is which connection, and that
   is asked solely because one number can hold several.

   WHAT A REPLY LOOKS LIKE
   -----------------------
   Replies are descriptions, not WhatsApp payloads, so the caller decides how
   to render them:

     { kind: 'text',   text }
     { kind: 'choice', text, options: [{ id, label, short, description }] }

   routes/webhook.js turns a 'choice' into WhatsApp buttons or a list depending
   on how many options it has; scripts/simulate.js just prints them.
   ========================================================================== */

const complaintService = require('./complaintService');
const crmService = require('./crmService');
const categories = require('./complaintCategories');

/* --------------------------------------------------------------------------
   Answer options

   Each option carries three things:

     id           what comes back when the customer taps it on WhatsApp, and
                  what the engine matches on. Stable - never reuse an id for a
                  different meaning, or old sessions will answer the wrong
                  question.
     label        the value stored on the complaint, and what the customer
                  reads in a summary.
     short        the caption WhatsApp actually shows. Reply buttons allow 20
                  characters and list rows 24, and three of our labels are
                  longer than that, so they get a shortened caption here and
                  the full text moves into `description`.

   Anything without a `short` uses its label, because it already fits.
   -------------------------------------------------------------------------- */

/** Builds an option list from plain strings, for the sets that all fit. */
function options(...labels) {
  return labels.map(function (label) {
    return { id: slug(label), label: label };
  });
}

/** 'Fiber Cut / Cable Damage' -> 'fiber_cut_cable_damage' */
function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/* The complaint categories come from services/complaintCategories.js, which
   mirrors iCRM's "Select Reason" list. Adding one there adds it here, to the
   validator, and to the WhatsApp menu at the same time. */
const CATEGORY_OPTIONS = categories.OPTIONS;


const CONFIRM_OPTIONS = [
  { id: 'submit',  label: 'Yes, submit' },
  { id: 'restart', label: 'No, start over' }
];

const CLOSING_OPTIONS = [
  { id: 'another', label: 'Register another complaint', short: 'New complaint' },  // label is 26
  { id: 'agent',   label: 'Talk to an agent' },
  { id: 'done',    label: 'No, that is all' }
];

/* Which categories get the troubleshooting questions, which get a visit, and
   what we promise for each - all read from the same table, so a new category
   only has to be described once. */

/* --------------------------------------------------------------------------
   Reply builders
   -------------------------------------------------------------------------- */

function text(body) {
  return { kind: 'text', text: body };
}

function choice(body, list) {
  return { kind: 'choice', text: body, options: list };
}

/* --------------------------------------------------------------------------
   Validators
   -------------------------------------------------------------------------- */

/** Digits only, 10 to 15 of them - the same rule complaintService applies. */
function validPhone(value) {
  return /^[0-9]{10,15}$/.test(value)
    ? null
    : 'Please send a valid number: digits only, 10 to 15 digits.';
}

/** Builds a "must be at least N characters" check. */
function minLength(count, message) {
  return function (value) {
    return value.length >= count ? null : message;
  };
}

/* --------------------------------------------------------------------------
   Conditions

   Each answers: given what we know so far, is this question worth asking?
   Everything the skip logic does is expressed here.
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   The question table

   Fields on each entry:
     id        stable name, also what `session.stepId` holds between messages
     when      optional - the question is skipped when this returns false
     ask       the prompt, as a string or a function of the session
     type      'text' (typed reply) or 'choice' (tap an option, or type it)
     options   for 'choice': the option list, or a function returning one
     optional  for 'text': "skip" is accepted and stores an empty answer
     max       for 'text': the character limit complaintService also enforces
     check     for 'text': returns an error message, or null when valid
     store     writes the answer onto session.formData
     after     optional async hook returning extra replies to send before the
               next question
   -------------------------------------------------------------------------- */

const QUESTIONS = [

  /* --- Who is complaining --------------------------------------------------
     Nothing is asked here on WhatsApp: the webhook already carries the
     customer's number, and that is all the CRM needs to find the account.
     ---------------------------------------------------------------------- */

  {
    /* Only for channels that do not identify the customer for us. WhatsApp
       always does, so this never fires there. */
    id: 'REFERENCE',
    when: function (session) { return !session.formData.mobile; },
    ask: 'Please send your registered mobile number.',
    type: 'text',
    max: 40,
    check: validPhone,
    store: function (value, session) { session.formData.mobile = value; }
  },

  {
    /* One number can hold several connections, and a case belongs to exactly
       one of them, so the customer picks rather than the bot guessing.

       Skipped when there is one connection (nothing to choose), none, or when
       the CRM is not wired up yet - in all three cases the conversation just
       carries on. */
    id: 'CONNECTION_PICK',
    when: function (session) {
      return Array.isArray(session.subscribers) && session.subscribers.length > 1;
    },
    ask: 'You have more than one connection on this number.\nWhich one is this complaint about?',
    type: 'choice',
    options: function (session) {
      // WhatsApp lists cap at 10 rows; beyond that the extras would be dropped
      // silently, so the cap is applied here where it can be seen
      return session.subscribers.slice(0, 10).map(function (subscriber, index) {
        const detail = [subscriber.plan, subscriber.status].filter(Boolean).join(' - ');
        return {
          id: 'conn_' + index,
          label: subscriber.userId,
          description: detail || subscriber.name || undefined
        };
      });
    },
    store: function (value, session) {
      session.formData.customerId = value;

      const chosen = session.subscribers.find(function (s) { return s.userId === value; });
      if (chosen && chosen.name) { session.formData.name = chosen.name; }
      if (chosen && chosen.plan) { session.formData.planAccount = chosen.plan; }
    }
  },

  {
    /* Asked only when nothing else has identified the account, so it
       disappears by itself the moment the CRM's lookupSubscribers() starts
       returning connections. Until then it is the only thing standing between
       the support desk and a complaint they cannot attach to an account.

       Optional on purpose. The User ID is printed on the bill and most
       customers can produce one, but somebody whose line is dead may have no
       way to look it up, and turning their complaint away over a reference
       number would be the wrong trade. The mobile number reaches the desk
       either way, so a skipped answer still leaves a case worth acting on. */
    id: 'CUSTOMER_ID',
    when: function (session) { return !session.formData.customerId; },
    ask: 'Please enter your User ID, as printed on your bill.\n\n' +
         'If you do not have it to hand, reply SKIP and we will trace the ' +
         'account from your mobile number.',
    type: 'text',
    optional: true,
    max: 40,
    check: function (value) {
      return value.length >= 3
        ? null
        : 'That User ID looks too short. Please check your bill, or reply SKIP.';
    },
    store: function (value, session) {
      // '' is what an optional question stores when the customer skips
      if (value) { session.formData.customerId = value; }
    }
  },

  /* --- What is wrong ------------------------------------------------------ */

  {
    /* The categories mirror the portal's "Select Reason" list, so a complaint
       can be filed under a reason the CRM actually has. */
    id: 'CATEGORY',
    ask: 'What type of issue are you facing?',
    type: 'choice',
    options: CATEGORY_OPTIONS,
    store: function (value, session) { session.formData.complaintType = value; },
    after: async function (value) {
      return [text(categories.slaFor(value))];
    }
  },

  {
    id: 'DESCRIPTION',
    ask: 'Please describe the problem in 1-2 lines.',
    type: 'text',
    max: 1000,
    check: minLength(5, 'Please describe the problem in a little more detail (at least 5 characters).'),
    store: function (value, session) { session.formData.description = value; }
  }
];

/* The confirmation is not in the table: it is the terminal step, reached once
   the walk runs out of questions, and it either submits or starts over. */
const CONFIRM_STEP = 'CONFIRM';

/* Set after a complaint is registered. Replies are then handled by the
   closing menu rather than the question table. */
const CLOSING_STEP = 'CLOSING';

/* --------------------------------------------------------------------------
   Session shape
   -------------------------------------------------------------------------- */

/**
 * Builds an empty conversation.
 *
 * @param {Object} [seed]
 * @param {string} [seed.mobile] the number the channel already knows, if any.
 *                               Supplying it skips question 1 entirely.
 * @returns {Object} a fresh session
 */
function createSession(seed) {
  const known = (seed && seed.mobile) || '';

  return {
    stepId: null,
    subscribers: [],
    formData: {
      mobile: known, customerId: '', name: '', address: '',
      provider: '', planAccount: '', issueStart: '',
      complaintType: '', description: '',
      redLight: '', routerRestarted: '', devicesAffected: '', connectionMode: '',
      visitAvailable: '', visitDate: '', visitSlot: '', altContact: '',
      attachment: ''
    },
    awaitingMedia: false,
    updatedAt: Date.now()
  };
}

/* --------------------------------------------------------------------------
   Walking the table
   -------------------------------------------------------------------------- */

function questionById(stepId) {
  return QUESTIONS.find(function (question) { return question.id === stepId; }) || null;
}

/**
 * Finds the next question worth asking after the given one.
 * @param {string|null} afterId  null starts from the beginning
 * @param {Object} session
 * @returns {Object|null} the question, or null when the table is finished
 */
function nextQuestion(afterId, session) {
  const start = afterId === null
    ? 0
    : QUESTIONS.findIndex(function (q) { return q.id === afterId; }) + 1;

  for (let i = start; i < QUESTIONS.length; i++) {
    const question = QUESTIONS[i];
    if (!question.when || question.when(session)) {
      return question;
    }
  }
  return null;
}

/** Renders one question as a reply, and parks the session on it. */
function askQuestion(question, session) {
  session.stepId = question.id;

  const prompt = typeof question.ask === 'function' ? question.ask(session) : question.ask;

  if (question.type === 'choice') {
    const list = typeof question.options === 'function' ? question.options(session) : question.options;
    return choice(prompt, list);
  }
  return text(prompt);
}

/**
 * Moves past the current question and renders whatever comes next.
 * Running out of questions means it is time to confirm the summary.
 *
 * @param {Object} session
 * @returns {Array} replies
 */
function advance(session) {
  const question = nextQuestion(session.stepId, session);

  if (question) {
    return [askQuestion(question, session)];
  }

  session.stepId = CONFIRM_STEP;
  // The summary goes as its own message: an interactive body is capped at
  // 1024 characters and a long address plus description can exceed it
  return [
    text(buildSummaryText(session)),
    choice('Is this correct?', CONFIRM_OPTIONS)
  ];
}

/* --------------------------------------------------------------------------
   Matching what the customer sent to an option

   Taps arrive as an option id. Typing is just as common, so the label and the
   option's position in the list are accepted too.
   -------------------------------------------------------------------------- */

/**
 * @param {Array}  list     the options currently on offer
 * @param {Object} incoming { text, optionId }
 * @returns {Object|null} the matched option
 */
function matchOption(list, incoming) {
  if (incoming.optionId) {
    const tapped = list.find(function (option) { return option.id === incoming.optionId; });
    if (tapped) { return tapped; }
  }

  const needle = String(incoming.text || '').trim().toLowerCase();
  if (!needle) { return null; }

  const byLabel = list.find(function (option) {
    return option.label.toLowerCase() === needle ||
           (option.short || '').toLowerCase() === needle;
  });
  if (byLabel) { return byLabel; }

  if (/^[0-9]+$/.test(needle)) {
    const position = parseInt(needle, 10) - 1;
    if (position >= 0 && position < list.length) {
      return list[position];
    }
  }

  return null;
}

/* --------------------------------------------------------------------------
   The account lookup behind question 1
   -------------------------------------------------------------------------- */

/* --------------------------------------------------------------------------
   Summary
   -------------------------------------------------------------------------- */

/** Builds the confirmation summary, leaving out anything that was skipped. */
function buildSummaryText(session) {
  const data = session.formData;
  const lines = ['Complaint Summary', ''];

  /** Adds one row, but only when there is an answer to show. */
  function row(label, value) {
    if (value) { lines.push(label + ': ' + value); }
  }

  row('Mobile Number', data.mobile);
  row('Customer ID', data.customerId);
  row('Customer Name', data.name);
  row('Service Address', data.address);
  row('Provider', data.provider);
  row('Plan / Account', data.planAccount);
  row('Issue Started', data.issueStart);
  row('Complaint Type', data.complaintType);
  row('Problem Description', data.description);
  row('Red Light', data.redLight);
  row('Router Restarted', data.routerRestarted);
  row('Devices Affected', data.devicesAffected);
  row('Connection In Use', data.connectionMode);
  row('Someone Available', data.visitAvailable);
  row('Preferred Date', data.visitDate);
  row('Preferred Slot', data.visitSlot);
  row('Alternate Contact', data.altContact);
  row('Attachment', data.attachment);

  return lines.join('\n');
}

/* --------------------------------------------------------------------------
   Submission
   -------------------------------------------------------------------------- */

/**
 * Saves the complaint and produces the closing messages.
 * A failed save must not lose twenty answers, so the session stays parked on
 * the confirmation and the customer is offered a retry.
 *
 * @param {Object} session
 * @returns {Promise<Array>} replies
 */
async function submit(session) {
  const invalid = complaintService.validateComplaint(session.formData);

  if (invalid) {
    // The engine and complaintService disagree about what is valid. That is a
    // bug rather than a customer mistake, so say so plainly and log the detail.
    console.error('[engine] refused by validation: ' + invalid);
    return [
      text('Sorry, something went wrong with your complaint. Please reply RESTART to try again.'),
      text('If it keeps happening, reply 9 to talk to a support agent.')
    ];
  }

  let complaint;
  try {
    complaint = await complaintService.createComplaint(session.formData);
  } catch (error) {
    console.error('[engine] could not save complaint: ' + error.message);
    return [
      text('Sorry, we could not register your complaint right now.'),
      choice('Would you like to try again?', [
        { id: 'submit',  label: 'Try again' },
        { id: 'restart', label: 'Start over' }
      ])
    ];
  }

  /* Hand it to the CRM. A CRM outage must never turn a complaint that IS
     saved into an error for the customer, so every outcome here is logged
     rather than shown - the complaint is on disk either way. */
  let ticket = '';
  try {
    const crmResult = await crmService.sendToCRM(complaint);
    if (crmResult.success) {
      ticket = crmResult.ticket || '';
    } else {
      console.log('[engine] CRM not updated for ' + complaint.complaintId + ': ' + crmResult.message);
    }
  } catch (error) {
    console.error('[engine] CRM call failed for ' + complaint.complaintId + ': ' + error.message);
  }

  session.stepId = CLOSING_STEP;
  session.lastComplaintId = complaint.complaintId;

  return [
    text('Your complaint has been registered successfully.\n' +
         /* The CRM's own ticket number when it gave us one, so the customer
            and the support desk quote the same reference. Falls back to our
            id, which is still unique and still findable. */
         (ticket ? 'Ticket Number: ' + ticket : 'Complaint ID: ' + complaint.complaintId)),
    text('You will receive updates on ' + complaint.mobile + ' as your complaint progresses.'),
    text(categories.slaFor(complaint.complaintType) +
         '\nIf it is not resolved within 48 hours, reply 9 to talk to a support agent.'),
    choice('Is there anything else we can help you with?', CLOSING_OPTIONS)
  ];
}

/* --------------------------------------------------------------------------
   The public entry points
   -------------------------------------------------------------------------- */

/**
 * Asks the CRM which connections sit on this number.
 *
 * Populates session.subscribers, which the CONNECTION_PICK question above
 * reads. One result is adopted silently; several make the customer choose;
 * none - including a CRM that is not configured, or is down - simply means the
 * complaint is taken without a connection attached.
 *
 * Never throws, and never delays the greeting by more than the lookup's own
 * short timeout. An earlier version of this waited on a portal that took 90
 * seconds, and the customer sat looking at an empty chat before the bot said
 * anything. That must not happen again.
 *
 * @param {Object} session
 * @param {string} mobile
 */
async function attachSubscribers(session, mobile) {
  session.subscribers = [];

  if (!mobile || !crmService.isConfigured()) { return; }

  try {
    const result = await crmService.lookupSubscribers(mobile);

    if (!result || !result.ok) {
      console.log('[engine] CRM lookup unavailable, continuing: ' +
        ((result && result.error) || 'no reason given'));
      return;
    }

    session.subscribers = result.subscribers || [];

    // Exactly one connection - nothing worth asking about
    if (session.subscribers.length === 1) {
      const only = session.subscribers[0];
      session.formData.customerId = only.userId;
      if (only.name) { session.formData.name = only.name; }
      if (only.plan) { session.formData.planAccount = only.plan; }
    }
  } catch (error) {
    // crmService is written not to throw; this is belt and braces
    console.error('[engine] CRM lookup failed: ' + error.message);
  }
}

/**
 * Opens a conversation: the welcome, then the first applicable question.
 *
 * @param {Object} [seed] see createSession
 * @returns {Promise<Object>} { session, replies }
 */
async function start(seed) {
  const session = createSession(seed);

  await attachSubscribers(session, session.formData.mobile);

  const replies = [
    text('Welcome to FTTH Support. I will help you register your complaint.'),
    text('This takes about a minute. Tap the options or type your answers.')
  ].concat(advance(session));

  return { session, replies };
}

/**
 * Handles one incoming message.
 *
 * @param {Object} session  the state from last time
 * @param {Object} incoming { text, optionId, media }
 *                          `media` is { filename } when the customer sent a
 *                          photo or video the caller has already stored.
 * @returns {Promise<Object>} { session, replies }
 */
async function handleIncoming(session, incoming) {
  const message = incoming || {};
  const body = String(message.text || '').trim();

  session.updatedAt = Date.now();

  /* --- Global shortcuts, available at any point ------------------------- */

  if (/^restart$/i.test(body)) {
    const fresh = await start({ mobile: session.formData.mobile });
    return { session: fresh.session, replies: [text('Starting again.')].concat(fresh.replies) };
  }

  if (body === '9') {
    return { session, replies: [agentHandoff()] };
  }

  /* --- Waiting for a photo or video (kept: a customer may still send one) -- */

  if (session.awaitingMedia) {
    if (message.media && message.media.filename) {
      session.formData.attachment = String(message.media.filename).slice(0, 120);
      session.awaitingMedia = false;
      return {
        session,
        replies: [text('Got it, thank you.')].concat(advance(session))
      };
    }

    if (/^(skip|no|none|-)$/i.test(body)) {
      session.awaitingMedia = false;
      return {
        session,
        replies: [text('No problem, continuing without an attachment.')].concat(advance(session))
      };
    }

    return {
      session,
      replies: [text('Please send the photo or video as an attachment, or reply SKIP to continue.')]
    };
  }

  /* --- The closing menu -------------------------------------------------- */

  if (session.stepId === CLOSING_STEP) {
    const picked = matchOption(CLOSING_OPTIONS, message);

    if (picked && picked.id === 'another') {
      const fresh = await start({ mobile: session.formData.mobile });
      return {
        session: fresh.session,
        replies: [text('Sure, let us register another complaint.')].concat(fresh.replies)
      };
    }
    if (picked && picked.id === 'agent') {
      return { session, replies: [agentHandoff()] };
    }
    if (picked && picked.id === 'done') {
      return {
        session,
        replies: [text('Thank you for contacting FTTH Support. Have a good day.')]
      };
    }

    return {
      session,
      replies: [choice(
        'Please choose one of these, or reply 9 to talk to an agent.',
        CLOSING_OPTIONS
      )]
    };
  }

  /* --- The confirmation -------------------------------------------------- */

  if (session.stepId === CONFIRM_STEP) {
    const picked = matchOption(CONFIRM_OPTIONS, message);

    if (picked && picked.id === 'submit') {
      return { session, replies: await submit(session) };
    }
    if (picked && picked.id === 'restart') {
      const fresh = await start({ mobile: session.formData.mobile });
      return {
        session: fresh.session,
        replies: [text('No problem, let us start again.')].concat(fresh.replies)
      };
    }

    return {
      session,
      replies: [choice('Please confirm before I register this.', CONFIRM_OPTIONS)]
    };
  }

  /* --- A normal question ------------------------------------------------- */

  const question = questionById(session.stepId);

  if (!question) {
    // No conversation in progress - a first message, or a session that expired
    const fresh = await start({ mobile: session.formData.mobile });
    return fresh;
  }

  if (question.type === 'choice') {
    const list = typeof question.options === 'function' ? question.options(session) : question.options;
    const picked = matchOption(list, message);

    if (!picked) {
      return {
        session,
        replies: [choice('Please choose one of these options.', list)]
      };
    }

    return { session, replies: await acceptAnswer(question, picked.label, session) };
  }

  /* Text questions */

  if (question.optional && /^(skip|no|none|-)$/i.test(body)) {
    return { session, replies: await acceptAnswer(question, '', session) };
  }

  if (!body) {
    return { session, replies: [askQuestion(question, session)] };
  }

  // complaintService caps every text field. Catching it here turns a generic
  // failure at the end into an answerable question now.
  if (question.max && body.length > question.max) {
    return {
      session,
      replies: [text('That is a bit long - please keep it under ' + question.max + ' characters.')]
    };
  }

  const error = question.check ? question.check(body) : null;
  if (error) {
    return { session, replies: [text(error)] };
  }

  return { session, replies: await acceptAnswer(question, body, session) };
}

/** Stores a valid answer, runs any hook, and asks the next question. */
async function acceptAnswer(question, value, session) {
  question.store(value, session);

  const extra = question.after ? await question.after(value, session) : [];

  // A question whose hook opened a media window must not also move on - the
  // conversation now waits for the photo instead.
  if (session.awaitingMedia) {
    return extra;
  }

  return extra.concat(advance(session));
}

function agentHandoff() {
  return text(
    'Connecting you to a support agent. Someone will reply on this chat shortly.\n' +
    'Our helpline is also open from 9 AM to 9 PM.'
  );
}

module.exports = {
  start,
  handleIncoming,
  createSession,
  buildSummaryText,
  QUESTIONS,
  CATEGORY_OPTIONS,
  CONFIRM_OPTIONS,
  CLOSING_OPTIONS
};
