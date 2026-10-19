// Shared test helper.
//
// The deliverable is one file, so the unit tests must run the code that ships
// rather than a copy. This helper slices named sections out of index.html and
// writes them to a temporary module that the suites import.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const INDEX = join(ROOT, 'index.html');

const SECTION_START = (title) => `/* ---------------------------------------------------------------------\n   ${title}`;

/** Return the slice of index.html from one section header up to the next. */
export function readSection(title) {
  const html = readFileSync(INDEX, 'utf8');
  const start = html.indexOf(SECTION_START(title));
  if (start === -1) throw new Error(`section not found in index.html: ${title}`);
  const rest = html.slice(start + 10);
  const next = rest.indexOf(SECTION_START(''));
  const end = next === -1 ? html.length : start + 10 + next;
  return html.slice(start, end);
}

/** Extract the shell interpreter section as a temporary importable module. */
export function shellModule(outPath) {
  const source = readSection('8. Shell interpreter');
  writeFileSync(outPath, `${source}
export { Shell, ShellExit, ShellReturn, shellTokenize, shellExpand, shellWords, shellGlob,
  shellParameter, ShellParser, shellExecNode, shellRunCommand, shellRunExternal,
  shellRunScriptFile, shellArithmetic, shellRunBusybox, SHELL_BUILTINS,
  NATIVE_BINARY_COMMANDS, runMaintainerScript, stripShellComments, isShellScript,
  shellLookup, shellResolve, shellPath, shellWriteFile, shellReadFile, shellEnsureDir,
  shellFindExecutable };
`);
  return outPath;
}

/** Extract the apk section as a temporary importable module. */
export function apkModule(outPath) {
  const source = readSection('9. apk package manager');
  writeFileSync(outPath, `${source}
export { gzipMembers, gzipMemberEnd, gunzip, inflateRaw, parseTar, parsePaxRecords, tarEntry,
  parseApkIndex, compareVersions, bytesToBase64, base64ToBytes, bytesToHex, sha1Of,
  sha1Fallback, buildHuffman, verifyRsaSha1, verifySignedBlob, pemToDer, parseSpki,
  signerNameFromEntry, ALPINE_KEYS, apkState, apkUpdate, ensureIndex, apkInstall,
  findPackage, searchPackages, describeDependency, parsePkgInfo, looksBinary, formatBytes,
  countElfBinaries, installPayloadFile, splitApkMembers, apkUrl, apkDisplayUrl,
  fetchRepoBytes, verifyPayloadChecksums };
`);
  return outPath;
}

/** Install the globals the extracted sections expect from the page. */
export function installPageGlobals() {
  const globals = globalThis;
  if (!globals.ShellError) {
    class ShellError extends Error {}
    globals.ShellError = ShellError;
  }
  globals.performance ??= { now: () => Date.now() };
  globals.makeDir = (name, children = {}) => ({ name, type: 'dir', children });
  globals.makeFile = (name, content = '', extra = {}) => ({ name, type: 'file', content, ...extra });
  globals.isDir = (node) => Boolean(node) && node.type === 'dir';
  globals.VFS = globals.makeDir('~', {});
  globals.cloneVfs = (node = globals.VFS) => node;
  globals.writeLine = () => {};
  globals.escapeHtml = (value) => String(value);
  globals.promptHtml = () => '';
  globals.clearScreen = () => {};
  globals.displayPath = () => '~';
  globals.cfg = { user: 'ubuntu', host: 'sandbox-vm', root: '~', aiEnabled: true };
  globals.childNames = (dir) => Object.keys(dir.children).sort();
  globals.state = { cwd: [] };
  return globals;
}

/** Create the temporary directory the suites write into. */
export function tempDir() {
  const dir = join(ROOT, '.test-tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}
