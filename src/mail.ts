import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";

export type MailConfig = {
  imapHost: string;
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
};

const TLS = { minVersion: "TLSv1.2", rejectUnauthorized: true } as const;

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

export type SearchParams = {
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

async function readMessage(client: ImapFlow, mailbox: string, uid: number) {
  const msg = await client.fetchOne(
    String(uid),
    { size: true, source: { maxLength: MAX_MESSAGE_BYTES } },
    { uid: true },
  );
  if (!msg || !msg.source) throw new Error(`No message with UID ${uid} in ${mailbox}`);
  if ((msg.size ?? 0) > MAX_MESSAGE_BYTES) throw new Error("Message is larger than 40 MB");
  return simpleParser(msg.source, { skipImageLinks: true, skipTextLinks: true });
}

export function getMessage(config: MailConfig, mailbox: string, uid: number) {
  return withMailbox(config, mailbox, async (client) => {
    const parsed = await readMessage(client, mailbox, uid);
    const text = parsed.text ?? "";
    return {
      messageId: parsed.messageId ?? null,
      date: parsed.date ?? null,
      from: formatParsed(parsed.from),
      to: formatParsed(parsed.to),
      cc: formatParsed(parsed.cc),
      subject: parsed.subject ?? "",
      text: text.slice(0, MAX_TEXT_CHARS),
      textTruncated: text.length > MAX_TEXT_CHARS,
      attachments: parsed.attachments.map((a, index) => ({
        index,
        filename: a.filename ?? null,
        contentType: a.contentType,
        sizeBytes: a.size,
      })),
    };
  });
}

export type AttachmentRef = { mailbox: string; uid: number; index: number };

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

export type NewAttachment = { filename: string; content: string; encoding: "utf8" | "base64"; contentType?: string };

export type SendParams = {
  from?: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  attachments?: (NewAttachment | AttachmentRef)[];
};

export async function sendEmail(config: MailConfig, params: SendParams) {
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
      subject: params.subject,
      text: params.text,
      inReplyTo: params.inReplyTo,
      references: params.inReplyTo,
      attachments,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } finally {
    transport.close();
  }
}
