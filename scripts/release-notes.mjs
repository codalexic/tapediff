import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const manifest = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);
assert.equal(
  process.env.GITHUB_REF_NAME,
  `v${manifest.version}`,
  'Release tag must match package.json',
);
const changelog = await readFile(
  new URL('../CHANGELOG.md', import.meta.url),
  'utf8',
);
const section = changelog
  .split(/^## /m)
  .find((part) => part.startsWith(`[${manifest.version}] - `));
assert.ok(section, 'Missing version in CHANGELOG.md');
const notes = section.split('\n').slice(1).join('\n').split(/^\[\d/m)[0].trim();
assert.ok(notes, 'Empty release notes');
await writeFile('release-notes.md', notes + '\n');
