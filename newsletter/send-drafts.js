#!/usr/bin/env node

/**
 * Eventini Monthly Newsletter Drafts — Professional Edition
 * Sends 3 newsletters: Admin, Provider, Host/Public
 */

const https = require('https');

const RESEND_API_KEY = 're_WHT1GjbS_8WHryeYcSpNUu2firM9qQWuw';
const FROM = 'Eventini <orders@eventini.io>';
const TO = 'jadenbrozynski@gmail.com';
const LOGO = 'https://res.cloudinary.com/ds6wefak1/image/upload/v1773975528/eventinipos/eventini-logo-square.png';

// Brand palette
const C = {
  teal:       '#3D5A62',
  tealSoft:   '#4D6E77',
  tealPale:   '#EDF3F4',
  orange:     '#FE5B0F',
  orangeSoft: '#FF7D3F',
  orangePale: '#FFF4EE',
  navy:       '#0F1B3D',
  navyMid:    '#1A2B52',
  white:      '#FFFFFF',
  offWhite:   '#FAFBFC',
  bgOuter:    '#EBEEF2',
  border:     '#E2E6EB',
  borderLight:'#F0F2F5',
  dark:       '#111827',
  mid:        '#374151',
  gray:       '#6B7280',
  grayLight:  '#9CA3AF',
  success:    '#059669',
  successPale:'#ECFDF5',
  warn:       '#D97706',
  warnPale:   '#FFFBEB',
};

const FONT = "'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, Helvetica, Arial, sans-serif";

function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ from: FROM, to: [to], subject, html });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode < 300 ? resolve(JSON.parse(d)) : reject(new Error(`${res.statusCode}: ${d}`)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Layout primitives ───────────────────────────────────────────────────────

function shell({ preheader, headerBg, headerAccent, badge, title, subtitle, body, ctaLabel, ctaUrl, ctaBg, footerLines }) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${title}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><style>*{font-family:Arial,sans-serif!important;}</style><![endif]-->
<style>
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap');
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}
  img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;}
  @media only screen and (max-width:620px){
    .outer{width:100%!important;padding:16px!important;}
    .inner{width:100%!important;}
    .mob-pad{padding-left:24px!important;padding-right:24px!important;}
    .stat-cell{display:block!important;width:100%!important;padding:12px 0!important;}
    .stat-gap{display:none!important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.bgOuter};font-family:${FONT};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
<!-- Preheader -->
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader || ''}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.bgOuter};">
<tr><td class="outer" align="center" style="padding:48px 24px;">
<table role="presentation" class="inner" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:${C.white};border-radius:20px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.04),0 8px 32px rgba(0,0,0,0.06);">

<!-- ═══ HEADER ═══ -->
<tr><td style="background:${headerBg};padding:0;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <!-- Top bar accent -->
  <tr><td style="height:4px;background:${headerAccent};font-size:1px;line-height:1px;">&nbsp;</td></tr>
  <tr><td style="padding:44px 48px 40px 48px;text-align:center;">
    <!-- Logo -->
    <table cellpadding="0" cellspacing="0" border="0" align="center"><tr>
    <td style="width:52px;height:52px;border-radius:13px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.15);">
      <img src="${LOGO}" alt="Eventini" width="52" height="52" style="display:block;border-radius:13px;"/>
    </td></tr></table>
    ${badge ? `<table cellpadding="0" cellspacing="0" border="0" align="center" style="margin-top:16px;"><tr><td style="background:rgba(255,255,255,0.15);border-radius:100px;padding:4px 14px;"><p style="margin:0;font-size:11px;font-weight:600;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:1.2px;">${badge}</p></td></tr></table>` : ''}
    <h1 style="margin:16px 0 0 0;font-size:28px;font-weight:800;color:${C.white};font-family:${FONT};letter-spacing:-0.6px;line-height:1.2;">${title}</h1>
    <p style="margin:10px 0 0 0;font-size:15px;color:rgba(255,255,255,0.7);font-weight:500;line-height:1.4;">${subtitle}</p>
  </td></tr>
  </table>
</td></tr>

${body}

<!-- ═══ CTA ═══ -->
<tr><td class="mob-pad" style="padding:8px 48px 44px 48px;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
  <td align="center" style="background:${ctaBg || C.orange};border-radius:14px;padding:0;">
    <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${ctaUrl}" style="height:52px;v-text-anchor:middle;width:520px;" arcsize="27%" fillcolor="${ctaBg || C.orange}" stroke="f"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${ctaLabel}</center></v:roundrect><![endif]-->
    <!--[if !mso]><!--><a href="${ctaUrl}" style="display:block;padding:16px 32px;color:${C.white};text-decoration:none;font-size:15px;font-weight:700;font-family:${FONT};text-align:center;letter-spacing:0.2px;">${ctaLabel} &rarr;</a><!--<![endif]-->
  </td></tr></table>
</td></tr>

<!-- ═══ FOOTER ═══ -->
<tr><td style="border-top:1px solid ${C.border};padding:32px 48px 36px 48px;text-align:center;">
  <img src="${LOGO}" alt="Eventini" width="28" height="28" style="display:block;margin:0 auto 16px auto;border-radius:7px;opacity:0.5;"/>
  ${footerLines.map(l => `<p style="margin:0 0 4px 0;font-size:12px;color:${C.grayLight};line-height:1.6;">${l}</p>`).join('')}
  <p style="margin:12px 0 0 0;font-size:12px;"><a href="https://eventini.io" style="color:${C.teal};text-decoration:none;font-weight:600;">eventini.io</a></p>
</td></tr>

</table></td></tr></table></body></html>`;
}

function sec(title, content, opts = {}) {
  const pad = opts.topPad || '36px';
  const divider = opts.noDivider ? '' : `<tr><td class="mob-pad" style="padding:0 48px;"><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td style="border-top:1px solid ${C.borderLight};"></td></tr></table></td></tr>`;
  return `${divider}
<tr><td class="mob-pad" style="padding:${pad} 48px 0 48px;">
${title ? `<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr><td>
<p style="margin:0 0 4px 0;font-size:11px;font-weight:700;color:${C.grayLight};text-transform:uppercase;letter-spacing:1.5px;">${title}</p>
<table cellpadding="0" cellspacing="0" border="0"><tr><td style="width:32px;height:3px;background:${C.orange};border-radius:2px;"></td></tr></table>
</td></tr></table>` : ''}
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:${title ? '20px' : '0'};">
${content}
</table>
</td></tr>`;
}

function stats(items) {
  return `<tr><td><table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
${items.map(s => `<td class="stat-cell" style="text-align:center;padding:20px 6px;background:${C.offWhite};border-radius:12px;border:1px solid ${C.borderLight};width:${Math.floor(100 / items.length)}%;">
<p style="margin:0;font-size:28px;font-weight:800;color:${s.color || C.teal};font-family:${FONT};line-height:1;">${s.value}</p>
<p style="margin:8px 0 0 0;font-size:11px;font-weight:600;color:${C.gray};text-transform:uppercase;letter-spacing:0.6px;line-height:1.2;">${s.label}</p>
</td>`).join(`<td class="stat-gap" style="width:10px;font-size:1px;">&nbsp;</td>`)}
</tr></table></td></tr>`;
}

function featureCard(icon, title, desc) {
  return `<tr><td style="padding-bottom:14px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td style="background:${C.offWhite};border-radius:14px;padding:22px 24px;border:1px solid ${C.borderLight};">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td style="width:40px;vertical-align:top;padding-top:1px;">
  <div style="width:36px;height:36px;border-radius:10px;background:${C.orangePale};text-align:center;line-height:36px;font-size:18px;">${icon}</div>
</td>
<td style="padding-left:16px;">
  <p style="margin:0;font-size:15px;font-weight:700;color:${C.dark};line-height:1.3;">${title}</p>
  <p style="margin:6px 0 0 0;font-size:13px;color:${C.gray};line-height:1.65;">${desc}</p>
</td></tr></table>
</td></tr></table>
</td></tr>`;
}

function simpleCard(title, desc, borderColor) {
  borderColor = borderColor || C.border;
  return `<tr><td style="padding-bottom:10px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td style="border-radius:12px;padding:20px 22px;border:1px solid ${borderColor};border-left:4px solid ${borderColor === C.border ? C.tealSoft : borderColor};">
<p style="margin:0;font-size:14px;font-weight:700;color:${C.dark};line-height:1.35;">${title}</p>
<p style="margin:6px 0 0 0;font-size:13px;color:${C.gray};line-height:1.6;">${desc}</p>
</td></tr></table>
</td></tr>`;
}

function alertCard(title, items, color, bgColor) {
  return `<tr><td style="padding-bottom:10px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td style="background:${bgColor};border-radius:12px;padding:20px 22px;border:1px solid ${color}20;">
<p style="margin:0 0 10px 0;font-size:13px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.8px;">${title}</p>
${items.map(i => `<p style="margin:0 0 6px 0;font-size:13px;color:${C.mid};line-height:1.55;">${i}</p>`).join('')}
</td></tr></table>
</td></tr>`;
}

function providerCard(name, type, desc) {
  return `<tr><td style="padding-bottom:10px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td style="border-radius:12px;padding:18px 22px;border:1px solid ${C.border};background:${C.white};">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td style="width:44px;vertical-align:top;">
  <div style="width:40px;height:40px;border-radius:10px;background:${C.tealPale};text-align:center;line-height:40px;">
    <span style="font-size:13px;font-weight:800;color:${C.teal};">${name.charAt(0).toUpperCase()}</span>
  </div>
</td>
<td style="padding-left:14px;">
  <p style="margin:0;font-size:14px;font-weight:700;color:${C.dark};line-height:1.3;">${name}</p>
  <p style="margin:2px 0 0 0;font-size:11px;font-weight:600;color:${C.orange};text-transform:uppercase;letter-spacing:0.6px;">${type}</p>
  <p style="margin:6px 0 0 0;font-size:12px;color:${C.gray};line-height:1.55;">${desc}</p>
</td></tr></table>
</td></tr></table>
</td></tr>`;
}

function bulletItem(text) {
  return `<tr><td style="padding:0 0 10px 0;">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td style="width:24px;vertical-align:top;padding-top:4px;">
  <div style="width:6px;height:6px;border-radius:50%;background:${C.orange};margin:4px auto 0 auto;"></div>
</td>
<td style="font-size:14px;color:${C.mid};line-height:1.55;">${text}</td>
</tr></table>
</td></tr>`;
}

function stepItem(num, title, desc) {
  return `<tr><td style="padding:0 0 20px 0;">
<table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td style="width:48px;vertical-align:top;">
  <div style="width:40px;height:40px;border-radius:50%;background:${C.teal};text-align:center;line-height:40px;color:${C.white};font-weight:800;font-size:16px;font-family:${FONT};">${num}</div>
</td>
<td style="padding-left:16px;">
  <p style="margin:0;font-size:15px;font-weight:700;color:${C.dark};line-height:1.3;">${title}</p>
  <p style="margin:5px 0 0 0;font-size:13px;color:${C.gray};line-height:1.6;">${desc}</p>
</td></tr></table>
</td></tr>`;
}

function introText(text) {
  return `<tr><td class="mob-pad" style="padding:36px 48px 0 48px;">
<p style="margin:0;font-size:15px;color:${C.gray};line-height:1.75;">${text}</p>
</td></tr>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. ADMIN DIGEST
// ═══════════════════════════════════════════════════════════════════════════

function buildAdmin() {
  const body = [
    introText('Your monthly internal digest — platform metrics, development progress, and items that need attention.'),

    sec('Platform Overview', `
      ${stats([
        { value: '142', label: 'Total Users', color: C.teal },
        { value: '68', label: 'Providers', color: C.teal },
        { value: '8', label: 'Events', color: C.teal },
        { value: '99', label: 'Transactions', color: C.teal },
      ])}
    `, { noDivider: true }),

    sec('Pipeline', `
      ${stats([
        { value: '16', label: 'Pending Apps', color: C.orange },
        { value: '3', label: 'Bookings', color: C.orange },
        { value: '20', label: 'New Providers', color: C.orange },
        { value: '34', label: 'Waitlist', color: C.orange },
      ])}
      <tr><td style="padding-top:14px;">
        <p style="margin:0;font-size:13px;color:${C.gray};line-height:1.65;">16 provider applications awaiting review. 13 new event requests in March. 1 Accelerate application pending.</p>
      </td></tr>
    `),

    sec('Development', `
      ${featureCard('&#9881;', 'Payment Infrastructure Overhaul', 'Idempotency keys prevent duplicate Stripe charges. Source_transaction for cleaner provider payouts. Proportional refund fee handling.')}
      ${featureCard('&#9711;', 'Mobile App v4.1.0', 'Server-side provider geocoding, Apple Developer team migration, Stripe SDK 25.7.1 for Xcode 26.4 compatibility.')}
      ${featureCard('&#9889;', 'Accelerate Program', 'Commission tracking, phone onboarding, dedicated welcome emails. 2.5% per transaction model is live.')}
      ${featureCard('&#9673;', 'Fee Transparency', 'Full breakdown on every order — tax, service fee, tip separated. Duplicate order prevention shipped.')}
    `),

    sec('Active Campaigns', `
      ${bulletItem('<strong style="color:' + C.dark + ';">Instagram DM Outreach</strong> &mdash; ongoing provider recruitment')}
      ${bulletItem('<strong style="color:' + C.dark + ';">Park People</strong> &mdash; community event partnerships')}
      ${bulletItem('<strong style="color:' + C.dark + ';">MailChimp</strong> &mdash; email marketing integration')}
      ${bulletItem('<strong style="color:' + C.dark + ';">Facebook Groups</strong> &mdash; host acquisition')}
      ${bulletItem('<strong style="color:' + C.dark + ';">Press Release</strong> &mdash; media outreach')}
    `),

    sec('Needs Attention', `
      ${alertCard('Action Required', [
        '<strong>16 provider applications</strong> pending review',
        '<strong>Keven Bell</strong> stalled on event plan (Red Cats Opening Day, 200 guests) at recommendations &mdash; consider a follow-up',
        '<strong>1 Accelerate application</strong> awaiting approval',
      ], C.warn, C.warnPale)}
    `),

    `<tr><td style="height:12px;"></td></tr>`,
  ].join('');

  return shell({
    preheader: 'March 2026 internal digest — 142 users, 68 providers, 20 new this month',
    headerBg: `linear-gradient(160deg, ${C.navy} 0%, ${C.navyMid} 50%, ${C.teal} 100%)`,
    headerAccent: C.orange,
    badge: 'Internal',
    title: 'Admin Digest',
    subtitle: 'March 2026',
    body,
    ctaLabel: 'Open Admin Dashboard',
    ctaUrl: 'https://eventini-admin.vercel.app',
    ctaBg: C.navy,
    footerLines: ['Eventini Internal &mdash; Confidential', 'This digest is for the Eventini team only.'],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. PROVIDER NEWSLETTER
// ═══════════════════════════════════════════════════════════════════════════

function buildProvider() {
  const body = [
    introText("Here's your monthly Eventini update &mdash; platform improvements that affect you, events looking for providers, and tips to grow your business."),

    sec("What's New", `
      ${featureCard('&#36;', 'Faster, Cleaner Payouts', "Rebuilt payout system using source transactions for faster processing. You'll see clearer breakdowns of every payout in your dashboard.")}
      ${featureCard('&#9889;', 'Accelerate Program', "Grow your business with just 2.5% commission per transaction. Priority placement, dedicated support, and real-time commission tracking.")}
      ${featureCard('&#9881;', 'POS Improvements', "Average ticket time tracking, improved receipt emails with full fee transparency, and a better organization dashboard for multi-provider setups.")}
    `, { noDivider: true }),

    sec('Marketplace Pulse', `
      ${stats([
        { value: '142', label: 'Active Hosts', color: C.teal },
        { value: '13', label: 'New Requests', color: C.orange },
        { value: '200+', label: 'Avg Guests', color: C.teal },
      ])}
      <tr><td style="padding-top:14px;">
        <p style="margin:0;font-size:13px;color:${C.gray};line-height:1.65;">Events range from 50-person gatherings to 800+ community festivals. Keep your profile complete and your calendar up to date to show up in search.</p>
      </td></tr>
    `),

    sec('Events Looking for Providers', `
      ${simpleCard('Denim Day Block Party', 'Community festival in Milwaukee. Seeking food and entertainment providers.', C.tealSoft)}
      ${simpleCard('Family Gathering &mdash; 100 Guests', 'Personal host in Milwaukee. Looking for food truck and catering. Budget: $525.', C.tealSoft)}
      ${simpleCard('Graduation Party &mdash; 200 Guests', 'Whitefish Bay. Food, beverage, and entertainment needed.', C.tealSoft)}
      ${simpleCard('Red Cats Opening Day &mdash; 200 Guests', 'Milwaukee baseball event, May 2. Food trucks wanted.', C.tealSoft)}
    `),

    sec('Welcome to the Platform', `
      ${providerCard('Roll MKE', 'Food & Beverage', 'Creative street food now available for Milwaukee events.')}
      ${providerCard('Spaceman Burgers', 'Food & Beverage', 'Gourmet burgers from Racine, now booking spring and summer.')}
      ${providerCard('Eaden Marti', 'Entertainment', 'Magician and mentalist bringing mind-bending performances.')}
      ${providerCard('Masso Balloons', 'Vendor / Maker', 'Custom balloon art and installations for all event sizes.')}
    `),

    sec('Grow Your Bookings', `
      ${bulletItem('<strong style="color:' + C.dark + ';">Complete your profile</strong> &mdash; providers with photos and full menus get 3x more views')}
      ${bulletItem('<strong style="color:' + C.dark + ';">Respond fast</strong> &mdash; hosts book the first provider who responds. Aim for under 2 hours.')}
      ${bulletItem('<strong style="color:' + C.dark + ';">Keep your calendar current</strong> &mdash; updated availability = more bookings')}
      ${bulletItem('<strong style="color:' + C.dark + ';">Ask for reviews</strong> &mdash; after every event, ask your host to review you on Eventini')}
    `),

    `<tr><td style="height:12px;"></td></tr>`,
  ].join('');

  return shell({
    preheader: 'March update — new payout system, 13 event requests, and tips to get more bookings',
    headerBg: `linear-gradient(160deg, ${C.teal} 0%, ${C.tealSoft} 100%)`,
    headerAccent: C.orange,
    badge: 'Provider Update',
    title: 'Your Monthly Brief',
    subtitle: 'March 2026',
    body,
    ctaLabel: 'View Your Dashboard',
    ctaUrl: 'https://eventini.io',
    ctaBg: C.teal,
    footerLines: [
      "Eventini &mdash; Milwaukee's Event Planning Marketplace",
      "You're receiving this as a registered Eventini provider.",
    ],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. HOST / PUBLIC NEWSLETTER
// ═══════════════════════════════════════════════════════════════════════════

function buildHost() {
  const body = [
    introText("Planning something special? Here's what's new on Eventini &mdash; fresh providers, seasonal inspiration, and everything you need to host an unforgettable event."),

    sec('The Marketplace Is Growing', `
      ${stats([
        { value: '68', label: 'Providers', color: C.orange },
        { value: '37', label: 'Food & Bev', color: C.orange },
        { value: '17', label: 'Entertainment', color: C.orange },
        { value: '14', label: 'Vendors & Venues', color: C.orange },
      ])}
      <tr><td style="padding-top:14px;">
        <p style="margin:0;font-size:14px;color:${C.gray};line-height:1.65;">From food trucks to magicians, DJs to balloon artists &mdash; find the perfect mix for your next event, all in one place.</p>
      </td></tr>
    `, { noDivider: true }),

    sec('New This Month', `
      ${providerCard('Roll MKE', 'Food Truck', 'Fresh rolls and creative street food, now booking for events.')}
      ${providerCard('Spaceman Burgers', 'Food Truck &mdash; Racine', 'Gourmet burgers that are out of this world. Spring and summer availability.')}
      ${providerCard('Pop City Gourmet Popcorn', 'Food & Beverage', 'Every flavor imaginable. Perfect for movie nights, festivals, and parties.')}
      ${providerCard('Fusion Flamenco', 'Entertainment', 'Passionate flamenco dance performances for any celebration.')}
      ${providerCard('Jazz In Vivo Trio', 'Live Music', 'Smooth jazz for cocktail hours, dinners, and sophisticated events.')}
      ${providerCard('Sabor Sin Fronteras', 'Peruvian Kitchen', 'Bold South American flavors, now on the Eventini marketplace.')}
    `),

    sec('Spring Event Ideas', `
      ${featureCard('&#9788;', 'Community Block Parties', "Weather's warming up. A food truck, DJ, and balloon artist for under $1,000 &mdash; Eventini coordinates it all.")}
      ${featureCard('&#127891;', 'Graduation Season', "May and June fill up fast. Book now and secure the best local providers &mdash; we recommend 3&ndash;4 weeks lead time.")}
      ${featureCard('&#127970;', 'Corporate Team Events', "Skip the generic catering. Browse unique local vendors for a team outing people actually enjoy.")}
    `),

    sec('How Eventini Works', `
      ${stepItem('1', 'Tell Us About Your Event', 'Answer a few quick questions &mdash; event type, date, guest count, and what you need.')}
      ${stepItem('2', 'Get Matched with Providers', "We surface the best local providers for your specific event. Browse menus, reviews, and pricing.")}
      ${stepItem('3', 'Book and Relax', 'Confirm your lineup, pay securely through Eventini, and enjoy your event.')}
    `),

    sec('What Hosts Are Saying', `
      <tr><td>
      <table cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="background:${C.tealPale};border-radius:14px;padding:28px 26px;">
        <p style="margin:0;font-size:20px;color:${C.teal};line-height:1;font-family:Georgia,serif;">&ldquo;</p>
        <p style="margin:0;font-size:15px;color:${C.dark};line-height:1.65;font-style:italic;">Eventini made planning our community block party so easy. We found three amazing food trucks and a DJ all in one place. Everyone loved it.</p>
        <table cellpadding="0" cellspacing="0" border="0" style="margin-top:16px;"><tr>
        <td style="width:32px;height:32px;border-radius:50%;background:${C.teal};text-align:center;line-height:32px;color:${C.white};font-size:13px;font-weight:700;">M</td>
        <td style="padding-left:10px;">
          <p style="margin:0;font-size:13px;font-weight:700;color:${C.dark};">Milwaukee Community Host</p>
          <p style="margin:1px 0 0 0;font-size:12px;color:${C.gray};">Block Party, 150 guests</p>
        </td></tr></table>
      </td></tr></table>
      </td></tr>
    `),

    `<tr><td style="height:12px;"></td></tr>`,
  ].join('');

  return shell({
    preheader: '68 providers and growing — new food trucks, entertainers, and spring event ideas',
    headerBg: `linear-gradient(160deg, ${C.orange} 0%, ${C.orangeSoft} 100%)`,
    headerAccent: C.teal,
    badge: 'Monthly Update',
    title: 'Eventini Monthly',
    subtitle: 'March 2026 &mdash; New Providers, Ideas & More',
    body,
    ctaLabel: 'Start Planning Your Event',
    ctaUrl: 'https://eventini.io',
    ctaBg: C.orange,
    footerLines: [
      'Eventini &mdash; Find and book the best event providers for your next celebration.',
      "You're receiving this because you signed up on eventini.io.",
    ],
  });
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  const drafts = [
    { subject: '[DRAFT v2] Eventini Admin Digest — March 2026', html: buildAdmin() },
    { subject: '[DRAFT v2] Eventini Provider Update — March 2026', html: buildProvider() },
    { subject: '[DRAFT v2] Eventini Monthly — March 2026 (Host/Public)', html: buildHost() },
  ];

  for (const d of drafts) {
    console.log(`Sending: ${d.subject}`);
    try {
      const r = await sendEmail(TO, d.subject, d.html);
      console.log(`  Sent: ${r.id}`);
    } catch (e) {
      console.error(`  Failed: ${e.message}`);
    }
  }
}

main();
