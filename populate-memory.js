const fs = require("fs");
const path = require("path");
const https = require("https");

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

const TOKEN = process.env.SLACK_BOT_TOKEN;
const MEMORY_DIR = path.join(__dirname, "memory");

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

function slackApi(method, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const options = {
      hostname: "slack.com",
      path: `/api/${method}?${qs}`,
      headers: { Authorization: `Bearer ${TOKEN}` },
    };
    https
      .get(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Invalid JSON"));
          }
        });
      })
      .on("error", reject);
  });
}

async function getUserMap() {
  const res = await slackApi("users.list", { limit: 200 });
  const map = {};
  if (res.ok && res.members) {
    for (const m of res.members) {
      map[m.id] = m.real_name || m.name;
    }
  }
  return map;
}

async function getChannelHistory(channelId, limit = 200) {
  const res = await slackApi("conversations.history", {
    channel: channelId,
    limit: String(limit),
  });
  if (!res.ok) {
    console.error(`  Failed to fetch ${channelId}: ${res.error}`);
    return [];
  }
  return (res.messages || []).reverse(); // oldest first
}

function formatTimestamp(ts) {
  return new Date(parseFloat(ts) * 1000).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cleanText(text, userMap) {
  // Replace <@USERID> with real names
  return text.replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${userMap[id] || id}`);
}

async function main() {
  console.log("Fetching user list...");
  const userMap = await getUserMap();
  console.log(`  Found ${Object.keys(userMap).length} users\n`);

  for (const [channelName, channelId] of Object.entries(CHANNELS)) {
    console.log(`Fetching #${channelName} (${channelId})...`);
    const messages = await getChannelHistory(channelId);
    console.log(`  Got ${messages.length} messages`);

    if (messages.length === 0) {
      console.log(`  Skipping — no messages\n`);
      continue;
    }

    // Build memory content
    const lines = [];
    lines.push(`# Channel Memory: #${channelName}\n`);
    lines.push(
      "This file stores context and conversation history for this channel."
    );
    lines.push(
      "Update this file after completing tasks or learning important context.\n"
    );
    lines.push(`## Recent History (as of ${new Date().toLocaleDateString("en-US", { timeZone: "America/Chicago" })})\n`);

    // Group by date
    let currentDate = "";
    let humanMessages = 0;
    let botMessages = 0;

    for (const msg of messages) {
      const date = new Date(parseFloat(msg.ts) * 1000).toLocaleDateString(
        "en-US",
        { timeZone: "America/Chicago", month: "short", day: "numeric" }
      );
      const time = formatTimestamp(msg.ts);
      const user = msg.bot_id
        ? "EventiniClaw"
        : userMap[msg.user] || msg.user || "Unknown";
      const text = cleanText(msg.text || "", userMap);

      if (msg.bot_id) {
        botMessages++;
      } else {
        humanMessages++;
      }

      if (date !== currentDate) {
        currentDate = date;
        lines.push(`\n### ${date}\n`);
      }

      // Truncate very long messages (bot reports etc.) to keep memory manageable
      const truncated =
        text.length > 500 ? text.slice(0, 500) + "... [truncated]" : text;
      lines.push(`- *${time}* — *${user}*: ${truncated}`);
    }

    lines.push(`\n## Summary`);
    lines.push(`- ${messages.length} total messages (${humanMessages} human, ${botMessages} bot)`);

    // Extract key topics from human messages
    const humanTexts = messages
      .filter((m) => !m.bot_id && m.text)
      .map((m) => cleanText(m.text, userMap));

    if (humanTexts.length > 0) {
      lines.push(`\n## Key Requests / Topics`);
      for (const t of humanTexts.slice(-20)) {
        // last 20 human messages
        if (t.length > 200) {
          lines.push(`- ${t.slice(0, 200)}...`);
        } else {
          lines.push(`- ${t}`);
        }
      }
    }

    const memPath = path.join(MEMORY_DIR, `channel_${channelId}.md`);
    fs.writeFileSync(memPath, lines.join("\n") + "\n");
    console.log(`  Wrote ${memPath}\n`);

    // Small delay to avoid rate limiting
    await new Promise((r) => setTimeout(r, 1200));
  }

  console.log("Done! All channel memories populated.");
}

main().catch(console.error);
