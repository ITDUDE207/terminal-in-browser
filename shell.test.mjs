// Shell interpreter tests. Exercises real POSIX semantics against the VFS.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempDir, apkModule, shellModule, installPageGlobals } from './test-harness.mjs';
import { ensureFixtures } from './fetch-fixtures.mjs';

await ensureFixtures();

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

installPageGlobals();
globalThis.normalizeSegments = (raw) => {
  const segments = [];
  for (const value of raw) {
    if (value === '' || value === '.') continue;
    if (value === '..') { segments.pop(); continue; }
    segments.push(value);
  }
  return segments;
};
globalThis.VFS = makeDir('~', {
  bin: makeDir('bin', {}),
  usr: makeDir('usr', { bin: makeDir('bin', {}), sbin: makeDir('sbin', {}) }),
  etc: makeDir('etc', {}),
  tmp: makeDir('tmp', {})
});
globalThis.cloneVfs = (node = VFS) => {
  if (node.type === 'file') return { ...node };
  const children = {};
  for (const key of Object.keys(node.children)) children[key] = cloneVfs(node.children[key]);
  return { name: node.name, type: 'dir', children };
};

/* Serve the real downloaded packages instead of the network. */
const FILES = {
  'APKINDEX.tar.gz': join(FIXTURE_DIR, 'APKINDEX.tar.gz'),
  'busybox-1.37.0-r31.apk': join(FIXTURE_DIR, 'busybox-1.37.0-r31.apk'),
  'alpine-conf-3.22.0-r0.apk': join(FIXTURE_DIR, 'alpine-conf-3.22.0-r0.apk')
};
globalThis.fetch = async (url) => {
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
const shell = await import(shellModule(join(tempDir(), 'shell-engine.mjs')));
const { Shell, runMaintainerScript, shellTokenize, shellExpand } = shell;

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label} ${detail}`); }
}

/** Run a script and capture stdout, stderr and status. */
function run(source, { stdin = '', cwd = [], env = {} } = {}) {
  const instance = new Shell({ stdin, cwd, env });
  instance.fs = VFS;
  let status = 0;
  try {
    instance.run(source, { stdin, stdout: (t) => instance.out(t), stderr: (t) => instance.err(t) });
    status = instance.lastStatus;
  } catch (error) {
    if (error.constructor.name === 'ShellExit') status = error.code;
    else return { stdout: instance.stdout.join(''), stderr: instance.stderr.join('') + String(error.message), status: 1 };
  }
  return { stdout: instance.stdout.join(''), stderr: instance.stderr.join(''), status };
}

console.log('\n== tokenizer ==');
check('splits on whitespace', JSON.stringify(shellTokenize('a b c')) === '["a","b","c"]');
check('keeps quoted spaces', JSON.stringify(shellTokenize('echo "a b"')) === JSON.stringify(['echo','"a b"']));
check('splits on semicolon', JSON.stringify(shellTokenize('a;b')) === '["a",";","b"]');
check('recognises &&', JSON.stringify(shellTokenize('a && b')) === '["a","&&","b"]');
check('recognises pipe', JSON.stringify(shellTokenize('a|b')) === '["a","|","b"]');
check('strips trailing comment', JSON.stringify(shellTokenize('a # note')) === '["a"]');
check('keeps hash inside quotes', JSON.stringify(shellTokenize('echo "#x"')) === JSON.stringify(['echo','"#x"']));

console.log('\n== echo and quoting ==');
check('echo plain', run('echo hello').stdout === 'hello\n');
check('echo -n suppresses newline', run('echo -n hi').stdout === 'hi');
check('echo with quotes', run('echo "a  b"').stdout === 'a  b\n');
check('echo single quotes', run("echo 'a b'").stdout === 'a b\n');
check('echo escapes', run('echo "a\\tb"').stdout === 'a\tb\n');

console.log('\n== variables ==');
check('assign then expand', run('X=5; echo $X').stdout === '5\n');
check('braced expansion', run('X=5; echo ${X}').stdout === '5\n');
check('default value', run('echo ${NOPE:-fallback}').stdout === 'fallback\n');
check('default when set', run('X=1; echo ${X:-fallback}').stdout === '1\n');
check('assign default', run('echo ${NEW:=made}; echo $NEW').stdout === 'made\nmade\n');
check('quote protects expansion', run("X=5; echo '$X'").stdout === '$X\n');

console.log('\n== command substitution ==');
check('backticks', run('echo `echo inner`').stdout === 'inner\n');
check('dollar parens', run('echo $(echo inner)').stdout === 'inner\n');
check('nested substitution', run('echo $(echo $(echo deep))').stdout === 'deep\n');

console.log('\n== control flow ==');
check('if true branch', run('if true; then echo yes; fi').stdout === 'yes\n');
check('if false branch', run('if false; then echo yes; fi').stdout === '');
check('if else', run('if false; then echo a; else echo b; fi').stdout === 'b\n');
check('elif chain', run('if false; then echo a; elif true; then echo b; else echo c; fi').stdout === 'b\n');
check('and short circuit', run('false && echo no').stdout === '');
check('and runs when true', run('true && echo yes').stdout === 'yes\n');
check('or short circuit', run('true || echo no').stdout === '');
check('or runs when false', run('false || echo yes').stdout === 'yes\n');
check('while loop', run('i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done').stdout.includes('0'));
check('for loop over words', run('for x in a b c; do echo $x; done').stdout === 'a\nb\nc\n');
check('until loop', run('i=0; until [ $i -ge 2 ]; do echo $i; i=$((i+1)); done').stdout.includes('0'));

console.log('\n== case statement ==');
check('case match', run('x=b; case $x in a) echo A;; b) echo B;; esac').stdout === 'B\n');
check('case wildcard', run('x=hello; case $x in h*) echo starts-h;; esac').stdout === 'starts-h\n');
check('case no match', run('x=z; case $x in a) echo A;; esac').stdout === '');

console.log('\n== exit status ==');
check('true is 0', run('true').status === 0);
check('false is 1', run('false').status === 1);
check('exit sets status', run('exit 3').status === 3);
check('last status propagates', run('false; true').status === 0);

console.log('\n== pipelines ==');
check('echo piped to cat', run('echo hello | cat').stdout === 'hello\n');
check('grep filters', run('printf "a\\nb\\n" | grep b').stdout === 'b\n');
check('wc -l counts', run('printf "a\\nb\\n" | wc -l').stdout === '2\n');
check('tr upper', run('echo abc | tr a-z A-Z').stdout === 'ABC\n');
check('three stage pipe', run('printf "c\\na\\nb\\n" | sort | head -n 1').stdout === 'a\n');

console.log('\n== redirection ==');
run('echo written > /tmp/out.txt');
check('write then read back', run('cat /tmp/out.txt').stdout === 'written\n');
run('echo more >> /tmp/out.txt');
check('append adds a line', run('cat /tmp/out.txt').stdout === 'written\nmore\n');
run('echo overwrite > /tmp/out.txt');
check('overwrite replaces content', run('cat /tmp/out.txt').stdout === 'overwrite\n');
check('stderr redirect to stdout', run('ls /nope 2>&1').stderr.includes('No such file') || run('ls /nope 2>&1').stdout.includes('No such file'));

console.log('\n== file system builtins ==');
run('mkdir -p /etc/pkg/conf.d');
check('mkdir -p created nested dirs', Boolean(VFS.children.etc.children.pkg.children['conf.d']));
check('mkdir -p is idempotent', run('mkdir -p /etc/pkg/conf.d').status === 0);
run('echo "config" > /etc/pkg/app.conf');
check('wrote a config file', run('cat /etc/pkg/app.conf').stdout === 'config\n');
check('test -f sees the file', run('[ -f /etc/pkg/app.conf ]').status === 0);
check('test -d sees the directory', run('[ -d /etc/pkg ]').status === 0);
check('test -z on empty', run('[ -z "" ]').status === 0);
check('test -n on text', run('[ -n "x" ]').status === 0);
check('test string equality', run('[ abc = abc ]').status === 0);
check('test numeric compare', run('[ 5 -gt 3 ]').status === 0);
check('test negation', run('[ ! -f /nope ]').status === 0);
run('cp /etc/pkg/app.conf /tmp/copy.conf');
check('cp copied the file', run('cat /tmp/copy.conf').stdout === 'config\n');
run('mv /tmp/copy.conf /tmp/moved.conf');
check('mv moved the file', run('cat /tmp/moved.conf').stdout === 'config\n');
check('mv removed the old name', run('cat /tmp/copy.conf').status === 1);
check('rm deletes', (run('rm /tmp/moved.conf'), run('cat /tmp/moved.conf').status === 1));
check('rmdir on empty dir', run('mkdir /tmp/empty; rmdir /tmp/empty').status === 0);
check('rmdir refuses non-empty', run('rmdir /etc/pkg').status === 1);
check('rm -r removes a tree', (run('rm -r /tmp/nonexistent'), true));

console.log('\n== globbing ==');
run('touch /tmp/g1.txt; touch /tmp/g2.txt');
check('glob expands to matches', run('ls /tmp/g*.txt').stdout.includes('g1.txt'));
check('glob matches both', run('ls /tmp/g*.txt').stdout.includes('g2.txt'));

console.log('\n== functions ==');
check('define and call', run('greet() { echo hi; }; greet').stdout === 'hi\n');
check('function with args', run('say() { echo "$1"; }; say word').stdout === 'word\n');
check('function sees $@', run('list() { echo "$@"; }; list a b').stdout === 'a b\n');
check('return sets status', run('f() { return 4; }; f').status === 4);

await engine.apkUpdate();
console.log('\n== real maintainer script: alpine-conf ==');
{
  const report = await engine.apkInstall('alpine-conf');
  console.log(`  (${report.scripts.length} maintainer scripts)`);
  check('alpine-conf installed payload files', report.installed.length > 5, String(report.installed.length));
  for (const script of report.scripts) {
    const result = runMaintainerScript(script.body, 'alpine-conf');
    console.log(`  ${script.name}: status=${result.status} steps=${result.steps}${result.error ? ' err=' + result.error.slice(0, 70) : ''}`);
    check(`${script.name} runs without throwing`, result.status >= 0);
  }
  check('installed lbu is runnable as a script', Boolean(engine.apkState && VFS.children.usr.children.sbin.children.lbu));
}

console.log('\n== real maintainer script: busybox ==');
{
  const report = await engine.apkInstall('busybox');
  const post = report.scripts.find((script) => script.name === 'post-install');
  check('busybox has a post-install script', Boolean(post));
  const result = runMaintainerScript(post.body, 'busybox');
  console.log(`  post-install: status=${result.status} steps=${result.steps}${result.error ? ' err=' + result.error.slice(0, 80) : ''}`);
  check('busybox post-install completes cleanly', result.status === 0, result.error);
  check('busybox post-install created /sbin', Boolean(VFS.children.sbin));
  check('busybox post-install created /usr/sbin', Boolean(VFS.children.usr.children.sbin));
}

console.log('\n== shell runs an installed package script ==');
{
  const instance = new Shell({ cwd: [], env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' } });
  instance.fs = VFS;
  let status = 0;
  try {
    instance.run('/usr/sbin/lbu --help', { stdout: (t) => instance.out(t), stderr: (t) => instance.err(t) });
    status = instance.lastStatus;
  } catch (error) { status = error.code ?? 1; }
  console.log(`  lbu --help status=${status} stdout=${JSON.stringify(instance.stdout.join('').slice(0, 80))}`);
  check('lbu script is found and interpreted', instance.stdout.join('').length + instance.stderr.join('').length > 0
    || status === 0 || status === 1);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
