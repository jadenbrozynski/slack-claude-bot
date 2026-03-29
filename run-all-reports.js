#!/usr/bin/env node
/**
 * One-off script to re-run all reports and verify they post to the correct channels.
 * Usage: node run-all-reports.js
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

// Load .env
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^(\w+)=(.*)$/);
    if (match) process.env[match[1]] = match[2].trim();
  }
}

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const CLAUDE_PATH = "/Users/jadenbro1/.local/bin/claude";

const CHANNELS = {
  "health-report": "C0AQ28LB9B2",
  "cloud-report": "C0AP1JGKA03",
  "pos-report": "C0AP5TVL4EA",
  "event-report": "C0AQ28JMH6U",
};

const SLACK_FORMAT_RULE = `CRITICAL: Your output will be posted directly to Slack. Use Slack mrkdwn formatting:
- Bold: *single asterisks* (NOT **double**)
- Italic: _underscores_
- Code: \`backticks\`
- Code blocks: \`\`\`code\`\`\`
- NEVER use markdown tables (| col |). Use \`\`\`code blocks\`\`\` with aligned columns instead.
- NEVER use # headings. Use *bold text* on its own line.
- Links: <https://url|text> NOT [text](url)

`;

function loadPrompt(name) {
  const content = fs.readFileSync(
    path.join(__dirname, "reports", `${name}.txt`),
    "utf8"
  );
  return SLACK_FORMAT_RULE + content;
}

function markdownToSlack(text) {
  let out = text;
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");
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
  out = out.replace(/\*\*([^*]+)\*\*/g, "*$1*");
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  out = out.replace(
    /((?:^\|.+\|$\n?){2,})/gm,
    (table) =>
      "```\n" +
      table.replace(/^\||\|$/gm, "").replace(/\|/g, " │ ") +
      "```"
  );
  out = out.replace(/__INLINE_(\d+)__/g, (_, i) => inlineCode[i]);
  out = out.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => codeBlocks[i]);
  return out;
}

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

function postToSlack(channelId, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel: channelId, text });
    const options = {
      hostname: "slack.com",
      path: "/api/chat.postMessage",
      method: "POST",
      headers: {
        Authorization: `Bearer ${SLACK_TOKEN}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed.ok) {
            reject(new Error(`Slack API error: ${parsed.error}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error("Invalid JSON from Slack"));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function postToChannel(channelId, text) {
  const formatted = markdownToSlack(text);
  const chunks = splitMessage(formatted);
  for (const chunk of chunks) {
    await postToSlack(channelId, chunk);
  }
}

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      prompt,
      "--allowedTools",
      "Bash,Read,Write,Edit,Glob,Grep",
      "--output-format",
      "text",
    ];

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: os.homedir(),
      env: { ...process.env, HOME: os.homedir() },
      timeout: 600000,
      maxBuffer: 1024 * 1024 * 10,
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin.end();

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0 && !stdout) {
        reject(new Error(stderr || `claude exited with code ${code}`));
      } else {
        resolve(stdout.trim());
      }
    });

    proc.on("error", reject);
  });
}

async function runReport(reportName) {
  const channelId = CHANNELS[reportName];
  const startTime = Date.now();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`▶ STARTING: ${reportName} → channel ${channelId}`);
  console.log(`  Time: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}`);

  try {
    // Post status message
    await postToChannel(channelId, `📊 _Generating ${reportName}..._`);
    console.log(`  ✓ Status message posted to #${reportName}`);

    // Run the report
    const prompt = loadPrompt(reportName);
    console.log(`  ⏳ Running Claude CLI for ${reportName}... (this may take a few minutes)`);
    const response = await runClaude(prompt);

    if (!response || response.trim().length === 0) {
      throw new Error("Empty response from Claude CLI");
    }

    console.log(`  ✓ Claude returned ${response.length} chars`);

    // Post to channel
    if (reportName === "pos-report" && response.includes("===SPLIT===")) {
      const [section1, section2] = response.split("===SPLIT===");
      await postToChannel(channelId, section1.trim());
      await postToChannel(channelId, section2.trim());
      console.log(`  ✓ POS report posted in 2 sections to #${reportName}`);
    } else {
      await postToChannel(channelId, response);
      console.log(`  ✓ Report posted to #${reportName}`);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`  ✅ ${reportName} PASSED (${elapsed}s)`);
    return { report: reportName, status: "SUCCESS", elapsed: `${elapsed}s`, error: null };

  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`  ❌ ${reportName} FAILED (${elapsed}s): ${err.message}`);

    // Post error to channel
    try {
      await postToChannel(channelId, `:x: ${reportName} failed: ${err.message}`);
    } catch (postErr) {
      console.error(`  ❌ Could not post error to Slack: ${postErr.message}`);
    }

    return { report: reportName, status: "FAILED", elapsed: `${elapsed}s`, error: err.message };
  }
}

async function main() {
  console.log("🦞 Running ALL reports...");
  console.log(`Started: ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })}`);

  if (!SLACK_TOKEN) {
    console.error("❌ SLACK_BOT_TOKEN not found in .env");
    process.exit(1);
  }

  const reportNames = ["health-report", "cloud-report", "pos-report", "event-report"];
  const results = [];

  for (const name of reportNames) {
    const result = await runReport(name);
    results.push(result);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("📋 FINAL RESULTS:");
  console.log("=".repeat(60));
  for (const r of results) {
    const icon = r.status === "SUCCESS" ? "✅" : "❌";
    console.log(`  ${icon} ${r.report} — ${r.status} (${r.elapsed})${r.error ? ` — ${r.error}` : ""}`);
  }

  const failed = results.filter((r) => r.status === "FAILED");
  if (failed.length === 0) {
    console.log("\n🎉 All reports ran successfully and posted to their channels!");
  } else {
    console.log(`\n⚠️  ${failed.length}/${results.length} reports failed.`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
