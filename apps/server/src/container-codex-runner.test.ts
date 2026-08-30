import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import {
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      OPENROUTER_API_KEY: "secret-that-must-not-appear-in-argv",
      OPENROUTER_MODEL: "openai/gpt-4o-mini",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent/unsafe",
        runId: "run-1",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
        sandboxMode: "workspace-write",
        networkAccess: true,
      },
      config,
    );

    expect(containerName("agent/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-agent-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    // `config.codexHome` is `path.resolve(CODEX_HOME)`, which normalizes
    // separators per-OS (e.g. to a `C:\...` path on Windows dev machines).
    // Assert against the actual resolved value rather than a hardcoded
    // POSIX string, so this test is correct on every platform, not just the
    // macOS/Linux hosts this project targets for deployment.
    expect(args).toContain("type=bind,src=" + config.codexHome + ",dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("bridge");
    expect(args).toContain("--read-only");
    expect(args).toContain("/tmp:rw,nosuid,nodev,noexec,size=256m");
    expect(args).toContain("/run:rw,nosuid,nodev,noexec,size=32m");
    expect(args).toContain("/var/tmp:rw,nosuid,nodev,noexec,size=32m");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
  });

  it("cuts network access per-Agent when networkAccess is false", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "install a dependency",
        threadId: null,
        sandboxMode: "workspace-write",
        networkAccess: false,
      },
      config,
    );
    expect(args).toContain("none");
    expect(args).not.toContain("bridge");
  });

  it("blocks writes per-Agent via read-only sandbox mode", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "just look around",
        threadId: null,
        sandboxMode: "read-only",
        networkAccess: true,
      },
      config,
    );
    expect(args).toContain("read-only");
    expect(args).not.toContain("workspace-write");
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        agentId: "agent",
        runId: "run-1",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
        sandboxMode: "workspace-write",
        networkAccess: true,
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});
