#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -z "${VOLCENGINE_ACCESS_KEY:-}" || -z "${VOLCENGINE_SECRET_KEY:-}" ]]; then
  echo "Export VOLCENGINE_ACCESS_KEY and VOLCENGINE_SECRET_KEY first." >&2
  exit 1
fi

if [[ ! -f .env.production ]]; then
  echo "Missing .env.production. Copy .env.example and fill the OpenRouter values." >&2
  exit 1
fi

if [[ ! -f deploy/volcengine/terraform.tfvars ]]; then
  echo "Missing deploy/volcengine/terraform.tfvars." >&2
  echo "Copy terraform.tfvars.example and fill the region-specific values." >&2
  exit 1
fi

set -a
source .env.production
set +a

if [[ "${OPENROUTER_API_KEY:-}" == "" || "${OPENROUTER_MODEL:-}" == "" || "${APP_AUTH_TOKEN:-}" == "" ]]; then
  echo "OPENROUTER_API_KEY, OPENROUTER_MODEL and APP_AUTH_TOKEN are required in .env.production." >&2
  exit 1
fi

export TF_VAR_openrouter_api_key="$OPENROUTER_API_KEY"
export TF_VAR_app_auth_token="$APP_AUTH_TOKEN"
export TF_VAR_openrouter_model="$OPENROUTER_MODEL"
export TF_VAR_openrouter_base_url="${OPENROUTER_BASE_URL:-https://openrouter.ai/api/v1}"

terraform -chdir=deploy/volcengine init
terraform -chdir=deploy/volcengine apply

echo
echo "Deployment requested. Cloud-init may take 5-10 minutes."
terraform -chdir=deploy/volcengine output app_url
