import { build } from 'tsup';

export default async function setup(): Promise<void> {
  await build({ config: 'tsup.config.ts' });
}
