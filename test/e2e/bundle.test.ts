import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { run } from '../helpers/cli.js';

const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
it('keeps React/Ink outside the CLI static import graph and starts --version', async () => {
  const visited = new Set<string>();
  const visit = async (name: string): Promise<void> => {
    if (visited.has(name)) return;
    visited.add(name);
    const source = await readFile(path.join(dist, name), 'utf8');
    expect(source).not.toMatch(/react|from ["']ink["']/);
    const ast = ts.createSourceFile(
      name,
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.JS,
    );
    for (const statement of ast.statements) {
      if (
        !ts.isImportDeclaration(statement) &&
        !ts.isExportDeclaration(statement)
      )
        continue;
      const specifier = statement.moduleSpecifier;
      if (
        specifier &&
        ts.isStringLiteral(specifier) &&
        specifier.text.startsWith('./')
      )
        await visit(specifier.text);
    }
  };
  await visit('cli.js');
  const files = await readdir(dist);
  const lazy = await Promise.all(
    files
      .filter(
        (name) =>
          name.endsWith('.js') &&
          !visited.has(name) &&
          !visited.has(`./${name}`),
      )
      .map(async (name) => readFile(path.join(dist, name), 'utf8')),
  );
  expect(lazy.some((source) => source.includes('react'))).toBe(true);
  const version = await run(['--version'], { NODE_DEBUG: 'esm' });
  expect(version.code).toBe(0);
  expect(version.stdout.trim()).toBe('0.1.0');
  expect(version.stderr).not.toMatch(
    /node_modules[\\/]react[\\/]|node_modules[\\/]ink[\\/]/,
  );
});
