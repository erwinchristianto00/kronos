import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export interface ArchiveBundleFile { relativePath: string; fileHash: string; }
export interface ArchiveBundleIdentity { version: "archive-bundle-v1"; fileCount: number; files: ArchiveBundleFile[]; archiveBundleHash: string; }
export interface ReadArchiveBundle extends ArchiveBundleIdentity { contents: ReadonlyMap<string, Buffer>; }

const HASH = /^[a-f0-9]{64}$/;
const sha256 = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const posix = (path: string): string => path.split(sep).join("/");

/** Hash a large archival object without retaining its bytes in process memory. */
function fileHash(path: string): string {
  const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) { const bytes = readSync(handle, buffer); if (bytes === 0) break; hash.update(buffer.subarray(0, bytes)); }
  } finally { closeSync(handle); }
  return hash.digest("hex");
}

function walk(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry) => {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) return walk(path);
    if (!entry.isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`FOUNDRY_ARCHIVE_ENTRY_INVALID_${path}`);
    return [path];
  });
}

function selectedFiles(input: { root: string; include: (relativePath: string) => boolean }): Array<{ path: string; relativePath: string }> {
  const root = resolve(input.root);
  return walk(root).map((path) => ({ path, relativePath: posix(relative(root, path)) })).filter((file) => input.include(file.relativePath)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** Builds a bundle identity for large files while keeping the archive out of memory. */
export function inspectArchiveBundle(input: { root: string; include: (relativePath: string) => boolean }): ArchiveBundleIdentity {
  const files = selectedFiles(input); if (!files.length) throw new Error("FOUNDRY_ARCHIVE_BUNDLE_EMPTY");
  const identities = files.map((file) => ({ relativePath: file.relativePath, fileHash: fileHash(file.path) }));
  return { version: "archive-bundle-v1", fileCount: identities.length, files: identities, archiveBundleHash: sha256(identities.map((file) => `${file.relativePath}:${file.fileHash}`).join("\n")) };
}
/** Reads the complete selected archive exactly once and hashes the exact bytes consumed. */
export function readArchiveBundle(input: { root: string; include: (relativePath: string) => boolean }): ReadArchiveBundle {
  const files = selectedFiles(input);
  if (!files.length) throw new Error("FOUNDRY_ARCHIVE_BUNDLE_EMPTY");
  const contents = new Map<string, Buffer>(); const identities: ArchiveBundleFile[] = [];
  for (const file of files) { const bytes = readFileSync(file.path); contents.set(file.relativePath, bytes); identities.push({ relativePath: file.relativePath, fileHash: sha256(bytes) }); }
  const archiveBundleHash = sha256(identities.map((file) => `${file.relativePath}:${file.fileHash}`).join("\n"));
  return { version: "archive-bundle-v1", fileCount: identities.length, files: identities, archiveBundleHash, contents };
}

export function assertArchiveBundleIdentity(value: ArchiveBundleIdentity | undefined): asserts value is ArchiveBundleIdentity {
  if (!value || value.version !== "archive-bundle-v1" || !Number.isInteger(value.fileCount) || value.fileCount <= 0 || value.fileCount !== value.files.length || !HASH.test(value.archiveBundleHash) || value.files.some((file, index) => !file.relativePath || !HASH.test(file.fileHash) || (index > 0 && value.files[index - 1]!.relativePath >= file.relativePath))) throw new Error("FOUNDRY_ARCHIVE_BUNDLE_IDENTITY_INVALID");
  const calculated = sha256(value.files.map((file) => `${file.relativePath}:${file.fileHash}`).join("\n"));
  if (calculated !== value.archiveBundleHash) throw new Error("FOUNDRY_ARCHIVE_BUNDLE_HASH_INVALID");
}

/** Detects mutation, additions, removals, unreadable files, and selection drift before a real run. */
export function verifyArchiveBundle(input: { root: string; include: (relativePath: string) => boolean; expected: ArchiveBundleIdentity }): ArchiveBundleIdentity {
  assertArchiveBundleIdentity(input.expected);
  const actual = inspectArchiveBundle({ root: input.root, include: input.include });
  if (JSON.stringify(actual.files) !== JSON.stringify(input.expected.files) || actual.archiveBundleHash !== input.expected.archiveBundleHash) throw new Error("FOUNDRY_ARCHIVE_BUNDLE_CHANGED");
  return actual;
}
