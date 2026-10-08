import { main, REGRESSED_PROMPT } from './agent.mjs';

// Intentional regression: the same tool loop, with one extra prompt instruction.
await main(REGRESSED_PROMPT);
