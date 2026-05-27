const { App } = require("@slack/bolt");
const { spawn } = require("child_process");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// Direct-write logging that bypasses stdout buffering (launchd issue)
// All activity goes to activity.log, errors to activity-error.log
const ACTIVITY_LOG = path.join(__dirname, "activity.log");
const ACTIVITY_ERR = path.join(__dirname, "activity-error.log");

function log(...args) {
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const msg = `[${ts}] ${args.map(String).join(" ")}\n`;
  try {
    fs.appendFileSync(ACTIVITY_LOG, msg);
  } catch {
    // fallback
  }
}

function logError(...args) {
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const msg = `[${ts}] ${args.map(String).join(" ")}\n`;
  try {
    fs.appendFileSync(ACTIVITY_ERR, msg);
  } catch {
    // fallback
  }
}

// ============================================================
// SINGLE-INSTANCE LOCK (prevents duplicate processes)
// ============================================================

const LOCK_FILE = path.join(__dirname, "bot.lock");

function acquireLock() {
  try {
    // Check if lock file exists and if the PID in it is still alive
    if (fs.existsSync(LOCK_FILE)) {
      const oldPid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (oldPid) {
        try {
          process.kill(oldPid, 0); // signal 0 = just check if alive
          console.error(`Another bot instance is already running (PID ${oldPid}). Exiting.`);
          process.exit(1);
        } catch {
          // Old process is dead — stale lock, we can take over
        }
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
  } catch (err) {
    console.error("Failed to acquire lock:", err.message);
    process.exit(1);
  }
}

function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(LOCK_FILE, "utf8").trim(), 10);
      if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

acquireLock();
process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseLock(); process.exit(0); });

// ============================================================
// CONFIG & SETUP
// ============================================================

const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}


const CLAUDE_PATH = "/Users/jadenbro1/.local/bin/claude";
const SESSIONS_FILE = path.join(__dirname, "sessions.json");
const MEMORY_DIR = path.join(__dirname, "memory");
const TEMP_DIR = path.join(os.tmpdir(), "slack-claude-bot");

// Model tiering — save tokens by using cheaper models where possible
const MODEL_HAIKU = "haiku";
const MODEL_SONNET = "sonnet";

// Ensure temp directory exists
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// File type detection
const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/x-m4a",
  "audio/mp3",
  "audio/aac",
]);

// Ensure memory directory exists
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

// Initialize global memory file
const GLOBAL_MEMORY = path.join(MEMORY_DIR, "slack_global.md");
if (!fs.existsSync(GLOBAL_MEMORY)) {
  fs.writeFileSync(
    GLOBAL_MEMORY,
    `# EventiniClaw Global Memory

This file stores context that applies across all Slack channels.
Update this file when you learn important cross-channel context about Eventini, the team, or ongoing initiatives.
`
  );
}

// Slack channel IDs
const CHANNELS = {
  "cloud-report": "C0AP1JGKA03",
  "health-report": "C0AQ28LB9B2",
  "pos-report": "C0AP5TVL4EA",
  "event-report": "C0AQ28JMH6U",
  "transaction-log": "C0APM3GF3B3",
  "marketplace-builder": "C0AQ2FHSKMW",
  "admin-builder": "C0ANSPXF6QP",
  "app-builder": "C0AP87ALJ1Y",
  "pos-app": "C0AP4SDTK61",
};

// Reverse lookup: channel ID -> name
const CHANNEL_NAMES = {};
for (const [name, id] of Object.entries(CHANNELS)) {
  CHANNEL_NAMES[id] = name;
}

// Builder channel config
const BUILDER_CHANNELS = {
  C0AQ2FHSKMW: {
    name: "marketplace-builder",
    projectPath: "/Users/jadenbro1/Desktop/EVENTINI-MARKETPLACE",
    projectName: "EVENTINI-MARKETPLACE",
    autoPush: false,
    vercel: true,
    appStore: false,
  },
  C0ANSPXF6QP: {
    name: "admin-builder",
    projectPath: "/Users/jadenbro1/Desktop/eventini-admin",
    projectName: "eventini-admin",
    autoPush: false,
    vercel: true,
    appStore: false,
  },
  C0AP87ALJ1Y: {
    name: "app-builder",
    projectPath: "/Users/jadenbro1/EventiniMockUp",
    projectName: "EventiniMockUp",
    autoPush: false,
    vercel: false,
    appStore: true,
    scheme: "EventiniMockUp",
    workspace: "ios/EventiniMockUp.xcworkspace",
    xcodeproj: "ios/EventiniMockUp.xcodeproj",
  },
  C0AP4SDTK61: {
    name: "pos-app",
    projectPath: "/Users/jadenbro1/EventiniPOS_local",
    projectName: "EventiniPOS Local",
    autoPush: false,
    vercel: false,
    appStore: true,
    scheme: "EventiniPoS",
    workspace: "ios/EventiniPoS.xcworkspace",
    xcodeproj: "ios/EventiniPoS.xcodeproj",
  },
};

// ============================================================
// SESSION MANAGEMENT (persisted to disk)
// Sessions auto-rotate after MAX_SESSION_MESSAGES to prevent context bloat
// ============================================================

const MAX_SESSION_MESSAGES = 20; // Start fresh session after this many messages
const SESSION_COUNTS_FILE = path.join(__dirname, "session-counts.json");

function loadSessions() {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSessions(sessions) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function loadSessionCounts() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_COUNTS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveSessionCounts(counts) {
  fs.writeFileSync(SESSION_COUNTS_FILE, JSON.stringify(counts));
}

function getSessionId(key) {
  return loadSessions()[key] || null;
}

function setSessionId(key, id) {
  const s = loadSessions();
  s[key] = id;
  saveSessions(s);
}

function incrementSessionCount(key) {
  const counts = loadSessionCounts();
  counts[key] = (counts[key] || 0) + 1;
  saveSessionCounts(counts);
  return counts[key];
}

function shouldRotateSession(key) {
  const counts = loadSessionCounts();
  return (counts[key] || 0) >= MAX_SESSION_MESSAGES;
}

function clearSession(key) {
  const s = loadSessions();
  delete s[key];
  saveSessions(s);
  // Also reset the message count
  const counts = loadSessionCounts();
  delete counts[key];
  saveSessionCounts(counts);
}

// ============================================================
// FILE DOWNLOAD & TRANSCRIPTION
// ============================================================

// Download a file from Slack (follows redirects, authenticated)
function downloadSlackFile(url) {
  return new Promise((resolve, reject) => {
    const doGet = (targetUrl) => {
      const parsed = new URL(targetUrl);
      const options = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
      };
      https
        .get(options, (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            doGet(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        })
        .on("error", reject);
    };
    doGet(url);
  });
}

// Transcribe audio using local Whisper (no API key needed)
function transcribeAudio(audioBuffer, filename) {
  return new Promise((resolve, reject) => {
    // Save audio to temp file
    const ext = filename.split(".").pop() || "webm";
    const audioPath = path.join(
      TEMP_DIR,
      `voice_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
    );
    fs.writeFileSync(audioPath, audioBuffer);

    const outputDir = TEMP_DIR;
    const proc = spawn(
      "/opt/homebrew/bin/whisper",
      [
        audioPath,
        "--model",
        "base",
        "--language",
        "en",
        "--output_format",
        "txt",
        "--output_dir",
        outputDir,
      ],
      { cwd: TEMP_DIR, env: { ...process.env, HOME: os.homedir() } }
    );

    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      // Read the output .txt file (whisper names it based on input filename)
      const baseName = path.basename(audioPath, `.${ext}`);
      const txtPath = path.join(outputDir, `${baseName}.txt`);

      try {
        if (fs.existsSync(txtPath)) {
          const text = fs.readFileSync(txtPath, "utf8").trim();
          // Clean up temp files
          try {
            fs.unlinkSync(audioPath);
            fs.unlinkSync(txtPath);
          } catch {}
          if (text) {
            resolve(text);
          } else {
            reject(new Error("Whisper returned empty transcription"));
          }
        } else {
          reject(
            new Error(
              `Whisper failed (code ${code}): ${stderr.slice(-200)}`
            )
          );
        }
      } catch (err) {
        reject(new Error(`Transcription read error: ${err.message}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Whisper spawn error: ${err.message}`));
    });
  });
}

// Clean up temp files older than 1 hour
function cleanupTempFiles() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < oneHourAgo) {
        fs.unlinkSync(filePath);
      }
    }
  } catch {}
}

setInterval(cleanupTempFiles, 30 * 60 * 1000);

// ============================================================
// MEMORY FILES (per-channel)
// ============================================================

function getChannelMemoryPath(channelId) {
  return path.join(MEMORY_DIR, `channel_${channelId}.md`);
}

function ensureChannelMemory(channelId) {
  const memPath = getChannelMemoryPath(channelId);
  if (!fs.existsSync(memPath)) {
    const channelName = CHANNEL_NAMES[channelId] || channelId;
    fs.writeFileSync(
      memPath,
      `# Channel Memory: #${channelName}

This file stores context and conversation history for this channel.
Update this file after completing tasks or learning important context.
Track: what you've worked on, decisions made, current state, and key context.
`
    );
  }
  return memPath;
}

// ============================================================
// CONCURRENCY QUEUE (max 2 Claude processes at once)
// ============================================================

const MAX_CONCURRENT = 2;
let activeCount = 0;
const claudeQueue = [];

function enqueueClaude(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeCount++;
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      } finally {
        activeCount--;
        if (claudeQueue.length > 0) claudeQueue.shift()();
      }
    };
    if (activeCount < MAX_CONCURRENT) {
      run();
    } else {
      claudeQueue.push(run);
    }
  });
}

// ============================================================
// PER-CHANNEL BUSY TRACKING
// Prevents new Claude processes from starting while one is already running
// for the same channel. Queues the latest pending message instead.
// ============================================================

const busyChannels = new Set();
const pendingMessages = new Map(); // channelId -> { event, client }

function processNextPending(channelId, client) {
  const pending = pendingMessages.get(channelId);
  if (pending) {
    pendingMessages.delete(channelId);
    log(`[BUSY] Processing queued message for #${CHANNEL_NAMES[channelId] || channelId}`);
    handleMessage(pending.event, pending.client).catch((err) => {
      logError(`[BUSY] Error processing queued message: ${err.message}`);
    });
  }
}

// ============================================================
// CLAUDE CLI RUNNER
// ============================================================

function runClaude(prompt, sessionKey, timeoutMs = 600000, cwd = null, opts = {}) {
  return enqueueClaude(() =>
    _runClaudeInternal(prompt, sessionKey, timeoutMs, cwd, 0, opts)
  );
}

const MAX_RETRIES = 3;
const RETRY_DELAYS = [5000, 10000, 15000]; // escalating backoff

function _runClaudeInternal(prompt, sessionKey, timeoutMs, cwd, retryCount = 0, opts = {}) {
  return new Promise((resolve, reject) => {
    // Auto-rotate session if it's gotten too long
    if (sessionKey && shouldRotateSession(sessionKey)) {
      log(`[SESSION] Rotating ${sessionKey} after ${MAX_SESSION_MESSAGES} messages`);
      clearSession(sessionKey);
    }

    const existingSession =
      sessionKey && retryCount === 0 ? getSessionId(sessionKey) : null;

    const tools = opts.tools || "Bash,Read,Write,Edit,Glob,Grep";
    const budget = opts.budget || "5.00";
    // Prompt is sent via stdin (not argv) so user text starting with "--"
    // isn't mis-parsed by Claude CLI's argparser (e.g. "--prod" collapsing
    // into "--print/--resume" prefix matches and eating later args).
    const args = [
      "-p",
      "--allowedTools",
      tools,
      "--output-format",
      "json",
      "--max-budget-usd",
      budget,
    ];

    if (opts.model) args.push("--model", opts.model);
    if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));

    if (existingSession) {
      args.push("--resume", existingSession);
    }

    log(`[CLAUDE] Starting (attempt ${retryCount + 1}/${MAX_RETRIES + 1}, budget: $${budget}, session: ${existingSession ? "resume" : "new"}, key: ${sessionKey})`);

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: cwd || os.homedir(),
      env: { ...process.env, HOME: os.homedir() },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.write(prompt);
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, timeoutMs);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      clearTimeout(timer);

      // Helper: retry with backoff if attempts remain
      const maybeRetry = (reason) => {
        if (retryCount < MAX_RETRIES) {
          const delay = RETRY_DELAYS[retryCount] || 15000;
          log(`[CLAUDE] ${reason} for ${sessionKey}, retry ${retryCount + 1}/${MAX_RETRIES} in ${delay / 1000}s...`);
          if (sessionKey) clearSession(sessionKey);
          setTimeout(() => {
            _runClaudeInternal(prompt, sessionKey, timeoutMs, cwd, retryCount + 1, opts)
              .then(resolve)
              .catch(reject);
          }, delay);
          return true;
        }
        return false;
      };

      // Killed by timeout
      if (code === 143 || code === null) {
        if (!maybeRetry("Timeout")) {
          reject(new Error("Request timed out after multiple attempts. Try a simpler request."));
        }
        return;
      }

      // Try to parse JSON output
      let result = null;
      try {
        result = JSON.parse(stdout);
      } catch {
        // Try last line (in case of stream output)
        const lines = stdout.trim().split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            result = JSON.parse(lines[i]);
            break;
          } catch {
            continue;
          }
        }
      }

      if (result) {
        // Save session ID and increment message count for rotation tracking
        if (sessionKey && result.session_id) {
          setSessionId(sessionKey, result.session_id);
          const count = incrementSessionCount(sessionKey);
          if (count >= MAX_SESSION_MESSAGES - 3) {
            log(`[SESSION] ${sessionKey} at ${count}/${MAX_SESSION_MESSAGES} messages — rotating soon`);
          }
        }

        if (result.is_error) {
          const errorMsg = result.result || "Claude returned an error";
          log(`[CLAUDE] Error response: ${errorMsg}`);

          // Retry on API errors or session resume failures
          const isRetryable = /no_text|overloaded|rate_limit|internal_error|server_error|capacity/i.test(errorMsg)
            || existingSession; // session resume failures are always retryable

          if (isRetryable && maybeRetry(`API error: ${errorMsg}`)) {
            return;
          }
          reject(new Error(errorMsg));
        } else {
          resolve(result.result || "");
        }
      } else {
        // Could not parse JSON at all
        if (code !== 0 && !stdout.trim()) {
          if (maybeRetry(`Non-zero exit (code ${code})`)) {
            return;
          }
          reject(new Error(stderr || `claude exited with code ${code}`));
        } else {
          resolve(stdout.trim());
        }
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ============================================================
// SYSTEM PROMPTS
// ============================================================

const FORMATTING_RULES = `SLACK FORMATTING: *bold* (not **), _italic_, \`code\`, \`\`\`blocks\`\`\`. No markdown tables/headings. Links: <url|text>. Bullets: •. Only emojis: ✅ ❌. Be concise.`;

// Hard rules for any answer that quotes a dollar figure to a CS rep or
// provider. Born from the SapSap thread (Apr 2026) where the bot dumped
// 1,500 words on sweep schedules, 3-day windows, and FIFO logic — none
// of which a provider could act on. Provider-facing answers must lead
// with the number, qualify the timeframe + scope (so nobody reads "1
// month" as "calendar April"), and stop. Drill-downs only on request.
const NUMBER_ANSWER_RULES = `
NUMBER-QUOTING RULES (when answering anything that includes a $ amount):
1. *Lead with the number, qualified by timeframe + scope.* Format:
   "*$X,XXX.XX* — <metric>, <date range>, <location/provider scope>."
   e.g. "*$9,375.06* — Net Revenue, Apr 1–28 2026 (calendar April), SapSap all locations."
2. *State the timeframe explicitly* (calendar month vs rolling 30 days vs week, etc.).
   The dashboard's "1M" pill = LAST 30 DAYS, not calendar month — say so.
3. *Cap the answer at ~120 words* unless the user explicitly asks for a breakdown.
   No background on sweep schedules, 3-day settlement windows, FIFO, dynamic
   reserves, or compliance unless asked. Those go behind a one-line
   "_Reply 'breakdown' for the full settlement walkthrough._" footer.
4. *Never compare two numbers without flagging timeframe alignment.* If
   provider asks "why is dashboard $X but report $Y," check whether the
   two surfaces use the same date window before explaining anything else.
5. *Reconciliation always shows provenance:* POS gross, ghost refunds
   excluded, Stripe processing fees, payouts to bank — in that order, on
   separate lines. No multi-paragraph prose.`;

function buildSystemPrompt(channelId) {
  const channelName = CHANNEL_NAMES[channelId] || "direct-message";
  const channelMemPath = ensureChannelMemory(channelId);

  return `You are EventiniClaw, Eventini's engineering assistant in Slack (#${channelName}).
Eventini = event planning marketplace (hosts + providers). Firebase: eventini-746af. Stripe Connect.
Projects: EventiniMockUp (RN mobile), EVENTINI-MARKETPLACE (Next.js/Vercel), eventini-admin (Next.js), EventiniPOS_local (RN POS), Pina-Eventini (Vite).
Memory: read ${GLOBAL_MEMORY} and ${channelMemPath} for context. Update after significant tasks.
${FORMATTING_RULES}
${NUMBER_ANSWER_RULES}
Answer directly. Full system access.`;
}

function buildBuilderSystemPrompt(config) {
  const channelMemPath = ensureChannelMemory(
    Object.keys(BUILDER_CHANNELS).find(
      (k) => BUILDER_CHANNELS[k].name === config.name
    ) || ""
  );

  return `You are EventiniClaw, senior full-stack engineer on ${config.projectName}.
Path: ${config.projectPath}. Memory: ${GLOBAL_MEMORY}, ${channelMemPath}. Read for context, update after tasks.
${FORMATTING_RULES}
Can: read/edit/create files, git add/commit/push.${config.vercel ? " Deploy: npx vercel --prod --yes." : ""}${config.appStore ? " TestFlight: bundle exec fastlane beta." : ""}
Workflow: edit -> git add -A && git commit -> tell user to "push".${config.appStore ? ' Or "deploy to testflight".' : ""}
Make clean, production-quality edits.`;
}

const SLACK_FORMAT_RULE = `Output goes directly to Slack. ${FORMATTING_RULES}\n\n`;

// Load report prompts
function loadPrompt(name) {
  const content = fs.readFileSync(
    path.join(__dirname, "reports", `${name}.txt`),
    "utf8"
  );
  return SLACK_FORMAT_RULE + content;
}

// ============================================================
// FORMATTING & OUTPUT
// ============================================================

// Convert markdown to Slack mrkdwn
function markdownToSlack(text) {
  let out = text;

  // Convert markdown links [text](url) -> <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Protect code blocks and inline code
  const codeBlocks = [];
  out = out.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `__CODEBLOCK_${codeBlocks.length - 1}__`;
  });
  const inlineCode = [];
  out = out.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `__INLINE_${inlineCode.length - 1}__`;
  });

  // Convert **bold** -> *bold*
  out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");

  // Convert ### heading -> *heading*
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert markdown tables to code blocks
  out = out.replace(/((?:^\|.+\|$\n?){2,})/gm, (table) => {
    return (
      "```\n" +
      table.replace(/^\||\|$/gm, "").replace(/\|/g, " | ") +
      "```"
    );
  });

  // Restore code blocks and inline code
  out = out.replace(/__INLINE_(\d+)__/g, (_, i) => inlineCode[i]);
  out = out.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => codeBlocks[i]);

  return out;
}

// Strip emojis except ✅ and ❌
function stripEmojis(text) {
  let out = text;

  // Protect code blocks
  const blocks = [];
  out = out.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `__EBLOCK_${blocks.length - 1}__`;
  });

  // Remove Unicode emojis (preserve ✅ U+2705 and ❌ U+274C)
  out = out.replace(
    /[\u{1F300}-\u{1F9FF}\u{1FA00}-\u{1FAFF}\u{2600}-\u{26FF}]/gu,
    ""
  );
  out = out.replace(/[\u{2700}-\u{27BF}]/gu, (ch) =>
    ch === "\u2705" || ch === "\u274C" ? ch : ""
  );
  out = out.replace(/\u{FE0F}/gu, "");

  // Remove Slack :emoji: syntax except :x: and :white_check_mark:
  out = out.replace(/:[a-z0-9_+-]+:/g, (match) => {
    if (match === ":x:" || match === ":white_check_mark:") return match;
    return "";
  });

  // Collapse extra spaces (not in code blocks)
  out = out.replace(/ {2,}/g, " ");

  // Restore code blocks
  out = out.replace(/__EBLOCK_(\d+)__/g, (_, i) => blocks[i]);

  return out;
}

// Full output pipeline: markdown -> slack -> strip emojis
function formatForSlack(text) {
  return stripEmojis(markdownToSlack(text));
}

// Split long messages for Slack's 4000 char limit
function splitMessage(text, limit = 3900) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// Post formatted message to a channel
async function postToChannel(client, channelId, text) {
  const formatted = formatForSlack(text);
  const chunks = splitMessage(formatted);
  for (const chunk of chunks) {
    await client.chat.postMessage({ channel: channelId, text: chunk });
  }
}

// ============================================================
// MESSAGE DEDUPLICATION
// ============================================================

const processedMessages = new Set();

function isDuplicate(channel, ts) {
  const key = `${channel}:${ts}`;
  if (processedMessages.has(key)) return true;
  processedMessages.add(key);
  // Prune old entries
  if (processedMessages.size > 500) {
    const arr = [...processedMessages];
    processedMessages.clear();
    arr.slice(-250).forEach((k) => processedMessages.add(k));
  }
  return false;
}

// ============================================================
// SLACK APP
// ============================================================

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// Store our own bot user ID to strip from messages
let botUserId = null;

// Transaction logging is now handled by Firebase Cloud Functions (stripeWebhook)
// Events are now handled by Firestore triggers (notifySlackOnNewEvent)
// No more polling — real-time via webhooks

// ============================================================
// SCHEDULED REPORTS — Daily at 8am
// ============================================================

async function runScheduledReport(reportName) {
  const channelId = CHANNELS[reportName];
  if (!channelId) {
    logError(`No channel ID for report: ${reportName}`);
    return;
  }

  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/Chicago",
  });
  log(`[${now}] Running scheduled report: ${reportName}`);

  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: `_Generating ${reportName}..._`,
    });

    const prompt = loadPrompt(reportName);
    // Reports: sonnet + max 5 turns, read-only tools
    const response = await runClaude(prompt, null, 600000, null, {
      model: MODEL_SONNET,
      maxTurns: 5,
      tools: "Bash,Read,Glob,Grep",
      budget: "10.00",
    });

    if (reportName === "pos-report" && response.includes("===SPLIT===")) {
      const [section1, section2] = response.split("===SPLIT===");
      await postToChannel(app.client, channelId, section1.trim());
      await postToChannel(app.client, channelId, section2.trim());
    } else {
      await postToChannel(app.client, channelId, response);
    }

    log(`[${now}] Report ${reportName} completed`);
  } catch (err) {
    logError(`Report ${reportName} failed:`, err.message);
    await app.client.chat.postMessage({
      channel: channelId,
      text: `❌ ${reportName} failed: ${err.message}`,
    });
  }
}

// Clear all sessions daily at 7:50am — prevents context from ballooning over days
cron.schedule("50 7 * * *", () => {
  fs.writeFileSync(SESSIONS_FILE, "{}");
  fs.writeFileSync(SESSION_COUNTS_FILE, "{}");
  log("Sessions and message counts cleared for new day");
});

// 8am daily reports removed — they spawned Claude sessions that failed/timed out.
// Use /report <name> in Slack to run reports on demand instead.

// New event detection is now handled by Firebase Cloud Functions (notifySlackOnNewEvent)
// No more Claude-powered polling — Firestore trigger fires instantly on event creation

// ============================================================
// /report COMMAND
// ============================================================

const REPORT_MENU = `*Choose a report to run:*

1. \`cloud\` — Cloud Functions, errors, scheduled tasks, Firestore indexes
2. \`health\` — General system health, all services status
3. \`pos\` — Stripe transactions, balances, payouts, revenue
4. \`event\` — All events, provider requests, estimated payouts
5. \`all\` — Run all 4 reports
6. \`custom\` — Describe what you want and I'll generate a custom report

Reply with the name or number.`;

const pendingReportSelections = new Map();

// ============================================================
// CORE MESSAGE HANDLER (handles ALL messages — channels, DMs, @mentions)
// ============================================================

async function handleMessage(event, client) {
  // Skip bot messages and non-file subtypes (joins, leaves, etc.)
  if (event.bot_id) return;
  if (event.subtype && event.subtype !== "file_share") return;

  // Deduplicate (prevents double-handling from message + app_mention events)
  if (isDuplicate(event.channel, event.ts)) return;

  const channel = event.channel;

  // If this channel is already processing a Claude request, queue the message
  // instead of starting a second parallel process that may timeout or conflict
  if (busyChannels.has(channel)) {
    log(`[BUSY] #${CHANNEL_NAMES[channel] || channel} is busy, queuing message: "${(event.text || "").slice(0, 60)}"`);
    pendingMessages.set(channel, { event, client });
    return;
  }
  let text = (event.text || "").trim();

  // Strip bot @mention from text
  if (botUserId) {
    text = text.replace(new RegExp(`<@${botUserId}>`, "g"), "").trim();
  }
  // Also strip any @mention pattern just in case
  text = text.replace(/<@[A-Z0-9]+>/g, "").trim();

  // Process attached files (images + voice messages)
  const imagePaths = [];
  let voiceTranscription = "";

  if (event.files && event.files.length > 0) {
    for (const file of event.files) {
      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) continue;

      try {
        const buffer = await downloadSlackFile(downloadUrl);

        if (IMAGE_TYPES.has(file.mimetype)) {
          const ext = file.name?.split(".").pop() || "png";
          const tempPath = path.join(
            TEMP_DIR,
            `img_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`
          );
          fs.writeFileSync(tempPath, buffer);
          imagePaths.push(tempPath);
          log(`[FILE] Downloaded image: ${file.name} -> ${tempPath}`);
        } else if (AUDIO_TYPES.has(file.mimetype)) {
          log(
            `[FILE] Transcribing voice: ${file.name} (${file.mimetype})`
          );
          const transcription = await transcribeAudio(
            buffer,
            file.name || "voice.webm"
          );
          voiceTranscription +=
            (voiceTranscription ? "\n" : "") + transcription;
          log(
            `[FILE] Transcription: "${transcription.slice(0, 100)}"`
          );
        }
      } catch (err) {
        logError(`[FILE] Error processing ${file.name}: ${err.message}`);
      }
    }
  }

  // Append voice transcription to text
  if (voiceTranscription) {
    text = text
      ? `${text}\n\n[Voice message transcription]: ${voiceTranscription}`
      : `[Voice message transcription]: ${voiceTranscription}`;
  }

  // If no text and no images, nothing to process
  if (!text && imagePaths.length === 0) return;

  // Default prompt for image-only messages
  if (!text && imagePaths.length > 0) {
    text =
      "The user sent an image. Read and analyze it, then describe what you see and ask how you can help.";
  }

  // Add image file paths so Claude can read them
  if (imagePaths.length > 0) {
    const imageInstructions = imagePaths
      .map(
        (p) =>
          `Read this image file with the Read tool and analyze it: ${p}`
      )
      .join("\n");
    text = `${text}\n\n[Attached images — use the Read tool to view these files]:\n${imageInstructions}`;
  }

  const textLower = text.toLowerCase();

  // Helper: post to channel (formatted for Slack)
  async function reply(msg) {
    const formatted = formatForSlack(msg);
    const chunks = splitMessage(formatted);
    for (const chunk of chunks) {
      await client.chat.postMessage({ channel, text: chunk });
    }
  }

  // ---- BUILDER CHANNELS ----
  const builder = BUILDER_CHANNELS[channel];
  if (builder) {
    busyChannels.add(channel);
    await client.chat.postMessage({
      channel,
      text: `_Working on ${builder.projectName}..._`,
    });

    try {
      const sessionKey = `builder:${channel}`;
      const hasSession = !!getSessionId(sessionKey);

      // On a NEW session, sync the working tree with origin before letting
      // Claude edit. Prevents the "Claw pushes and reverts the latest
      // upstream commit" failure mode. We `fetch --prune`, clear any
      // stale .git/index.lock (iCloud File Provider sometimes leaves one),
      // then `pull --rebase --autostash` so local-uncommitted edits
      // re-apply on top of origin. If the rebase conflicts, we bail out
      // loud — the user can resolve manually.
      if (!hasSession && builder.projectPath) {
        try {
          const lockPath = `${builder.projectPath}/.git/index.lock`;
          await fs.promises.rm(lockPath, { force: true }).catch(() => {});
          await new Promise((resolve, reject) => {
            const child = require("child_process").exec(
              "git fetch --prune && git pull --rebase --autostash",
              { cwd: builder.projectPath, timeout: 60000 },
              (err, _stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()),
            );
            child?.on?.("error", reject);
          });
          log(`[builder-sync] ${builder.name}: fetched + pulled origin`);
        } catch (syncErr) {
          logError(`[builder-sync] ${builder.name} failed:`, syncErr.message);
          await client.chat.postMessage({
            channel,
            text: `:warning: Couldn't auto-sync ${builder.projectName} with origin: \`${syncErr.message}\`\nProceeding anyway — fix manually and retry if needed.`,
          });
        }
      }

      // If resuming, just send user text. If new, send full builder prompt.
      const prompt = hasSession
        ? text
        : `${buildBuilderSystemPrompt(builder)}\n\nUser request: ${text}`;

      const response = await runClaude(
        prompt,
        sessionKey,
        900000, // 15 min for builder tasks (code changes take longer)
        builder.projectPath,
        { budget: "25.00" } // Builder needs higher budget for multi-file code changes
      );
      await reply(response);
    } catch (err) {
      logError(`Builder error (${builder.name}):`, err.message);
      await reply(`❌ Build failed: ${err.message}`);
    } finally {
      busyChannels.delete(channel);
      processNextPending(channel, client);
    }
    return;
  }

  // ---- /report COMMAND ----
  if (textLower === "/report" || textLower === "report") {
    pendingReportSelections.set(event.user, channel);
    await reply(REPORT_MENU);
    return;
  }

  // ---- REPORT SELECTION (if user just typed "report") ----
  const pendingChannel = pendingReportSelections.get(event.user);
  if (pendingChannel) {
    pendingReportSelections.delete(event.user);

    const reportMap = {
      1: "cloud-report",
      cloud: "cloud-report",
      "cloud-report": "cloud-report",
      2: "health-report",
      health: "health-report",
      "health-report": "health-report",
      3: "pos-report",
      pos: "pos-report",
      "pos-report": "pos-report",
      4: "event-report",
      event: "event-report",
      events: "event-report",
      "event-report": "event-report",
      5: "all",
      all: "all",
    };

    const selection = reportMap[textLower];

    if (selection === "all") {
      await reply("Running all 4 reports...");
      for (const name of [
        "health-report",
        "cloud-report",
        "pos-report",
        "event-report",
      ]) {
        await runScheduledReport(name);
      }
      await reply("✅ All reports posted to their channels.");
      return;
    }

    if (selection) {
      await reply(
        `Running ${selection}... Results will post to #${selection}`
      );
      await runScheduledReport(selection);
      await reply(`✅ ${selection} complete.`);
      return;
    }

    if (textLower === "6" || textLower === "custom") {
      await reply(
        "Describe what you want me to check and I'll generate a custom report."
      );
      return;
    }

    // Unrecognized — treat as custom report request
    busyChannels.add(channel);
    await client.chat.postMessage({
      channel,
      text: "_Generating custom report..._",
    });
    try {
      const customPrompt = `${buildSystemPrompt(channel)}\n\nThe user wants a custom report. Generate it based on their request:\n\n${text}`;
      const response = await runClaude(customPrompt, `custom:${channel}`, 600000, null, {
        model: MODEL_SONNET,
        maxTurns: 5,
        tools: "Bash,Read,Glob,Grep",
      });
      await reply(response);
    } catch (err) {
      await reply(`❌ Custom report failed: ${err.message}`);
    } finally {
      busyChannels.delete(channel);
      processNextPending(channel, client);
    }
    return;
  }

  // ---- SESSION RESET ----
  if (
    textLower === "new session" ||
    textLower === "reset" ||
    textLower === "fresh start"
  ) {
    clearSession(`chat:${channel}`);
    await reply("Session cleared. Starting fresh.");
    return;
  }

  // ---- GENERAL CHAT (all channels + DMs) ----
  busyChannels.add(channel);
  try {
    await client.chat.postMessage({
      channel,
      text: "_Processing..._",
    });

    const sessionKey = `chat:${channel}`;
    const hasSession = !!getSessionId(sessionKey);

    // If resuming, just send user text. If new, include full system prompt.
    const prompt = hasSession
      ? text
      : `${buildSystemPrompt(channel)}\n\nUser message: ${text}`;

    const response = await runClaude(prompt, sessionKey, 600000, null, {
      model: MODEL_SONNET,
    });
    await reply(response);
  } catch (err) {
    logError("Claude error:", err.message);
    await reply(`❌ Error: ${err.message}`);
  } finally {
    busyChannels.delete(channel);
    processNextPending(channel, client);
  }
}

// ============================================================
// EVENT LISTENERS (fallback — events may not fire without subscription)
// ============================================================

app.event("message", async ({ event, client }) => {
  try {
    log(`[EVENT-MSG] ${event.channel} "${(event.text || "").slice(0, 50)}"`);
    await handleMessage(event, client);
  } catch (err) {
    logError("Unhandled message handler error:", err.message);
  }
});

app.event("app_mention", async ({ event, client }) => {
  try {
    log(`[EVENT-MENTION] ${event.channel} "${(event.text || "").slice(0, 50)}"`);
    await handleMessage(event, client);
  } catch (err) {
    logError("Unhandled mention handler error:", err.message);
  }
});

// ============================================================
// MESSAGE POLLING (real-time message detection via API)
// Polls channels round-robin for new messages every ~1 second.
// Works regardless of Slack event subscriptions.
// Deduplication prevents double-handling if events DO fire.
// ============================================================

const POLL_STATE_FILE = path.join(__dirname, "poll-state.json");

function loadPollState() {
  try {
    return JSON.parse(fs.readFileSync(POLL_STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function savePollState(state) {
  fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(state));
}

// Dynamically populated at startup — includes ALL channels the bot is in + DMs
let POLL_CHANNELS = [];

let pollIndex = 0;
let pollState = {};
let pollInitialized = false;

async function initPollState() {
  // Discover ALL channels the bot is a member of (including DMs)
  try {
    const res = await app.client.conversations.list({
      types: "public_channel,private_channel,im,mpim",
      limit: 200,
    });
    if (res.ok && res.channels) {
      for (const ch of res.channels) {
        // Include channels we're a member of, plus all DMs
        if (ch.is_member || ch.is_im || ch.is_mpim) {
          POLL_CHANNELS.push({
            id: ch.id,
            name: ch.name || ch.id,
          });
          // Also add to CHANNEL_NAMES if not already there
          if (!CHANNEL_NAMES[ch.id] && ch.name) {
            CHANNEL_NAMES[ch.id] = ch.name;
          }
        }
      }
    }
  } catch (err) {
    logError("Failed to discover channels:", err.message);
    // Fallback to predefined channels
    POLL_CHANNELS = Object.entries(CHANNELS).map(([name, id]) => ({
      name,
      id,
    }));
  }

  // Set initial timestamps to "now" so we don't process old messages
  const now = String(Date.now() / 1000);
  const existing = loadPollState();
  for (const ch of POLL_CHANNELS) {
    if (!existing[ch.id]) {
      existing[ch.id] = now;
    }
  }
  pollState = existing;
  savePollState(pollState);
  pollInitialized = true;
  log(
    `  Poll state initialized for ${POLL_CHANNELS.length} channels: ${POLL_CHANNELS.map((c) => "#" + c.name).join(", ")}`
  );
}

async function pollNextChannel() {
  if (!pollInitialized) return;

  const ch = POLL_CHANNELS[pollIndex % POLL_CHANNELS.length];
  pollIndex++;

  // Heartbeat every full cycle
  if (pollIndex % POLL_CHANNELS.length === 0) {
    log(`[POLL] Heartbeat: cycle ${Math.floor(pollIndex / POLL_CHANNELS.length)}, active claude: ${activeCount}, queued: ${claudeQueue.length}`);
  }

  try {
    const oldest = pollState[ch.id] || String(Date.now() / 1000);

    const res = await app.client.conversations.history({
      channel: ch.id,
      oldest: oldest,
      limit: 5,
      inclusive: false,
    });

    if (res.ok && res.messages && res.messages.length > 0) {
      // Process oldest first
      const msgs = [...res.messages].reverse();
      for (const msg of msgs) {
        // Update timestamp (always, even for bot messages)
        if (!pollState[ch.id] || msg.ts > pollState[ch.id]) {
          pollState[ch.id] = msg.ts;
        }

        // Only process human messages (skip bot, subtypes like joins/leaves)
        // Allow messages with files (images, voice) even without text
        if (
          !msg.bot_id &&
          (!msg.subtype || msg.subtype === "file_share") &&
          (msg.text || (msg.files && msg.files.length > 0))
        ) {
          // Add channel field (not included in conversations.history response)
          msg.channel = ch.id;
          log(
            `[POLL] #${ch.name}: "${msg.text.slice(0, 60)}" from ${msg.user}`
          );
          try {
            await handleMessage(msg, app.client);
          } catch (err) {
            logError(`[POLL] Error handling message: ${err.message}`);
          }
        }
      }
      savePollState(pollState);
    }
  } catch (err) {
    logError(
      `[POLL] Error polling #${ch.name}: ${err.message || err}${err.data ? " (" + err.data.error + ")" : ""}`
    );
    if (err.data && err.data.error === "ratelimited") {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

// Poll 1 channel every 3 seconds
// With ~13 channels, full cycle = ~39 seconds, ~20 calls/min (well within Slack limits)
setInterval(pollNextChannel, 3000);

// ============================================================
// STARTUP
// ============================================================

(async () => {
  await app.start();

  // Get our own bot user ID for stripping @mentions
  try {
    const auth = await app.client.auth.test();
    botUserId = auth.user_id;
    log(`Bot user ID: ${botUserId}`);
  } catch (err) {
    logError("Could not get bot user ID:", err.message);
  }

  // Initialize polling state
  await initPollState();

  // Live POS support sessions — Firestore listener + Block Kit
  // interactive cards (Take Over / Open Simulator / End + remote
  // command palette). Logs and no-ops gracefully if SUPPORT_CHANNEL
  // env var isn't set.
  try {
    require("./support-sessions").init({ logger: log, errorLogger: logError, slackApp: app });
  } catch (e) {
    logError("[support] init failed:", e.message);
  }

  log("");
  log("EventiniClaw Slack Bot is running!");
  log("  Powered by Claude Code CLI");
  log("");
  log("  Daily Reports (8:00 AM) — Sonnet, max 5 turns");
  log("  Transactions — Firebase webhook (zero Claude tokens)");
  log("  New Events — Firestore trigger (zero Claude tokens)");
  log("  Chat/Builder — Sonnet");
  log("  Sessions auto-clear daily at 7:50 AM");
  log("");
})();
