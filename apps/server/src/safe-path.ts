import path from "node:path";
import { HttpError } from "./errors.js";

/**
 * Joins `name` onto `root` and verifies the resolved path is still inside
 * `root` (CWE-22 mitigation: canonicalize, then check containment, rather
 * than pattern-matching `name` for traversal sequences). This is the
 * defense-in-depth layer -- the request-body schema in app.ts already
 * rejects "..", control characters, and reserved Windows device names
 * before a request gets this far, but this check is what actually decides
 * whether the file access is safe, independent of how `name` got here.
 */
export function resolveWithinRoot(root: string, name: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, name);
  // A single-name join must land strictly *inside* the root -- if it
  // resolves to the root itself (name was "." or similar), that's not a
  // valid file target either, so it's rejected the same as an escape.
  if (!candidate.startsWith(resolvedRoot + path.sep)) {
    throw new HttpError(400, "Resource name resolves outside its storage root");
  }
  return candidate;
}
