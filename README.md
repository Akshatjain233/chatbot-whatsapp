# FTTH Support Assistant — WhatsApp complaint bot

A complaint-registration bot for an FTTH (fiber broadband) provider. A customer
messages the support number on WhatsApp, the bot works through a registration
flow — who they are, which connection, what is wrong, what they have already
tried, when a technician can visit — and files a complaint with a reference ID
like `FTX-2026-1234`.

**WhatsApp is the only channel.** There is no web page and no frontend: the
conversation lives entirely on the server, so the same code answers every
customer.

---

## Try it right now, with no WhatsApp account

```bash
npm install
npm run simulate
```

That runs the real conversation engine in your terminal. Nothing is sent
anywhere — with no API token the bot works out each reply and logs it instead
of delivering it (**mock mode**).

Useful commands inside the simulator:

| Command | Does |
|---|---|
| `/preview` | shows how the current question renders on WhatsApp — buttons or a list menu |
| `/state` | dumps the conversation state as JSON |
| `/media` | pretends you sent a photo |
| `/quit` | stop |

It is scriptable too, which is handy for demos:

```bash
printf 'Test User\nHouse 1, Model Town\n1\nskip\n1\n5\nCharged twice\n2\n1\n' | npm run simulate
```

---

## The question flow

The bot never asks every question. Each one carries a condition, and the engine
skips any that does not apply — a billing query is six questions, a fibre cut
is thirteen.

| # | Question | Asked when |
|---|----------|-----------|
| 1 | Registered mobile number or customer ID | never on WhatsApp — see below |
| 2 | Confirm the name on the account | the number matched an account |
| 3 | Full name | no account matched |
| 4 | Service address with landmark | no account matched |
| 5 | Internet provider | no account matched |
| 6 | Plan / account number *(optional)* | no account matched |
| 7 | When the issue started | always |
| 8 | Complaint category (9 options) | always |
| 9 | Describe the problem | always |
| 10 | Red light on the ONT / router? | technical faults only |
| 11 | Restarted the router? | technical faults only |
| 12 | All devices, or one? | technical faults only |
| 13 | WiFi or LAN cable? | technical faults only |
| 14 | Someone available for a visit? | anything but a billing issue |
| 15 | Preferred visit date | someone is available |
| 16 | Preferred time slot | someone is available |
| 17 | Alternate contact *(optional)* | anything but a billing issue |
| 18 | Send a photo or video? | always |
| — | Confirm the summary before submitting | always |

"Technical faults" means `No Internet`, `Slow Speed`, `Frequent Disconnection`
and `WiFi Router Issue`. The same conditions are re-checked before saving, so a
complaint can never carry answers its category was never asked.

**Question 1 never appears on WhatsApp.** The webhook already tells us the
customer's number, so asking them to type it would be asking for something we
have. It is looked up automatically instead. One detail this depends on:
WhatsApp reports `919876543210` while an Indian ISP's records hold
`9876543210`, so the last ten digits are matched.

Every menu also accepts a **typed** answer — the option text, or its number in
the list. Customers type instead of tapping constantly.

At any point: **`RESTART`** starts over, **`9`** reaches a human. The `9`
promise stays true after the complaint is filed, too.

---

## How it fits together

```
WhatsApp  ──POST──▶  routes/webhook.js
                          │  verify signature, drop replays, park status callbacks
                          ▼
                     services/sessionStore.js      ← where this customer got to
                          │
                          ▼
                     services/conversationEngine.js ← the 18 questions
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
   services/complaintService.js   services/whatsappService.js
        (validate + store)          (render + send the replies)
```

The engine knows nothing about HTTP or WhatsApp. It takes the state of one
conversation plus the message that just arrived, and returns the state
afterwards plus a list of replies to deliver. That is what lets the whole
eighteen-question flow be tested in about a millisecond, and what lets
`npm run simulate` reuse it unchanged.

### Project structure

```
chatbot whatsapp/
├── routes/
│   ├── webhook.js           WhatsApp: verification, signatures, incoming messages
│   ├── complaints.js        admin API, behind ADMIN_API_KEY
│   └── health.js            GET /health
├── services/
│   ├── conversationEngine.js  the question table and all the skip logic
│   ├── sessionStore.js        who is on which question
│   ├── whatsappService.js     Cloud API sends + media downloads
│   ├── complaintService.js    validation and storage
│   ├── crmService.js          account lookup + CRM push (placeholder)
│   └── paths.js               where data files live (see DATA_DIR)
├── scripts/
│   └── simulate.js          the bot, in your terminal
├── data/                    never served over HTTP
│   ├── complaints.json      the "database" — a plain JSON array
│   ├── sessions.json        conversations in progress
│   ├── uploads/             photos and videos customers sent
│   └── customers.example.json  sample accounts, safe to commit
├── test/
│   ├── engine.test.js       the conversation, every branch
│   ├── whatsapp.test.js     handshake, signatures, replays, payload limits
│   └── api.test.js          storage and the admin API
├── render.yaml              Render deployment blueprint
├── .env.example             every variable, and what breaks without it
└── server.js                wiring only
```

---

## WhatsApp's limits, and why the code looks like it does

WhatsApp has no free-form menus. A question with options must be either **reply
buttons** (max 3, titles ≤ 20 chars) or a **list** (max 10 rows, titles ≤ 24
chars). Exceeding any of these is a `400` from Meta, not a truncated message.

So three questions render as lists, and three labels are too long to show in
full:

| Question | Options | Renders as | Note |
|---|---|---|---|
| Provider | 5 | list | |
| Category | 9 | list | `New Connection / Installation Pending` is 37 chars → shown as `New Connection` |
| Devices affected | 4 | list | |
| Account confirm | 2 | buttons | `No, use other details` is 21 → shown as `No, not me` |
| Closing menu | 3 | buttons | `Register another complaint` is 26 → shown as `New complaint` |
| Everything else | 2–3 | buttons | |

Each option carries the shortened caption *and* its full label; the full one is
what gets stored on the complaint. A test fails if any caption ever exceeds the
limit, so adding a question cannot quietly break this.

The summary is sent as a **plain text message followed by a separate button
message**, because an interactive body caps at 1024 characters and a long
address plus description can exceed that.

---

## Setting up WhatsApp

You need a Meta Business account. Work through these in order — step 7 takes
days to weeks, so start it early.

1. **Meta Business account** — business.facebook.com.
2. **Developer app** — developers.facebook.com → Create App → type *Business* →
   add the **WhatsApp** product.
3. **Test phone number** — Meta gives you one free, immediately. It can message
   up to **5 numbers you nominate**. Add your own phone. This is enough to
   build and test everything.
4. **Phone number ID** — WhatsApp → API Setup. It is the long numeric ID next
   to the number, *not* the number itself. This is `WHATSAPP_PHONE_ID`.
5. **Access token** — the one on the dashboard expires in 24 hours. For
   anything real, create a **System User** (Business Settings → Users → System
   Users), assign it the app, and generate a token with
   `whatsapp_business_messaging` and `whatsapp_business_management`. That one
   does not expire. This is `WHATSAPP_API_TOKEN`.
6. **App Secret** — App Settings → Basic. This is `WHATSAPP_APP_SECRET`.
7. **Business verification** — required before you can message anyone beyond
   your 5 test numbers. Meta asks for business registration documents.
8. **A real business number** — must not already be registered on WhatsApp. If
   the ISP's support number is on the WhatsApp Business app today, it has to be
   migrated or you use a fresh SIM.

### Registering the webhook

Once the server is deployed (below), go to **WhatsApp → Configuration → Edit**:

- **Callback URL**: `https://<your-app>.onrender.com/webhook/whatsapp`
- **Verify token**: the same string you set as `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the **`messages`** field — without it, nothing is ever sent to
  you

Meta immediately sends a `GET` to that URL and expects the raw `hub.challenge`
value echoed back. If the token does not match, it refuses to save the webhook
and the dashboard error does not explain why. Test it yourself first:

```bash
curl "https://<your-app>.onrender.com/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=YOUR_TOKEN&hub.challenge=42"
# must print exactly:  42
```

---

## Deploying to Render

`render.yaml` is a blueprint — in Render, **New +** → **Blueprint**, point it at
this repository, and everything except the secrets is configured for you. Fill
in the five prompted values (`WHATSAPP_*` and `ADMIN_API_KEY`).

**Two things about Render that will cost you data if ignored:**

1. **The filesystem is ephemeral.** It is rebuilt from the repo on every
   deploy, so anything written next to the code is deleted with it — silently,
   with no error. `render.yaml` therefore mounts a 1 GB persistent disk at
   `/var/data` and sets `DATA_DIR=/var/data`, which is what
   [services/paths.js](services/paths.js) reads. **Persistent disks require a
   paid instance type**; the free plan has none, so complaints filed there are
   disposable.

2. **Free services sleep after 15 minutes idle** and take roughly a minute to
   wake. A customer messaging at 11pm waits a minute for the first reply, and
   Meta retries the message meanwhile. The starter plan (~$7/month) has neither
   problem, which is why the blueprint specifies it.

If you want to try the free plan first, delete the `disk:` block and set
`plan: free` — but treat anything filed there as throwaway.

### When to move off JSON files

`data/complaints.json` on a persistent disk is fine for a single instance and
an ISP's complaint volume. It stops being fine when you want more than one
instance, or reporting queries. At that point only
[services/complaintService.js](services/complaintService.js) changes — nothing
else touches storage.

---

## Configuration

Copy `.env.example` to `.env` and fill it in. Every variable is documented
there, including what breaks when it is missing. The short version:

| Variable | Without it |
|---|---|
| `WHATSAPP_API_TOKEN` + `WHATSAPP_PHONE_ID` | **mock mode** — replies are logged, not sent |
| `WHATSAPP_VERIFY_TOKEN` | Meta cannot verify the webhook, so it refuses to save it |
| `WHATSAPP_APP_SECRET` | unsigned webhooks are accepted — anyone who finds the URL can file complaints as any number |
| `ADMIN_API_KEY` | `/api/complaints` returns `503` rather than defaulting to open |
| `DATA_DIR` | data files live in the project folder — wrong on any PaaS |

`GET /health` tells you which mode you are in:

```json
{ "status": "ok", "whatsapp": "mock", "sessions": 3 }
```

If the bot is not replying, check that first — `"whatsapp": "mock"` means it is
working correctly and deliberately not sending.

---

## Routes

| Method | URL | Purpose | Auth |
|--------|-----|---------|------|
| GET | `/webhook/whatsapp` | Meta's verification handshake | verify token |
| POST | `/webhook/whatsapp` | incoming customer messages | signature |
| GET | `/health` | liveness + whether WhatsApp is connected | none |
| GET | `/api/complaints` | all complaints, newest first | `X-Api-Key` |
| GET | `/api/complaints?mobile=…` | one customer's complaints | `X-Api-Key` |
| GET | `/api/complaints/:id` | one complaint by reference ID | `X-Api-Key` |
| POST | `/api/complaints` | file a complaint directly | `X-Api-Key` |

The complaint routes return customer names, phone numbers and home addresses.
Nothing in the WhatsApp flow uses them — the bot writes through the service
directly — so they exist for an admin view or the client's CRM. They **fail
closed**: with no `ADMIN_API_KEY` set they refuse to answer at all, so a deploy
where someone forgot the variable returns `503` instead of quietly publishing
the customer database.

### Complaint fields

Required: `mobile`, `name`, `address`, `provider`, `issueStart`,
`complaintType`, `description`. Everything else may be empty.

| Field | Allowed values |
|-------|----------------|
| `complaintType` | `No Internet`, `Slow Speed`, `Frequent Disconnection`, `New Connection / Installation Pending`, `Billing Issue`, `Shifting / Relocation`, `Fiber Cut / Cable Damage`, `WiFi Router Issue`, `Others` |
| `redLight`, `routerRestarted`, `visitAvailable` | `Yes`, `No` |
| `devicesAffected` | `All devices`, `Phone`, `Laptop`, `TV` |
| `connectionMode` | `WiFi`, `LAN cable`, `Both` |
| `visitSlot` | `Morning`, `Afternoon`, `Evening` |

`complaintId`, `status` and `createdAt` are added by the server.

---

## Recognising customers, and the CRM

The bot looks the customer up by phone number. On a match, questions 3–6
collapse into a single "is this you?" confirmation.

There is no CRM connected yet, so the lookup reads an optional
`data/customers.json`. To try it:

```bash
cp data/customers.example.json data/customers.json
```

Then message the bot from `9876543210` (or answer with `LDH-100234`). Without
that file the lookup finds nothing and the bot asks for the details instead —
which is the normal, tested path.

When the client's CRM arrives, only
[services/crmService.js](services/crmService.js) changes: `lookupCustomer()`
for the recognition, `sendToCRM()` for pushing tickets across. The conversation
needs no changes at all.

---

## Testing

```bash
npm test
```

98 tests, no network access, nothing sent to Meta. Three files:

- **`engine.test.js`** — the conversation itself: every category, the skip
  logic, typed vs tapped answers, validation, attachments, restart, the closing
  menu. Also asserts that the engine's categories and the validator's list
  cannot drift apart.
- **`whatsapp.test.js`** — the verification handshake, signature rejection,
  payload shapes against WhatsApp's limits, and **replay handling**: a resent
  confirmation must not file a second complaint.
- **`api.test.js`** — storage, validation, concurrency, corrupt-file recovery,
  and that the admin routes refuse unauthenticated requests.

---

## Known gaps

- **Proactive updates need a template.** WhatsApp only allows free-form
  messages within 24 hours of the customer's last message. Everything the bot
  does is a reply, so it is fine — but "your technician is on the way", sent
  the next morning, needs a template approved in Business Manager first.
  `sendTemplateMessage()` is written and ready for one.
- **No admin UI.** Complaints are readable over the API with a key; there is no
  screen.
- **Single instance only.** Sessions live in memory (mirrored to disk), so
  running two copies behind a load balancer would split conversations across
  them. Moving sessions to Redis is the fix if that day comes.
