"""Intentional regression: only the system prompt changes."""

from agent import REGRESSED_PROMPT, main

if __name__ == "__main__":
    main(REGRESSED_PROMPT)
