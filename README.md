# Postern

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that gives Grok Bot (or any MCP client) email access over HTTPS. Use it when the bot's VM can't open IMAP/SMTP ports.

```
bot ──HTTPS + bearer token──▶ Postern on Cloud Run ──IMAP/SMTP over TLS──▶ your mail provider
```

## Tools

| Tool | What it does |
| --- | --- |
| `list_mailboxes` | Lists folders |
| `search_messages` | Searches a folder by sender, recipient, subject, text, date or unread status |
| `get_message` | Reads one message as plain text, including its Reply-To address, and lists its attachments |
| `get_attachment` | Downloads an attachment: images as images, text as text, other files as base64 |
| `send_email` | Sends plain-text mail, with attachments and an optional alias or display name. Replies reference the original email, and Postern adds the threading headers and "Re:" subject. Only available when `SMTP_HOST` is set |

Attachments can be new files or attachments of existing emails, which are forwarded without passing through the bot. Messages over 40 MB can't be read, and requests are limited to 25 MB (about 18 MB of new attachments). Most providers only let you send from addresses the account owns.

## Security

- The mail password stays in Google Secret Manager. Bots only get a revocable 256-bit bearer token, and every request without it is rejected.
- Folders are opened read-only: reading never marks messages as read, moves or deletes anything.
- The mail servers are fixed at deploy time, and connections require TLS 1.2+ with certificate checks.
- Sending is only enabled when `SMTP_HOST` is set. A bot that can read and send can be tricked by a malicious email into forwarding your mail, so leave it out unless the bot needs to send.
- Attachments can only come from the request itself or from emails in the mailbox. Postern never reads files or URLs.
- Every sent email is logged with its sender, recipients, attachment count and Message-ID. Review them with `gcloud run services logs read postern --region us-central1 --project $(cat .project-postern)`.
- Each deployment gets its own Google Cloud project, so nothing else shares access to its secrets. The service runs as its own service account, which can read only its two secrets, in a distroless non-root container with at most one instance.

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

You need the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), signed in with `gcloud auth login`, and a Google Cloud [billing account](https://console.cloud.google.com/billing). Usage at personal scale normally stays within the free tier.

```bash
IMAP_HOST=imap.mail.me.com SMTP_HOST=smtp.mail.me.com MAIL_USERNAME=you@icloud.com ./deploy.sh
```

The first run creates a dedicated Google Cloud project, links your billing account (it asks which one if you have several), and asks for the app password. The project ID is saved in `.project-postern`, so re-running the same command updates the same deployment. Leave out `SMTP_HOST` for read-only access.

To use an existing project instead, set `PROJECT_ID`. To remove everything, delete the project with `gcloud projects delete $(cat .project-postern)`.

To serve another mailbox, deploy again with a different `SERVICE` name (default `postern`).

## Connect Grok Bot

Copy the token to your clipboard:

```bash
gcloud secrets versions access latest --secret postern-token --project $(cat .project-postern) | pbcopy
```

In the Grok Bot app, open **Connect apps** and choose **Add a custom connector**:

- **Type:** Remote HTTPS
- **Server URL:** the MCP endpoint `deploy.sh` prints
- **Header:** `Authorization: Bearer <token>`

Then type `@` in a bot's chat to attach Postern. Don't paste the token into the chat.

Other MCP clients: use Streamable HTTP at `/mcp` with the same `Authorization` header.

## Rotate credentials

```bash
P=$(cat .project-postern)

# New bot token, then update the connector's header
openssl rand -hex 32 | tr -d '\n' | gcloud secrets versions add postern-token --data-file=- --project $P

# New mail password
read -rs p && printf '%s' "$p" | gcloud secrets versions add postern-mail-password --data-file=- --project $P
```

Re-run `./deploy.sh` afterwards so the service picks up the new values.

## Run locally

```bash
npm install
cp .env.example .env   # fill in your values; MCP_BEARER_TOKEN from `openssl rand -hex 32`
npm run dev            # http://127.0.0.1:7993/mcp
```
