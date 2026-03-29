#!/bin/bash
# Eventini Monthly Newsletter Cron Script
# Runs on the 1st of each month
# This script triggers the newsletter flow:
# 1. Gathers GitHub updates automatically
# 2. Sends a Slack message to #jaden-cto asking for company updates/partnerships
# 3. After Jaden responds, compiles and sends the newsletter

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="$SCRIPT_DIR/newsletter.log"

echo "[$(date)] Monthly newsletter cron triggered" >> "$LOG_FILE"

# Send the newsletter with auto-gathered GitHub data
cd "$SCRIPT_DIR"
node send-newsletter.js --example 2>&1 >> "$LOG_FILE"

echo "[$(date)] Newsletter sent" >> "$LOG_FILE"
