/* ==========================================================================
   complaintCategories.js

   The complaint categories, in one place, mirroring what the CRM offers.

   WHY THIS FILE EXISTS
   --------------------
   Every complaint the bot files becomes a Case in the client's CRM. Its
   "Select Reason" dropdown is a fixed list, so if the bot offers a category
   the CRM has never heard of, the Case arrives mislabelled - a billing query
   tagged "Speed Issue", or blank. The categories below therefore match the
   portal exactly.

   TO ADD A CATEGORY
   -----------------
   Add the reason in the CRM first, then add a row here. Nothing else needs changing: the conversation,
   the validator, the WhatsApp menu and the SLA replies are all built from this
   table. A test fails if the bot and the validator ever disagree.

   FIELDS
   ------
     id          what comes back when the customer taps it on WhatsApp.
                 Stable - never reuse an id for a different meaning, or a
                 session in progress will answer the wrong question.
     label       stored on the complaint, and shown in summaries.
     short       optional - the caption WhatsApp shows when `label` is too
                 long. Reply buttons allow 20 characters, list rows 24.
     crmReason   the exact "Select Reason" text in the CRM.
     crmReasonId the numeric option value the CRM expects for that reason.
                 This is what actually gets sent - the text is only for humans
                 reading this file.
     crmType     the exact "Problem" dropdown text in the CRM. That dropdown is
                 the case TYPE: Problem, Feedback, Question or Request.
     crmTypeId   the numeric option value the CRM expects for the type.
     technical   true -> ask the four troubleshooting questions
     visit       true -> ask about a technician visit
     sla         quoted back to the customer as soon as they choose
   ========================================================================== */

/* These are the CRM's own option values. If it is ever reconfigured they can
   change, and a mismatch shows up as a Case filed under the wrong reason
   rather than as an error - so they are worth re-checking after an upgrade. */
const CATEGORIES = [
  {
    id: 'speed_issue',
    label: 'Speed Issue',
    crmReason: 'Speed Issue',
    crmReasonId: '10192',
    crmType: 'Problem',
    crmTypeId: '331',
    technical: true,
    visit: true,
    sla: 'A technician will be assigned within 24 hours.'
  },
  {
    id: 'red_light',
    label: 'Red Light Coming',
    crmReason: 'Red Light Coming',
    crmReasonId: '10217',
    crmType: 'Problem',
    crmTypeId: '331',
    technical: true,
    visit: true,
    sla: 'Our field team will be assigned within 12 hours.'
  },
  {
    id: 'voice_not_working',
    label: 'Voice not Working',
    crmReason: 'Voice not Working',
    crmReasonId: '10220',
    crmType: 'Problem',
    crmTypeId: '331',
    technical: true,
    visit: true,
    sla: 'A technician will be assigned within 24 hours.'
  },
  {
    // An account change, not a fault - nothing to troubleshoot and nobody to
    // send, so both question blocks are skipped
    id: 'password_change',
    label: 'Password Change',
    crmReason: 'Password Change',
    crmReasonId: '10219',
    crmType: 'Request',
    crmTypeId: '334',
    technical: false,
    visit: false,
    sla: 'Our support team will process this within 24 hours.'
  }
];

/* --------------------------------------------------------------------------
   Everything below is derived, so there is only ever one list to edit
   -------------------------------------------------------------------------- */

/** Every category label the system accepts. */
const ALLOWED = CATEGORIES.map(function (c) { return c.label; });

/** Labels that get the four troubleshooting questions. */
const TROUBLESHOOTING = CATEGORIES
  .filter(function (c) { return c.technical; })
  .map(function (c) { return c.label; });

/** Labels that never produce a technician visit. */
const NO_VISIT = CATEGORIES
  .filter(function (c) { return !c.visit; })
  .map(function (c) { return c.label; });

/** label -> the whole row */
const BY_LABEL = {};
CATEGORIES.forEach(function (c) { BY_LABEL[c.label] = c; });

/**
 * The option list the conversation shows.
 * Only the fields the chat needs - the CRM mapping stays out of the menu.
 */
const OPTIONS = CATEGORIES.map(function (c) {
  const option = { id: c.id, label: c.label };
  if (c.short) { option.short = c.short; }
  return option;
});

/** Looks up one category by its stored label. */
function find(label) {
  return BY_LABEL[label] || null;
}

/** The service promise for a category, or a safe default. */
function slaFor(label) {
  const category = find(label);
  return category ? category.sla : 'Our support team will respond within 48 hours.';
}

/** True when this category gets the troubleshooting questions. */
function isTechnical(label) {
  return TROUBLESHOOTING.indexOf(label) !== -1;
}

/** True when this category can lead to a technician visit. */
function needsVisit(label) {
  return label !== '' && NO_VISIT.indexOf(label) === -1;
}

/**
 * How this category should be filed in the CRM.
 *
 * The ids are what the CRM expects; the names are returned too
 * so a log line can say "Speed Issue" rather than "10192".
 *
 * An unknown label falls back to the generic "Problem" type with no reason -
 * the CRM accepts that, and a Case with a blank reason is far better than one
 * that fails to file at all.
 *
 * @param {string} label
 * @returns {Object} { reasonId, reason, typeId, type }
 */
function crmMapping(label) {
  const category = find(label);

  if (!category) {
    return { reasonId: '0', reason: '', typeId: '331', type: 'Problem' };
  }

  return {
    reasonId: category.crmReasonId,
    reason: category.crmReason,
    typeId: category.crmTypeId,
    type: category.crmType
  };
}

module.exports = {
  CATEGORIES,
  ALLOWED,
  TROUBLESHOOTING,
  NO_VISIT,
  OPTIONS,
  find,
  slaFor,
  isTechnical,
  needsVisit,
  crmMapping
};
