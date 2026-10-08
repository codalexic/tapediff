import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Small portable glob subset: *, ?, character classes and ** directory segments. */
function globRegex(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') {
        source += '(?:.*/)?';
        index++;
      } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1);
      if (end < 0) throw new Error('invalid tape glob');
      const contents = pattern.slice(index + 1, end).replace(/^!/, '^');
      source += `[${contents}]`;
      index = end;
    } else source += char.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
  }
  return new RegExp(`${source}$`, process.platform === 'win32' ? 'i' : '');
}

async function walk(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    // Do not follow directory symlinks (cycles or trees outside the selected root).
    if (entry.isDirectory()) found.push(...(await walk(file)));
    else if (entry.isFile() && entry.name.endsWith('.tape')) found.push(file);
  }
  return found;
}

export async function findTapes(input: string): Promise<string[]> {
  const absolute = path.resolve(input);
  try {
    const info = await stat(absolute);
    if (info.isDirectory()) return (await walk(absolute)).sort();
    if (info.isFile()) return absolute.endsWith('.tape') ? [absolute] : [];
  } catch (error) {
    if (!(
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT'
    )) {
      // Windows may reject wildcard paths before stat can return ENOENT.
      if (!/[*?[]/.test(input))
        throw new Error('cannot find tapes', { cause: error });
    }
  }
  const normalized = input.split(path.sep).join('/');
  const wildcard = normalized.search(/[*?[]/);
  if (wildcard < 0) return [];
  const separator = normalized.lastIndexOf('/', wildcard);
  const base = path.resolve(normalized.slice(0, separator + 1) || '.');
  let matcher: RegExp;
  try {
    matcher = globRegex(normalized.slice(separator + 1));
  } catch {
    throw new Error('invalid tape glob');
  }
  try {
    return (await walk(base))
      .filter((file) =>
        matcher.test(path.relative(base, file).split(path.sep).join('/')),
      )
      .sort();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return [];
    throw new Error('cannot find tapes', { cause: error });
  }
}
