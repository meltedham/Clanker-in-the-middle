import path from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError } from "./errors.js";
import { resolveWithinRoot } from "./safe-path.js";

describe("resolveWithinRoot", () => {
  const root = path.join("C:", "data", "shared-resources");

  it("joins an ordinary name onto the root", () => {
    expect(resolveWithinRoot(root, "notes.md")).toBe(path.resolve(root, "notes.md"));
  });

  it("rejects a name that resolves above the root", () => {
    expect(() => resolveWithinRoot(root, "..")).toThrow(HttpError);
    expect(() => resolveWithinRoot(root, "..")).toThrow(/outside its storage root/);
  });

  it("rejects a name that resolves to the root itself", () => {
    expect(() => resolveWithinRoot(root, ".")).toThrow(HttpError);
  });

  it("is the last line of defense even if the app-layer schema were bypassed", () => {
    // app.ts already rejects names containing "/" or "\\" before this is
    // ever reached, but this check has to hold on its own: it is what a
    // future caller (a script, a test, a second route) actually relies on.
    expect(() => resolveWithinRoot(root, "../../etc/passwd")).toThrow(HttpError);
  });
});
