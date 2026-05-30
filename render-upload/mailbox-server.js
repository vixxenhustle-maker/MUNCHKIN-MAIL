const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { URLSearchParams } = require("node:url");

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_PIN = process.env.MUNKIN_ADMIN_PIN || "munkin";
const DEVICE_KEY = process.env.MUNKIN_DEVICE_KEY || "munkin-device";
const DUNKIN_APP_CODE = process.env.DUNKIN_APP_CODE || "ADD-CODE-LATER";
const PUBLIC_DEMO = process.env.PUBLIC_DEMO === "1";
const DATA_FILE = path.join(__dirname, "mailbox-data.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const MESSAGE_TTL_HOURS = Math.max(0, Number(process.env.MUNKIN_MESSAGE_TTL_HOURS || 24));
const MESSAGE_TTL_MS = MESSAGE_TTL_HOURS * 60 * 60 * 1000;
const MESSAGE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const state = {
  messages: [],
  subscribers: [],
  settings: {
    dunkinAppCode: DUNKIN_APP_CODE,
  },
};

let dbPool = null;
let lastMessageCleanupAt = 0;

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function cleanText(value = "", max = 120) {
  return String(value)
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function json(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function html(res, status, markup) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(markup);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

async function loadJsonState() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const loaded = JSON.parse(raw);
    state.messages = Array.isArray(loaded.messages) ? loaded.messages : [];
    state.subscribers = Array.isArray(loaded.subscribers) ? loaded.subscribers : [];
    state.settings = { ...state.settings, ...(loaded.settings || {}) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveJsonState();
  }
}

async function saveJsonState() {
  await fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2));
}

async function initDatabase() {
  if (!DATABASE_URL) return;
  let Pool;
  try {
    ({ Pool } = require("pg"));
  } catch (error) {
    throw new Error("DATABASE_URL is set, but the pg package is not installed. Run npm install first.");
  }

  dbPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  });

  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS mailbox_messages (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS mailbox_subscribers (
      email TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS mailbox_settings (
      key TEXT PRIMARY KEY,
      data JSONB NOT NULL
    );
  `);

  const counts = await dbPool.query(`
    SELECT
      (SELECT COUNT(*)::INT FROM mailbox_messages) AS messages,
      (SELECT COUNT(*)::INT FROM mailbox_subscribers) AS subscribers;
  `);
  if (counts.rows[0].messages === 0 && counts.rows[0].subscribers === 0) {
    await loadJsonState();
    if (state.messages.length || state.subscribers.length) {
      await saveDbState();
    }
  }
}

async function loadDbState() {
  const [messages, subscribers, settings] = await Promise.all([
    dbPool.query("SELECT data FROM mailbox_messages ORDER BY created_at DESC"),
    dbPool.query("SELECT data FROM mailbox_subscribers ORDER BY joined_at DESC"),
    dbPool.query("SELECT key, data FROM mailbox_settings"),
  ]);
  state.messages = messages.rows.map((row) => row.data);
  state.subscribers = subscribers.rows.map((row) => row.data);
  state.settings = { dunkinAppCode: DUNKIN_APP_CODE };
  for (const row of settings.rows) {
    state.settings[row.key] = row.data?.value || "";
  }
}

async function saveDbState() {
  for (const message of state.messages) {
    await dbPool.query(
      `INSERT INTO mailbox_messages (id, data, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
      [message.id, message, message.createdAt || new Date().toISOString()]
    );
  }
  for (const subscriber of state.subscribers) {
    await dbPool.query(
      `INSERT INTO mailbox_subscribers (email, data, joined_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET data = EXCLUDED.data`,
      [subscriber.email, subscriber, subscriber.joinedAt || new Date().toISOString()]
    );
  }
  const messageIds = state.messages.map((message) => message.id);
  if (messageIds.length) {
    await dbPool.query("DELETE FROM mailbox_messages WHERE NOT (id = ANY($1::text[]))", [messageIds]);
  } else {
    await dbPool.query("DELETE FROM mailbox_messages");
  }
  for (const [key, value] of Object.entries(state.settings)) {
    await dbPool.query(
      `INSERT INTO mailbox_settings (key, data)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data`,
      [key, { value }]
    );
  }
}

async function loadState() {
  if (dbPool) return loadDbState();
  return loadJsonState();
}

async function saveState() {
  if (dbPool) return saveDbState();
  return saveJsonState();
}

function isMessageExpired(message, now = Date.now()) {
  if (!MESSAGE_TTL_HOURS) return false;
  const createdAt = Date.parse(message.createdAt || "");
  if (!Number.isFinite(createdAt)) return false;
  return now - createdAt >= MESSAGE_TTL_MS;
}

async function cleanupExpiredMessages(force = false) {
  if (!MESSAGE_TTL_HOURS) return;
  const now = Date.now();
  if (!force && now - lastMessageCleanupAt < MESSAGE_CLEANUP_INTERVAL_MS) return;
  lastMessageCleanupAt = now;

  const before = state.messages.length;
  state.messages = state.messages.filter((message) => !isMessageExpired(message, now));
  if (state.messages.length !== before) {
    await saveState();
  }
}

function currentDunkinCode() {
  return state.settings.dunkinAppCode || DUNKIN_APP_CODE;
}

function nextId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function responseEmail(message) {
  const name = message.name || "friend";
  return {
    subject: "Munchkin got your note!",
    body:
      `Hi ${name},\n\n` +
      "Munchkin received your message and is doing a tiny happy wiggle.\n\n" +
      `Your note:\n"${message.message}"\n\n` +
      "If Munchkin replies, you will hear back soon.\n\n" +
      "Love,\nMunchkin",
  };
}

function replyEmail(message) {
  const reply = message.reply || "LOVE IT";
  const name = message.name || "friend";
  return {
    subject: "Munchkin replied!",
    body:
      `Hi ${name},\n\n` +
      `Munchkin says: ${reply}\n\n` +
      "Thanks for sending a little sparkle.\n\n" +
      "Love,\nMunchkin",
  };
}

function mailtoHref(email, subject, body) {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function layout(title, body, extraScript = "") {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --pink: #ff0064;
      --orange: #ff7f00;
      --green: #50ed00;
      --ink: #211f20;
      --paper: #f3f3f0;
      --cream: #fff8f3;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      background: var(--paper);
      color: var(--ink);
      font-family: Arial, Helvetica, sans-serif;
    }
    .page {
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .shell {
      width: min(100%, 920px);
      display: grid;
      grid-template-columns: minmax(260px, 360px) minmax(280px, 1fr);
      border: 4px solid var(--ink);
      background: white;
      min-height: 560px;
    }
    .portal {
      position: relative;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: var(--orange);
      border-right: 4px solid var(--ink);
    }
    .portal::before {
      content: "";
      position: absolute;
      inset: -90px 42% -90px -160px;
      background: var(--pink);
      border-radius: 50%;
    }
    .screen {
      position: relative;
      width: min(82vw, 286px);
      aspect-ratio: 1;
      border: 5px solid var(--ink);
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: #d0d0d0;
      overflow: hidden;
    }
    .screen img {
      width: 62%;
      height: 62%;
      object-fit: contain;
      animation: wiggle 2s ease-in-out infinite;
    }
    .screen strong {
      position: absolute;
      bottom: 33px;
      font-size: 18px;
      letter-spacing: 0;
      color: var(--pink);
      text-shadow: 1px 1px 0 white;
    }
    .panel {
      padding: 30px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      gap: 16px;
      background: linear-gradient(180deg, #fff, var(--cream));
    }
    h1, h2, p { margin: 0; }
    h1 {
      font-size: clamp(30px, 5vw, 52px);
      line-height: 0.95;
      color: var(--pink);
    }
    h2 { font-size: 24px; color: var(--orange); }
    p { line-height: 1.45; }
    form { display: grid; gap: 12px; }
    label {
      display: grid;
      gap: 6px;
      font-weight: 800;
      color: var(--ink);
    }
    input, textarea, button, select {
      width: 100%;
      border: 3px solid var(--ink);
      border-radius: 8px;
      padding: 12px;
      font: inherit;
      background: white;
      color: var(--ink);
    }
    textarea { min-height: 118px; resize: vertical; }
    button, .button {
      appearance: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 46px;
      border: 3px solid var(--ink);
      border-radius: 8px;
      background: var(--orange);
      color: white;
      font-weight: 900;
      text-decoration: none;
      cursor: pointer;
    }
    button.secondary, .button.secondary { background: var(--pink); }
    button.quiet, .button.quiet {
      background: white;
      color: var(--ink);
    }
    .consent {
      display: grid;
      grid-template-columns: 20px 1fr;
      align-items: start;
      gap: 10px;
      font-weight: 700;
    }
    .consent input { width: 20px; height: 20px; padding: 0; margin: 2px 0 0; }
    .status {
      min-height: 22px;
      font-weight: 900;
      color: var(--pink);
    }
    .admin-shell {
      width: min(100%, 1040px);
      display: grid;
      gap: 18px;
    }
    .admin-top {
      display: grid;
      gap: 12px;
      grid-template-columns: 1fr auto auto;
      align-items: end;
      border: 4px solid var(--ink);
      background: white;
      padding: 18px;
    }
    .messages {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 16px;
    }
    .message-card {
      display: grid;
      gap: 10px;
      border: 3px solid var(--ink);
      border-radius: 8px;
      background: white;
      padding: 16px;
    }
    .message-card[data-status="approved"] { border-color: var(--green); }
    .message-card[data-status="deleted"] { opacity: 0.55; }
    .tag {
      display: inline-flex;
      width: fit-content;
      border: 2px solid var(--ink);
      border-radius: 999px;
      padding: 3px 9px;
      font-size: 12px;
      font-weight: 900;
      background: var(--cream);
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
    }
    .email-preview {
      white-space: pre-wrap;
      border: 2px dashed var(--orange);
      border-radius: 8px;
      padding: 10px;
      background: var(--cream);
      font-size: 13px;
    }
    .thanks {
      display: grid;
      gap: 14px;
    }
    .drawer-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.36);
      opacity: 0;
      pointer-events: none;
      transition: opacity 180ms ease;
    }
    .drawer-backdrop.is-open {
      opacity: 1;
      pointer-events: auto;
    }
    .code-drawer {
      position: fixed;
      top: 0;
      right: 0;
      width: min(360px, 88vw);
      height: 100vh;
      display: grid;
      align-content: center;
      gap: 16px;
      padding: 22px;
      border-left: 4px solid var(--ink);
      background: white;
      transform: translateX(104%);
      transition: transform 220ms ease;
      z-index: 2;
    }
    .code-drawer.is-open { transform: translateX(0); }
    .code-window {
      display: grid;
      gap: 14px;
      padding: 18px;
      border: 4px solid var(--ink);
      background: var(--cream);
    }
    .code-orb {
      width: 180px;
      height: 180px;
      margin: 0 auto;
      border: 4px solid var(--ink);
      border-radius: 50%;
      display: grid;
      place-items: center;
      background: var(--paper);
      overflow: hidden;
    }
    .code-orb img {
      width: 132px;
      height: 132px;
      object-fit: contain;
    }
    .barcode {
      height: 70px;
      display: flex;
      align-items: stretch;
      justify-content: center;
      gap: 3px;
      padding: 9px;
      border: 3px solid var(--ink);
      background: white;
    }
    .barcode span {
      width: 5px;
      background: var(--ink);
    }
    .barcode span:nth-child(2n) { width: 2px; }
    .barcode span:nth-child(3n) { width: 8px; }
    .barcode span:nth-child(5n) { height: 76%; }
    .code-value {
      display: block;
      padding: 11px;
      border: 3px solid var(--ink);
      background: white;
      text-align: center;
      font-weight: 900;
      color: var(--orange);
      overflow-wrap: anywhere;
    }
    @keyframes wiggle {
      0%, 100% { transform: rotate(-3deg) translateY(0); }
      50% { transform: rotate(3deg) translateY(-5px); }
    }
    @media (max-width: 760px) {
      .shell { grid-template-columns: 1fr; }
      .portal {
        border-right: 0;
        border-bottom: 4px solid var(--ink);
        min-height: 280px;
      }
      .admin-top { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
${body}
${extraScript}
</body>
</html>`;
}

function friendPage() {
  const ownerLink = PUBLIC_DEMO ? "" : `<a class="button quiet" href="/admin">OWNER INBOX</a>`;
  const ttlCopy = MESSAGE_TTL_HOURS
    ? `It waits safely for ${MESSAGE_TTL_HOURS} hour${MESSAGE_TTL_HOURS === 1 ? "" : "s"} until it is approved for Munchkin.`
    : "It waits safely until it is approved for Munchkin.";
  return layout(
    "Munchkin Mailbox",
    `<main class="page">
      <section class="shell">
        <div class="portal" aria-hidden="true">
          <div class="screen">
            <img src="/asset/dunkin-go-happy.svg" alt="" />
            <strong>MAILBOX</strong>
          </div>
        </div>
        <div class="panel">
          <h1>Munchkin Mailbox</h1>
          <p>Send a little note. ${escapeHtml(ttlCopy)}</p>
          <form id="messageForm">
            <label>
              YOUR NAME
              <input name="name" maxlength="32" required placeholder="Name" />
            </label>
            <label>
              EMAIL
              <input name="email" type="email" maxlength="80" placeholder="you@example.com" />
            </label>
            <label>
              MESSAGE
              <textarea name="message" maxlength="180" required placeholder="Tell Munchkin something sweet"></textarea>
            </label>
            <label class="consent">
              <input name="optIn" type="checkbox" />
              <span>Send me Munchkin updates and replies.</span>
            </label>
            <button type="submit">SEND TO MUNCHKIN</button>
            <div class="status" id="status" role="status"></div>
          </form>
          ${ownerLink}
        </div>
      </section>
    </main>`,
    `<script>
      const form = document.querySelector("#messageForm");
      const status = document.querySelector("#status");
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        status.textContent = "SENDING...";
        const body = Object.fromEntries(new FormData(form));
        body.optIn = form.optIn.checked;
        const response = await fetch("/api/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const result = await response.json();
        if (!response.ok) {
          status.textContent = result.error || "TRY AGAIN";
          return;
        }
        window.location.href = "/thanks?id=" + encodeURIComponent(result.id);
      });
    </script>`
  );
}

function thanksPage(message) {
  const email = responseEmail(message);
  const emailBlock = message.email && message.optIn
    ? `<div class="email-preview"><b>${escapeHtml(email.subject)}</b>\n\n${escapeHtml(email.body)}</div>`
    : `<p>They did not join the email list, so this stays as an on-screen thank you.</p>`;

  return layout(
    "Munchkin Got It",
    `<main class="page">
      <section class="shell">
        <div class="portal" aria-hidden="true">
          <div class="screen">
            <img src="/asset/HAPPY.svg" alt="" />
            <strong>GOT IT!</strong>
          </div>
        </div>
        <div class="panel thanks">
          <h1>Munchkin got your note!</h1>
          <p>Your message is waiting for approval. If approved, it can appear on the Munchkin device.</p>
          ${emailBlock}
          <a class="button" href="/">SEND ANOTHER</a>
        </div>
      </section>
    </main>`
  );
}

function adminPage() {
  const codeBars = Array.from({ length: 24 }, () => "<span></span>").join("");
  const deviceViewLink = PUBLIC_DEMO ? "" : `<a class="button" href="/device-preview">DEVICE VIEW</a>`;
  const dunkinCode = currentDunkinCode();
  return layout(
    "Munchkin Owner Inbox",
    `<main class="page">
      <section class="admin-shell">
        <div class="admin-top">
          <div>
            <h1>Owner Inbox</h1>
            <p>Approve notes, collect opt-in emails, and see Munchkin replies.</p>
          </div>
          <label>
            PIN
            <input id="pin" type="password" value="" placeholder="private PIN" />
          </label>
          <button class="secondary" id="openCode" type="button">DUNKIN CODE</button>
          ${deviceViewLink}
          <a class="button quiet" id="csvLink" href="/api/admin/emails.csv?pin=">EXPORT EMAILS</a>
        </div>
        <div class="status" id="adminStatus"></div>
        <section class="messages" id="messages"></section>
      </section>
      <div class="drawer-backdrop" id="drawerBackdrop"></div>
      <aside class="code-drawer" id="codeDrawer" aria-label="Private Dunkin code">
        <section class="code-window">
          <h2>Dunkin Code</h2>
          <div class="code-orb">
            <img src="/asset/dunkin-go-happy.svg" alt="" />
          </div>
          <div class="barcode" aria-hidden="true">${codeBars}</div>
          <code class="code-value" id="codeValue">${escapeHtml(dunkinCode)}</code>
          <form id="codeForm">
            <label>
              DUNKIN CARD / APP CODE
              <input id="dunkinCodeInput" name="dunkinAppCode" maxlength="64" value="${escapeHtml(dunkinCode)}" placeholder="Paste private code" />
            </label>
            <button type="submit">SAVE CODE</button>
            <div class="status" id="codeStatus" role="status"></div>
          </form>
          <p>This is private. Only the owner page and device key can see it.</p>
          <button id="closeCode" type="button">CLOSE</button>
        </section>
      </aside>
    </main>`,
    `<script>
      const pin = document.querySelector("#pin");
      const csvLink = document.querySelector("#csvLink");
      const messages = document.querySelector("#messages");
      const adminStatus = document.querySelector("#adminStatus");
      const codeDrawer = document.querySelector("#codeDrawer");
      const drawerBackdrop = document.querySelector("#drawerBackdrop");
      const openCode = document.querySelector("#openCode");
      const closeCode = document.querySelector("#closeCode");
      const codeForm = document.querySelector("#codeForm");
      const codeValue = document.querySelector("#codeValue");
      const codeStatus = document.querySelector("#codeStatus");
      const dunkinCodeInput = document.querySelector("#dunkinCodeInput");
      pin.value = localStorage.getItem("munkin-admin-pin") || "";

      function setCodeOpen(open) {
        codeDrawer.classList.toggle("is-open", open);
        drawerBackdrop.classList.toggle("is-open", open);
      }
      openCode.addEventListener("click", () => setCodeOpen(true));
      closeCode.addEventListener("click", () => setCodeOpen(false));
      drawerBackdrop.addEventListener("click", () => setCodeOpen(false));

      function emailCard(message) {
        if (!message.email || !message.optIn) return "";
        const subject = encodeURIComponent(message.reply ? "Munchkin replied!" : "Munchkin got your note!");
        const body = encodeURIComponent(message.reply
          ? "Hi " + message.name + ",\\n\\nMunchkin says: " + message.reply + "\\n\\nLove,\\nMunchkin"
          : "Hi " + message.name + ",\\n\\nMunchkin received your message and is doing a tiny happy wiggle.\\n\\nYour note:\\n\\"" + message.message + "\\"\\n\\nLove,\\nMunchkin");
        return '<a class="button quiet" href="mailto:' + encodeURIComponent(message.email) + '?subject=' + subject + '&body=' + body + '">EMAIL RESPONSE</a>';
      }

      function card(message) {
        return '<article class="message-card" data-status="' + message.status + '">' +
          '<span class="tag">' + message.status.toUpperCase() + '</span>' +
          '<h2>' + message.name + '</h2>' +
          '<p><b>Email:</b> ' + (message.email || "none") + '</p>' +
          '<p>' + message.message + '</p>' +
          '<p><b>Munchkin reply:</b> ' + (message.reply || "waiting") + '</p>' +
          '<div class="actions">' +
            '<button data-action="approve" data-id="' + message.id + '">APPROVE</button>' +
            '<button class="secondary" data-action="delete" data-id="' + message.id + '">DELETE</button>' +
            '<button class="quiet" data-action="pending" data-id="' + message.id + '">PENDING</button>' +
            emailCard(message) +
          '</div>' +
        '</article>';
      }

      async function load() {
        const value = pin.value || "";
        localStorage.setItem("munkin-admin-pin", value);
        csvLink.href = "/api/admin/emails.csv?pin=" + encodeURIComponent(value);
        const response = await fetch("/api/admin/messages?pin=" + encodeURIComponent(value));
        const result = await response.json();
        if (!response.ok) {
          adminStatus.textContent = result.error || "BAD PIN";
          messages.innerHTML = "";
          return;
        }
        adminStatus.textContent = result.messages.length + " MESSAGE(S) / " + result.subscribers.length + " EMAIL OPT-IN(S)";
        messages.innerHTML = result.messages.map(card).join("") || '<p>No messages yet.</p>';
      }

      async function loadSettings() {
        if (!pin.value) return;
        const response = await fetch("/api/admin/settings?pin=" + encodeURIComponent(pin.value));
        const result = await response.json();
        if (!response.ok) return;
        dunkinCodeInput.value = result.dunkinAppCode || "";
        codeValue.textContent = result.dunkinAppCode || "ADD-CODE-LATER";
      }

      codeForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        codeStatus.textContent = "SAVING...";
        const response = await fetch("/api/admin/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: pin.value, dunkinAppCode: dunkinCodeInput.value })
        });
        const result = await response.json();
        if (!response.ok) {
          codeStatus.textContent = result.error || "BAD PIN";
          return;
        }
        codeValue.textContent = result.dunkinAppCode || "ADD-CODE-LATER";
        codeStatus.textContent = "SAVED";
      });

      messages.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-action]");
        if (!button) return;
        await fetch("/api/admin/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pin: pin.value, id: button.dataset.id, action: button.dataset.action })
        });
        load();
      });
      pin.addEventListener("input", () => {
        load();
        loadSettings();
      });
      load();
      loadSettings();
      setInterval(load, 3000);
    </script>`
  );
}

function devicePreviewPage() {
  return layout(
    "Munchkin Device View",
    `<main class="page">
      <section class="shell">
        <div class="portal" aria-hidden="true">
          <div class="screen">
            <img src="/asset/dunkin-go-happy.svg" alt="" />
            <strong>DEVICE</strong>
          </div>
        </div>
        <div class="panel">
          <h1>Device View</h1>
          <p>This is the tiny-screen flow before it goes onto the ESP32: review pending notes, approve them, then see the approved device message.</p>
          <section class="message-card" id="pendingCard">
            <span class="tag">PENDING</span>
            <h2 id="pendingFrom">NO MESSAGE</h2>
            <p id="pendingText">Waiting for a new note.</p>
            <div class="actions">
              <button id="approvePending" type="button">APPROVE</button>
              <button class="secondary" id="deletePending" type="button">DELETE</button>
            </div>
          </section>
          <section class="message-card" id="approvedCard">
            <span class="tag">READY FOR MUNCHKIN</span>
            <h2 id="approvedFrom">NO APPROVED MESSAGE</h2>
            <p id="approvedText">Approve a note to send it to the device.</p>
          </section>
          <a class="button quiet" href="/admin">OWNER INBOX</a>
        </div>
      </section>
    </main>`,
    `<script>
      const key = ${JSON.stringify(DEVICE_KEY)};
      let pendingId = "";
      const pendingFrom = document.querySelector("#pendingFrom");
      const pendingText = document.querySelector("#pendingText");
      const approvedFrom = document.querySelector("#approvedFrom");
      const approvedText = document.querySelector("#approvedText");
      const approvePending = document.querySelector("#approvePending");
      const deletePending = document.querySelector("#deletePending");

      async function loadDeviceView() {
        const pending = await fetch("/device/pending?key=" + encodeURIComponent(key)).then(r => r.json());
        pendingId = pending.hasMessage ? pending.id : "";
        pendingFrom.textContent = pending.hasMessage ? pending.from : "NO MESSAGE";
        pendingText.textContent = pending.hasMessage ? pending.message : "Waiting for a new note.";
        approvePending.disabled = !pending.hasMessage;
        deletePending.disabled = !pending.hasMessage;

        const approved = await fetch("/device/inbox?key=" + encodeURIComponent(key)).then(r => r.json());
        approvedFrom.textContent = approved.hasMessage ? approved.from : "NO APPROVED MESSAGE";
        approvedText.textContent = approved.hasMessage ? approved.message : "Approve a note to send it to the device.";
      }

      async function moderate(action) {
        if (!pendingId) return;
        await fetch("/device/moderate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, id: pendingId, action })
        });
        loadDeviceView();
      }

      approvePending.addEventListener("click", () => moderate("approve"));
      deletePending.addEventListener("click", () => moderate("delete"));
      loadDeviceView();
      setInterval(loadDeviceView, 2500);
    </script>`
  );
}

function requireAdmin(url) {
  return url.searchParams.get("pin") === ADMIN_PIN;
}

function requireDevice(url) {
  return url.searchParams.get("key") === DEVICE_KEY;
}

async function createMessage(res, data) {
  const name = cleanText(data.name, 32);
  const email = cleanText(data.email, 80).toLowerCase();
  const messageText = cleanText(data.message, 180);
  const optIn = data.optIn === true || data.optIn === "on" || data.optIn === "true";

  if (!name) return json(res, 400, { error: "NAME NEEDED" });
  if (!messageText) return json(res, 400, { error: "MESSAGE NEEDED" });
  if (email && !isEmail(email)) return json(res, 400, { error: "EMAIL LOOKS OFF" });
  if (optIn && !email) return json(res, 400, { error: "EMAIL NEEDED FOR UPDATES" });

  const now = new Date().toISOString();
  const item = {
    id: nextId(),
    name,
    email,
    optIn,
    message: messageText,
    status: "pending",
    createdAt: now,
    approvedAt: "",
    deliveredAt: "",
    reply: "",
    replyAt: "",
  };
  state.messages.unshift(item);

  if (optIn && email && !state.subscribers.some((subscriber) => subscriber.email === email)) {
    state.subscribers.unshift({ name, email, joinedAt: now });
  }

  await saveState();
  return json(res, 201, { ok: true, id: item.id, emailPreview: responseEmail(item) });
}

async function adminAction(res, data) {
  if (data.pin !== ADMIN_PIN) return json(res, 403, { error: "BAD PIN" });
  const message = state.messages.find((item) => item.id === data.id);
  if (!message) return json(res, 404, { error: "MESSAGE NOT FOUND" });
  if (!["approve", "delete", "pending"].includes(data.action)) {
    return json(res, 400, { error: "UNKNOWN ACTION" });
  }
  message.status = data.action === "approve" ? "approved" : data.action === "delete" ? "deleted" : "pending";
  if (message.status === "approved") {
    message.approvedAt = new Date().toISOString();
    message.deliveredAt = "";
  }
  await saveState();
  return json(res, 200, { ok: true, message });
}

function adminSettings(res, url) {
  if (!requireAdmin(url)) return json(res, 403, { error: "BAD PIN" });
  return json(res, 200, {
    dunkinAppCode: currentDunkinCode(),
  });
}

async function saveAdminSettings(res, data) {
  if (data.pin !== ADMIN_PIN) return json(res, 403, { error: "BAD PIN" });
  const dunkinAppCode = cleanText(data.dunkinAppCode, 64) || "ADD-CODE-LATER";
  state.settings.dunkinAppCode = dunkinAppCode;
  await saveState();
  return json(res, 200, { ok: true, dunkinAppCode });
}

function emailsCsv() {
  const rows = [["name", "email", "joinedAt"]];
  for (const subscriber of state.subscribers) {
    rows.push([subscriber.name, subscriber.email, subscriber.joinedAt]);
  }
  return rows
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");
}

function deviceInbox(res) {
  const next = state.messages
    .slice()
    .reverse()
    .find((message) => message.status === "approved" && !message.deliveredAt);
  if (!next) return json(res, 200, { hasMessage: false });
  return json(res, 200, {
    hasMessage: true,
    id: next.id,
    from: next.name.toUpperCase().slice(0, 12),
    message: next.message.toUpperCase().slice(0, 48),
  });
}

function devicePending(res) {
  const next = state.messages
    .slice()
    .reverse()
    .find((message) => message.status === "pending");
  if (!next) return json(res, 200, { hasMessage: false });
  return json(res, 200, {
    hasMessage: true,
    id: next.id,
    from: next.name.toUpperCase().slice(0, 12),
    message: next.message.toUpperCase().slice(0, 72),
  });
}

async function deviceModerate(res, data) {
  if (data.key !== DEVICE_KEY) return json(res, 403, { error: "BAD DEVICE KEY" });
  const message = state.messages.find((item) => item.id === data.id);
  if (!message) return json(res, 404, { error: "MESSAGE NOT FOUND" });
  if (!["approve", "delete"].includes(data.action)) {
    return json(res, 400, { error: "UNKNOWN ACTION" });
  }
  message.status = data.action === "approve" ? "approved" : "deleted";
  if (message.status === "approved") {
    message.approvedAt = new Date().toISOString();
    message.deliveredAt = "";
  }
  await saveState();
  return json(res, 200, { ok: true, message });
}

async function deviceAck(res, url) {
  const message = state.messages.find((item) => item.id === url.searchParams.get("id"));
  if (!message) return json(res, 404, { error: "MESSAGE NOT FOUND" });
  message.deliveredAt = new Date().toISOString();
  await saveState();
  return json(res, 200, { ok: true });
}

async function deviceReply(res, data) {
  if (data.key !== DEVICE_KEY) return json(res, 403, { error: "BAD DEVICE KEY" });
  const message = state.messages.find((item) => item.id === data.id);
  if (!message) return json(res, 404, { error: "MESSAGE NOT FOUND" });
  message.reply = cleanText(data.reply, 32).toUpperCase() || "LOVE IT";
  message.replyAt = new Date().toISOString();
  await saveState();
  return json(res, 200, { ok: true, emailPreview: replyEmail(message) });
}

function deviceDunkinCode(res) {
  return json(res, 200, {
    dunkinAppCode: currentDunkinCode(),
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  await cleanupExpiredMessages();

  if (req.method === "GET" && url.pathname === "/") return html(res, 200, friendPage());
  if (req.method === "GET" && url.pathname === "/admin") return html(res, 200, adminPage());
  if (req.method === "GET" && url.pathname === "/device-preview") {
    if (PUBLIC_DEMO && !requireAdmin(url)) return text(res, 403, "Device preview is private during public demos.");
    return html(res, 200, devicePreviewPage());
  }
  if (req.method === "GET" && url.pathname === "/thanks") {
    const message = state.messages.find((item) => item.id === url.searchParams.get("id"));
    return html(res, message ? 200 : 404, thanksPage(message || { name: "friend", message: "Missing message" }));
  }
  if (req.method === "GET" && url.pathname === "/asset/dunkin-go-happy.svg") {
    return text(res, 200, await fs.readFile(path.join(__dirname, "dunkin-go-happy.svg"), "utf8"), "image/svg+xml; charset=utf-8");
  }
  if (req.method === "GET" && url.pathname === "/asset/HAPPY.svg") {
    return text(res, 200, await fs.readFile(path.join(__dirname, "HAPPY.svg"), "utf8"), "image/svg+xml; charset=utf-8");
  }
  if (req.method === "POST" && url.pathname === "/api/messages") return createMessage(res, await readBody(req));
  if (req.method === "GET" && url.pathname === "/api/admin/messages") {
    if (!requireAdmin(url)) return json(res, 403, { error: "BAD PIN" });
    return json(res, 200, { messages: state.messages, subscribers: state.subscribers });
  }
  if (req.method === "POST" && url.pathname === "/api/admin/action") return adminAction(res, await readBody(req));
  if (req.method === "GET" && url.pathname === "/api/admin/settings") return adminSettings(res, url);
  if (req.method === "POST" && url.pathname === "/api/admin/settings") return saveAdminSettings(res, await readBody(req));
  if (req.method === "GET" && url.pathname === "/api/admin/emails.csv") {
    if (!requireAdmin(url)) return text(res, 403, "BAD PIN");
    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": "attachment; filename=munchkin-emails.csv",
    });
    return res.end(emailsCsv());
  }
  if (req.method === "GET" && url.pathname === "/device/inbox") {
    if (!requireDevice(url)) return json(res, 403, { error: "BAD DEVICE KEY" });
    return deviceInbox(res);
  }
  if (req.method === "GET" && url.pathname === "/device/pending") {
    if (!requireDevice(url)) return json(res, 403, { error: "BAD DEVICE KEY" });
    return devicePending(res);
  }
  if (req.method === "GET" && url.pathname === "/device/dunkin-code") {
    if (!requireDevice(url)) return json(res, 403, { error: "BAD DEVICE KEY" });
    return deviceDunkinCode(res);
  }
  if (req.method === "POST" && url.pathname === "/device/moderate") return deviceModerate(res, await readBody(req));
  if (req.method === "POST" && url.pathname === "/device/reply") return deviceReply(res, await readBody(req));
  if (req.method === "GET" && url.pathname === "/device/ack") {
    if (!requireDevice(url)) return json(res, 403, { error: "BAD DEVICE KEY" });
    return deviceAck(res, url);
  }

  return text(res, 404, "Not found");
}

async function main() {
  await initDatabase();
  await loadState();
  await cleanupExpiredMessages(true);
  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      console.error(error);
      json(res, 500, { error: "SERVER ERROR" });
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`Munchkin Mailbox running at http://${HOST}:${PORT}`);
    console.log(`Owner inbox: http://${HOST}:${PORT}/admin`);
    console.log(`Admin PIN: ${ADMIN_PIN}`);
    console.log(`Storage: ${dbPool ? "Postgres database" : "local JSON file"}`);
    console.log(`Message cleanup: ${MESSAGE_TTL_HOURS ? `${MESSAGE_TTL_HOURS} hour(s)` : "off"}`);
  });
  setInterval(() => cleanupExpiredMessages(true).catch(console.error), MESSAGE_CLEANUP_INTERVAL_MS).unref();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
