import { render } from 'ink';
import type { RunDiff } from '../diff/index.js';
import { DiffViewer } from './view.js';

export async function showDiff(diff: RunDiff, color: boolean): Promise<void> {
  const app = render(<DiffViewer diff={diff} color={color} />, {
    patchConsole: false,
  });
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
    app.cleanup();
  }
}
