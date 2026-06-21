// Vessel Intelligence — push lookup triggered on every form submission.
// Runs as a Netlify Background Function (up to 15 min, returns 202 immediately).
//
// Required env vars:
//   ANTHROPIC_API_KEY   — from platform.anthropic.com
//   GMAIL_APP_PASSWORD  — Gmail app password for angam.cowork@gmail.com

const GMAIL_USER = "angam.cowork@gmail.com";

// ─── helpers ────────────────────────────────────────────────────────────────

async function jinaFetch(url, timeoutMs = 20000) {
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain", "X-Return-Format": "text" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    return text.length > 200 ? text : "";
  } catch {
    return "";
  }
}

async function gatherVesselData(identifier) {
  const isIMO  = /^\d{7}$/.test(identifier);
  const isDNV  = /^\d{1,6}$/.test(identifier) && !isIMO;
  const isName = !isIMO && !isDNV;

  let pages = [];

  if (isIMO) {
    const [vf, mt] = await Promise.all([
      jinaFetch(`https://www.vesselfinder.com/vessels/details/${identifier}`),
      jinaFetch(`https://www.marinetraffic.com/en/ais/details/ships/imo:${identifier}`),
    ]);
    if (vf) pages.push({ source: "VesselFinder",   text: vf.slice(0, 5000) });
    if (mt) pages.push({ source: "MarineTraffic",  text: mt.slice(0, 5000) });
  } else if (isDNV) {
    const vf = await jinaFetch(
      `https://www.vesselfinder.com/vessels?name=${encodeURIComponent(identifier)}`
    );
    if (vf) pages.push({ source: "VesselFinder search", text: vf.slice(0, 5000) });
  } else {
    const [vf, mt] = await Promise.all([
      jinaFetch(`https://www.vesselfinder.com/vessels?name=${encodeURIComponent(identifier)}`),
      jinaFetch(
        `https://www.marinetraffic.com/en/ais/home/centerx:-25/centery:35/zoom:2/searchValue:${encodeURIComponent(identifier)}`
      ),
    ]);
    if (vf) pages.push({ source: "VesselFinder search", text: vf.slice(0, 5000) });
    if (mt) pages.push({ source: "MarineTraffic search", text: mt.slice(0, 5000) });
  }

  return pages;
}

async function synthesiseReport(identifier, pages) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const sourceBlock = pages.length
    ? pages.map((p) => `=== ${p.source} ===\n${p.text}`).join("\n\n")
    : "(No public data was retrievable for this identifier.)";

  const now = new Date().toUTCString();
  const sourceList = pages.map((p) => p.source).join(", ") || "none";

  const prompt = `You are a maritime intelligence analyst. Generate a professional vessel report for the identifier: "${identifier}"

Use only the data provided below. Do not invent or guess any values — write "Not available" for any field that cannot be confirmed.

${sourceBlock}

Format the report exactly as follows:

VESSEL REPORT
=============
Vessel Name:           [name]
IMO Number:            [7-digit IMO or "Not available"]
Vessel Type:           [type]
Flag State:            [country]
Gross Tonnage:         [GT]
DWT:                   [deadweight tonnage]
Dimensions:            [LOA x beam, if available]
Build Year / Delivery: [year or date]
Operational Status:    [in service / laid up / scrapped / unknown]

OWNERSHIP & MANAGEMENT
=======================
Registered Owner:      [company]
Ship Manager:          [company or "Not available"]

CLASSIFICATION
==============
Class Society:         [society name or "Not available"]

PORT STATE CONTROL
==================
[Any PSC inspection or detention data found, or "No PSC data in public sources"]

RECENT ACTIVITY (last 12 months)
=================================
[News, incidents, detentions, ownership changes — or "None found in public data"]

---
Sources used: ${sourceList}
Note: This report is based on publicly accessible maritime data. For authoritative class records, Equasis ownership history, and DNV survey dates, use the full Vessel Intelligence Cowork skill.
Report generated: ${now}`;

  const msg = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2000,
    messages: [{ role: "user", content: prompt }],
  });

  return msg.content[0].text;
}

async function sendEmail(to, subject, body) {
  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: `"Vessel Intelligence" <${GMAIL_USER}>`,
    to, subject, text: body,
  });
}

// ─── handler ────────────────────────────────────────────────────────────────

exports.handler = async function (event) {
  let vessel_id, send_to;
  try {
    ({ vessel_id, send_to } = JSON.parse(event.body || "{}"));
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }
  if (!vessel_id || !send_to) {
    return { statusCode: 400, body: "Missing vessel_id or send_to" };
  }
  (async () => {
    try {
      const pages  = await gatherVesselData(vessel_id);
      const report = await synthesiseReport(vessel_id, pages);
      await sendEmail(send_to, `Vessel Report: ${vessel_id}`, report);
      console.log(`✓ Report for "${vessel_id}" sent to ${send_to}`);
    } catch (err) {
      console.error(`✗ vessel-request error for "${vessel_id}":`, err);
      try {
        await sendEmail(
          send_to,
          `Vessel Report: ${vessel_id} — lookup failed`,
          `We were unable to retrieve data for vessel "${vessel_id}" at this time.\n\nPlease try again or contact support.\n\nError: ${err.message}`
        );
      } catch { /* swallow */ }
    }
  })();
  return { statusCode: 202, body: JSON.stringify({ queued: true }) };
};
