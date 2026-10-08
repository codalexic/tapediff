import pc from 'picocolors';

export interface LoggerOptions {
  verbose?: boolean;
  color?: boolean;
}

export function createLogger({
  verbose = false,
  color = true,
}: LoggerOptions = {}) {
  const colors = pc.createColors(
    color &&
      process.stderr.isTTY === true &&
      process.env.NO_COLOR === undefined,
  );
  const write = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };

  return {
    info(message: string): void {
      write(message);
    },
    warn(message: string): void {
      write(colors.yellow(message));
    },
    error(message: string): void {
      write(colors.red(message));
    },
    debug(message: string): void {
      if (verbose) write(colors.dim(message));
    },
  };
}
