const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");

function todayPL() {
  // YYYY-MM-DD w strefie Europe/Warsaw
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(new Date());
}

function safeJoinUrl(base, p) {
  if (!base) return p || "";
  const b = base.endsWith("/") ? base : base + "/";
  const pp = (p || "").replace(/^\//, "");
  return b + pp;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function readJsonOrEmpty(filePath) {
  try {
    if (!filePath) return {};
    if (!fs.existsSync(filePath)) return {};
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.log(`Could not parse JSON: ${filePath}. Using empty object.`);
    return {};
  }
}

async function main() {
  // args: before.json after.json
  const beforePath = process.argv[2] || "";
  const afterPath = process.argv[3] || path.join(process.cwd(), "manifest.json");

  const beforeManifest = readJsonOrEmpty(beforePath);
  const afterManifest = readJsonOrEmpty(afterPath);

  const today = todayPL();
  const baseUrl = process.env.BASE_URL || "";

  const items = [];

  for (const [key, after] of Object.entries(afterManifest)) {
    if (!after || typeof after !== "object") continue;

    const before = (beforeManifest && beforeManifest[key] && typeof beforeManifest[key] === "object")
      ? beforeManifest[key]
      : null;

    const afterUpdated = (after.updated || "").toString().trim();
    const beforeUpdated = before ? (before.updated || "").toString().trim() : "";

    // WARUNEK:
    // 1) po zmianie: updated == today
    // 2) przed zmianą: updated != today (lub nie istniało)
    if (afterUpdated === today && beforeUpdated !== today) {
      items.push({
        name: after.name || key,
        description: after.description || "",
        path: after.path || "",
        frequency: after.frequency || "",
        next_issue: after.next_issue || "",
        alert_comment: (after.alert_comment || "").toString().trim(),
        url: safeJoinUrl(baseUrl, after.path || ""),
      });
    }
  }

  if (items.length === 0) {
    console.log(`No NEW items updated today (${today}). Not sending email.`);
    return;
  }

  const toList = (process.env.MAIL_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (toList.length === 0) {
    console.log("MAIL_TO is empty. Not sending email.");
    return;
  }

  const namesForSubject = items.map((it) => it.name).join(", ");
  const subject = `ACE – nowe wydanie (${today}${namesForSubject ? ", " + namesForSubject : ""})`;

  // TEXT body
  const linesText = items.map((it, i) => {
    return [
      `${i + 1}. ${it.name}`,
      it.description ? `   ${it.description}` : "",
      it.alert_comment ? `   Komentarz ACE: ${it.alert_comment}` : "",
      it.frequency ? `   Częstotliwość: ${it.frequency}` : "",
      it.next_issue ? `   Kolejna: ${it.next_issue}` : "",
      it.url ? `   Link: ${it.url}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  const textBody = `Nowe Wydanie Agri Commodity Experts:
Data: ${today}

${linesText.join("\n\n")}

Panel: https://raporty.ace-group.pl/
— ACE`;

  // HTML items
  const htmlItems = items
  .map((it) => {

    const commentBlock = it.alert_comment
      ? `
      <div style="
        margin-top:6px;
        margin-bottom:10px;
        padding:10px 12px;
        background:#eef3ff;
        border-left:4px solid #244a9b;
        border-radius:6px;
        font-size:13px;
        line-height:1.6;
        color:#24324a;
      ">
        <strong style="color:#244a9b;">Komentarz ACE:</strong>
        ${escapeHtml(it.alert_comment)}
      </div>
      `
      : "";

    const reportLink = it.url
      ? `
      <div style="margin-top:12px;">
        <a href="${escapeHtml(it.url)}"
        style="
          color:#0b1220;
          font-size:13px;
          font-weight:700;
          text-decoration:none;
        ">
          Otwórz publikację →
        </a>
      </div>`
      : "";

    return `
      <div style="
        margin-bottom:20px;
        padding-bottom:16px;
        border-bottom:1px solid #eee;
      ">

        <div style="font-size:16px;margin-bottom:4px;">
          <strong>${escapeHtml(it.name)}</strong>
        </div>

        ${commentBlock}

        ${
          it.description
            ? `<div style="color:#333;margin-top:4px;">
                ${escapeHtml(it.description)}
               </div>`
            : ""
        }

        <div style="margin-top:8px;color:#666;font-size:12px;line-height:1.5;">
          ${it.frequency ? `Częstotliwość: ${escapeHtml(it.frequency)}<br>` : ""}
          ${it.next_issue ? `Kolejna: ${escapeHtml(it.next_issue)}<br>` : ""}
        </div>

        ${reportLink}

      </div>
    `;
  })
  .join("");

  // HTML template
  const templatePath = path.join(process.cwd(), ".github", "email-template.html");
  if (!fs.existsSync(templatePath)) {
    console.log("Missing .github/email-template.html. Not sending.");
    return;
  }

  const template = fs.readFileSync(templatePath, "utf8");
  const htmlBody = template
    .replaceAll("{{DATE}}", escapeHtml(today))
    .replace("{{CONTENT}}", htmlItems);

  // SMTP
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "587");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM;

  if (!host || !port || !user || !pass || !from) {
    console.log("Missing SMTP env vars (SMTP_HOST/PORT/USER/PASS or MAIL_FROM). Not sending.");
    return;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { minVersion: "TLSv1.2" },
  });

  const info = await transporter.sendMail({
    from,
    to: from,
    bcc: toList,
    subject,
    text: textBody,
    html: htmlBody,
  });

  console.log("Email sent:", info.messageId);
}

main().catch((err) => {
  console.error("ERROR:", err);
  process.exit(1);
});
