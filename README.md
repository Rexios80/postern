# iCloud Mail MCP

A small, self-hosted [MCP](https://modelcontextprotocol.io) server that lets Grok bots (or any MCP client) read and send iCloud Mail over HTTPS. Use it when the bot's VM can't open IMAP/SMTP ports. The bot talks HTTPS to your Cloud Run service, and that service talks IMAP/SMTP to Apple.

```
Grok bot ──HTTPS + bearer token──▶ Cloud Run (this repo) ──IMAP 993 / SMTP 587, TLS──▶ iCloud
```

Each person deploys their own copy into their own Google Cloud project with one command. No mail data is shared or stored.

## Tools

| Tool | What it does |
| --- | --- |
| `list_mailboxes` | Lists folders (INBOX, Sent Messages, Archive, …) |
| `search_messages` | Searches a folder by sender, recipient, subject, text, date range or unread status, newest first |
| `get_message` | Reads one message: headers, plain-text body (HTML is converted), attachment names and sizes |
| `send_email` | Sends plain-text mail, including threaded replies. Only present when sending is enabled |

Reading never changes your mailbox. Folders are opened read-only (`EXAMINE`), so messages are not marked as read and nothing can be moved or deleted.

## Security model

- **Your password never reaches the bot.** The iCloud app-specific password lives in Google Secret Manager and is only mounted into the Cloud Run container. Bots hold a separate, revocable 256-bit bearer token.
- **Every request is authenticated.** `/mcp` rejects requests without the bearer token (constant-time comparison). Only `GET /healthz` is public, and it returns nothing but `{"ok":true}`.
- **Least privilege.** The service runs as a dedicated service account with no project roles. It can read only its own two secrets.
- **Fixed upstream hosts.** The server only ever connects to `imap.mail.me.com` and `smtp.mail.me.com`, with TLS 1.2+ and certificate verification. Clients can't point it anywhere else.
- **Sending is opt-in and fenced.** It's off unless you enable it. You can restrict recipients to specific addresses and/or `@domains` (`ALLOWED_RECIPIENTS`), so injected instructions can't make the bot email strangers. Send attempts are capped per hour (`MAX_SENDS_PER_HOUR`, default 20), and subjects can't contain line breaks (no header injection).
- **Prompt-injection warning.** Message bodies are returned with a notice telling the model that email content is untrusted. This reduces the risk but can't eliminate it, so keep the recipient allowlist tight if the bot can send.
- **Small attack surface.** Distroless, non-root container. Request bodies are capped at 1 MB. Logs record only the method, path, status and latency, never message content or tokens.
- **Bounded cost and blast radius.** One Cloud Run instance at most, scaling to zero when idle.

## Deploy

Prerequisites:

- A Google Cloud project with billing enabled. Usage at personal scale normally stays within the free tier.
- The [`gcloud` CLI](https://cloud.google.com/sdk/docs/install), signed in with `gcloud auth login`.
- Node.js 22+ and `openssl`.
- An iCloud **app-specific password**: [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords. Your Apple ID must use two-factor authentication.

Then run:

```bash
git clone <this repo> && cd <repo>
PROJECT_ID=my-gcp-project ./deploy.sh
```

The script prompts for:

- your iCloud email address (for example `you@icloud.com`, or a custom-domain address hosted on iCloud);
- the app-specific password (hidden input);
- whether bots may send email, and which recipients to allow.

It then enables the required APIs, creates the service account and secrets, builds the container with Cloud Build, deploys to Cloud Run and prints the exact snippet for your bot.

You can preset any prompt with environment variables, for example in CI:

```bash
PROJECT_ID=my-gcp-project REGION=europe-west1 SERVICE=icloud-mail-mcp \
ICLOUD_EMAIL=you@icloud.com ENABLE_SEND=true ALLOWED_RECIPIENTS="me@gmail.com,@mycompany.com" \
MAX_SENDS_PER_HOUR=10 ./deploy.sh
```

Re-running `./deploy.sh` updates the service and keeps your existing settings and secrets.

## Connect a Grok bot

The deploy script prints these steps with your URL filled in.

1. `bot/mcp-connections/icloud-mail.ts`:

   ```ts
   import { defineConnection } from "@grok/agent-sdk/connections";

   export default defineConnection({
     url: "https://icloud-mail-mcp-xxxxxxxx-uc.a.run.app/mcp",
     headers: { authorization: "Bearer ${ICLOUD_MAIL_MCP_TOKEN}" },
     advertiseTools: true,
   });
   ```

2. In `bot/agent.ts`, allow egress to the service and declare the secret:

   ```ts
   export default defineAgent({
     hosting: {
       egressDomains: ["icloud-mail-mcp-xxxxxxxx-uc.a.run.app"],
       secretNames: ["ICLOUD_MAIL_MCP_TOKEN"],
     },
   });
   ```

3. Pipe the token from Secret Manager into the bot's secrets, so it never shows up on screen:

   ```bash
   gcloud secrets versions access latest --secret icloud-mail-mcp-bearer-token \
     | npx --yes "@grok/agent-sdk@0.6.0" secret set <agent-name> ICLOUD_MAIL_MCP_TOKEN
   ```

4. Redeploy the bot so the new egress entry takes effect.

Any other MCP client works the same way: point it at `https://<service-url>/mcp` (Streamable HTTP) with an `Authorization: Bearer <token>` header.

## Operations

| Task | Command |
| --- | --- |
| Rotate the bot token (old token stops working; update the bot's secret afterwards) | `./deploy.sh rotate-token` |
| Replace the iCloud app-specific password | `./deploy.sh update-password` |
| Turn sending on or off | `ENABLE_SEND=true ./deploy.sh` or `ENABLE_SEND=false ./deploy.sh` |
| Change allowed recipients | `ALLOWED_RECIPIENTS="a@x.com,@y.com" ./deploy.sh`. Use `ALLOWED_RECIPIENTS=""` to allow anyone |
| View logs | `gcloud run services logs read icloud-mail-mcp --region us-central1` |
| Remove everything | `./deploy.sh destroy`, then revoke the app-specific password at account.apple.com |

If you suspect the token leaked, rotate it. If you suspect the password leaked, revoke it at account.apple.com first, then run `update-password`.

## Run locally

```bash
npm install
cp .env.example .env   # fill in ICLOUD_EMAIL, ICLOUD_APP_PASSWORD, and a token from `openssl rand -hex 32`
npm run dev            # http://127.0.0.1:7993/mcp
```

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `ICLOUD_EMAIL` | yes | | iCloud address used to sign in and as the From address |
| `ICLOUD_APP_PASSWORD` | yes | | App-specific password |
| `MCP_BEARER_TOKEN` | yes | | At least 32 characters |
| `ENABLE_SEND` | no | `false` | `true` registers `send_email` |
| `ALLOWED_RECIPIENTS` | no | anyone | Comma-separated addresses and/or `@domains` |
| `MAX_SENDS_PER_HOUR` | no | `20` | Counts send attempts |
| `PORT` | no | `7993` | Cloud Run sets this automatically |

## Troubleshooting

- **`--allow-unauthenticated` fails with an organization policy error.** Your org enforces Domain Restricted Sharing. Ask an admin to exempt this project. The app still requires the bearer token, which is what protects it.
- **Cloud Build permission errors on the first deploy.** Newer projects may not grant the build service account enough rights. Grant `roles/run.builder` to the project's default compute service account, then re-run.
- **`iCloud rejected the login`.** Check that `ICLOUD_EMAIL` is your iCloud Mail address (not a non-Apple Apple ID email) and that the app-specific password hasn't been revoked.
- **The bot gets connection resets or a 403 from a proxy.** The Cloud Run hostname is missing from `hosting.egressDomains`, or the bot wasn't redeployed after you added it.
