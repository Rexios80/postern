#!/usr/bin/env bash
# Usage: ./deploy.sh [deploy|rotate-token|update-password|destroy]
# Config via env: PROJECT_ID, REGION (us-central1), SERVICE (postern),
# PROVIDER (icloud|gmail|fastmail|yahoo|custom), IMAP_HOST, IMAP_PORT, SMTP_HOST, SMTP_PORT,
# MAIL_USERNAME, MAIL_FROM, ENABLE_SEND (true|false), ALLOWED_RECIPIENTS, MAX_SENDS_PER_HOUR (20).
set -euo pipefail

COMMAND="${1:-deploy}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "error: $*" >&2; exit 1; }
info() { echo "==> $*" >&2; }

command -v gcloud >/dev/null || die "gcloud CLI not found: https://cloud.google.com/sdk/docs/install"
command -v openssl >/dev/null || die "openssl not found"
command -v node >/dev/null || die "node not found (Node 22+ is required)"

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
[[ -n "$PROJECT_ID" ]] || die "set PROJECT_ID or run: gcloud config set project <id>"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-postern}"
[[ "$SERVICE" =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] || die "SERVICE must be 6-30 lowercase letters, digits or dashes"

SA_EMAIL="${SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"
PASSWORD_SECRET="${SERVICE}-mail-password"
TOKEN_SECRET="${SERVICE}-bearer-token"
BOT_TOKEN_VAR="$(tr 'a-z-' 'A-Z_' <<<"$SERVICE")_TOKEN"
G=(--project "$PROJECT_ID" --quiet)

secret_exists() { gcloud secrets describe "$1" "${G[@]}" >/dev/null 2>&1; }

# Reads the secret value from stdin so it never appears in argv or shell history.
put_secret() {
  if secret_exists "$1"; then
    gcloud secrets versions add "$1" --data-file=- "${G[@]}" >/dev/null
  else
    gcloud secrets create "$1" --replication-policy=automatic --data-file=- "${G[@]}" >/dev/null
  fi
}

prompt_password() {
  local password
  echo "Use an app-specific password if your provider offers one (iCloud, Gmail, Fastmail and Yahoo all do)." >&2
  read -rsp "Mail password: " password; echo >&2
  [[ -n "$password" ]] || die "password cannot be empty"
  printf '%s' "$password" | put_secret "$PASSWORD_SECRET"
}

rotate_token() {
  openssl rand -hex 32 | tr -d '\n' | put_secret "$TOKEN_SECRET"
}

provider_preset() {
  case "$1" in
    icloud) echo "imap.mail.me.com 993 smtp.mail.me.com 587" ;;
    gmail) echo "imap.gmail.com 993 smtp.gmail.com 587" ;;
    fastmail) echo "imap.fastmail.com 993 smtp.fastmail.com 465" ;;
    yahoo) echo "imap.mail.yahoo.com 993 smtp.mail.yahoo.com 465" ;;
    *) return 1 ;;
  esac
}

current_env() {
  gcloud run services describe "$SERVICE" --region "$REGION" "${G[@]}" \
    --format=json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{for(const e of JSON.parse(s).spec.template.spec.containers[0].env??[])if(e.value!==undefined)console.log(`${e.name}=${e.value}`)}catch{}})' 2>/dev/null || true
}

destroy() {
  read -rp "Delete service $SERVICE, its secrets and service account in $PROJECT_ID? [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]] || exit 0
  gcloud run services delete "$SERVICE" --region "$REGION" "${G[@]}" || true
  gcloud secrets delete "$PASSWORD_SECRET" "${G[@]}" || true
  gcloud secrets delete "$TOKEN_SECRET" "${G[@]}" || true
  gcloud iam service-accounts delete "$SA_EMAIL" "${G[@]}" || true
  info "Removed. Revoke the app password with your mail provider too."
}

deploy() {
  info "Enabling APIs in $PROJECT_ID"
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
    artifactregistry.googleapis.com secretmanager.googleapis.com "${G[@]}"

  if ! gcloud iam service-accounts describe "$SA_EMAIL" "${G[@]}" >/dev/null 2>&1; then
    info "Creating runtime service account $SA_EMAIL (no project roles)"
    gcloud iam service-accounts create "$SERVICE" --display-name "Postern runtime" "${G[@]}"
  fi

  local existing; existing="$(current_env)"
  existing_value() { grep -E "^$1=" <<<"$existing" | head -1 | cut -d= -f2- || true; }

  local imap_host="${IMAP_HOST:-$(existing_value IMAP_HOST)}"
  local imap_port="${IMAP_PORT:-$(existing_value IMAP_PORT)}"
  local smtp_host="${SMTP_HOST:-$(existing_value SMTP_HOST)}"
  local smtp_port="${SMTP_PORT:-$(existing_value SMTP_PORT)}"
  if [[ -z "$imap_host" ]]; then
    local provider="${PROVIDER:-}"
    [[ -n "$provider" ]] || read -rp "Mail provider [icloud/gmail/fastmail/yahoo/custom]: " provider
    local preset preset_smtp_host preset_smtp_port
    if preset="$(provider_preset "$provider")"; then
      read -r imap_host imap_port preset_smtp_host preset_smtp_port <<<"$preset"
      smtp_host="${smtp_host:-$preset_smtp_host}"
      smtp_port="${smtp_port:-$preset_smtp_port}"
    else
      read -rp "IMAP host: " imap_host
      read -rp "IMAP port [993]: " imap_port
      read -rp "SMTP host (blank if you won't send): " smtp_host
      [[ -z "$smtp_host" ]] || read -rp "SMTP port [587]: " smtp_port
    fi
  fi
  imap_port="${imap_port:-993}"
  smtp_port="${smtp_port:-587}"
  local host_re='^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
  [[ "$imap_host" =~ $host_re ]] || die "invalid IMAP host: $imap_host"
  [[ -z "$smtp_host" || "$smtp_host" =~ $host_re ]] || die "invalid SMTP host: $smtp_host"
  [[ "$imap_port" =~ ^[0-9]+$ && "$smtp_port" =~ ^[0-9]+$ ]] || die "ports must be numbers"

  local username="${MAIL_USERNAME:-$(existing_value MAIL_USERNAME)}"
  [[ -n "$username" ]] || read -rp "Login username (usually your full email address): " username
  [[ -n "$username" && "$username" != *"|"* ]] || die "invalid username"
  local from="${MAIL_FROM-$(existing_value MAIL_FROM)}"
  [[ -z "$from" || "$from" =~ ^[^@[:space:]|]+@[^@[:space:]|]+$ ]] || die "invalid MAIL_FROM: $from"

  secret_exists "$PASSWORD_SECRET" || prompt_password
  secret_exists "$TOKEN_SECRET" || rotate_token

  local enable_send="${ENABLE_SEND:-$(existing_value ENABLE_SEND)}"
  if [[ -z "$enable_send" ]]; then
    read -rp "Allow bots to send email? [y/N] " answer
    [[ "$answer" =~ ^[Yy]$ ]] && enable_send=true || enable_send=false
  fi
  [[ "$enable_send" == true || "$enable_send" == false ]] || die "ENABLE_SEND must be true or false"
  [[ "$enable_send" == false || -n "$smtp_host" ]] || die "SMTP_HOST is required to send email"

  local recipients="${ALLOWED_RECIPIENTS-$(existing_value ALLOWED_RECIPIENTS)}"
  if [[ "$enable_send" == true && -z "${ALLOWED_RECIPIENTS+x}" && -z "$existing" ]]; then
    echo "Restrict who bots can email (comma-separated addresses and/or @domains). Blank allows anyone." >&2
    read -rp "Allowed recipients: " recipients
  fi
  [[ "$recipients" != *"|"* ]] || die "ALLOWED_RECIPIENTS cannot contain |"

  local max_sends="${MAX_SENDS_PER_HOUR:-$(existing_value MAX_SENDS_PER_HOUR)}"
  max_sends="${max_sends:-20}"
  [[ "$max_sends" =~ ^[0-9]+$ ]] || die "MAX_SENDS_PER_HOUR must be a number"

  for secret in "$PASSWORD_SECRET" "$TOKEN_SECRET"; do
    gcloud secrets add-iam-policy-binding "$secret" \
      --member "serviceAccount:$SA_EMAIL" --role roles/secretmanager.secretAccessor "${G[@]}" >/dev/null
  done

  info "Building and deploying $SERVICE to Cloud Run ($REGION)"
  gcloud run deploy "$SERVICE" \
    --source "$SCRIPT_DIR" \
    --region "$REGION" \
    --service-account "$SA_EMAIL" \
    --allow-unauthenticated \
    --ingress all \
    --set-secrets "MAIL_PASSWORD=${PASSWORD_SECRET}:latest,MCP_BEARER_TOKEN=${TOKEN_SECRET}:latest" \
    --set-env-vars "^|^IMAP_HOST=${imap_host}|IMAP_PORT=${imap_port}|SMTP_HOST=${smtp_host}|SMTP_PORT=${smtp_port}|MAIL_USERNAME=${username}|MAIL_FROM=${from}|ENABLE_SEND=${enable_send}|ALLOWED_RECIPIENTS=${recipients}|MAX_SENDS_PER_HOUR=${max_sends}" \
    --max-instances 1 \
    --concurrency 10 \
    --cpu 1 \
    --memory 512Mi \
    --timeout 120 \
    "${G[@]}"

  local url; url="$(gcloud run services describe "$SERVICE" --region "$REGION" "${G[@]}" --format 'value(status.url)')"
  local host="${url#https://}"
  curl -fsS "$url/healthz" >/dev/null || die "health check failed at $url/healthz"

  cat <<EOF

Deployed. MCP endpoint: $url/mcp
Mailbox: $username via $imap_host
Sending: $enable_send${recipients:+ (allowed recipients: $recipients)}

Wire it into a Grok bot (Agent SDK):

  1. bot/mcp-connections/$SERVICE.ts

     import { defineConnection } from "@grok/agent-sdk/connections";

     export default defineConnection({
       url: "$url/mcp",
       headers: { authorization: "Bearer \${$BOT_TOKEN_VAR}" },
       advertiseTools: true,
     });

  2. In bot/agent.ts, add to defineAgent({ hosting }):

     egressDomains: ["$host"],
     secretNames: ["$BOT_TOKEN_VAR"],

  3. Copy the token straight into the bot's secrets (it is never printed):

     gcloud secrets versions access latest --secret $TOKEN_SECRET --project $PROJECT_ID \\
       | npx --yes "@grok/agent-sdk@0.6.0" secret set <agent-name> $BOT_TOKEN_VAR

     For local runs, export it instead:
     export $BOT_TOKEN_VAR="\$(gcloud secrets versions access latest --secret $TOKEN_SECRET --project $PROJECT_ID)"
EOF
}

case "$COMMAND" in
  deploy) deploy ;;
  rotate-token) rotate_token; info "Token rotated"; deploy ;;
  update-password) prompt_password; deploy ;;
  destroy) destroy ;;
  *) die "unknown command: $COMMAND (use deploy, rotate-token, update-password or destroy)" ;;
esac
