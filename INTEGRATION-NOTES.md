# Integration notes — running list

Everything discovered, decided, and still open. Updated as we go, so nothing
has to be remembered from chat history.

Last updated: 17 Aug 2026

---

## 1. Where things stand

| Piece | State |
|---|---|
| WhatsApp bot | **Done** — 84 tests passing |
| Deployed to Render | **Done** — https://chatbot-whatsapp-itsx.onrender.com |
| Meta webhook verified | **Done** |
| Bot replies | needs a permanent access token |
| CRM integration | **the client owns this** — see below |

---

## 2. The CRM integration — two functions to fill in

**The client owns this.** Everything that tried to drive the portal from here
is gone. What is left is one file, `services/crmService.js`, with two clearly
marked functions and nothing else to touch.

### Step 1 — set two variables

    CRM_API_URL=https://the-portal/api/v1
    CRM_API_KEY=...

### Step 2 — `lookupSubscribers(mobile)`

Returns the connections on a phone number. One number often holds several -
the account used in testing had six - and a case belongs to exactly one of
them. Return more than one and the bot asks the customer which, then files
against their answer.

    { ok: true, subscribers: [
        { userId: '0172-2273528', name: 'A Customer',
          plan: '100 Mbps', status: 'Active' }
    ]}

`userId` is required; `plan` and `status` are shown under each option so
the customer can tell their connections apart.

### Step 3 — `sendToCRM(complaint)`

Files the case. Return the portal's own ticket number and the bot quotes that
to the customer instead of its internal reference, so both sides of a support
call are saying the same thing:

    { success: true, ticket: 'TKT448' }

### Three rules

1. **Never throw.** Return `{ success: false, message }` instead.
2. **Be quick in the lookup.** It runs before the bot's first reply, so its
   cost is time the customer spends looking at an empty chat. It is bounded at
   4 seconds. An earlier version called a portal that took 90 seconds and the
   conversation looked broken.
3. **Assume it will fail sometimes.** It does not have to be perfect; the bot
   is built to carry on without it.

### What happens while it is unimplemented

Nothing breaks. The bot takes complaints, answers, and saves them to
`data/complaints.json`. It simply does not ask which connection, and quotes
its own reference. `test/crm-slot.test.js` holds 15 tests covering exactly
this - including a CRM that throws, returns nonsense, is slow, or is missing
entirely.

---

## 3. The conversation

Two answers from the customer, three when they have several connections:

1. **Which connection** — only when the CRM returns more than one
2. **Category** — the four the portal offers, as a WhatsApp list
3. **Description** — free text

Then a summary and a Yes/No. The mobile number comes from the webhook and is
never asked. `RESTART` starts over, `9` reaches an agent, at any point.

---

## 4. Still to do

- [ ] **Permanent WhatsApp token** — business.facebook.com → Business settings
      → Users → System users → Generate, expiration **Never**. Every token used
      so far has been a temporary one that expires in about two hours.
- [ ] **Change the CRM password** — it was shared over chat during setup.
- [ ] **Reset the Meta App Secret** — also shared in chat.
- [ ] **Delete the four FTX-TEST cases** created in the portal during setup.
- [ ] Client: implement the two functions above.
