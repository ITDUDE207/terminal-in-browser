// End-to-end test: load the real index.html in jsdom, drive the real router.
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const RAW_HTML = readFileSync('/workspace/project/terminal-in-browser/index.html', 'utf8');

// jsdom does not execute ES module scripts, so run the same code as a classic
// script. The only module-specific syntax is the dynamic import for WebLLM,
// which jsdom also lacks; it is replaced by a stub that reports no WebGPU.
const HTML = RAW_HTML
  .replace('<script type="module">', '<script>')
  .replace(
    "const webllm = await import(/* @vite-ignore */ WEBLLM_CDN);",
    "const webllm = await window.__stubWebllm();"
  );

const virtualConsole = new VirtualConsole();
const pageErrors = [];
virtualConsole.on('jsdomError', (error) => pageErrors.push(error.message));
virtualConsole.on('error', (message) => pageErrors.push(String(message)));

const dom = new JSDOM(HTML, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://localhost/index.html',
  virtualConsole
});

const { window } = dom;

// The page probes WebGPU at boot. Report it as missing, like a headless browser.
Object.defineProperty(window.navigator, 'gpu', { value: undefined, configurable: true });
window.__stubWebllm = async () => { throw new Error('WebGPU is unavailable in this test'); };

// Serve real package bytes instead of the network, and record requested urls.
const requested = [];
window.fetch = async (url) => {
  const name = String(url).split('/').pop().split('?')[0];
  requested.push(name);
  const map = {
    'APKINDEX.tar.gz': '/tmp/apkwork/APKINDEX.tar.gz',
    'busybox-1.37.0-r31.apk': '/tmp/apkwork/busybox.apk',
    'alpine-conf-3.22.0-r0.apk': '/tmp/apkwork/conf.apk'
  };
  const path = map[name];
  if (!path || !existsSync(path)) return { ok: false, status: 404 };
  const bytes = readFileSync(path);
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  };
};

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label} ${detail}`); }
}

await new Promise((resolve) => window.addEventListener('load', resolve));
await new Promise((resolve) => setTimeout(resolve, 300));

const outputText = () => window.document.getElementById('output').textContent;
const lastOutput = () => {
  const lines = [...window.document.querySelectorAll('#output .line, #output .block')];
  return lines.map((line) => line.textContent);
};

/** Type a command and wait for the router to settle. */
async function run(command) {
  const before = window.document.querySelectorAll('#output > *').length;
  const input = window.document.getElementById('prompt');
  input.value = command;
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = [...window.document.querySelectorAll('#output > *')];
  return after.slice(before).map((node) => node.textContent);
}

console.log('\n== boot ==');
check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));
check('banner rendered', outputText().includes('Welcome to Ubuntu 26.04 LTS'));
check('webgpu notice shown', outputText().includes('WebGPU'));

console.log('\n== native bash still works ==');
let lines = await run('mkdir projects');
check('mkdir created the directory', window.ubuntuSim.vfs().children.projects !== undefined);
lines = await run('ls');
check('ls lists the new directory', lines.join(' ').includes('projects'));
lines = await run('mkdir -p a/b/c');
check('mkdir -p creates parents', Boolean(window.ubuntuSim.vfs().children.a?.children.b?.children.c));
lines = await run('touch projects/file.txt');
check('touch created a file', Boolean(window.ubuntuSim.vfs().children.projects.children['file.txt']));
lines = await run('rm nonexistent');
check('rm reports a missing target', lines.join(' ').includes('No such file'));
lines = await run('rm');
check('rm reports missing operand', lines.join(' ').includes('missing operand'));

console.log('\n== sh interpreter ==');
lines = await run('sh -c "for i in 1 2 3; do echo n=$i; done"');
check('for loop runs', lines.join(' ').includes('n=3'), lines.join(' | '));
lines = await run('sh -c "echo hello | tr a-z A-Z"');
check('pipeline runs', lines.join(' ').includes('HELLO'), lines.join(' | '));

console.log('\n== apk help and status ==');
lines = await run('apk help');
check('apk help lists subcommands', lines.join(' ').includes('apk update'));
check('apk help mentions verification', lines.join(' ').includes('signature'));
lines = await run('apk status');
check('apk status shows no index yet', lines.join(' ').includes('not downloaded yet'), lines.join(' | '));

console.log('\n== apk update with signature verification ==');
lines = await run('apk update');
const updateText = lines.join('\n');
console.log(updateText.split('\n').map((l) => '    ' + l).join('\n'));
check('index downloaded and verified', updateText.includes('signature ok'), updateText);
check('signature checked against a pinned key', /signed by|6165ee59|61666e3f/.test(updateText));
check('package count reported', /\d+ packages/.test(updateText));

console.log('\n== apk search and info ==');
lines = await run('apk search alpine-conf');
check('search finds alpine-conf', lines.join(' ').includes('alpine-conf'));
lines = await run('apk info busybox');
check('info shows the version', lines.join(' ').includes('1.37.0-r31'), lines.join(' | '));
check('info shows the checksum', lines.join(' ').includes('Q1'));
check('info shows depends', lines.join(' ').includes('depends'));

console.log('\n== apk add: real package into the VFS ==');
lines = await run('apk add alpine-conf');
const addText = lines.join('\n');
console.log(addText.split('\n').map((l) => '    ' + l).join('\n'));
check('signature verified', addText.includes('signature'));
check('package reported installed', addText.includes('installed'));
check('payload landed in the VFS', Boolean(window.ubuntuSim.vfs().children.usr?.children.sbin?.children.lbu), JSON.stringify(Object.keys(window.ubuntuSim.vfs().children)));
check('installed file is a shell script', String(window.ubuntuSim.vfs().children.usr.children.sbin.children.lbu.content).startsWith('#!'));

console.log('\n== run an installed package script ==');
lines = await run('run /usr/sbin/lbu --help');
const runText = lines.join('\n');
console.log(runText.split('\n').slice(0, 6).map((l) => '    ' + l).join('\n'));
check('script ran through the interpreter', /exit \d+ in \d+ ms/.test(runText), runText);

console.log('\n== tamper detection ==');
{
  const realFetch = window.fetch;
  window.fetch = async (url) => {
    const response = await realFetch(url);
    if (!String(url).includes('.apk')) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    bytes[4000] ^= 0xff;
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer };
  };
  lines = await run('apk add alpine-conf');
  const tamperText = lines.join('\n');
  check('corrupted package is refused', /signature|checksum|deflate|invalid/i.test(tamperText), tamperText.slice(0, 300));
  window.fetch = realFetch;
}

console.log('\n== apk list and del ==');
lines = await run('apk list');
check('list shows the installed package', lines.join(' ').includes('alpine-conf'));
lines = await run('apk del alpine-conf');
check('del removes it from the database', lines.join(' ').includes('removed'));

console.log('\n== router boundaries ==');
lines = await run('clear');
check('clear wipes the screen', window.document.getElementById('output').textContent.length < 40);
lines = await run('ls -la');
check('shell is usable after clear', lines.length > 0);

console.log('\n== command chaining ==');
{
  const sim = window.ubuntuSim;
  lines = await run('mkdir chain && cd chain && touch note.txt && ls -l');
  check('&& runs every segment', lines.join(' ').includes('note.txt'), lines.join(' | '));
  check('cd moved the prompt', lines.join(' ').includes('~/chain'), lines.join(' | '));
  check('the file exists on disk', Boolean(sim.vfs().children.chain?.children['note.txt']));
  await run('cd ~');

  lines = await run('mkdir c1; mkdir c2; ls');
  check('; runs every segment', lines.join(' ').includes('c1') && lines.join(' ').includes('c2'), lines.join(' | '));

  lines = await run('ls missing || echo fallback');
  check('|| runs after a failure', lines.join(' ').includes('fallback'), lines.join(' | '));

  lines = await run('mkdir dup && mkdir dup && echo never');
  check('&& stops after a failure', !lines.join(' ').includes('never'), lines.join(' | '));

  lines = await run('echo "a && b"');
  check('quoted operators are not split', lines.join(' ').includes('a && b'), lines.join(' | '));
  await run('rm -r c1 c2 chain');
}

console.log('\n== route B: plain English through the AI engine ==');
{
  // Stub WebLLM with a deterministic model that returns the JSON the real
  // prompt asks for, so the whole Route B path can be exercised headlessly.
  const prompts = [];
  window.__stubWebllm = async () => ({
    version: 'stub',
    CreateMLCEngine: async () => ({
      chat: {
        completions: {
          create: async ({ messages, temperature }) => {
            prompts.push({ messages, temperature });
            const request = messages[1].content.split('User request: ').pop().split('\n')[0];
            const map = {
              'make a folder called invoices': { bash: 'mkdir', argument: 'invoices' },
              'list everything in this directory': { bash: 'ls', argument: '.' },
              'create an empty file named budget.txt': { bash: 'touch', argument: 'budget.txt' },
              'delete the folder called invoices': { bash: 'rm', argument: 'invoices', recursive: true },
              'install the alpine-conf package': { bash: 'apk', arguments: ['add', 'alpine-conf'] },
              'tell me a joke': { reply: 'I only speak commands.' }
            };
            const answer = map[request] ?? { reply: 'no match' };
            return { choices: [{ message: { content: JSON.stringify(answer) } }] };
          }
        }
      }
    })
  });
  // `ai on` re-probes the GPU, so report a working adapter from here on.
  Object.defineProperty(window.navigator, 'gpu', {
    value: { requestAdapter: async () => ({ name: 'stub-adapter' }) },
    configurable: true
  });

  lines = await run('ai on');
  check('ai on succeeds with a stub engine', lines.join(' ').includes('enabled'), lines.join(' | '));

  lines = await run('make a folder called invoices');
  const nlText = lines.join('\n');
  console.log(nlText.split('\n').map((l) => '    ' + l).join('\n'));
  check('intent log is printed', nlText.includes('Compiling natural language intent'));
  check('temperature is forced to 0.0', prompts.every((p) => p.temperature === 0.0));
  check('vfs state was sent to the model', prompts[0].messages[1].content.includes('File system state'));
  check('model output was applied to the vfs', Boolean(window.ubuntuSim.vfs().children.invoices), JSON.stringify(Object.keys(window.ubuntuSim.vfs().children)));

  lines = await run('create an empty file named budget.txt');
  check('second intent also applied', Boolean(window.ubuntuSim.vfs().children['budget.txt']));

  lines = await run('delete the folder called invoices');
  check('rm intent removed the folder', window.ubuntuSim.vfs().children.invoices === undefined);

  lines = await run('install the alpine-conf package');
  check('apk intent installed a real package', Boolean(window.ubuntuSim.vfs().children.usr?.children.sbin?.children.lbu), lines.join(' | '));

  lines = await run('tell me a joke');
  check('a non-command intent falls back to a reply', lines.join(' ').includes('I only speak commands.'));

  lines = await run('list everything in this directory');
  check('ls intent lists the directory', lines.join(' ').includes('budget.txt'));
}

console.log('\n== focus returns to the prompt ==');
check('prompt has focus', window.document.activeElement === window.document.getElementById('prompt'),
  String(window.document.activeElement?.id));

console.log('\n== requested urls ==');
console.log('  ' + [...new Set(requested)].join('\n  '));

console.log(`\n${passed} passed, ${failed} failed`);
if (pageErrors.length) console.log('page errors:', pageErrors);
process.exit(failed === 0 ? 0 : 1);
