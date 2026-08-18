/* ==========================================================================
   paths.js

   Where the app keeps its files - in one place, because it has to move.

   Locally, everything lives in the project's own data/ folder, which is
   convenient and keeps a fresh clone working with no configuration.

   On cPanel or any normal server this default is correct and needs no
   setting: the folder lives beside the code and survives restarts.

   It only needs overriding on hosts with an EPHEMERAL filesystem - Render,
   Heroku and similar rebuild the container from the repo on every deploy, so
   anything written next to the code is deleted with it, silently. There, point
   DATA_DIR at a mounted volume:

     DATA_DIR=/var/data
   ========================================================================== */

const path = require('path');

/* Falls back to the project's data/ folder, so a fresh clone needs no setup */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

module.exports = {
  DATA_DIR: DATA_DIR,

  /** The complaint "database" - a plain JSON array */
  COMPLAINTS_FILE: path.join(DATA_DIR, 'complaints.json'),

  /** Half-finished conversations, so a restart does not lose them */
  SESSIONS_FILE: path.join(DATA_DIR, 'sessions.json'),

  /** Optional account directory, until a real CRM is connected */
  CUSTOMERS_FILE: path.join(DATA_DIR, 'customers.json'),

  /** Photos and videos customers send. Never served over HTTP. */
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads')
};
