# Postern

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that gives Grok bots (or any MCP client) email access over HTTPS. Use it when the bot's VM can't open IMAP/SMTP ports.

```
bot ──HTTPS + bearer token──▶ Postern on Cloud Run ──IMAP/SMTP over TLS──▶ your mail provider
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_mailboxes` | Lists folders |
| `search_messages` | Searches a folder by sender, recipient, subject, text, date or unread status |
| `get_message` | Reads one message as plain text and lists its attachments |
| `get_attachment` | Downloads an attachment: images as images, text as text, other files as base64 |
| `send_email` | Sends plain-text mail and replies, optionally from an alias with a display name. Attachments can be new files or attachments of existing emails, which are forwarded without passing through the bot. Only available when `SMTP_HOST` is set |

Messages larger than 40 MB can't be read, and requests to Postern are limited to 25 MB, which caps new attachments at about 18 MB once base64-encoded. Most providers only let you send from addresses the account owns.

## Security

- The mail password stays in Google Secret Manager. Bots only get a revocable 256-bit bearer token, and every request without it is rejected.
- Folders are opened read-only: reading never marks messages as read, moves or deletes anything.
- The mail servers are fixed at deploy time, and connections require TLS 1.2+ with certificate checks.
- Sending is only enabled when `SMTP_HOST` is set. A bot that can read and send can be tricked by a malicious email into forwarding your mail, so leave it out unless the bot needs to send.
- Attachments can only come from the request itself or from emails in the mailbox. Postern never reads files or URLs.
- Every sent email is logged with its sender, recipients, attachment count and Message-ID. Review them with `gcloud run services logs read postern --region us-central1`.
- The service runs as its own service account, which can read only its two secrets, in a distroless non-root container with at most one instance.

## Providers

Any provider with IMAP/SMTP password login works. Use an app password, not your main password.

| Provider | `IMAP_HOST` | `SMTP_HOST` | `SMTP_PORT` |
| --- | --- | --- | --- |
| iCloud | imap.mail.me.com | smtp.mail.me.com | 587 |
| Gmail | imap.gmail.com | smtp.gmail.com | 587 |
| Fastmail | imap.fastmail.com | smtp.fastmail.com | 465 |
| Yahoo | imap.mail.yahoo.com | smtp.mail.yahoo.com | 465 |

Outlook.com and Microsoft 365 aren't supported, because they no longer allow password login over IMAP.

## Deploy to Google Cloud Run

You need a Google Cloud project with billing enabled, the `gcloud` CLI (signed in), and `openssl`.

```bash
PROJECT_ID=my-project IMAP_HOST=imap.mail.me.com SMTP_HOST=smtp.mail.me.com \
MAIL_USERNAME=you@icloud.com \
./deploy.sh
```

The first run asks for the app password. Leave out `SMTP_HOST` for read-only access. Re-run the same command to apply changes.

To serve another mailbox, deploy again with a different `SERVICE` name (default `postern`).

## Connect a Grok bot

Add `bot/mcp-connections/postern.ts`:

```ts
import { defineConnection } from "@grok/agent-sdk/connections";

export default defineConnection({
  url: "https://<your-service-url>/mcp",
  headers: { authorization: "Bearer ${POSTERN_TOKEN}" },
  advertiseTools: true,
});
```

In `bot/agent.ts`, add the service host to `hosting.egressDomains` and `POSTERN_TOKEN` to `hosting.secretNames`. Set the secret with the command `deploy.sh` prints, then redeploy the bot.

Other MCP clients: use Streamable HTTP at `/mcp` with an `Authorization: Bearer <token>` header.

## Rotate credentials

```bash
# New bot token, then update the bot's secret
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add postern-token --data-file=-

# New mail password
read -rs p && printf '%s' "$p" | gcloud secrets versions add postern-mail-password --data-file=-
```

Re-run `./deploy.sh` afterwards so the service picks up the new values.

## Run locally

```bash
npm install
cp .env.example .env   # fill in your values
npm run dev            # http://127.0.0.1:7993/mcp
```
