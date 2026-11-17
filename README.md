# Postern

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that lets Grok bots (or any MCP client) read and send email over HTTPS. It works with any provider that supports IMAP/SMTP with a password: iCloud, Gmail, Fastmail, Yahoo, Zoho, your own server and so on. Use it when the bot's VM can't open IMAP/SMTP ports. The bot talks HTTPS to your Cloud Run service, and that service talks IMAP/SMTP to your mail provider.

```
Grok bot ──HTTPS + bearer token──▶ Cloud Run (Postern) ──IMAP / SMTP over TLS──▶ your mail provider
```

Each person deploys their own copy into their own Google Cloud project with one command. No mail data is shared or stored. One deployment serves one mailbox; deploy again with a different `SERVICE` name for another mailbox.

## Supported providers

The deploy script has presets for these:

| Provider | IMAP | SMTP | Password |
| --- | --- | --- | --- |
| `icloud` | imap.mail.me.com:993 | smtp.mail.me.com:587 | [App-specific password](https://support.apple.com/102654) |
| `gmail` | imap.gmail.com:993 | smtp.gmail.com:587 | [App password](https://support.google.com/accounts/answer/185833) (requires 2-Step Verification; enter it without spaces) |
| `fastmail` | imap.fastmail.com:993 | smtp.fastmail.com:465 | App password (Settings → Privacy & Security) |
| `yahoo` | imap.mail.yahoo.com:993 | smtp.mail.yahoo.com:465 | [App password](https://help.yahoo.com/kb/SLN15241.html) |

Choose `custom` for anything else. IMAP must use implicit TLS (normally port 993). SMTP must use port 465 (implicit TLS) or STARTTLS (normally 587). Plaintext connections are never used.

**Not supported:** Outlook.com, Hotmail and Microsoft 365. Microsoft has turned off password login for IMAP/SMTP, so they need OAuth, which Postern doesn't implement.

## Tools

| Tool | What it does |
| --- | --- |
| `list_mailboxes` | Lists folders (INBOX, Sent, Archive, …) |
| `search_messages` | Searches a folder by sender, recipient, subject, text, date range or unread status, newest first |
| `get_message` | Reads one message: headers, plain-text body (HTML is converted), attachment names and sizes |
| `send_email` | Sends plain-text mail, including threaded replies. Only present when sending is enabled |

Reading never changes your mailbox. Folders are opened read-only (`EXAMINE`), so messages are not marked as read and nothing can be moved or deleted.

## Security model

- **Your password never reaches the bot.** The mail password lives in Google Secret Manager and is only mounted into the Cloud Run container. Bots hold a separate, revocable 256-bit bearer token.
- **Every request is authenticated.** `/mcp` rejects requests without the bearer token (constant-time comparison). Only `GET /healthz` is public, and it returns nothing but `{"ok":true}`.
- **Least privilege.** The service runs as a dedicated service account with no project roles. It can read only its own two secrets.
- **Fixed upstream hosts.** The IMAP and SMTP hosts are set at deploy time. Clients can't point the server anywhere else. Connections require TLS 1.2+ with certificate verification.
- **Sending is opt-in and fenced.** It's off unless you enable it. You can restrict recipients to specific addresses and/or `@domains` (`ALLOWED_RECIPIENTS`), so injected instructions can't make the bot email strangers. Send attempts are capped per hour (`MAX_SENDS_PER_HOUR`, default 20), and subjects can't contain line breaks (no header injection).
- **Prompt-injection warning.** Message bodies are returned with a notice telling the model that email content is untrusted. This reduces the risk but can't eliminate it, so keep the recipient allowlist tight if the bot can send.
- **Small attack surface.** Distroless, non-root container. Request bodies are capped at 1 MB. Logs record only the method, path, status and latency, never message content or tokens.
- **Bounded cost and blast radius.** One Cloud Run instance at most, scaling to zero when idle.

Use an app password rather than your main account password wherever your provider offers one. It can be revoked on its own and doesn't bypass two-factor authentication for the rest of your account.

## Deploy

Prerequisites:

- A Google Cloud project with billing enabled. Usage at personal scale normally stays within the free tier.
- The [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), signed in with `gcloud auth login`.
- Node.js 22+ and `openssl`.
- An app password for your mail account (see the table above).

Then run:

```bash
git clone <this repo> && cd <repo>
PROJECT_ID=my-gcp-project ./deploy.sh
```

The script prompts for:

- your provider (a preset, or custom hosts and ports);
- your login username, which is usually your full email address;
- the password (hidden input);
- whether bots may send email, and which recipients to allow.

It then enables the required APIs, creates the service account and secrets, builds the container with Cloud Build, deploys to Cloud Run and prints the exact snippet for your bot.

You can preset any prompt with environment variables, for example in CI:

```bash
PROJECT_ID=my-gcp-project REGION=europe-west1 SERVICE=postern-work \
PROVIDER=fastmail MAIL_USERNAME=me@fastmail.com \
ENABLE_SEND=true ALLOWED_RECIPIENTS="me@gmail.com,@mycompany.com" MAX_SENDS_PER_HOUR=10 \
./deploy.sh
```

For a custom server, set `IMAP_HOST`, `IMAP_PORT`, `SMTP_HOST` and `SMTP_PORT` instead of `PROVIDER`. Set `MAIL_FROM` when the sending address differs from the login username, for example a custom-domain alias.

Re-running `./deploy.sh` updates the service and keeps your existing settings and secrets.

## Connect a Grok bot

The deploy script prints these steps with your URL filled in. The bot's secret is named after the service: `POSTERN_TOKEN` for the default `postern`, `POSTERN_WORK_TOKEN` for `postern-work`, and so on.

1. `bot/mcp-connections/postern.ts`:

   ```ts
   import { defineConnection } from "@grok/agent-sdk/connections";

   export default defineConnection({
     url: "https://postern-xxxxxxxx-uc.a.run.app/mcp",
     headers: { authorization: "Bearer ${POSTERN_TOKEN}" },
     advertiseTools: true,
   });
   ```

2. In `bot/agent.ts`, allow egress to the service and declare the secret:

   ```ts
   export default defineAgent({
     hosting: {
       egressDomains: ["postern-xxxxxxxx-uc.a.run.app"],
       secretNames: ["POSTERN_TOKEN"],
     },
   });
   ```

3. Pipe the token from Secret Manager into the bot's secrets, so it never shows up on screen:

   ```bash
   gcloud secrets versions access latest --secret postern-bearer-token \
     | npx --yes "@grok/agent-sdk@0.6.0" secret set <agent-name> POSTERN_TOKEN
   ```

4. Redeploy the bot so the new egress entry takes effect.

Any other MCP client works the same way: point it at `https://<service-url>/mcp` (Streamable HTTP) with an `Authorization: Bearer <token>` header.

## Operations

| Task | Command |
| --- | --- |
| Rotate the bot token (old token stops working; update the bot's secret afterwards) | `./deploy.sh rotate-token` |
| Replace the mail password | `./deploy.sh update-password` |
| Turn sending on or off | `ENABLE_SEND=true ./deploy.sh` or `ENABLE_SEND=false ./deploy.sh` |
| Change allowed recipients | `ALLOWED_RECIPIENTS="a@x.com,@y.com" ./deploy.sh`. Use `ALLOWED_RECIPIENTS=""` to allow anyone |
| View logs | `gcloud run services logs read postern --region us-central1` |
| Remove everything | `./deploy.sh destroy`, then revoke the app password with your provider |

If you suspect the token leaked, rotate it. If you suspect the password leaked, revoke it with your provider first, then run `update-password`.

## Run locally

```bash
npm install
cp .env.example .env   # fill in your server, username, password, and a token from `openssl rand -hex 32`
npm run dev            # http://127.0.0.1:7993/mcp
```

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `IMAP_HOST` | yes | | For example `imap.gmail.com` |
| `IMAP_PORT` | no | `993` | Implicit TLS |
| `SMTP_HOST` | when sending | | For example `smtp.gmail.com` |
| `SMTP_PORT` | no | `587` | `465` uses implicit TLS; anything else requires STARTTLS |
| `MAIL_USERNAME` | yes | | Login username, usually the full email address |
| `MAIL_PASSWORD` | yes | | App password |
| `MAIL_FROM` | no | `MAIL_USERNAME` | From address for sent mail |
| `MCP_BEARER_TOKEN` | yes | | At least 32 characters |
| `ENABLE_SEND` | no | `false` | `true` registers `send_email` |
| `ALLOWED_RECIPIENTS` | no | anyone | Comma-separated addresses and/or `@domains` |
| `MAX_SENDS_PER_HOUR` | no | `20` | Counts send attempts |
| `PORT` | no | `7993` | Cloud Run sets this automatically |

## Troubleshooting

- **`--allow-unauthenticated` fails with an organization policy error.** Your org enforces Domain Restricted Sharing. Ask an admin to exempt this project. The app still requires the bearer token, which is what protects it.
- **Cloud Build permission errors on the first deploy.** Newer projects may not grant the build service account enough rights. Grant `roles/run.builder` to the project's default compute service account, then re-run.
- **`The mail server rejected the login`.** Check the username (usually the full address; for iCloud it must be your iCloud Mail address) and that the app password hasn't been revoked. Some providers also require IMAP to be enabled in their settings.
- **The bot gets connection resets or a 403 from a proxy.** The Cloud Run hostname is missing from `hosting.egressDomains`, or the bot wasn't redeployed after you added it.
