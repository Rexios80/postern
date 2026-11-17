#!/usr/bin/env bash
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }

: "${IMAP_HOST:?set IMAP_HOST, e.g. imap.mail.me.com (see README)}"
: "${MAIL_USERNAME:?set MAIL_USERNAME, usually your full email address}"
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
[[ -n "$PROJECT_ID" ]] || die "set PROJECT_ID or run: gcloud config set project <id>"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-postern}"

SA="${SERVICE}@${PROJECT_ID}.iam.gserviceaccount.com"
G=(--project "$PROJECT_ID" --quiet)

gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com "${G[@]}"

gcloud iam service-accounts describe "$SA" "${G[@]}" >/dev/null 2>&1 ||
  gcloud iam service-accounts create "$SERVICE" "${G[@]}"

# Secret values go through stdin so they never appear in argv or shell history.
if ! gcloud secrets describe "$SERVICE-mail-password" "${G[@]}" >/dev/null 2>&1; then
  read -rsp "Mail app password: " password; echo
  printf '%s' "$password" | gcloud secrets create "$SERVICE-mail-password" --data-file=- "${G[@]}"
fi
if ! gcloud secrets describe "$SERVICE-token" "${G[@]}" >/dev/null 2>&1; then
  openssl rand -hex 32 | tr -d '\n' | gcloud secrets create "$SERVICE-token" --data-file=- "${G[@]}"
fi
for secret in "$SERVICE-mail-password" "$SERVICE-token"; do
  gcloud secrets add-iam-policy-binding "$secret" --member "serviceAccount:$SA" \
    --role roles/secretmanager.secretAccessor "${G[@]}" >/dev/null
done

gcloud run deploy "$SERVICE" --source "$(dirname "$0")" --region "$REGION" \
  --service-account "$SA" --allow-unauthenticated --max-instances 1 \
  --set-secrets "MAIL_PASSWORD=$SERVICE-mail-password:latest,MCP_BEARER_TOKEN=$SERVICE-token:latest" \
  --set-env-vars "IMAP_HOST=$IMAP_HOST,SMTP_HOST=$SMTP_HOST,SMTP_PORT=$SMTP_PORT,MAIL_USERNAME=$MAIL_USERNAME" \
  "${G[@]}"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)' "${G[@]}")"
cat <<EOF

MCP endpoint: $URL/mcp
Copy the token into your bot's secrets:
  gcloud secrets versions access latest --secret $SERVICE-token --project $PROJECT_ID \\
    | npx --yes "@grok/agent-sdk@0.6.0" secret set <agent-name> POSTERN_TOKEN
EOF
