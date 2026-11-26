import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import nodemailer from "nodemailer";
import { htmlToPlainText } from "./html-text.js";

export type MailConfig = {
  imapHost: string;
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
};

type MessageRef = { mailbox: string; uid: number };
type AttachmentRef = MessageRef & { index: number };

const TLS = { minVersion: "TLSv1.2", rejectUnauthorized: true } as const;
const MESSAGE_ID = /^<[^<>\s]+>$/;

type Address = { name?: string; address?: string };

function formatAddresses(list: Address[] = []): string[] {
  return list.map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")));
}

function formatParsed(value?: AddressObject | AddressObject[]): string[] {
  return [value ?? []].flat().flatMap((o) => formatAddresses(o.value));
}

async function withMailbox<T>(config: MailConfig, mailbox: string | null, fn: (client: ImapFlow) => Promise<T>) {
  const client = new ImapFlow({
    host: config.imapHost,
    port: 993,
    secure: true,
    auth: { user: config.username, pass: config.password },
    tls: TLS,
    logger: false,
    disableAutoIdle: true,
  });
  try {
    await client.connect();
    if (!mailbox) return await fn(client);
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } catch (err) {
    const e = err as { authenticationFailed?: boolean; responseText?: string };
    if (e.authenticationFailed) throw new Error("The mail server rejected the login");
    throw e.responseText ? new Error(`IMAP error: ${e.responseText}`) : err;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

export function listMailboxes(config: MailConfig) {
  return withMailbox(config, null, async (client) =>
    (await client.list()).map((b) => ({ path: b.path, specialUse: b.specialUse ?? null })),
  );
}

type SearchParams = {
  mailbox: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unreadOnly: boolean;
  limit: number;
};

export function searchMessages(config: MailConfig, { mailbox, unreadOnly, limit, ...filters }: SearchParams) {
  return withMailbox(config, mailbox, async (client) => {
    const query: SearchObject = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    if (unreadOnly) query.seen = false;
    if (Object.keys(query).length === 0) query.all = true;

    const uids = (await client.search(query, { uid: true })) || [];
    const newest = uids.sort((a, b) => a - b).slice(-limit);
    if (newest.length === 0) return { totalMatches: 0, messages: [] };

    const fetched = await client.fetchAll(newest.join(","), { envelope: true, flags: true }, { uid: true });
    const messages = fetched
      .map((m) => ({
        uid: m.uid,
        date: m.envelope?.date ?? null,
        from: formatAddresses(m.envelope?.from),
        to: formatAddresses(m.envelope?.to),
        subject: m.envelope?.subject ?? "",
        unread: !m.flags?.has("\\Seen"),
      }))
      .sort((a, b) => b.uid - a.uid);
    return { totalMatches: uids.length, messages };
  });
}

const MAX_TEXT_CHARS = 20_000;
const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
const PARSER_OPTIONS = { skipImageLinks: true, skipTextLinks: true };

function parseSource(source: Buffer) {
  return simpleParser(source, PARSER_OPTIONS);
}

// simpleParser fills `text` from text/plain parts, and converts HTML only when the
// text/html part is the root of the message. Nested HTML (multipart/alternative,
// related, or mixed) otherwise leaves `text` empty while `html` holds the body.
function extractText(parsed: ParsedMail): { text: string; textError?: string } {
  const plain = typeof parsed.text === "string" ? parsed.text : "";
  if (plain.trim()) return { text: plain };
  if (parsed.textConversionError) return { text: "", textError: parsed.textConversionError.message };
  const html = typeof parsed.html === "string" ? parsed.html : "";
  if (!html.trim()) return { text: plain };
  return htmlToPlainText(html);
}

function formatMessage(parsed: ParsedMail) {
  const { text, textError } = extractText(parsed);
  return {
    date: parsed.date ?? null,
    from: formatParsed(parsed.from),
    to: formatParsed(parsed.to),
    cc: formatParsed(parsed.cc),
    replyTo: formatParsed(parsed.replyTo),
    subject: parsed.subject ?? "",
    text: text.slice(0, MAX_TEXT_CHARS),
    textTruncated: text.length > MAX_TEXT_CHARS,
    ...(textError ? { textError } : {}),
    attachments: parsed.attachments.map((a, index) => ({
      index,
      filename: a.filename ?? null,
      contentType: a.contentType,
      sizeBytes: a.size,
    })),
  };
}

export async function parseMessage(source: Buffer) {
  return formatMessage(await parseSource(source));
}

async function readMessage(client: ImapFlow, mailbox: string, uid: number) {
  const msg = await client.fetchOne(
    String(uid),
    { size: true, source: { maxLength: MAX_MESSAGE_BYTES } },
    { uid: true },
  );
  if (!msg || !msg.source) throw new Error(`No message with UID ${uid} in ${mailbox}`);
  if ((msg.size ?? 0) > MAX_MESSAGE_BYTES) throw new Error("Message is larger than 40 MB");
  return parseSource(msg.source);
}

export function getMessage(config: MailConfig, { mailbox, uid }: MessageRef) {
  return withMailbox(config, mailbox, async (client) => formatMessage(await readMessage(client, mailbox, uid)));
}

function getThread(config: MailConfig, { mailbox, uid }: MessageRef) {
  return withMailbox(config, mailbox, async (client) => {
    const msg = await client.fetchOne(String(uid), { envelope: true, headers: ["references"] }, { uid: true });
    if (!msg || !msg.envelope) throw new Error(`No message with UID ${uid} in ${mailbox}`);
    const messageId = msg.envelope.messageId ?? "";
    const subject = msg.envelope.subject ?? "";
    const references = [...(msg.headers?.toString().match(/<[^<>\s]+>/g) ?? []), messageId];
    return {
      messageId: MESSAGE_ID.test(messageId) ? messageId : undefined,
      references: references.filter((id) => MESSAGE_ID.test(id)),
      subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`,
    };
  });
}

export function getAttachment(config: MailConfig, { mailbox, uid, index }: AttachmentRef) {
  return withMailbox(config, mailbox, async (client) => {
    const attachment = (await readMessage(client, mailbox, uid)).attachments[index];
    if (!attachment) throw new Error(`Message ${uid} in ${mailbox} has no attachment ${index}`);
    return {
      filename: attachment.filename ?? `attachment-${index}`,
      contentType: attachment.contentType,
      content: attachment.content,
    };
  });
}

type NewAttachment = { filename: string; content: string; encoding: "utf8" | "base64"; contentType?: string };

type SendParams = {
  from?: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text: string;
  inReplyTo?: MessageRef;
  attachments?: (NewAttachment | AttachmentRef)[];
};

export async function sendEmail(config: MailConfig, params: SendParams) {
  const thread = params.inReplyTo && (await getThread(config, params.inReplyTo));
  const subject = params.subject ?? thread?.subject;
  if (!subject) throw new Error("subject is required unless replying");

  const attachments = [];
  for (const a of params.attachments ?? []) {
    attachments.push(
      "content" in a
        ? { filename: a.filename, content: Buffer.from(a.content, a.encoding), contentType: a.contentType }
        : await getAttachment(config, a),
    );
  }

  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    requireTLS: true,
    auth: { user: config.username, pass: config.password },
    tls: TLS,
  });
  try {
    const info = await transport.sendMail({
      from: { name: params.fromName ?? "", address: params.from ?? config.username },
      to: params.to,
      cc: params.cc,
      subject,
      text: params.text,
      inReplyTo: thread?.messageId,
      references: thread?.references,
      attachments,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } finally {
    transport.close();
  }
}
