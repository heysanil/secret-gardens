#!/usr/bin/env bun
/**
 * safe CLI.
 * Placeholder — the real commands land in a later phase.
 */
export const CLI_VERSION = "0.0.1" as const;

if (import.meta.main) {
  console.log(`safe ${CLI_VERSION}`);
}
