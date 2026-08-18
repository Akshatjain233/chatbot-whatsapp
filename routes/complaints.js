/* ==========================================================================
   routes/complaints.js

   The HTTP layer for complaints. Mounted in server.js at /api/complaints,
   so the paths below are relative to that:

     GET    /            ->  GET  /api/complaints
     GET    /:id         ->  GET  /api/complaints/FTX-2026-1234
     POST   /            ->  POST /api/complaints

   This file does not know how complaints are stored. It only reads the
   request, calls complaintService, and picks the right status code.
   ========================================================================== */

const express = require('express');
const crypto = require('crypto');
const complaintService = require('../services/complaintService');
const whatsappService = require('../services/whatsappService');
const crmService = require('../services/crmService');

// A Router is a mini-app: routes are declared on it, then server.js mounts it
const router = express.Router();

/* --------------------------------------------------------------------------
   Access control

   These routes hand out customer names, phone numbers and home addresses. On
   a laptop that is harmless; on a public URL it is the customer database,
   downloadable by anyone who guesses /api/complaints.

   Nothing in the WhatsApp flow uses these routes - the bot writes through
   complaintService directly - so they exist for whatever reads complaints
   later: an admin view, or the client's CRM. Both can send a header.

   Fail closed: with no key configured the routes refuse to answer at all,
   rather than defaulting to open. A deploy where someone forgot to set the
   variable then returns 503, which is noticed, instead of quietly serving
   every complaint to the internet.
   -------------------------------------------------------------------------- */

router.use(function (req, res, next) {
  /* Two keys are accepted, and they are separate on purpose: yours, and the
     one handed to whoever imports complaints into the CRM. Theirs can be
     rotated or revoked without locking you out of your own service. */
  const accepted = [
    { name: 'admin',   value: process.env.ADMIN_API_KEY || '' },
    { name: 'partner', value: process.env.PARTNER_API_KEY || '' }
  ].filter(function (k) { return k.value; });

  if (accepted.length === 0) {
    console.error('[complaints] no API key is configured, so these routes are disabled');
    return res.status(503).json({
      success: false,
      error: 'This endpoint is not configured. Set ADMIN_API_KEY to enable it.'
    });
  }

  const supplied = req.get('X-Api-Key') || '';
  const given = crypto.createHash('sha256').update(supplied).digest();

  const matched = accepted.find(function (key) {
    // Constant-time compare, so a key cannot be guessed byte by byte. Hashing
    // first keeps the lengths equal, which timingSafeEqual requires.
    const expected = crypto.createHash('sha256').update(key.value).digest();
    return crypto.timingSafeEqual(given, expected);
  });

  if (!matched) {
    return res.status(401).json({ success: false, error: 'Invalid or missing API key.' });
  }

  req.apiClient = matched.name;
  return next();
});

/**
 * GET /api/complaints
 * Returns every complaint, newest first.
 * Optional query: ?mobile=9876543210 to filter to one customer.
 *
 * 200 -> a JSON array (possibly empty)
 * 500 -> the data file could not be read
 */
router.get('/', async function (req, res) {
  try {
    const complaints = await complaintService.getAllComplaints({
      mobile: req.query.mobile,
      // ?since= is what lets an importer poll for only what is new. Without
      // it every poll returns everything, and duplicate cases follow.
      since: req.query.since,
      limit: req.query.limit
    });

    return res.status(200).json(complaints);

  } catch (error) {
    console.error('Failed to read complaints:', error.message);
    return res.status(500).json({ success: false, error: 'Could not read the complaints.' });
  }
});

/**
 * POST /api/complaints
 * Validates the body, saves the complaint, returns the new complaint ID.
 *
 * 201 -> saved, { success: true, complaintId: 'FTX-2026-1234' }
 * 400 -> the body is invalid, nothing was saved
 * 500 -> the data file could not be written, nothing was saved
 */
router.post('/', async function (req, res) {
  // 1. Validate first, so nothing invalid ever reaches the file
  const errorMessage = complaintService.validateComplaint(req.body);
  if (errorMessage) {
    return res.status(400).json({ success: false, error: errorMessage });
  }

  try {
    // 2. Hand the valid body to the service, which saves it and gives us
    //    back the stored record (with its generated ID and timestamp)
    const complaint = await complaintService.createComplaint(req.body);

    console.log('Registered ' + complaint.complaintId + ' (' + complaint.complaintType + ')');

    // 3. Offer the complaint to the CRM. This is a placeholder today and
    //    always reports "not configured", so it changes nothing - but the
    //    call site is now in place for the real integration.
    //
    //    Note the try/catch: a CRM problem must never turn a complaint that
    //    IS saved on disk into an error for the customer.
    try {
      const crmResult = await crmService.sendToCRM(complaint);
      if (!crmResult.success) {
        console.log('CRM not updated for ' + complaint.complaintId + ': ' + crmResult.message);
      }
    } catch (crmError) {
      console.error('CRM call failed for ' + complaint.complaintId + ':', crmError.message);
    }

    // TODO (future phase): once WhatsApp is connected, this is where the
    // confirmation message goes out:
    //   await whatsappService.sendTemplateMessage(complaint.mobile,
    //     'complaint_registered', { id: complaint.complaintId });

    // 4. Reply with the generated ID
    return res.status(201).json({
      success: true,
      complaintId: complaint.complaintId
    });

  } catch (error) {
    // Nothing was saved. Say so rather than reporting a success the file
    // does not actually contain.
    console.error('Failed to save complaint:', error.message);
    return res.status(500).json({ success: false, error: 'Could not save the complaint.' });
  }
});

/**
 * GET /api/complaints/:id
 * Returns one complaint by its ID, for looking up a reference number.
 *
 * 200 -> the complaint
 * 404 -> no complaint with that ID
 * 500 -> the data file could not be read
 */
router.get('/:id', async function (req, res) {
  try {
    const complaint = await complaintService.getComplaintById(req.params.id);

    if (!complaint) {
      return res.status(404).json({ success: false, error: 'No complaint found with that ID.' });
    }

    return res.status(200).json(complaint);

  } catch (error) {
    console.error('Failed to read complaints:', error.message);
    return res.status(500).json({ success: false, error: 'Could not read the complaints.' });
  }
});

/**
 * POST /api/complaints/:id/ticket
 * Body: { "ticket": "TKT448" }
 *
 * Records the reference the client's CRM assigned, and tells the customer on
 * WhatsApp. The case is created in their portal after the conversation has
 * ended, so without this the customer only ever has our internal id and the
 * support desk only has theirs - and neither can find the other.
 *
 * 200 -> { success: true, notified: true|false }
 * 404 -> no complaint with that id
 */
router.post('/:id/ticket', async function (req, res) {
  const ticket = String((req.body && req.body.ticket) || '').trim();

  if (!ticket) {
    return res.status(400).json({ success: false, error: 'A ticket number is required.' });
  }

  try {
    const complaint = await complaintService.setTicketNumber(req.params.id, ticket);

    if (!complaint) {
      return res.status(404).json({ success: false, error: 'No complaint found with that ID.' });
    }

    console.log('[complaints] ' + complaint.complaintId + ' is ticket ' + ticket + ' in the CRM');

    /* Tell the customer. Best effort: the ticket number is recorded either
       way, and a failed WhatsApp send must not make the caller think their
       update was rejected. */
    let notified = false;
    try {
      const result = await whatsappService.sendTextMessage(
        complaint.mobile,
        'Update on your complaint ' + complaint.complaintId + '.' +
        String.fromCharCode(10) +
        'Your ticket number is ' + ticket + '. Please quote this if you contact support.'
      );
      notified = Boolean(result && result.success);
    } catch (error) {
      console.error('[complaints] could not notify ' + complaint.mobile + ': ' + error.message);
    }

    return res.status(200).json({ success: true, notified: notified });

  } catch (error) {
    console.error('Failed to record a ticket number:', error.message);
    return res.status(500).json({ success: false, error: 'Could not record the ticket number.' });
  }
});

module.exports = router;
