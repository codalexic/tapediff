import pc from 'picocolors';
import { terminalLine } from './terminal.js';

export const money = (value: number | null): string =>
  value === null ? 'cost unknown' : moneyDelta(value);
export const count = (value: number): string => value.toLocaleString('en-US');
/** Keep real sub-cent costs visible, even below fixed decimal precision. */
export function moneyDelta(value: number): string {
  if (value === 0) return '$0';
  const magnitude = Math.abs(value);
  const digits = Math.max(4, -Math.floor(Math.log10(magnitude)));
  return `${value < 0 ? '-' : ''}$${digits > 20 ? magnitude.toExponential(2) : magnitude.toFixed(digits)}`;
}
export const tokens = (value: number): string =>
  Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(1)}k` : count(value);

export function latency(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  const value = Math.abs(ms);
  if (value < 1000) return `${sign}${Math.round(value)}ms`;
  if (value < 60_000) return `${sign}${(value / 1000).toFixed(1)}s`;
  const seconds = Math.round(value / 1000);
  return `${sign}${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function useColor(
  enabled = true,
  isTTY = Boolean(process.stdout.isTTY),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    enabled &&
    env.NO_COLOR === undefined &&
    (isTTY || (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0'))
  );
}

/** Sanitize/truncate before adding our own ANSI sequences. */
export function textFormatter(columns = 100, color = false) {
  const width = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : 100;
  const colors = pc.createColors(color);
  return {
    colors,
    line: (text: string, paint = colors.white): string =>
      paint(terminalLine(text, width)),
  };
}
