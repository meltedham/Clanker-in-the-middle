# Volc Agent Launchpad — Agent Briefing

## 1. Project purpose

Volc Agent Launchpad is a minimal single-user agent platform intended for hackathon or local proof-of-concept use. It gives users a browser-based workspace to create coding agents, configure their instructions, send tasks, and let an AI agent inspect files, modify code, and run commands in a persistent workspace.

The system is built around OpenAI-compatible Codex execution and Volcengine Ark model access. It is designed to demonstrate a lightweight control plane for AI coding agents without introducing full enterprise security or multi-tenant isolation features.

## 2. Product scope

The application provides:

- a React + TypeScript web UI
- agent create, edit, start, stop, and delete flows
- a chat/playground interface for prompt submission
- persistent per-agent workspaces
- resumable Codex sessions across turns
- run tracking and status polling
- local containerized execution or ECS-style in-process execution
- optional shared bearer-token protection for remote/demo access

The project is explicitly a demo and local POC, not a hardened production platform.

## 3. Core system model

The project follows a simple architecture:

- Web UI
- Fastify API
- Agent service layer
- JSON persistence layer
- Workspace manager
- Runtime runner abstraction
- Codex execution backend
- Volcengine Ark model access

The user interacts with the UI, which calls the API. The API validates requests and delegates to `AgentService`, which manages persistence and agent lifecycle. `AgentService` interacts with a workspace manager and a runner abstraction, which actualizes Codex execution in either local-container or host-process mode.

## 4. Primary components

### 4.1 Web UI

The frontend is a React app that:

- lists current agents
- selects an active agent
- shows messages and run state
- allows agent creation and editing
- displays runtime configuration status
- polls for asynchronous run completion
- enforces UI-level flow constraints like “cannot send while agent is busy”

The UI is intentionally minimal and focused on demonstrating the agent lifecycle.

### 4.2 Fastify API

The API exposes endpoints for:

- health and auth checks
- system info
- listing agents
- creating/updating/deleting agents
- starting/stopping agents
- fetching messages and runs
- creating a new user prompt/run
- retrieving run state

It also validates input with Zod schemas and guards remote/demo access using a shared bearer token if configured.

### 4.3 AgentService

`AgentService` is the main orchestration layer. It maintains:

- active execution tracking
- cancellation state
- agent metadata
- message history
- run records
- transition logic between `ready`, `busy`, `stopped`, and `error` agent states

It prevents conflicting active runs and marks interrupted runs as `cancelled` if the server restarts while work is in progress.

### 4.4 JSON data store

The store persists project state in a JSON file. It keeps:

- agents
- messages
- runs

Writes are serialized and replaced atomically. This is designed for a single-process single-user setup.

### 4.5 Workspace manager

Each agent gets a dedicated workspace directory. The manager creates:

- the workspace folder
- `AGENTS.md` with the current instructions
- a `.gitignore` file for common generated outputs
- a README file describing the workspace

When an agent is deleted, its workspace is archived under a `.deleted` directory.

### 4.6 Runner abstraction

The project implements the `AgentRunner` interface with two concrete types:

- `CodexRunner`: runs Codex directly in the application container or host environment
- `ContainerCodexRunner`: creates a disposable Docker/Podman/Colima container per turn

The runner abstraction handles:

- process startup
- runtime cancellation
- timeout enforcement
- output capture
- parsing structured Codex JSON events
- thread resume behavior

This separation is a key architectural seam and should be preserved when making changes.

## 5. Runtime execution flow

A typical interaction proceeds like this:

1. User creates an agent with a name, optional description, and instructions.
2. A workspace is created for the agent and `AGENTS.md` is written.
3. User sends a prompt from the UI.
4. API validates and records a user message and a queued run.
5. `AgentService` marks the agent as `busy`.
6. The appropriate runner starts `codex exec` against the agent workspace.
7. Codex runs in the workspace, optionally resuming an existing thread.
8. Structured output is parsed for:
   - agent messages
   - thread IDs
   - token usage metadata
   - error events
9. The final output is persisted to the run record.
10. The frontend polls the run until it reaches a terminal state.

## 6. Local POC and deployment profiles

The repo supports multiple operational profiles:

- Local POC: host Node.js + disposable runtime container
- Local development: host Node.js + local Codex process
- ECS deployment: application container runs Codex inside the same container

The design is meant to support quick demo and deployment scenarios, not a horizontally scaled shared-service architecture.

## 7. Security assumptions and limitations

This project explicitly states the following limitations:

- single-user design
- no identity or authorization system beyond a shared demo token
- no audit logging
- no hardened sandboxing or multi-tenant isolation
- trust boundary is effectively the current container or ECS instance

This means the repo is appropriate for demos, labs, and hackathon-style work, not for untrusted user access or real production workloads.

## 8. Configuration model

The app loads environment configuration from process env values. Important variables include:

- `ARK_API_KEY`: model access key
- `ARK_MODEL`: model or endpoint id
- `ARK_BASE_URL`: Ark API base URL
- `APP_AUTH_TOKEN`: shared bearer token for demo access
- `RUNTIME_PROVIDER`: local-process or container runtime selection
- `CODEX_SANDBOX_MODE`: sandbox policy for Codex
- `CODEX_TIMEOUT_MS`: run timeout
- `AGENT_WORKSPACE_ROOT`: workspace root
- `CODEX_HOME`: Codex home/session directory
- `CONTAINER_ENGINE`: Docker/Podman/Colima selection

The app validates these values on startup and refuses to use Ark if configuration is incomplete.

## 9. Notable implementation patterns

- `zod` validates request payloads and env configuration.
- The app uses `Fastify` for API routes and static serving in production.
- System messages and instructions are generated inside each workspace as `AGENTS.md`.
- The runner logic is intentionally resilient to cancellation and timeout.
- The frontend uses polling, not streaming subscriptions, to observe run state.

## 10. What to preserve when making changes

Any future work should respect the current architecture and assumptions:

- keep the UI/API/service/store separation intact
- keep the runner abstraction as the place for runtime-specific behavior
- preserve one-active-run-per-agent semantics
- maintain persistent workspace semantics for each agent
- keep local container and ECS paths behind the runner boundary
- do not assume a production identity model unless the task explicitly calls for it

## 11. One-paragraph summary for another agent

Volc Agent Launchpad is a minimal Codex-based agent platform for local or ECS demo deployments. It lets users create coding agents, persist workspace instructions and project files, send prompts through a browser UI, and run Codex in either disposable local containers or the application container. The backend is a Fastify API with a service layer that manages agent lifecycle, run state, and persistence in JSON; the workspace manager provisions per-agent directories and archives deleted workspaces; and the runner layer handles Codex process execution, timeout/cancellation, and parsing of structured agent events. The project is intentionally a single-user proof of concept, with limited security and authentication assumptions, and is meant to demonstrate the control plane and runtime model rather than provide a hardened production AI platform.

## 12. Recommended operating assumptions for future agents

When continuing work in this repo, assume:

- this is a demo-first environment
- architecture should stay lightweight and understandable
- security improvements are intentionally out of scope unless requested
- the priority is to preserve the project’s ability to demonstrate agent workflows reliably
- maintain compatibility with the current runner pattern and single-user persistence model
