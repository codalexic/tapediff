import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { exchangeSchema, parseTapeLine } from '../../src/tape/schema.js';

export const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/tapes/${name}.tape`, import.meta.url));
export const fixtureText = readFileSync(fixturePath('basic'), 'utf8');
export const header = parseTapeLine(fixtureText.split('\n')[0]!, 1);
export const exchange = exchangeSchema.parse(
  JSON.parse(fixtureText.split('\n')[1]!),
);
