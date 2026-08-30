import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// The same Runtime image `npm run poc` / `docker compose build` produces.
// These tests exercise Codex's own Landlock enforcement directly (the exact
// mechanism `--sandbox read-only`/`workspace-write` in codex-runner.ts and
// container-codex-runner.ts depend on), not a live model call -- so no Ark
// credentials or network are needed. Codex's `exec` subcommand always routes
// through a model, so it can't be driven end-to-end without live credentials;
// `codex sandbox linux` runs an arbitrary command under the same Landlock
// policy without a model in the loop, which is also what
// start-local-poc.sh/deploy-existing-ecs.sh already use to *detect* Landlock
// support -- this reuses that same verified technique to prove it actually
// *enforces* something, not just that it's present.
const RUNTIME_IMAGE = process.env.CONTAINER_RUNTIME_IMAGE ?? "volc-agent-launchpad:local";

function isRuntimeImageAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", RUNTIME_IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const runtimeImageAvailable = isRuntimeImageAvailable();
if (!runtimeImageAvailable) {
  console.warn(
    `Skipping sandbox-enforcement.test.ts: Docker image "${RUNTIME_IMAGE}" not found locally. ` +
      "Build it first (npm run poc, or docker compose build) to run these tests.",
  );
}

async function runUnderLandlock(hostDir: string, command: string, fullAuto: boolean) {
  const args = [
    "run",
    "--rm",
    "-v",
    `${hostDir}:/workspace`,
    "-w",
    "/workspace",
    RUNTIME_IMAGE,
    "codex",
    "sandbox",
    "linux",
    ...(fullAuto ? ["--full-auto"] : []),
    "--",
    "sh",
    "-c",
    command,
  ];
  try {
    await execFileAsync("docker", args, { timeout: 30_000 });
    return { blocked: false };
  } catch {
    return { blocked: true };
  }
}

describe.skipIf(!runtimeImageAvailable)("Sandbox (File access) enforcement -- real Landlock, no model call", () => {
  const workspaces: string[] = [];

  afterEach(async () => {
    await Promise.all(
      workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("blocks a file write when the sandbox has no write grant (\"Read only\" equivalent)", async () => {
    const hostDir = await mkdtemp(path.join(tmpdir(), "sandbox-readonly-"));
    workspaces.push(hostDir);

    const result = await runUnderLandlock(hostDir, "touch canary.txt", false);
    expect(result.blocked).toBe(true);

    const files = await readdir(hostDir);
    expect(files).not.toContain("canary.txt");
  });

  it("allows a file write inside the workspace when write is granted (\"Read + write\" equivalent)", async () => {
    const hostDir = await mkdtemp(path.join(tmpdir(), "sandbox-write-"));
    workspaces.push(hostDir);

    const result = await runUnderLandlock(hostDir, "touch canary.txt", true);
    expect(result.blocked).toBe(false);

    // Not just an exit-code check -- the file genuinely exists on the host
    // afterward, proving the write reached real disk, not just the
    // container's own report of success.
    const files = await readdir(hostDir);
    expect(files).toContain("canary.txt");
  });

  it("still refuses to write outside the mounted workspace even with write granted", async () => {
    const hostDir = await mkdtemp(path.join(tmpdir(), "sandbox-escape-"));
    workspaces.push(hostDir);

    const result = await runUnderLandlock(hostDir, "touch /etc/escape-canary.txt", true);
    expect(result.blocked).toBe(true);
  });
});
