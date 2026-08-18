# Complaint API

Our WhatsApp bot collects FTTH complaints from customers. This is how to pull
them into the CRM.

**Three calls. You only need the first two.**

---

## Setup

Every request needs this header:

    X-Api-Key: <the key we sent you separately>

Base URL:

    https://wa1.mishaelectronics.com

Test that your key works:

    curl -H "X-Api-Key: YOUR_KEY" https://wa1.mishaelectronics.com/api/complaints?limit=1

If you get `401`, the key is wrong or the header is missing.

---

## 1. Get new complaints

    GET /api/complaints?since=2026-08-18T09:00:00.000Z&limit=100

Returns a JSON array, newest first:

```json
[
  {
    "complaintId": "FTX-2026-1234",
    "mobile": "9876543210",
    "customerId": "ACC-100001",
    "complaintType": "Speed Issue",
    "description": "Internet very slow all day",
    "status": "Open",
    "createdAt": "2026-08-18T09:14:22.017Z"
  }
]
```

### Always use `since`

Without it you get **every complaint ever**, and you will create the same case
twice.

How to use it: remember the `createdAt` of the last complaint you imported,
and send it as `since` next time. It never returns the same complaint twice.

    First run:   GET /api/complaints?limit=100
    After that:  GET /api/complaints?since=<last createdAt you saw>

Poll every 2-5 minutes.

### About the fields

- **`complaintId`** — our reference. Save it, you need it for call 3.
- **`mobile`** — 10 digits, no country code.
- **`customerId`** — the User ID the complaint is filed against. The customer
  reads it off their bill, so it is usually there — **but it can be empty**,
  because someone with a dead line often cannot find their bill and we would
  rather take their complaint than turn it away. Please still accept those;
  the mobile number is always present, so they can be linked by hand.
- **`createdAt`** — send this back as `since`.

---

## 2. The complaint types

There are exactly four, matching the portal's reason list:

| complaintType | Reason id | Type id |
|---|---|---|
| Speed Issue | 10192 | 331 (Problem) |
| Red Light Coming | 10217 | 331 (Problem) |
| Voice not Working | 10220 | 331 (Problem) |
| Password Change | 10219 | 334 (Request) |

We read these ids from the portal during setup — please confirm they are still
correct.

Suggested case title, so the two systems can be matched up later:

    Speed Issue - FTX-2026-1234

Want a new complaint type? Tell us the reason and its id and we will add it to
the bot. It is one line for us.

---

## 3. Send the ticket number back

    POST /api/complaints/FTX-2026-1234/ticket
    Content-Type: application/json

    { "ticket": "TKT448" }

**Please do this.** The case is created in your portal after the WhatsApp
conversation has already finished. So the customer only knows our reference,
and your support desk only knows yours — and neither can find the other.

When you send it, we message the customer:

> Update on your complaint FTX-2026-1234.
> Your ticket number is TKT448. Please quote this if you contact support.

Now both sides have the same number.

You get back:

```json
{ "success": true, "notified": true }
```

`notified: false` means we could not message the customer — usually because
more than 24 hours have passed since they last wrote to us, which WhatsApp
does not allow. **The sooner you import, the more customers get their number.**
We still record it either way.

---

## Errors

| Code | Meaning |
|---|---|
| 401 | Key is missing or wrong |
| 404 | No complaint with that id |
| 500 | Our end failed — just retry |
| 503 | Our API is misconfigured — tell us, it is our problem |

All errors look like this:

```json
{ "success": false, "error": "Invalid or missing API key." }
```

If a poll fails, do nothing special — try again next cycle. `since` means you
will not miss or duplicate anything.

---

## Example importer

```js
let lastSeen = loadLastSeen();          // saved between runs, null on first run

const url = new URL('https://wa1.mishaelectronics.com/api/complaints');
url.searchParams.set('limit', '100');
if (lastSeen) url.searchParams.set('since', lastSeen);

const complaints = await (await fetch(url, {
  headers: { 'X-Api-Key': process.env.COMPLAINT_API_KEY }
})).json();

// Oldest first, so a crash halfway still leaves a correct high-water mark
for (const complaint of complaints.reverse()) {
  const ticket = await createCaseInCRM(complaint);

  await fetch(`https://wa1.mishaelectronics.com/api/complaints/${complaint.complaintId}/ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.COMPLAINT_API_KEY
    },
    body: JSON.stringify({ ticket })
  });

  lastSeen = complaint.createdAt;
  saveLastSeen(lastSeen);               // save as you go, not at the end
}
```

---

Anything unclear, or a field you need that is not here — just ask.
