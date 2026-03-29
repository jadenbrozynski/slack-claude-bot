#!/usr/bin/env node

/**
 * Eventini Monthly Newsletter Sender
 *
 * Usage:
 *   node send-newsletter.js                    # Interactive: gathers updates, asks for input, sends
 *   node send-newsletter.js --example          # Send example newsletter to Jaden
 *   node send-newsletter.js --html-only        # Output HTML to stdout (for preview)
 *   node send-newsletter.js --to email@x.com   # Override recipient
 */

const { execSync } = require('child_process');
const https = require('https');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────

const RESEND_API_KEY = 're_WHT1GjbS_8WHryeYcSpNUu2firM9qQWuw';
const FROM_ADDRESS = 'Eventini <orders@eventini.io>';
const DEFAULT_TO = 'jadenbrozynski@gmail.com';
const LOGO_URL = 'https://res.cloudinary.com/ds6wefak1/image/upload/v1773975528/eventinipos/eventini-logo-square.png';

// Eventini brand colors
const BRAND = {
  teal: '#44646c',
  tealLight: '#5a7a82',
  tealDark: '#344e54',
  orange: '#FE5B0F',
  orangeLight: '#FFCEB7',
  navy: '#120B3F',
  white: '#ffffff',
  lightGray: '#f8f9fa',
  gray: '#6b7280',
  darkText: '#1a1a1a',
};

// ── GitHub Activity ─────────────────────────────────────────────────────────

function getGitHubUpdates() {
  const repos = [
    { path: '/Users/jadenbro1/Desktop/EVENTINI-MARKETPLACE', name: 'Marketplace Web' },
    { path: '/Users/jadenbro1/EventiniMockUp', name: 'Mobile App' },
    { path: '/Users/jadenbro1/Desktop/eventini-admin', name: 'Admin Dashboard' },
    { path: '/Users/jadenbro1/EventiniPOS_local', name: 'POS System' },
  ];

  const since = new Date();
  since.setMonth(since.getMonth() - 1);
  const sinceStr = since.toISOString().split('T')[0];

  const updates = [];

  for (const repo of repos) {
    try {
      const log = execSync(
        `git -C "${repo.path}" log --oneline --since="${sinceStr}" --no-merges 2>/dev/null | head -30`,
        { encoding: 'utf-8' }
      ).trim();

      if (log) {
        const commits = log.split('\n').map(line => {
          const [hash, ...rest] = line.split(' ');
          return rest.join(' ');
        });
        updates.push({ repo: repo.name, commits });
      }
    } catch {
      // repo may not exist or have no recent commits
    }
  }

  return updates;
}

function categorizeUpdates(repoUpdates) {
  const categories = {
    features: [],
    fixes: [],
    improvements: [],
    infrastructure: [],
  };

  const seen = new Set();

  for (const { repo, commits } of repoUpdates) {
    for (const msg of commits) {
      const lower = msg.toLowerCase();
      const key = lower.replace(/[^a-z]/g, '').slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);

      const entry = { msg, repo };

      if (lower.includes('fix') || lower.includes('bug') || lower.includes('crash') || lower.includes('patch')) {
        categories.fixes.push(entry);
      } else if (lower.includes('add') || lower.includes('new') || lower.includes('feature') || lower.includes('implement') || lower.includes('support')) {
        categories.features.push(entry);
      } else if (lower.includes('update') || lower.includes('improve') || lower.includes('enhance') || lower.includes('refactor') || lower.includes('clean')) {
        categories.improvements.push(entry);
      } else {
        categories.infrastructure.push(entry);
      }
    }
  }

  return categories;
}

// ── HTML Template ───────────────────────────────────────────────────────────

function buildNewsletterHtml({ month, year, highlights, categories, partnerships, stats }) {
  const highlightHtml = highlights.map(h => `
    <tr>
      <td style="padding: 0 0 16px 0;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="background: ${BRAND.lightGray}; border-radius: 12px; padding: 20px 24px; border-left: 4px solid ${BRAND.orange};">
              <p style="margin: 0; font-size: 16px; font-weight: 600; color: ${BRAND.darkText}; line-height: 1.5;">${h.title}</p>
              <p style="margin: 8px 0 0 0; font-size: 14px; color: ${BRAND.gray}; line-height: 1.6;">${h.description}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  const partnershipHtml = partnerships.length > 0 ? `
    <tr>
      <td style="padding: 40px 40px 0 40px;">
        <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 700; color: ${BRAND.teal}; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;">Partnerships & Community</h2>
        ${partnerships.map(p => `
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 16px;">
            <tr>
              <td style="background: linear-gradient(135deg, ${BRAND.teal}08, ${BRAND.orange}08); border-radius: 12px; padding: 20px 24px; border: 1px solid #e5e7eb;">
                <p style="margin: 0; font-size: 16px; font-weight: 600; color: ${BRAND.darkText};">${p.name}</p>
                <p style="margin: 8px 0 0 0; font-size: 14px; color: ${BRAND.gray}; line-height: 1.6;">${p.description}</p>
              </td>
            </tr>
          </table>
        `).join('')}
      </td>
    </tr>
  ` : '';

  const categorySection = (title, items, emoji) => {
    if (!items || items.length === 0) return '';
    const limitedItems = items.slice(0, 5);
    return `
      <tr>
        <td style="padding: 0 0 24px 0;">
          <p style="margin: 0 0 12px 0; font-size: 15px; font-weight: 700; color: ${BRAND.tealDark}; text-transform: uppercase; letter-spacing: 0.5px;">${emoji} ${title}</p>
          ${limitedItems.map(item => `
            <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom: 8px;">
              <tr>
                <td style="padding: 8px 0; border-bottom: 1px solid #f0f0f0;">
                  <span style="font-size: 14px; color: ${BRAND.darkText}; line-height: 1.5;">${item.msg}</span>
                  <span style="font-size: 12px; color: ${BRAND.gray}; margin-left: 8px; background: ${BRAND.lightGray}; padding: 2px 8px; border-radius: 4px;">${item.repo}</span>
                </td>
              </tr>
            </table>
          `).join('')}
        </td>
      </tr>
    `;
  };

  const statsHtml = stats ? `
    <tr>
      <td style="padding: 0 40px 40px 40px;">
        <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 700; color: ${BRAND.teal}; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;">By The Numbers</h2>
        <table cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            ${stats.map(s => `
              <td style="text-align: center; padding: 20px; background: ${BRAND.lightGray}; border-radius: 12px; width: ${Math.floor(100 / stats.length)}%;">
                <p style="margin: 0; font-size: 28px; font-weight: 800; color: ${BRAND.orange};">${s.value}</p>
                <p style="margin: 6px 0 0 0; font-size: 13px; color: ${BRAND.gray}; text-transform: uppercase; letter-spacing: 0.5px;">${s.label}</p>
              </td>
            `).join(`<td style="width: 12px;"></td>`)}
          </tr>
        </table>
      </td>
    </tr>
  ` : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Eventini Newsletter — ${month} ${year}</title>
  <!--[if mso]>
  <style>* { font-family: Arial, sans-serif !important; }</style>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #f0f2f5; font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; -webkit-font-smoothing: antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #f0f2f5;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width: 600px; background: ${BRAND.white}; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">

          <!-- Header -->
          <tr>
            <td style="background: linear-gradient(135deg, ${BRAND.teal}, ${BRAND.tealDark}); padding: 48px 40px; text-align: center;">
              <img src="${LOGO_URL}" alt="Eventini" width="64" height="64" style="display: block; margin: 0 auto 20px auto; border-radius: 14px;" />
              <h1 style="margin: 0; font-size: 28px; font-weight: 800; color: ${BRAND.white}; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; letter-spacing: -0.5px;">
                Monthly Update
              </h1>
              <p style="margin: 8px 0 0 0; font-size: 16px; color: ${BRAND.orangeLight}; font-weight: 500;">
                ${month} ${year}
              </p>
            </td>
          </tr>

          <!-- Intro -->
          <tr>
            <td style="padding: 40px 40px 20px 40px;">
              <p style="margin: 0; font-size: 16px; color: ${BRAND.gray}; line-height: 1.7;">
                Here's what's been happening at Eventini this month. From platform improvements to new partnerships, we're building the best event planning marketplace in Milwaukee and beyond.
              </p>
            </td>
          </tr>

          <!-- Highlights -->
          <tr>
            <td style="padding: 20px 40px 0 40px;">
              <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 700; color: ${BRAND.teal}; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;">Highlights</h2>
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                ${highlightHtml}
              </table>
            </td>
          </tr>

          <!-- Partnerships -->
          ${partnershipHtml}

          <!-- Stats -->
          ${statsHtml}

          <!-- Dev Updates -->
          <tr>
            <td style="padding: 0 40px 40px 40px;">
              <h2 style="margin: 0 0 20px 0; font-size: 22px; font-weight: 700; color: ${BRAND.teal}; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;">Under The Hood</h2>
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                ${categorySection('New Features', categories.features, '&#x25CF;')}
                ${categorySection('Bug Fixes', categories.fixes, '&#x25CF;')}
                ${categorySection('Improvements', categories.improvements, '&#x25CF;')}
              </table>
            </td>
          </tr>

          <!-- CTA -->
          <tr>
            <td style="padding: 0 40px 40px 40px; text-align: center;">
              <table cellpadding="0" cellspacing="0" border="0" width="100%">
                <tr>
                  <td style="background: linear-gradient(135deg, ${BRAND.orange}, #e04d0a); border-radius: 12px; padding: 20px; text-align: center;">
                    <a href="https://eventini.io" style="color: ${BRAND.white}; text-decoration: none; font-size: 16px; font-weight: 700; letter-spacing: 0.3px;">
                      Visit Eventini.io &rarr;
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background: ${BRAND.lightGray}; padding: 32px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
              <p style="margin: 0; font-size: 13px; color: ${BRAND.gray}; line-height: 1.6;">
                Eventini — Milwaukee's Event Planning Marketplace<br/>
                Connecting hosts with the best local providers.<br/><br/>
                <a href="https://eventini.io" style="color: ${BRAND.teal}; text-decoration: none;">eventini.io</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Send Email via Resend ───────────────────────────────────────────────────

function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html });

    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Resend API error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isExample = args.includes('--example');
  const htmlOnly = args.includes('--html-only');
  const toIdx = args.indexOf('--to');
  const toEmail = toIdx !== -1 ? args[toIdx + 1] : DEFAULT_TO;

  const now = new Date();
  const month = now.toLocaleString('en-US', { month: 'long' });
  const year = now.getFullYear();

  // Gather GitHub updates
  console.log('Gathering GitHub updates...');
  const repoUpdates = getGitHubUpdates();
  const categories = categorizeUpdates(repoUpdates);

  console.log(`Found: ${categories.features.length} features, ${categories.fixes.length} fixes, ${categories.improvements.length} improvements`);

  // Build content (example or dynamic)
  const highlights = isExample || !args.includes('--highlights')
    ? [
        {
          title: 'Payment Infrastructure Overhaul',
          description: 'Complete rebuild of our Stripe payment pipeline — idempotency keys prevent duplicate charges, source_transaction support for cleaner provider payouts, and proportional refund fee handling.',
        },
        {
          title: 'Mobile App v4.1.0 — Security Hardening',
          description: 'Server-side provider geocoding, new Apple Developer team migration, and Stripe SDK update for latest Xcode compatibility.',
        },
        {
          title: 'Online Ordering Fee Transparency',
          description: 'Full fee breakdown now shown on every order — tax, service fee, and tip are all clearly separated so customers and providers see exactly where the money goes.',
        },
        {
          title: 'Accelerate Program Launch',
          description: 'New program helping providers grow with just 2.5% commission per transaction. Includes dedicated onboarding, phone number collection, and commission tracking.',
        },
      ]
    : JSON.parse(args[args.indexOf('--highlights') + 1]);

  const partnerships = isExample
    ? [
        {
          name: 'Newaukee Partnership',
          description: 'Teaming up with Newaukee to bring Eventini to Milwaukee\'s largest community events and connect local providers with high-volume opportunities.',
        },
      ]
    : [];

  const stats = isExample
    ? [
        { value: '142', label: 'Total Users' },
        { value: '8', label: 'Events Created' },
        { value: '120+', label: 'Providers' },
      ]
    : null;

  const html = buildNewsletterHtml({ month, year, highlights, categories, partnerships, stats });

  if (htmlOnly) {
    process.stdout.write(html);
    return;
  }

  const subject = `Eventini Update — ${month} ${year}`;

  console.log(`Sending newsletter to ${toEmail}...`);
  try {
    const result = await sendEmail(toEmail, subject, html);
    console.log(`Sent! ID: ${result.id}`);
  } catch (err) {
    console.error(`Failed to send: ${err.message}`);
    process.exit(1);
  }
}

main();
