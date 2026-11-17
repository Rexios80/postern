import { ImapFlow, type SearchObject } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import nodemailer from "nodemailer";

const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

export type MailConfig = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  password: string;
  from: string;
};

type EnvelopeAddress = { name?: string; address?: string };

function formatAddresses(list?: EnvelopeAddress[]): string[] {
  return (list ?? []).map((a) => (a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? "")));
}

function formatParsedAddresses(value?: AddressObject | AddressObject[]): string[] {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((o) => formatAddresses(o.value));
}

async function withImap<T>(config: MailConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.username, pass: config.password },
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    logger: false,
    disableAutoIdle: true,
    socketTimeout: 60_000,
  });
  try {
    await client.connect();
    return await fn(client);
  } catch (err) {
    throw describeImapError(err);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

function describeImapError(err: unknown): Error {
  const e = err as { authenticationFailed?: boolean; responseText?: string; message?: string };
  if (e.authenticationFailed) {
    return new Error("The mail server rejected the login: check MAIL_USERNAME and MAIL_PASSWORD");
  }
  return new Error(e.responseText ? `IMAP error: ${e.responseText}` : (e.message ?? String(err)));
}

export async function listMailboxes(config: MailConfig) {
  return withImap(config, async (client) => {
    const boxes = await client.list();
    return boxes.map((b) => ({ path: b.path, specialUse: b.specialUse ?? null }));
  });
}

export type SearchParams = {
  mailbox: string;
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  since?: string;
  before?: string;
  unreadOnly?: boolean;
  limit: number;
};

export async function searchMessages(config: MailConfig, params: SearchParams) {
  return withImap(config, async (client) => {
    const lock = await client.getMailboxLock(params.mailbox, { readOnly: true });
    try {
      const query: SearchObject = {};
      if (params.from) query.from = params.from;
      if (params.to) query.to = params.to;
      if (params.subject) query.subject = params.subject;
      if (params.text) query.text = params.text;
      if (params.since) query.since = params.since;
      if (params.before) query.before = params.before;
      if (params.unreadOnly) query.seen = false;
      if (Object.keys(query).length === 0) query.all = true;

      const uids = (await client.search(query, { uid: true })) || [];
      const newest = uids.sort((a, b) => a - b).slice(-params.limit);
      const messages = [];
      if (newest.length > 0) {
        for await (const msg of client.fetch(
          newest.join(","),
          { uid: true, envelope: true, flags: true, internalDate: true, size: true },
          { uid: true },
        )) {
          messages.push({
            uid: msg.uid,
            date: (msg.envelope?.date ?? msg.internalDate)?.toString() ?? null,
            from: formatAddresses(msg.envelope?.from),
            to: formatAddresses(msg.envelope?.to),
            subject: msg.envelope?.subject ?? "",
            unread: !msg.flags?.has("\\Seen"),
            flagged: msg.flags?.has("\\Flagged") ?? false,
            sizeBytes: msg.size ?? null,
          });
        }
      }
      messages.sort((a, b) => b.uid - a.uid);
      return { mailbox: params.mailbox, totalMatches: uids.length, messages };
    } finally {
      lock.release();
    }
  });
}

export async function getMessage(config: MailConfig, mailbox: string, uid: number, maxChars: number) {
  return withImap(config, async (client) => {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, source: { maxLength: MAX_SOURCE_BYTES } },
        { uid: true },
      );
      if (!msg || !msg.source) throw new Error(`No message with UID ${uid} in ${mailbox}`);

      const parsed = await simpleParser(msg.source, { skipImageLinks: true, skipTextLinks: true });
      const text = parsed.text ?? "";
      return {
        mailbox,
        uid,
        messageId: parsed.messageId ?? null,
        inReplyTo: parsed.inReplyTo ?? null,
        date: parsed.date?.toISOString() ?? null,
        from: formatParsedAddresses(parsed.from),
        to: formatParsedAddresses(parsed.to),
        cc: formatParsedAddresses(parsed.cc),
        replyTo: formatParsedAddresses(parsed.replyTo),
        subject: parsed.subject ?? "",
        text: text.slice(0, maxChars),
        textTruncated: text.length > maxChars,
        attachments: parsed.attachments.map((a) => ({
          filename: a.filename ?? null,
          contentType: a.contentType,
          sizeBytes: a.size,
        })),
      };
    } finally {
      lock.release();
    }
  });
}

export type SendParams = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
};

export async function sendEmail(config: MailConfig, params: SendParams) {
  const transport = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    requireTLS: true,
    auth: { user: config.username, pass: config.password },
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 30_000,
    socketTimeout: 60_000,
  });
  try {
    const info = await transport.sendMail({
      from: config.from,
      to: params.to,
      cc: params.cc,
      bcc: params.bcc,
      subject: params.subject,
      text: params.text,
      inReplyTo: params.inReplyTo,
      references: params.inReplyTo,
    });
    return { messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } finally {
    transport.close();
  }
}
