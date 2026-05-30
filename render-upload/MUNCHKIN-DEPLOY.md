# Permanent Munchkin Mailbox

This makes the mailbox work like a real public link instead of a temporary tunnel.

## What I Set Up

- Local mode still works with `mailbox-data.json`.
- Permanent mode turns on when `DATABASE_URL` is added.
- Render can run the web page with `npm start`.
- Neon Postgres can store messages and email opt-ins so they survive restarts.

## Free Setup

1. Make a free Neon Postgres database.
2. Copy the pooled connection string. It usually starts with `postgresql://`.
3. Make a free Render web service from this folder/repo.
4. Use these Render settings:

```text
Build Command: npm install
Start Command: npm start
```

5. Add these Render environment variables:

```text
HOST=0.0.0.0
PUBLIC_DEMO=1
DATABASE_URL=your Neon pooled connection string
MUNKIN_ADMIN_PIN=make-a-private-owner-pin
MUNKIN_DEVICE_KEY=make-a-private-device-key
DUNKIN_APP_CODE=optional-private-code
MUNKIN_MESSAGE_TTL_HOURS=24
```

You can also update the Dunkin card/app code from the owner inbox after deploy. Open `/admin`, type the owner PIN, press **DUNKIN CODE**, paste the code, and press **SAVE CODE**.

## URLs After Deploy

```text
Friend mailbox:
https://your-render-app.onrender.com/

Owner inbox:
https://your-render-app.onrender.com/admin

Device feed:
https://your-render-app.onrender.com/device/inbox?key=YOUR_DEVICE_KEY

Private Dunkin code feed:
https://your-render-app.onrender.com/device/dunkin-code?key=YOUR_DEVICE_KEY
```

## Important

Do not share the owner PIN or device key. Share only the friend mailbox link.

Messages delete automatically after 24 hours by default. Email opt-ins stay saved for your list.

The ESP32 still needs to be pointed at the final Render URL before it can check the permanent mailbox directly.
