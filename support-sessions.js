/**
 * Live-support module for EventiniClaw.
 *
 * Subscribes to the top-level `supportSessions` Firestore collection
 * (written by the POS iPad when a cashier shakes the device → taps
 * "Connect with a Live Agent"). When a new session appears we post
 * an interactive Block Kit message to Slack with:
 *
 *   • Provider, staff, device, app version, pairing code
 *   • Buttons:
 *       Take Over       → claims the session (status='connected')
 *       Open Simulator  → launches Xcode iOS Simulator on this Mac
 *       End Session     → soft-cancel (status='ended')
 *
 * After "Take Over", the same message updates to expose remote-
 * command buttons. Clicking one writes an action doc to the
 * session's `actions` subcollection — the iPad has a listener that
 * picks it up and executes locally (show banner, navigate, sign-out,
 * clear cart, reload, PIN lock).
 *
 * Architecture notes:
 *   - Firebase Admin SDK uses the service account JSON at
 *     `eventini-admin-fresh/firebase-service-account.json` (already
 *     present on this Mac for other tooling). Lazily loaded so the
 *     bot still boots if the file is moved.
 *   - The Slack channel id comes from env (SUPPORT_CHANNEL). If
 *     unset we log + no-op rather than crash the bot.
 *   - Open Simulator runs `open -a Simulator` via child_process.
 *     The bot runs via launchd on Jaden's Mac so this lands locally.
 *     Optionally boots a specific UDID if SUPPORT_SIM_UDID is set.
 */
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");

let admin = null;
let db = null;

// Map of sessionId -> { channelId, ts, lastData } so we can update the
// original Slack message in place as the session progresses (waiting
// → connected → ended). `lastData` is the most recent Firestore doc
// payload — kept so the "ended" card still shows the provider name
// after the source doc drops out of our listener query.
const sessionMessages = new Map();
// Map of sessionId -> Slack user info for the agent who took over.
const sessionAgents = new Map();

function init({ logger, errorLogger, slackApp }) {
  const log = logger || console.log;
  const logError = errorLogger || console.error;

  const SUPPORT_CHANNEL = process.env.SUPPORT_CHANNEL || "";
  const SIM_UDID = process.env.SUPPORT_SIM_UDID || "";
  const SIM_APP_PATH = process.env.SUPPORT_SIM_APP_PATH || "";
  const SIM_BUNDLE_ID = process.env.SUPPORT_SIM_BUNDLE_ID || "com.eventini.pos";
  const SA_PATH =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    "/Users/jadenbro1/eventini-admin-fresh/firebase-service-account.json";

  if (!SUPPORT_CHANNEL) {
    log("[support] SUPPORT_CHANNEL not set in env — skipping support module init");
    return;
  }
  if (!fs.existsSync(SA_PATH)) {
    logError(`[support] service account not found at ${SA_PATH} — skipping init`);
    return;
  }

  try {
    admin = require("firebase-admin");
    if (!admin.apps.length) {
      const sa = JSON.parse(fs.readFileSync(SA_PATH, "utf8"));
      admin.initializeApp({
        credential: admin.credential.cert(sa),
        projectId: sa.project_id,
      });
    }
    db = admin.firestore();
  } catch (e) {
    logError("[support] firebase-admin init failed:", e.message);
    return;
  }

  log("[support] Subscribing to supportSessions (channel=" + SUPPORT_CHANNEL + ")");

  // Subscribe to in-flight sessions only. Once a session ends we
  // stop listening to it — the message in Slack still updates one
  // last time via the action handlers before we forget the mapping.
  db.collection("supportSessions")
    .where("status", "in", ["waiting", "connected"])
    .onSnapshot(
      async (snap) => {
        for (const change of snap.docChanges()) {
          const sessionId = change.doc.id;
          const data = change.doc.data();
          log(`[support] listener ${change.type} sessionId=${sessionId} status=${data.status} provider="${data.providerName || '?'}"`);
          try {
            if (change.type === "added") {
              await postSessionCard({ sessionId, data, slackApp, channelId: SUPPORT_CHANNEL });
              log(`[support] posted card for ${sessionId}`);
            } else if (change.type === "modified") {
              await updateSessionCard({ sessionId, data, slackApp });
              log(`[support] updated card for ${sessionId} → status=${data.status}`);
            } else if (change.type === "removed") {
              // session ended / cleaned up — flip card to final state
              await markCardEnded({ sessionId, slackApp });
              log(`[support] marked card ended for ${sessionId}`);
            }
          } catch (e) {
            logError(`[support] handler error for ${sessionId} type=${change.type}: ${e.message}`);
          }
        }
      },
      (err) => logError("[support] Firestore listener error:", err.message)
    );

  // ── Interactive action handlers ─────────────────────────────────
  slackApp.action(/^support_(.+)$/, async ({ ack, body, action, client, respond }) => {
    const actionId = action.action_id;
    const userId = body.user?.id;
    log(`[support] CLICK action=${actionId} user=${userId} channel=${body.channel?.id}`);
    try {
      await ack();
    } catch (e) {
      logError(`[support] ack failed for ${actionId}: ${e.message}`);
      return;
    }
    const payload = JSON.parse(action.value || "{}");
    const sessionId = payload.sessionId;
    const user = body.user;
    try {
      switch (actionId) {
        case "support_take_over":
          await handleTakeOver({ sessionId, user, slackApp, client });
          break;
        case "support_take_over_with_sim":
          // One-click: claim the session AND boot the iOS Simulator
          // on this Mac so the agent can poke around locally while
          // also driving the cashier's iPad over Firestore.
          await handleTakeOver({ sessionId, user, slackApp, client });
          await handleOpenSimulator({ user, client, channel: body.channel?.id, log, logError, simUdid: SIM_UDID, appPath: SIM_APP_PATH, bundleId: SIM_BUNDLE_ID });
          break;
        case "support_open_simulator":
          await handleOpenSimulator({ user, client, channel: body.channel?.id, log, logError, simUdid: SIM_UDID, appPath: SIM_APP_PATH, bundleId: SIM_BUNDLE_ID });
          break;
        case "support_end_session":
        case "support_cmd_end":
          await handleEndSession({ sessionId, user });
          break;
        // Remote commands — write to actions subcollection. The iPad
        // executor reads, runs locally, marks done.
        case "support_cmd_show_message":
          await openShowMessageModal({ sessionId, triggerId: body.trigger_id, client });
          break;
        case "support_cmd_navigate":
          await openNavigateModal({ sessionId, triggerId: body.trigger_id, client });
          break;
        case "support_cmd_open_simulator":
          await handleOpenSimulator({ user, client, channel: body.channel?.id, log, logError, simUdid: SIM_UDID, appPath: SIM_APP_PATH, bundleId: SIM_BUNDLE_ID });
          break;
        case "support_cmd_sign_out":
          await issueAction(sessionId, "sign_out", {}, user);
          break;
        case "support_cmd_clear_cart":
          await issueAction(sessionId, "clear_cart", {}, user);
          break;
        case "support_cmd_reload":
          await issueAction(sessionId, "reload_app", {}, user);
          break;
        case "support_cmd_pin_lock":
          await issueAction(sessionId, "force_pin_lock", {}, user);
          break;
        default:
          log("[support] Unknown action:", actionId);
      }
    } catch (e) {
      logError(`[support] action ${actionId} failed:`, e.message);
    }
  });

  // ── View submission handlers (modals for typing free-form input) ─
  // Ack FIRST (Slack's 3s ack window is tight). Any throw AFTER ack
  // logs but doesn't surface as a modal error — the user sees the
  // modal close and either a toast on iPad (success) or no-op.
  slackApp.view("support_view_show_message", async ({ ack, body, view }) => {
    await ack();
    try {
      const sessionId = view.private_metadata;
      const value = view.state.values?.body_block?.body_input?.value || "";
      log(`[support] show_message submit sessionId=${sessionId} len=${value.length}`);
      if (!sessionId || !value) return;
      await issueAction(sessionId, "show_message", { text: value }, body.user);
    } catch (e) {
      logError("[support] show_message submission failed:", e.message);
    }
  });

  slackApp.view("support_view_navigate", async ({ ack, body, view }) => {
    await ack();
    try {
      const sessionId = view.private_metadata;
      const path = view.state.values?.path_block?.path_input?.value || "";
      const label = view.state.values?.label_block?.label_input?.value || path;
      log(`[support] navigate submit sessionId=${sessionId} path=${path}`);
      if (!sessionId || !path) return;
      await issueAction(sessionId, "navigate_to", { path, label }, body.user);
    } catch (e) {
      logError("[support] navigate submission failed:", e.message);
    }
  });
}

// ─── Slack card composition ────────────────────────────────────────

function buildCardBlocks({ sessionId, data, ended = false }) {
  const code = String(data.code || "----");
  const connected = data.status === "connected";
  const headerText = ended
    ? `:white_check_mark: Session ended · ${data.providerName || "Unknown"}`
    : connected
    ? `:satellite_antenna: Live with ${data.agentName || "agent"} · ${data.providerName || "Unknown"}`
    : `:rotating_light: New support request · ${data.providerName || "Unknown"}`;

  const fields = [
    `*Provider:* ${data.providerName || "—"}`,
    `*Staff:* ${data.staffName || "—"}`,
    `*Device:* ${data.deviceName || data.deviceId || "—"}`,
    `*App:* v${data.appVersion || "—"}`,
    `*Platform:* ${data.platform || "—"}`,
    `*Pair code:* \`${code.slice(0, 2)} ${code.slice(2, 4)}\``,
  ];

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: headerText, emoji: true },
    },
    {
      type: "section",
      fields: fields.map((f) => ({ type: "mrkdwn", text: f })),
    },
    { type: "divider" },
  ];

  if (ended) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Ended ${data.endedReason ? `(${data.endedReason})` : ""}` },
      ],
    });
    return blocks;
  }

  if (!connected) {
    // Pre-takeover: 4 buttons. "Take Over + Sim" is the one-click
    // "I want to debug this — get me in" — it claims the session
    // AND boots the iOS Simulator on the Mac in one shot.
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Take Over", emoji: true },
          action_id: "support_take_over",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "🖥️ Take Over + Sim", emoji: true },
          action_id: "support_take_over_with_sim",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Open Simulator", emoji: true },
          action_id: "support_open_simulator",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "End", emoji: true },
          action_id: "support_end_session",
          value: JSON.stringify({ sessionId }),
        },
      ],
    });
  } else {
    // Post-takeover: command palette
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: "*Remote commands* — the cashier sees each action happen on their iPad." },
      ],
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "💬 Show Message", emoji: true },
          action_id: "support_cmd_show_message",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "➡️ Navigate", emoji: true },
          action_id: "support_cmd_navigate",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🛒 Clear Cart", emoji: true },
          action_id: "support_cmd_clear_cart",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🖥️ Open Simulator", emoji: true },
          action_id: "support_cmd_open_simulator",
          value: JSON.stringify({ sessionId }),
        },
      ],
    });
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "🔒 PIN Lock", emoji: true },
          action_id: "support_cmd_pin_lock",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🚪 Sign Out", emoji: true },
          action_id: "support_cmd_sign_out",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "🔄 Reload App", emoji: true },
          action_id: "support_cmd_reload",
          value: JSON.stringify({ sessionId }),
        },
        {
          type: "button",
          style: "danger",
          text: { type: "plain_text", text: "✖️ End Session", emoji: true },
          action_id: "support_cmd_end",
          value: JSON.stringify({ sessionId }),
        },
      ],
    });
  }

  return blocks;
}

async function postSessionCard({ sessionId, data, slackApp, channelId }) {
  const blocks = buildCardBlocks({ sessionId, data });
  const res = await slackApp.client.chat.postMessage({
    channel: channelId,
    text: `New POS support request from ${data.providerName || "Unknown"}`,
    blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  sessionMessages.set(sessionId, { channelId, ts: res.ts, lastData: data });
}

async function updateSessionCard({ sessionId, data, slackApp }) {
  const ref = sessionMessages.get(sessionId);
  if (!ref) return;
  ref.lastData = data;
  const blocks = buildCardBlocks({ sessionId, data });
  await slackApp.client.chat.update({
    channel: ref.channelId,
    ts: ref.ts,
    text: `POS support session · ${data.providerName || "Unknown"}`,
    blocks,
  });
}

async function markCardEnded({ sessionId, slackApp }) {
  const ref = sessionMessages.get(sessionId);
  if (!ref) return;
  // Merge the last-known doc data with `status: ended` so the ended
  // card shows the original provider / staff / device info instead of
  // a row of dashes (the data is no longer in the active-status
  // listener query, so we have to fall back to our cache).
  const merged = { ...(ref.lastData || {}), status: "ended" };
  const blocks = buildCardBlocks({ sessionId, data: merged, ended: true });
  try {
    await slackApp.client.chat.update({
      channel: ref.channelId,
      ts: ref.ts,
      text: `POS support session ended · ${merged.providerName || ""}`,
      blocks,
    });
  } catch { /* message may be gone */ }
  sessionMessages.delete(sessionId);
  sessionAgents.delete(sessionId);
}

// ─── Action handlers ───────────────────────────────────────────────

async function handleTakeOver({ sessionId, user, slackApp }) {
  if (!db) return;
  const ref = db.collection("supportSessions").doc(sessionId);
  await ref.update({
    status: "connected",
    agentId: user.id,
    agentName: user.username || user.name || "Eventini Support",
    connectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  sessionAgents.set(sessionId, user);
}

async function handleOpenSimulator({ user, client, channel, log, logError, simUdid, appPath, bundleId }) {
  // The cashier's iPad simulator is already booted on this Mac — we
  // need a SECOND, separate simulator (the "agent sim") to surface
  // a fresh window the agent can drive independently. Steps:
  //   1) Boot the agent UDID (no-op if already booted)
  //   2) Open Simulator.app so the window appears on screen
  //   3) (If we have an .app path) install + launch the POS app on
  //      the agent sim so the agent doesn't have to fish around for
  //      Xcode. Done sequentially because install must finish before
  //      launch can target the bundle id.
  const run = (cmd) => new Promise((resolve) => exec(cmd, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout, stderr })));

  let statusLines = [];

  if (simUdid) {
    const r = await run(`xcrun simctl boot ${simUdid}`);
    // Apple's actual error message is "Unable to boot device in
    // current state: Booted" (NOT "already booted"). Match either
    // string + the SimError code 405 so we can't false-alarm on a
    // sim that's already running.
    const alreadyBooted = r.err && (
      /already booted/i.test(r.err.message)
      || /current state:\s*Booted/i.test(r.err.message)
      || /code=405/i.test(r.err.message)
    );
    if (alreadyBooted) {
      statusLines.push(":white_check_mark: agent simulator already running");
    } else if (r.err) {
      logError("[support] simctl boot failed:", r.err.message);
      statusLines.push(`:warning: boot failed: ${r.err.message.split("\n")[0]}`);
    } else {
      statusLines.push(":white_check_mark: agent simulator booted");
    }
  }

  // Open Simulator.app and force-focus the agent's UDID so the right
  // device window comes to front (Simulator opens the last-active by
  // default, which would surface the cashier's iPad).
  const openCmd = simUdid
    ? `open -a Simulator --args -CurrentDeviceUDID ${simUdid}`
    : "open -a Simulator";
  const openRes = await run(openCmd);
  if (openRes.err) {
    logError("[support] open Simulator failed:", openRes.err.message);
    statusLines.push(`:warning: open Simulator failed: ${openRes.err.message}`);
  } else {
    log(`[support] Simulator opened for ${user.username || user.id}`);
    statusLines.push(":tv: Simulator window opened");
  }

  // Install + launch the EventiniPoS app if we have a build on disk.
  if (simUdid && appPath && fs.existsSync(appPath)) {
    log(`[support] installing ${appPath} onto ${simUdid}`);
    const inst = await run(`xcrun simctl install ${simUdid} "${appPath}"`);
    if (inst.err) {
      logError("[support] simctl install failed:", inst.err.message);
      statusLines.push(`:warning: app install failed: ${inst.err.message.split("\n")[0]}`);
    } else {
      log(`[support] install OK, launching ${bundleId}`);
      statusLines.push(":package: EventiniPoS installed");
      const launched = await run(`xcrun simctl launch ${simUdid} ${bundleId}`);
      if (launched.err) {
        logError("[support] simctl launch failed:", launched.err.message);
        statusLines.push(`:warning: app launch failed: ${launched.err.message.split("\n")[0]}`);
      } else {
        log(`[support] launch OK: ${launched.stdout?.trim()}`);
        statusLines.push(":rocket: EventiniPoS launched");
      }
    }
  } else if (appPath) {
    log(`[support] app bundle missing at ${appPath}`);
    statusLines.push(`:warning: app bundle not at ${appPath} — open Xcode and run once to rebuild`);
  }

  try {
    await client.chat.postEphemeral({
      channel,
      user: user.id,
      text: statusLines.join("\n"),
    });
  } catch { /* not critical */ }
}

async function handleEndSession({ sessionId, user }) {
  if (!db) return;
  const ref = db.collection("supportSessions").doc(sessionId);
  await ref.update({
    status: "ended",
    endedReason: "agent_ended",
    endedAt: admin.firestore.FieldValue.serverTimestamp(),
    endedByAgentId: user.id,
  });
}

async function issueAction(sessionId, type, payload, user) {
  if (!db) return;
  await db
    .collection("supportSessions")
    .doc(sessionId)
    .collection("actions")
    .add({
      type,
      payload,
      status: "pending",
      issuedBy: user.username || user.name || "Eventini Support",
      issuedByAgentId: user.id,
      issuedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
}

// ─── Modals (free-form input commands) ────────────────────────────

async function openShowMessageModal({ sessionId, triggerId, client }) {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "support_view_show_message",
      private_metadata: sessionId,
      title: { type: "plain_text", text: "Show Message" },
      submit: { type: "plain_text", text: "Send to iPad" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "body_block",
          label: { type: "plain_text", text: "Message" },
          element: {
            type: "plain_text_input",
            action_id: "body_input",
            multiline: true,
            placeholder: { type: "plain_text", text: "e.g. We're looking into this — hang tight!" },
          },
        },
      ],
    },
  });
}

async function openNavigateModal({ sessionId, triggerId, client }) {
  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "support_view_navigate",
      private_metadata: sessionId,
      title: { type: "plain_text", text: "Navigate iPad" },
      submit: { type: "plain_text", text: "Go" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "path_block",
          label: { type: "plain_text", text: "Route" },
          element: {
            type: "plain_text_input",
            action_id: "path_input",
            placeholder: { type: "plain_text", text: "/(main)/dashboard" },
          },
        },
        {
          type: "input",
          block_id: "label_block",
          optional: true,
          label: { type: "plain_text", text: "Friendly name (optional)" },
          element: {
            type: "plain_text_input",
            action_id: "label_input",
            placeholder: { type: "plain_text", text: "Dashboard" },
          },
        },
      ],
    },
  });
}

module.exports = { init };
