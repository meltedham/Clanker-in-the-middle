# OpenRouter migration guide for this repo

This document explains how to change this project from Volcengine Ark to OpenRouter.

## Goal

The project originally assumed Ark as the model provider. The config, startup validation, and generated Codex provider definition were all hardcoded to Ark-specific environment variables and model-provider settings.

The repository now supports OpenRouter as the default provider while keeping Ark as a fallback for compatibility.

## Required environment variables

Set these in the root `.env` file for local development or Docker Compose:

```dotenv
HOST=127.0.0.1
PORT=3000
PUBLIC_PORT=3000
LOG_LEVEL=info
APP_AUTH_TOKEN=replace-with-a-long-random-demo-token

OPENROUTER_API_KEY=replace-with-your-openrouter-api-key
OPENROUTER_MODEL=openai/gpt-4.1-mini
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1

ARK_API_KEY=
ARK_MODEL=
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
```

Notes:
- `APP_AUTH_TOKEN` is only required for non-loopback production listens; local loopback runs can use an empty value or a demo token.
- `OPENROUTER_MODEL` must be the exact model slug shown in your OpenRouter dashboard. Do not invent a generic value like `openai/free`.
- `OPENROUTER_BASE_URL` should stay `https://openrouter.ai/api/v1` unless you are deliberately using a custom proxy.

## Required code changes

The repo-specific migration points are:

### 1) Config schema and validation

File: `apps/server/src/config.ts`

What changed:
- Added `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, and `OPENROUTER_BASE_URL`
- Kept `ARK_*` values as a fallback path
- Added helper checks like `isOpenRouterConfigured()` and `isModelConfigured()`

This is the actual source of truth for whether a provider is configured.

### 2) Codex config generation

File: `apps/server/src/config.ts`

The generated Codex `config.toml` now chooses the provider dynamically:

- If `OPENROUTER_API_KEY` and `OPENROUTER_MODEL` are present, it writes:
  - `model_provider = "openrouter"`
  - `base_url = "https://openrouter.ai/api/v1"`
  - `env_key = "OPENROUTER_API_KEY"`
- Otherwise it falls back to `volcengine_ark`

This is important because the Codex CLI uses the provider block to know where to send model requests.

### 3) Runtime environment injection

Files:
- `apps/server/src/codex-runner.ts`
- `apps/server/src/container-codex-runner.ts`

What changed:
- Export `OPENROUTER_API_KEY` into the child runtime environment when present
- Also keep `ARK_API_KEY` as a fallback for Ark users

### 4) Startup validation

Files:
- `scripts/start-local-poc.sh`
- `scripts/bootstrap-local.sh`

What changed:
- Startup accepts either OpenRouter or Ark credentials, rather than requiring Ark-only values
- This prevents the local POC from failing before the app boots

### 5) UI readiness messaging

File: `apps/web/src/App.tsx`

The browser UI used to show Ark-specific guidance. The app should be treated as configured when either OpenRouter or Ark is available.

## Recommended local startup command

From the repo root:

```bash
OPENROUTER_API_KEY=your_key_here \
OPENROUTER_MODEL=openai/gpt-4.1-mini \
npm run poc
```

If using Docker Compose directly:

```bash
docker compose up --build
```

## Important caveat

`OPENROUTER_MODEL` must be an exact model slug from the OpenRouter dashboard. The value `openai/free` is not a reliable model slug; use a real provider/model identifier such as:

```dotenv
OPENROUTER_MODEL=openai/gpt-4.1-mini
```

or another exact model the account has access to.

## Verification checklist

Before calling the project ready, confirm:

1. `.env` contains `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`
2. The model value matches an actual OpenRouter model slug
3. `OPENROUTER_BASE_URL` is `https://openrouter.ai/api/v1`
4. `ARK_API_KEY` is blank or omitted if you are not using Ark
5. `docker compose up --build` starts the app without a config error
6. The first agent run succeeds, creating a model call through OpenRouter

## Common failure symptoms

- “Runtime configuration needed” banner in the UI
- `No model provider is configured` message
- OpenRouter key is present but model validation fails because the model slug is not available on the account
- Docker starts successfully, but the first agent turn fails because the model/provider environment is wrong

## Summary

The repo is now OpenRouter-capable, but the provider choice is driven by the env values. If the OpenRouter model slug and key are valid, the app should use OpenRouter without any Ark credentials.
