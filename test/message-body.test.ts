import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMessage } from "../src/mail.js";

const LINK = "https://travel.state.gov/status";
const HTML = [
  "<html><body>",
  "<style>.secret{display:none}</style>",
  "<p>Your passport application is <b>in process</b>.</p>",
  "<table><tr><td>Status</td><td>In process</td></tr>",
  `<tr><td colspan="2"><a href="${LINK}">the status page</a></td></tr></table>`,
  "</body></html>",
].join("");

const COMMON = [
  "From: DoNotReply@state.gov",
  "To: you@icloud.com",
  "Subject: Passport Application Status",
  "Date: Wed, 25 Nov 2026 15:04:00 +0000",
  "MIME-Version: 1.0",
];

function email(headers: string[], body: string | Buffer): Buffer {
  const head = Buffer.from(`${headers.join("\r\n")}\r\n\r\n`, "utf8");
  return Buffer.concat([head, Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")]);
}

function part(headers: string[], body: string): string {
  return `${headers.join("\r\n")}\r\n\r\n${body}\r\n`;
}

function alternative(parts: string[]): string {
  return parts.map((body) => `--alt\r\n${body}`).join("") + "--alt--\r\n";
}

function base64(data: Buffer): string {
  return data.toString("base64").replace(/.{76}/g, "$&\r\n");
}

const SUCCESS_KEYS = ["attachments", "cc", "date", "from", "replyTo", "subject", "text", "textTruncated", "to"];

describe("parseMessage", () => {
  it("converts a root HTML-only message and keeps link URLs", async () => {
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: 8bit"],
      HTML,
    ));
    assert.deepEqual(Object.keys(result).sort(), SUCCESS_KEYS);
    assert.equal(result.textTruncated, false);
    assert.equal(result.textError, undefined);
    assert.match(result.text, /in process/);
    assert.match(result.text, /Status/);
    assert.ok(result.text.includes(LINK));
    assert.doesNotMatch(result.text, /display:none|<html|<a /);
    assert.deepEqual(result.attachments, []);
    assert.deepEqual(result.from, ["DoNotReply@state.gov"]);
  });

  it("keeps the text/plain part of multipart/alternative when it has content", async () => {
    const body = alternative([
      part(["Content-Type: text/plain; charset=utf-8"], "Plain status: in process"),
      part(["Content-Type: text/html; charset=utf-8"], HTML),
    ]);
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/alternative; boundary=alt"],
      body,
    ));
    assert.equal(result.textError, undefined);
    assert.match(result.text, /Plain status: in process/);
    assert.equal(result.text.includes(LINK), false);
    assert.deepEqual(result.attachments, []);
  });

  it("converts quoted-printable HTML that is the only multipart/alternative part", async () => {
    const qp = [
      "<html><body><p>Your passport application is in pro=",
      `cess.</p><p><a href=3D"${LINK}">the status page</a></p></body></html>`,
    ].join("\r\n");
    const body = alternative([
      part(
        ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: quoted-printable"],
        qp,
      ),
    ]);
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/alternative; boundary=alt"],
      body,
    ));
    assert.equal(result.textError, undefined);
    assert.equal(result.textTruncated, false);
    assert.match(result.text, /in process/);
    assert.ok(result.text.includes(LINK));
    assert.equal(result.text.includes("=3D"), false);
    assert.equal(result.text.includes("pro="), false);
    assert.deepEqual(result.attachments, []);
    assert.equal(result.subject, "Passport Application Status");
  });

  it("converts base64 HTML nested in multipart/related and multipart/alternative", async () => {
    const htmlPart = part(
      ["Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64"],
      base64(Buffer.from(HTML, "utf8")),
    );
    const image = part(
      [
        'Content-Type: image/png; name="logo.png"',
        "Content-Transfer-Encoding: base64",
        "Content-ID: <logo@state.gov>",
        'Content-Disposition: inline; filename="logo.png"',
      ],
      "iVBORw0KGgo=",
    );
    const related = `--rel\r\n${part(
      ["Content-Type: multipart/alternative; boundary=alt"],
      alternative([htmlPart]),
    )}--rel\r\n${image}--rel--\r\n`;
    const result = await parseMessage(email(
      [...COMMON, 'Content-Type: multipart/related; boundary=rel; type="multipart/alternative"'],
      related,
    ));
    assert.equal(result.textError, undefined);
    assert.match(result.text, /in process/);
    assert.match(result.text, /Status\s+In process/);
    assert.ok(result.text.includes(LINK));
    assert.doesNotMatch(result.text, /display:none|<html/);
    assert.equal(result.text.includes("  "), false);
    assert.doesNotMatch(result.text, /[ \t]$/m);
    assert.deepEqual(result.attachments, [{
      index: 0,
      filename: "logo.png",
      contentType: "image/png",
      sizeBytes: Buffer.from("iVBORw0KGgo=", "base64").length,
    }]);
  });

  it("uses the HTML part when the text/plain alternative is blank", async () => {
    const body = alternative([
      part(["Content-Type: text/plain; charset=utf-8"], "   "),
      part(["Content-Type: text/html; charset=utf-8"], HTML),
    ]);
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/alternative; boundary=alt"],
      body,
    ));
    assert.equal(result.textError, undefined);
    assert.match(result.text, /in process/);
    assert.ok(result.text.includes(LINK));
    assert.equal(result.text.trim(), result.text);
  });

  it("decodes a windows-1252 quoted-printable HTML part", async () => {
    const qp = `<p>Your caf=E9 application is ready. <a href=3D"${LINK}">status</a>.</p>`;
    const body = alternative([
      part(
        ["Content-Type: text/html; charset=windows-1252", "Content-Transfer-Encoding: quoted-printable"],
        qp,
      ),
    ]);
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/alternative; boundary=alt"],
      body,
    ));
    assert.equal(result.textError, undefined);
    assert.match(result.text, /café/);
    assert.ok(result.text.includes(LINK));
    assert.deepEqual(result.attachments, []);
  });

  it("decodes a base64 iso-8859-1 text/plain part", async () => {
    const bytes = Buffer.concat([Buffer.from("Na", "ascii"), Buffer.from([0xef]), Buffer.from("ve status", "ascii")]);
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: base64"],
      base64(bytes),
    ));
    assert.equal(result.textError, undefined);
    assert.equal(result.text, "Naïve status");
    assert.deepEqual(result.attachments, []);
  });

  it("decodes quoted-printable iso-8859-1 text inside multipart/mixed", async () => {
    const plain = part(
      ["Content-Type: text/plain; charset=iso-8859-1", "Content-Transfer-Encoding: quoted-printable"],
      "Na=EFve status",
    );
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/mixed; boundary=mix"],
      `--mix\r\n${plain}--mix--\r\n`,
    ));
    assert.equal(result.text, "Naïve status");
    assert.equal(result.textError, undefined);
  });

  it("converts HTML that is the body of multipart/mixed", async () => {
    const htmlPart = part(["Content-Type: text/html; charset=utf-8"], HTML);
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/mixed; boundary=mix"],
      `--mix\r\n${htmlPart}--mix--\r\n`,
    ));
    assert.equal(result.textError, undefined);
    assert.match(result.text, /in process/);
    assert.ok(result.text.includes(LINK));
    assert.deepEqual(result.attachments, []);
  });

  it("still reads a layout table with many unclosed cells", async () => {
    const cells = Array.from({ length: 1100 }, (_, i) => `<td>c${i}`).join("");
    const html = `<html><body><table><tr>${cells}</tr></table><p>passport ready <a href="${LINK}">status</a></p></body></html>`;
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/alternative; boundary=alt"],
      alternative([part(["Content-Type: text/html; charset=utf-8"], html)]),
    ));
    assert.equal(result.textError, undefined);
    assert.match(result.text, /passport ready/);
    assert.match(result.text, /c0/);
    assert.match(result.text, /c1099/);
    assert.ok(result.text.includes(LINK));
  });

  it("says when HTML is nested too deeply to convert", async () => {
    let inner = "Passport status";
    for (let i = 0; i < 1001; i++) inner = `<div>${inner}</div>`;
    const html = `<html><body>${inner}</body></html>`;

    const root = await parseMessage(email(
      [...COMMON, "Content-Type: text/html; charset=utf-8"],
      html,
    ));
    assert.equal(root.text, "");
    assert.equal(root.textTruncated, false);
    assert.match(root.textError ?? "", /HTML nested deeper than 1000 levels/);
    assert.equal(root.subject, "Passport Application Status");

    const nested = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/alternative; boundary=alt"],
      alternative([part(["Content-Type: text/html; charset=utf-8"], html)]),
    ));
    assert.equal(nested.text, "");
    assert.match(nested.textError ?? "", /HTML nested deeper than 1000 levels/);
    assert.deepEqual(nested.attachments, []);
  });

  it("says when an HTML body has no readable text", async () => {
    const body = alternative([
      part(["Content-Type: text/html; charset=utf-8"], "<html><body><!-- tracking only --></body></html>"),
    ]);
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: multipart/alternative; boundary=alt"],
      body,
    ));
    assert.equal(result.text, "");
    assert.match(result.textError ?? "", /no readable text/);
    assert.equal(result.subject, "Passport Application Status");
  });

  it("returns empty text for a message that has no body", async () => {
    const result = await parseMessage(email(
      [...COMMON, "Content-Type: text/plain; charset=utf-8"],
      "",
    ));
    assert.equal(result.text.trim(), "");
    assert.equal(result.textError, undefined);
    assert.deepEqual(result.attachments, []);
  });
});
