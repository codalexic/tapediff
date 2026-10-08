import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import type { RunDiff } from '../diff/index.js';
import type { Op } from '../diff/align.js';
import { summary } from '../diff/render-text.js';
import { money, tokens, latency } from '../format.js';
import { terminalLine } from '../terminal.js';
import { fullStep, wordChanges, wrap } from './detail.js';
import { displayChanges } from '../diff/content-display.js';

interface Props {
  diff: RunDiff;
  columns?: number;
  rows?: number;
  color?: boolean;
}
const paints = {
  equal: undefined,
  added: 'green',
  removed: 'red',
  changed: 'yellow',
} as const;
const signs = { equal: ' ', added: '+', removed: '-', changed: '~' } as const;
const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));

export function DiffViewer({ diff, columns, rows, color = true }: Props) {
  const { stdout } = useStdout();
  const { exit } = useApp();
  const [size, setSize] = useState({
    columns: stdout.columns || 100,
    rows: stdout.rows || 24,
  });
  useEffect(() => {
    const resize = () =>
      setSize({ columns: stdout.columns || 100, rows: stdout.rows || 24 });
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);
  const width = Math.max(10, columns ?? size.columns);
  const height = Math.max(10, rows ?? size.rows);
  const narrow = width < 100;
  const pane = Math.floor((width - 3) / 2);
  const bodyHeight = height - 7;
  const page = Math.max(1, Math.floor(bodyHeight / (narrow ? 2 : 1)));
  const [selected, setSelected] = useState(0);
  const [filtered, setFiltered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const visible = diff.ops
    .map((op, index) => ({ op, index }))
    .filter(({ op }) => !filtered || op.type !== 'equal');
  const position = Math.max(
    0,
    visible.findIndex((row) => row.index === selected),
  );
  const active = visible[position];
  const op = active?.op;
  const detailRows = useMemo(() => {
    if (!expanded || !op) return [];
    const fullA = wrap(
      fullStep(op && 'a' in op ? op.a : undefined),
      narrow ? width - 3 : pane,
    );
    const fullB = wrap(
      fullStep(op && 'b' in op ? op.b : undefined),
      narrow ? width - 3 : pane,
    );
    const detailRows: { left: string; right?: string }[] = narrow
      ? [
          ...fullA.map((left) => ({ left: `a: ${left}` })),
          ...fullB.map((left) => ({ left: `b: ${left}` })),
        ]
      : Array.from(
          { length: Math.max(fullA.length, fullB.length) },
          (_, i) => ({
            left: fullA[i] ?? '',
            right: fullB[i] ?? '',
          }),
        );
    if (op?.type === 'changed')
      detailRows.push(
        ...wrap(
          `${displayChanges(op) === undefined ? 'Word' : 'JSON'} diff: ${wordChanges(op)}`,
          width,
        ).map((left) => ({
          left,
        })),
      );
    return detailRows;
  }, [expanded, op, narrow, width, pane]);
  const maxOffset = Math.max(0, detailRows.length - bodyHeight);
  const scroll = clamp(offset, maxOffset);
  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      exit();
      return;
    }
    if (input === '/' || input === 'd') {
      const nextFilter = !filtered;
      setFiltered(nextFilter);
      if (nextFilter && op?.type === 'equal') {
        const next = diff.ops.findIndex(
          (item, i) => i >= selected && item.type !== 'equal',
        );
        setSelected(
          next < 0
            ? Math.max(
                0,
                diff.ops.findIndex((item) => item.type !== 'equal'),
              )
            : next,
        );
      }
      setOffset(0);
      return;
    }
    if (!active) return;
    if (key.return) {
      setExpanded(!expanded);
      setOffset(0);
      return;
    }
    if (input === 'n' || input === 'N') {
      const differences = visible.filter((row) => row.op.type !== 'equal');
      const next =
        input === 'n'
          ? (differences.find((row) => row.index > active.index) ??
            differences[0])
          : ([...differences]
              .reverse()
              .find((row) => row.index < active.index) ?? differences.at(-1));
      if (next) setSelected(next.index);
      setOffset(0);
      return;
    }
    const movement =
      key.downArrow || input === 'j'
        ? 1
        : key.upArrow || input === 'k'
          ? -1
          : key.pageDown
            ? expanded
              ? bodyHeight
              : page
            : key.pageUp
              ? -(expanded ? bodyHeight : page)
              : 0;
    if (expanded)
      setOffset(
        input === 'g'
          ? 0
          : input === 'G'
            ? maxOffset
            : clamp(scroll + movement, maxOffset),
      );
    else {
      const next =
        input === 'g'
          ? 0
          : input === 'G'
            ? visible.length - 1
            : clamp(position + movement, visible.length - 1);
      setSelected(visible[next]!.index);
    }
  });
  const start = Math.max(
    0,
    Math.min(position - Math.floor(page / 2), visible.length - page),
  );
  const paint = (type: Op['type']) => (color ? paints[type] : undefined);
  const pair = (
    left: string,
    right: string,
    type: Op['type'],
    key: number,
    focus = false,
  ) => (
    <Box key={key} flexDirection={narrow ? 'column' : 'row'}>
      <Box width={narrow ? width : pane} flexShrink={0}>
        <Text color={paint(type)} bold={color && focus}>
          {terminalLine(left, narrow ? width : pane)}
        </Text>
      </Box>
      {!narrow && <Text dimColor={color}> │ </Text>}
      <Box width={narrow ? width : width - pane - 3} flexShrink={0}>
        <Text color={paint(type)} bold={focus}>
          {terminalLine(right, narrow ? width : width - pane - 3)}
        </Text>
      </Box>
    </Box>
  );
  const totals = (side: 'a' | 'b') => {
    const total = diff.totals[side];
    return `${side}: ${total.calls} calls · ${tokens(total.tokens)} tok · ${money(total.costUsd)} · ${latency(total.latencyMs)}`;
  };
  return (
    <Box flexDirection="column" width={width}>
      <Text bold={color}>
        {terminalLine(
          `tapediff · ${diff.identical ? 'identical behavior' : 'behavior differs'} · ${narrow ? 'stacked' : 'side by side'}`,
          width,
        )}
      </Text>
      <Text>
        {terminalLine(
          `a: ${diff.a.name ?? diff.a.path} → b: ${diff.b.name ?? diff.b.path}`,
          width,
        )}
      </Text>
      <Box flexDirection="column" height={bodyHeight}>
        {!active ? (
          <Text>{filtered ? 'No differences' : 'No steps'}</Text>
        ) : expanded ? (
          detailRows.slice(scroll, scroll + bodyHeight).map((row, i) =>
            row.right === undefined ? (
              <Text key={i} color={paint(op!.type)}>
                {row.left}
              </Text>
            ) : (
              pair(row.left, row.right, op!.type, i)
            ),
          )
        ) : (
          visible.slice(start, start + page).map(({ op: item, index }) => {
            const prefix = `${index === active.index ? '›' : ' '} ${index + 1} ${signs[item.type]} `;
            return pair(
              `${prefix}${narrow ? 'a: ' : ''}${'a' in item ? summary(item.a) : '(absent)'}`,
              `${prefix}${narrow ? 'b: ' : ''}${'b' in item ? summary(item.b) : '(absent)'}`,
              item.type,
              index,
              index === active.index,
            );
          })
        )}
      </Box>
      <Text>
        {terminalLine(
          `${active ? position + 1 : 0}/${visible.length} · ${filtered ? 'differences only' : 'all steps'}${expanded ? ` · expanded · lines ${scroll + 1}-${Math.min(scroll + bodyHeight, detailRows.length)}/${detailRows.length}` : ''}`,
          width,
        )}
      </Text>
      <Text dimColor>{terminalLine(totals('a'), width)}</Text>
      <Text dimColor>{terminalLine(totals('b'), width)}</Text>
      <Text dimColor>
        {terminalLine(
          `↑↓/jk ${expanded ? 'scroll' : 'move'} · PgUp/PgDn · g/G top/bottom · n/N diff`,
          width,
        )}
      </Text>
      <Text dimColor>
        {terminalLine(
          'Enter expand/collapse · / or d differences · q/Esc quit',
          width,
        )}
      </Text>
    </Box>
  );
}
