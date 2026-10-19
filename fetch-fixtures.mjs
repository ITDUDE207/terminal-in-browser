// Download the real Alpine bytes the engine tests need.
//
// The packages are not committed because they are binaries. Run this once
// before the suites, or let the suites call it themselves when a file is
// missing. The versions are pinned so the expected checksums stay stable.
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(ROOT, 'fixtures');

const BASE = 'https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/x86_64';
export const FIXTURES = [
  { file: 'APKINDEX.tar.gz', url: `${BASE}/APKINDEX.tar.gz` },
  { file: 'busybox-1.37.0-r31.apk', url: `${BASE}/busybox-1.37.0-r31.apk` },
  { file: 'alpine-conf-3.22.0-r0.apk', url: `${BASE}/alpine-conf-3.22.0-r0.apk` }
];

/** Download every missing fixture. Returns the list of files now on disk. */
export async function ensureFixtures() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const ready = [];
  for (const fixture of FIXTURES) {
    const target = join(FIXTURE_DIR, fixture.file);
    if (!existsSync(target)) {
      process.stdout.write(`fetching ${fixture.file} ... `);
      const response = await fetch(fixture.url);
      if (!response.ok) throw new Error(`${fixture.url} returned HTTP ${response.status}`);
      writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      process.stdout.write('done\n');
    }
    ready.push(target);
  }
  return ready;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureFixtures();
  console.log(`fixtures ready in ${FIXTURE_DIR}`);
}
