// Test harness for the APK engine, run against real Alpine bytes on disk.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, apkModule, installPageGlobals } from './test-harness.mjs';
import { ensureFixtures } from './fetch-fixtures.mjs';

await ensureFixtures();

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/* --- minimal host environment the engine expects ---------------------- */
const output = [];
installPageGlobals();
globalThis.writeLine = (line) => output.push(String(line));
globalThis.escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Serve real files instead of the network. */
const FILES = {
  'APKINDEX.tar.gz': join(FIXTURE_DIR, 'APKINDEX.tar.gz'),
  'busybox-1.37.0-r31.apk': join(FIXTURE_DIR, 'busybox-1.37.0-r31.apk'),
  'alpine-conf-3.22.0-r0.apk': join(FIXTURE_DIR, 'alpine-conf-3.22.0-r0.apk')
};
let fetchCount = 0;
globalThis.fetch = async (url) => {
  fetchCount++;
  const name = String(url).split('/').pop();
  const path = FILES[name];
  if (!path || !existsSync(path)) return { ok: false, status: 404 };
  const bytes = readFileSync(path);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
};

const engine = await import(apkModule(join(tempDir(), 'apk-engine.mjs')));
const {
  gzipMembers, gunzip, parseTar, parseApkIndex, compareVersions,
  bytesToBase64, base64ToBytes, bytesToHex, sha1Of,
  verifyRsaSha1, verifySignedBlob, apkState, apkUpdate, apkInstall,
  findPackage, searchPackages, describeDependency, looksBinary, ALPINE_KEYS,
  verifyPayloadChecksums, splitApkMembers, parsePaxRecords
} = engine;

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label} ${detail}`); }
}

console.log('\n== encoding helpers ==');
check('base64 round trip', bytesToHex(base64ToBytes(bytesToBase64(Uint8Array.from([1, 2, 3, 250, 255])))) === '010203faff');
check('base64 of empty', bytesToBase64(new Uint8Array(0)) === '');
const sha1Empty = await sha1Of(new Uint8Array(0));
check('sha1 of empty matches known digest', bytesToHex(sha1Empty) === 'da39a3ee5e6b4b0d3255bfef95601890afd80709', bytesToHex(sha1Empty));
const sha1Abc = await sha1Of(new TextEncoder().encode('abc'));
check('sha1 of "abc" matches known digest', bytesToHex(sha1Abc) === 'a9993e364706816aba3e25717850c26c9cd0d89d', bytesToHex(sha1Abc));
const long = new TextEncoder().encode('a'.repeat(100000));
check('sha1 of 100k matches node crypto',
  bytesToHex(await sha1Of(long)) === createHash('sha1').update(long).digest('hex'));

console.log('\n== gzip member splitting on the real index ==');
const indexBytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, "APKINDEX.tar.gz")));
const members = gzipMembers(indexBytes);
check('index has 2 gzip members', members.length === 2, `got ${members.length}`);
check('first member ends at 748', members[0].end === 748, `got ${members[0].end}`);
check('second member ends at file length', members[1].end === indexBytes.length);
check('second member begins with gzip magic', members[1].compressed[0] === 0x1f && members[1].compressed[1] === 0x8b);

console.log('\n== tar parsing of the signature member ==');
const sigTar = gunzip(members[0].compressed);
const sigEntries = parseTar(sigTar);
const signEntry = sigEntries.find((entry) => entry.name.includes('.SIGN.'));
check('signature entry found', Boolean(signEntry), JSON.stringify(sigEntries.map((e) => e.name)));
check('signature entry is 512 bytes', signEntry?.size === 512, String(signEntry?.size));

console.log('\n== RSA-SHA1 verification on real signed data ==');
const signer = await verifySignedBlob(sigTar, members[1].compressed, 'index');
check('index signature verifies and names a pinned key', signer === 'alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub', String(signer));

const goodKey = ALPINE_KEYS[signer];
check('correct signature verifies', await verifyRsaSha1(signEntry.data, members[1].compressed, goodKey));
const tampered = Uint8Array.from(members[1].compressed);
tampered[tampered.length - 20] ^= 0xff;
check('tampered payload is rejected', !(await verifyRsaSha1(signEntry.data, tampered, goodKey)));
const otherKey = ALPINE_KEYS['alpine-devel@lists.alpinelinux.org-61666e3f.rsa.pub'];
check('wrong key is rejected', !(await verifyRsaSha1(signEntry.data, members[1].compressed, otherKey)));

console.log('\n== APKINDEX parsing ==');
const indexText = new TextDecoder('utf-8').decode(gunzip(members[1].compressed));
const packages = parseApkIndex(indexText);
check('parsed a large package count', packages.length > 5000, String(packages.length));
const busyboxEntry = packages.find((entry) => entry.name === 'busybox');
check('busybox entry present', Boolean(busyboxEntry));
check('busybox has version 1.37.0-r31', busyboxEntry?.version === '1.37.0-r31', busyboxEntry?.version);
check('busybox description parsed', (busyboxEntry?.description ?? '').includes('Size optimized toolbox'));
check('busybox checksum parsed', (busyboxEntry?.checksum ?? '').startsWith('Q1'));
check('busybox dependencies parsed', busyboxEntry?.depends.includes('so:libc.musl-x86_64.so.1'));
const sevenZip = packages.find((entry) => entry.name === '7zip');
check('7zip provides parsed', sevenZip?.provides.some((p) => p.startsWith('cmd:7z')));

console.log('\n== version comparison ==');
check('equal versions', compareVersions('1.2.3-r0', '1.2.3-r0') === 0);
check('revision ordering', compareVersions('1.2.3-r1', '1.2.3-r0') > 0);
check('numeric ordering beats lexical', compareVersions('1.10.0-r0', '1.9.0-r0') > 0);
check('minor ordering', compareVersions('1.37.0-r31', '1.36.0-r0') > 0);
check('letter suffix', compareVersions('1.0_alpha', '1.0_beta') < 0);

console.log('\n== index refresh through the engine ==');
await apkUpdate();
check('index marked verified', apkState.indexVerified);
check('index signer recorded', apkState.indexSigner.includes('6165ee59'));
check('index map populated', apkState.indexMap.size > 5000, String(apkState.indexMap.size));
check('findPackage works', findPackage('busybox')?.version === '1.37.0-r31');
const hits = searchPackages('text editor');
check('search returns hits', hits.length > 0, String(hits.length));
check('search ranks exact name first', searchPackages('busybox')[0]?.name === 'busybox');
check('dependency describe for so:', describeDependency('so:libc.musl-x86_64.so.1').kind === 'shared library');
check('dependency describe for cmd:', describeDependency('cmd:busybox=1.37.0-r31').name === 'busybox');
check('dependency describe for package', describeDependency('musl>=1.2').name === 'musl');

console.log('\n== install a real package into the VFS ==');
const report = await apkInstall('busybox');
check('package name reported', report.entry.name === 'busybox');
check('files were extracted', report.installed.length > 0, String(report.installed.length));
check('bin/busybox landed in the VFS', Boolean(VFS.children.bin?.children?.busybox));
check('busybox flagged as binary', VFS.children.bin.children.busybox.binary === true);
check('ELF binaries counted', report.elfCount >= 1, String(report.elfCount));
check('maintainer scripts captured', report.scripts.some((script) => script.name === 'post-install'),
  JSON.stringify(report.scripts.map((s) => s.name)));
check('PKGINFO depends parsed', report.info.depends.includes('so:libc.musl-x86_64.so.1'));
check('PKGINFO license parsed', report.info.license === 'GPL-2.0-only');

console.log('\n== install a shell-script package ==');
const confReport = await apkInstall('alpine-conf');
check('alpine-conf extracted scripts', confReport.installed.includes('usr/sbin/lbu'), JSON.stringify(confReport.installed.slice(0, 5)));
check('lbu stored as text', typeof VFS.children.usr.children.sbin.children.lbu.content === 'string');
check('lbu content is a shell script', VFS.children.usr.children.sbin.children.lbu.content.startsWith('#!'));
check('lbu has no binary flag', !VFS.children.usr.children.sbin.children.lbu.binary);

console.log('\n== per-file checksums ==');
{
  const apkBytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, "alpine-conf-3.22.0-r0.apk")));
  const parts = splitApkMembers(apkBytes);
  const payload = parseTar(gunzip(parts.payload.compressed));
  const clean = await verifyPayloadChecksums(payload);
  check('payload files carry pax checksums', clean.checked > 0, String(clean.checked));
  check('untampered payload passes', clean.failures.length === 0, JSON.stringify(clean.failures));

  // Mutate one file's bytes in a copy of the payload, then re-verify.
  const copy = new Uint8Array(gunzip(parts.payload.compressed));
  const copyEntries = parseTar(copy);
  const target = copyEntries.find((entry) => entry.attributes?.['APK-TOOLS.checksum.SHA1']);
  target.data[0] ^= 0xff;
  const dirty = await verifyPayloadChecksums(copyEntries);
  check('tampered payload file is reported', dirty.failures.includes(target.name), JSON.stringify(dirty.failures));
}

console.log('\n== integrity failures are reported ==');
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const response = await realFetch(url);
  if (!String(url).includes('.apk')) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const cut = gzipMembers(bytes);
  bytes[cut[1].start + 40] ^= 0xff; // damage the control member
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
};
let caught = '';
try { await apkInstall('busybox'); } catch (error) { caught = error.message; }
check('corrupted package is rejected', caught !== '', caught);
check('rejection is an integrity failure', /signature|checksum|deflate|invalid/i.test(caught), caught);

// A proxy that rewrites the index must not be trusted.
globalThis.fetch = async (url) => {
  const response = await realFetch(url);
  if (!String(url).includes('APKINDEX')) return response;
  const bytes = new Uint8Array(await response.arrayBuffer());
  bytes[bytes.length - 100] ^= 0xff;
  return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
};
let indexCaught = '';
try { await apkUpdate(); } catch (error) { indexCaught = error.message; }
check('tampered index is rejected', indexCaught !== '', indexCaught);
check('tampered index names the signature', /signature|checksum|deflate|invalid/i.test(indexCaught), indexCaught);
globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
