/**
 * POS AI Support brain — answers the iPad in-app assistant.
 *
 * Transport: Firestore. The iPad writes `aiSupportThreads/{threadId}` with a
 * `messages` subcollection and flips `pending:true`. This module listens,
 * runs a LOCKED-DOWN Claude CLI call (NO tools — no Bash/Read/Write, so it
 * cannot act or touch the filesystem), and writes the reply back.
 *
 * v1 scope: knowledge / how-to answers (the "how do I enable X", "reader
 * won't connect" use cases). Provider-scoped live-data tools + visual guides
 * come in later increments.
 *
 * SECURITY (deferred hardening — see EventiniPOS_local/AI_SUPPORT_PLAN.md):
 *   providerId is trusted from the thread doc (the DB is currently open).
 *   This handler is READ-ONLY and tool-less, so it can never take a
 *   destructive action or run shell — the only deferred piece is verifying
 *   the provider's *identity* cryptographically. Harden before public launch.
 *
 * Run standalone for testing:  node pos-ai-support.js
 * (Safe to run alongside the launchd bot — separate process, same Firestore.)
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const SA_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT ||
  "/Users/jadenbro1/eventini-admin-fresh/firebase-service-account.json";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "/Users/jadenbro1/.local/bin/claude";
const MODEL = process.env.POS_AI_MODEL || "sonnet";
// Neutral empty working dir so the CLI doesn't load an unrelated CLAUDE.md.
const WORKDIR = path.join(__dirname, "pos-ai-workdir");

const admin = require("firebase-admin");
if (!admin.apps.length) {
  const sa = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
}
const db = admin.firestore();

if (!fs.existsSync(WORKDIR)) fs.mkdirSync(WORKDIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString(), "[pos-ai]", ...a);

// Ionicons the iPad guide renderer knows. Model must pick from these;
// unknown names fall back to a default icon on the client.
const GUIDE_ICONS = [
  "settings-outline", "card-outline", "cash-outline", "receipt-outline",
  "print-outline", "bluetooth-outline", "people-outline", "pricetag-outline",
  "restaurant-outline", "wallet-outline", "add-circle-outline",
  "checkmark-circle-outline", "refresh-outline", "power-outline",
  "navigate-outline", "toggle-outline", "search-outline", "create-outline",
  "time-outline", "list-outline", "grid-outline", "home-outline",
  "hardware-chip-outline", "wifi-outline", "battery-charging-outline",
];

// Deep-link route keys the iPad can navigate to. The model puts the best
// match on a guide step's "route"; unknown/missing → chip isn't clickable.
const ROUTE_KEYS = [
  "settings", "settings-printers", "settings-staff", "settings-locations",
  "settings-discounts", "settings-messaging", "reader-setup", "printer-setup",
  "cash-drawer-setup", "tap-to-pay-setup", "orders", "reports", "transactions",
  "payouts", "banking", "menu", "menu-performance", "invoices", "dashboard",
];

const SYSTEM_PROMPT = `You are the Eventini POS in-app AI support assistant. You help food &
beverage vendors and their cashiers use the Eventini Point-of-Sale iPad app.

You MUST reply with ONE JSON object and NOTHING else — no prose, no markdown, no code fences.

Pick the shape:

1) GUIDE — for ANY "how do I / where do I / set up / enable / turn on / troubleshoot / connect /
   fix" question with steps in the app. Shape:
{"type":"guide","title":"<3-5 words>","intro":"<one short sentence>",
 "steps":[{"title":"<2-5 word action>","detail":"<optional one short line>",
           "screen":"<on-screen path, e.g. 'Settings → Printers'>",
           "route":"<one route key from the list, or omit>",
           "icon":"<one icon from the list>"}],
 "outro":"<optional short note>"}
   3-6 steps, short. Put the best "route" key on each step so the user can tap to go there.
   Route keys: ${ROUTE_KEYS.join(", ")}. Icons: ${GUIDE_ICONS.join(", ")}.

2) REPORT — when the user asks about THEIR OWN sales, revenue, orders, or top/best-selling items,
   optionally for a date range ("sales May 7 to 29", "top items last week", "how many orders
   yesterday"). You DO have access to this provider's data via the system — return a spec and the
   system runs it and attaches a downloadable CSV. Shape:
{"type":"report","kind":"sales_summary"|"top_items"|"sales_by_day",
 "from":"YYYY-MM-DD","to":"YYYY-MM-DD","limit":<int for top_items, else omit>,
 "title":"<short title>"}
   Resolve relative dates against TODAY (given below). If no range is stated, use a sensible one
   (top_items: last 30 days; sales: last 30 days). Use sales_by_day when they want a trend/breakdown
   by day, sales_summary for a single total, top_items for best sellers.

3) TEXT — facts, yes/no, explanations, money/payout/balance questions, anything else
   (incl. "how is this calculated", "what's the formula", "what will be paid to my bank
   tomorrow", "how much is pending"). Shape:
{"type":"text","text":"<plain sentences, NO markdown/asterisks/bullets>"}
   For money/sales/payout questions, USE the real numbers in LIVE PROVIDER CONTEXT below and
   give a specific answer (cite the actual dollar amounts and dates). Never invent figures; if
   a needed number isn't in the context, say what you can and point them to the right tab.

HOW REPORTS ARE COMPUTED (use this to answer "how do you compute that / what's the formula /
how is X calculated / is this gross or net" type questions accurately):
- Net sales = Gross sales − Refunds.
- Average order = Net sales ÷ number of orders.
- Gross sales = the sum of every order's total in the period.
- Refunds = refunds recorded against those orders (subtracted).
- Tips = card tips collected on those orders (reported separately, not part of Net).
- The period is the provider's 6 AM operating day (late-night sales count toward the day
  they started), matching the Reports tab and dashboard. Fully-refunded orders are excluded.

LANGUAGE: Detect the language of the user's MOST RECENT message and write your ENTIRE reply in
that same language — every title, intro, detail, outro, summary, and sentence. (English in →
English out; Spanish in → Spanish out; etc.) EXCEPTION: keep the on-screen navigation in each
guide step's "screen" field in English, because it must match the app's actual buttons (the app
UI is English) — e.g. screen stays "Settings → Printers" but the step title/detail are translated.

Always warm and concise. You are READ-ONLY — guide and report, but never perform actions or move
money. This provider only ever sees their own business. Output ONLY the JSON object.`;

function buildPrompt(providerName, ctxBlock, history, question) {
  const convo = history
    .map((m) => `${m.from === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");
  const today = new Date().toISOString().slice(0, 10);
  return [
    SYSTEM_PROMPT,
    "",
    `TODAY is ${today}.`,
    providerName ? `You are helping the business: ${providerName}.` : "",
    "",
    ctxBlock || "",
    "",
    convo ? `Conversation so far:\n${convo}\n` : "",
    `User: ${question}`,
    "",
    "Reply with ONLY the JSON object.",
  ]
    .filter((s) => s !== null && s !== undefined)
    .join("\n");
}

// Locked-down Claude CLI call: no tools at all.
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format", "json",
      "--allowedTools", "",          // empty allowlist → no tools usable
      "--max-turns", "1",
      "--model", MODEL,
    ];
    const child = spawn(CLAUDE_BIN, args, { cwd: WORKDIR });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("claude timeout"));
    }, 90000);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${err.slice(0, 300)}`));
      try {
        const json = JSON.parse(out);
        resolve((json.result || "").trim());
      } catch (e) {
        // Fallback: some CLI versions print plain text.
        resolve(out.trim());
      }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Pull a JSON object out of the model's reply (tolerate stray prose or
// ```json fences). Returns null if nothing parseable.
function parsePayload(raw) {
  if (!raw) return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // If there's leading/trailing prose, grab the outermost {...}.
  if (s[0] !== "{") {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
  }
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const ALLOWED_ICONS = new Set(GUIDE_ICONS);

function sanitizeGuide(p) {
  return {
    title: String(p.title || "How to").slice(0, 60),
    intro: p.intro ? String(p.intro).slice(0, 240) : "",
    outro: p.outro ? String(p.outro).slice(0, 280) : "",
    steps: (p.steps || []).slice(0, 6).map((s) => ({
      title: String(s.title || "").slice(0, 60),
      detail: s.detail ? String(s.detail).slice(0, 160) : "",
      screen: s.screen ? String(s.screen).slice(0, 60) : "",
      route: ALLOWED_ROUTES.has(s.route) ? s.route : null,
      icon: ALLOWED_ICONS.has(s.icon) ? s.icon : "navigate-outline",
    })),
  };
}

const ALLOWED_ROUTES = new Set(ROUTE_KEYS);

// ───────────────────────── Report engine ─────────────────────────
// Read-only, scoped to one provider. Queries PosOrders/{providerId}/orders
// by created_at range, computes the report, and returns a CSV + summary.
const BUCKET = "eventini-746af.firebasestorage.app";

function dayBounds(from, to) {
  // Interpret the date strings in the server's local time; end is inclusive.
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T23:59:59.999`);
  return { start, end };
}

async function fetchOrders(providerId, from, to) {
  // POS orders store created_at as an ISO STRING (e.g. "2026-05-29T01:23:08").
  // ISO strings sort chronologically, so a string range works and is indexed.
  const fromS = `${from}T00:00:00`;
  const toS = `${to}T23:59:59.999`;
  const snap = await db
    .collection("PosOrders")
    .doc(providerId)
    .collection("orders")
    .where("created_at", ">=", fromS)
    .where("created_at", "<=", toS)
    .get();
  return snap.docs.map((d) => d.data());
}

function num(v) {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
// Money fields are stored in CENTS — convert to dollars.
function money(v) {
  return num(v) / 100;
}
function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCSV(columns, rows) {
  return [columns.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n");
}
function dateOf(o) {
  const c = o.created_at;
  if (c && typeof c.toDate === "function") return c.toDate();
  return new Date(c);
}

async function buildReport(providerId, spec) {
  const kind = spec.kind;
  const today = new Date().toISOString().slice(0, 10);
  const from = (spec.from || today).slice(0, 10);
  const to = (spec.to || today).slice(0, 10);
  const orders = await fetchOrders(providerId, from, to);
  // Exclude fully-refunded from revenue totals where flagged.
  const live = orders.filter((o) => (o.refund_status || "none") !== "refunded");

  if (kind === "top_items") {
    const limit = Math.min(Math.max(parseInt(spec.limit) || 20, 1), 100);
    const map = new Map();
    for (const o of live) {
      for (const it of o.items || []) {
        const name = it.menu_item_name || it.name || "Unknown";
        const qty = num(it.quantity) || 1;
        const rev = money(it.subtotal) || money(it.base_price) * qty;
        const cur = map.get(name) || { qty: 0, rev: 0 };
        cur.qty += qty;
        cur.rev += rev;
        map.set(name, cur);
      }
    }
    const ranked = [...map.entries()]
      .map(([name, v]) => ({ name, qty: v.qty, rev: v.rev }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, limit);
    const columns = ["Item", "Qty Sold", "Revenue"];
    const rows = ranked.map((r) => [r.name, r.qty, r.rev.toFixed(2)]);
    return {
      title: spec.title || "Top Selling Items",
      summary: `Top ${ranked.length} items by quantity, ${from} to ${to}. ${live.length} orders scanned.`,
      columns,
      rows,
      from,
      to,
    };
  }

  if (kind === "sales_by_day") {
    const byDay = new Map();
    for (const o of live) {
      const d = dateOf(o).toISOString().slice(0, 10);
      const cur = byDay.get(d) || { orders: 0, gross: 0 };
      cur.orders += 1;
      cur.gross += money(o.total);
      byDay.set(d, cur);
    }
    const days = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const columns = ["Date", "Orders", "Gross Sales"];
    const rows = days.map(([d, v]) => [d, v.orders, v.gross.toFixed(2)]);
    const total = days.reduce((s, [, v]) => s + v.gross, 0);
    return {
      title: spec.title || "Sales by Day",
      summary: `$${total.toFixed(2)} gross across ${live.length} orders, ${from} to ${to}.`,
      columns,
      rows,
      from,
      to,
    };
  }

  // sales_summary (default)
  const gross = live.reduce((s, o) => s + money(o.total), 0);
  const tips = live.reduce((s, o) => s + money(o.tip), 0);
  const count = live.length;
  const avg = count ? gross / count : 0;
  const columns = ["Metric", "Value"];
  const rows = [
    ["Date range", `${from} to ${to}`],
    ["Orders", count],
    ["Gross sales", gross.toFixed(2)],
    ["Tips", tips.toFixed(2)],
    ["Average order", avg.toFixed(2)],
  ];
  return {
    title: spec.title || "Sales Summary",
    summary: `$${gross.toFixed(2)} gross across ${count} orders (avg $${avg.toFixed(2)}), ${from} to ${to}.`,
    columns,
    rows,
    from,
    to,
  };
}

async function uploadCSV(threadId, report) {
  const csv = toCSV(report.columns, report.rows);
  const safe = (report.title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const path = `aiSupportThreads/${threadId}/reports/${safe}-${report.from}_${report.to}.csv`;
  const file = admin.storage().bucket(BUCKET).file(path);
  await file.save(csv, { contentType: "text/csv", resumable: false });
  const [url] = await file.getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
  });
  return { url, bytes: csv.length };
}

// ──────────────────── Live provider context ────────────────────
// Before answering, we pull REAL, current data for this one provider —
// recent sales (6 AM operating-day, matching the dashboard) and, if they
// have a Stripe Connect account, their actual balance + payout schedule +
// recent payouts. This is injected into the prompt so money/payout/sales
// questions get specific, correct numbers instead of generic guesses.
// Strictly READ-ONLY and scoped to the one providerId on the thread.

// Lazy Stripe client (read-only use). Key + module live in eventini-admin.
let _stripe = null;
function getStripe() {
  if (_stripe !== null) return _stripe;
  try {
    const envTxt = fs.readFileSync(
      "/Users/jadenbro1/eventini-admin-fresh/.env.local",
      "utf8",
    );
    const m = envTxt.match(/^STRIPE_SECRET_KEY=(.+)$/m);
    const key = (m && m[1] ? m[1] : "").trim().replace(/^["']|["']$/g, "");
    if (!key) {
      _stripe = false;
      return false;
    }
    const Stripe = require("/Users/jadenbro1/eventini-admin-fresh/node_modules/stripe");
    _stripe = Stripe(key);
  } catch (e) {
    log("stripe init failed:", e.message);
    _stripe = false;
  }
  return _stripe;
}

// The 6 AM operating-day key for a stored created_at string (local ISO,
// e.g. "2026-06-04T01:23:08"): sales before 6 AM belong to the prior day.
function opDayKey(createdAt) {
  const s = String(createdAt || "");
  const datePart = s.slice(0, 10);
  const hour = parseInt(s.slice(11, 13), 10) || 0;
  if (hour < 6) {
    const d = new Date(`${datePart}T12:00:00`);
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return datePart;
}

async function salesSnapshot(providerId) {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 9 * 86400000).toISOString().slice(0, 10);
  const orders = await fetchOrders(providerId, from, to);
  const live = orders.filter((o) => (o.refund_status || "none") !== "refunded");
  const byDay = {};
  for (const o of live) {
    const k = opDayKey(o.created_at);
    const cur = (byDay[k] = byDay[k] || { net: 0, orders: 0, tips: 0 });
    cur.net += money(o.total);
    cur.orders += 1;
    cur.tips += money(o.tip);
  }
  const todayKey = opDayKey(now.toISOString());
  const yd = new Date(now.getTime() - 86400000);
  const yKey = opDayKey(yd.toISOString());
  const days = Object.entries(byDay)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, 8);
  const last7 = Object.values(byDay).reduce(
    (s, v) => ({ net: s.net + v.net, orders: s.orders + v.orders }),
    { net: 0, orders: 0 },
  );
  return {
    today: byDay[todayKey] || { net: 0, orders: 0, tips: 0 },
    yesterday: byDay[yKey] || { net: 0, orders: 0, tips: 0 },
    last7,
    recentDays: days.map(([d, v]) => ({ date: d, net: v.net, orders: v.orders })),
  };
}

async function buildProviderContext(providerId, providerNameHint) {
  const ctx = { businessName: providerNameHint || providerId };
  let acctId = null;
  try {
    const ap = await db.collection("ActiveProviders").doc(providerId).get();
    if (ap.exists) {
      const d = ap.data();
      ctx.businessName =
        d.businessName || d.businessTitle || providerNameHint || providerId;
      acctId =
        d.stripeConnectAccountId || d.stripe_account_id || d.stripeAccountId || null;
    }
  } catch (e) {
    log("ctx provider fetch:", e.message);
  }

  try {
    ctx.sales = await salesSnapshot(providerId);
  } catch (e) {
    log("ctx sales:", e.message);
  }

  if (acctId) {
    const stripe = getStripe();
    if (stripe) {
      try {
        const [bal, acct, payouts] = await Promise.all([
          stripe.balance.retrieve({ stripeAccount: acctId }),
          stripe.accounts.retrieve(acctId),
          stripe.payouts.list({ limit: 5 }, { stripeAccount: acctId }),
        ]);
        const sumUsd = (arr) =>
          (arr || [])
            .filter((b) => b.currency === "usd")
            .reduce((s, b) => s + b.amount, 0) / 100;
        const sched = acct.settings && acct.settings.payouts && acct.settings.payouts.schedule;
        ctx.stripe = {
          available: sumUsd(bal.available),
          pending: sumUsd(bal.pending),
          payoutsEnabled: acct.payouts_enabled === true,
          schedule: sched
            ? { interval: sched.interval, delayDays: sched.delay_days, weeklyAnchor: sched.weekly_anchor || null }
            : null,
          recentPayouts: payouts.data.map((p) => ({
            amount: p.amount / 100,
            status: p.status,
            arrival: new Date(p.arrival_date * 1000).toISOString().slice(0, 10),
          })),
        };
      } catch (e) {
        log("ctx stripe:", e.message);
      }
    }
  }
  return ctx;
}

// Render the live context as a compact, model-friendly block.
function formatContext(ctx) {
  if (!ctx) return "";
  const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
  const lines = ["LIVE PROVIDER CONTEXT (real, current data for THIS business — use these"];
  lines.push("exact numbers for money/sales/payout questions; never invent figures):");
  lines.push(`- Business: ${ctx.businessName}`);
  if (ctx.sales) {
    const s = ctx.sales;
    lines.push(
      `- Sales today (6AM op-day): ${usd(s.today.net)} net across ${s.today.orders} orders (tips ${usd(s.today.tips)}).`,
    );
    lines.push(
      `- Sales yesterday: ${usd(s.yesterday.net)} net across ${s.yesterday.orders} orders.`,
    );
    lines.push(
      `- Last 7 days: ${usd(s.last7.net)} net across ${s.last7.orders} orders.`,
    );
    if (s.recentDays && s.recentDays.length) {
      lines.push(
        `- Recent days: ${s.recentDays.map((d) => `${d.date}=${usd(d.net)}/${d.orders}ord`).join(", ")}.`,
      );
    }
  }
  if (ctx.stripe) {
    const st = ctx.stripe;
    lines.push(
      `- Stripe balance: ${usd(st.available)} available now, ${usd(st.pending)} pending (still settling).`,
    );
    if (st.schedule) {
      lines.push(
        `- Payout schedule: ${st.schedule.interval}, funds arrive ${st.schedule.delayDays} business day(s) after a sale settles. Payouts enabled: ${st.payoutsEnabled ? "yes" : "no"}.`,
      );
    }
    if (st.recentPayouts && st.recentPayouts.length) {
      lines.push(
        `- Recent payouts to bank: ${st.recentPayouts.map((p) => `${usd(p.amount)} (${p.status}, arrives ${p.arrival})`).join("; ")}.`,
      );
    }
    lines.push(
      `- PAYOUT GUIDANCE: the "pending" balance above is what is still settling and will be paid out next on their schedule; "available" is cleared and pays out at the next scheduled run. To estimate tomorrow's deposit, use the pending/available balance and schedule — do not guess.`,
    );
  } else {
    lines.push(
      "- (No Stripe payout data available for this provider — answer payout questions generally and suggest the Payouts tab.)",
    );
  }
  return lines.join("\n");
}

const processing = new Set();

async function handleThread(threadId, data) {
  if (processing.has(threadId)) return;
  processing.add(threadId);
  try {
    const msgsSnap = await db
      .collection("aiSupportThreads")
      .doc(threadId)
      .collection("messages")
      .orderBy("at", "asc")
      .limit(40)
      .get();

    const msgs = msgsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // The newest unanswered user message is the question to answer.
    const lastUser = [...msgs].reverse().find((m) => m.from === "user" && !m.answered);
    if (!lastUser) {
      await db.collection("aiSupportThreads").doc(threadId).update({ pending: false });
      return;
    }

    const history = msgs
      .filter((m) => m.id !== lastUser.id && (m.text || "").trim())
      .map((m) => ({ from: m.from, text: m.text }));

    log(`thread ${threadId} provider=${data.providerId} q="${lastUser.text.slice(0, 60)}"`);

    // Pull real, current data for this provider (sales + Stripe payouts) so
    // money/payout questions get specific numbers. Non-fatal on failure.
    let ctxBlock = "";
    try {
      const ctx = await buildProviderContext(data.providerId, data.providerName);
      ctxBlock = formatContext(ctx);
      if (ctx.stripe) {
        log(`thread ${threadId} ctx: pending=$${ctx.stripe.pending.toFixed(2)} avail=$${ctx.stripe.available.toFixed(2)}`);
      }
    } catch (e) {
      log("context build error:", e.message);
    }

    let raw;
    try {
      raw = await runClaude(buildPrompt(data.providerName || data.providerId, ctxBlock, history, lastUser.text));
    } catch (e) {
      log("claude error:", e.message);
      raw = "";
    }

    // Parse the model's JSON (guide vs text); fall back to plain text.
    const payload = parsePayload(raw);
    const msgDoc = {
      from: "assistant",
      done: true,
      at: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (payload && payload.type === "guide" && Array.isArray(payload.steps) && payload.steps.length) {
      msgDoc.type = "guide";
      msgDoc.guide = sanitizeGuide(payload);
      msgDoc.text = payload.intro || payload.title || "Here's how:";
      log(`thread ${threadId} answered with GUIDE (${payload.steps.length} steps)`);
    } else if (payload && payload.type === "report" && payload.kind) {
      try {
        const report = await buildReport(data.providerId, payload);
        const csvData = toCSV(report.columns, report.rows);
        const safe = (report.title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-");
        msgDoc.type = "report";
        msgDoc.text = report.summary;
        // Firestore forbids nested arrays, so we ship the CSV string and the
        // iPad parses it for both the preview table and the download.
        msgDoc.report = {
          title: report.title,
          summary: report.summary,
          rowCount: report.rows.length,
          csvData, // full CSV (header + all rows)
          fileName: `${safe}-${report.from}_${report.to}.csv`,
          from: report.from,
          to: report.to,
        };
        log(`thread ${threadId} answered with REPORT ${payload.kind} (${report.rows.length} rows, ${csvData.length}B csv)`);
      } catch (e) {
        log("report error:", e.message);
        msgDoc.type = "text";
        msgDoc.text =
          "I couldn't pull that report just now — please try again, or narrow the date range.";
      }
    } else {
      msgDoc.type = "text";
      msgDoc.text =
        (payload && payload.text) ||
        (raw || "").trim() ||
        "Sorry, I didn't catch that — could you rephrase?";
      log(`thread ${threadId} answered with text (${msgDoc.text.length} chars)`);
    }

    await db.collection("aiSupportThreads").doc(threadId).collection("messages").add(msgDoc);
    await db
      .collection("aiSupportThreads")
      .doc(threadId)
      .collection("messages")
      .doc(lastUser.id)
      .update({ answered: true });
    await db.collection("aiSupportThreads").doc(threadId).update({ pending: false });
  } catch (e) {
    log("handleThread error:", e.message);
    try {
      await db.collection("aiSupportThreads").doc(threadId).update({ pending: false });
    } catch {}
  } finally {
    processing.delete(threadId);
  }
}

function start() {
  log("starting — listening for pending AI support threads…");
  db.collection("aiSupportThreads")
    .where("pending", "==", true)
    .onSnapshot(
      (snap) => {
        snap.docChanges().forEach((chg) => {
          if (chg.type === "removed") return;
          handleThread(chg.doc.id, chg.doc.data());
        });
      },
      (err) => log("snapshot error:", err.message),
    );
}

start();
