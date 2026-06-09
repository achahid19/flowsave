/**
 * @flowsave/cli — Error handling utilities
 *
 * handleError() is the single funnel for all command-level errors.
 * Rules:
 *   - Never print raw stack traces to users
 *   - Always print a human-readable message
 *   - Always include an actionable hint when possible
 *   - Always exit with code 1
 */

import chalk from 'chalk';
import type { Ora } from 'ora';
import { ConfigValidationError } from '@flowsave/core';

/**
 * Classify an error and return a user-friendly message + optional hint.
 */
function classify(err: unknown): { message: string; hint?: string } {
  if (err instanceof ConfigValidationError) {
    return {
      message: err.message,
      hint: 'Run "flowsave config init" to set up or fix your configuration.',
    };
  }

  if (err instanceof Error) {
    const msg = err.message;

    // Network errors
    if (
      msg.includes('ECONNREFUSED') ||
      msg.includes('ENOTFOUND') ||
      msg.includes('ETIMEDOUT') ||
      msg.includes('fetch failed')
    ) {
      return {
        message: `Cannot reach n8n instance: ${msg}`,
        hint: 'Run "flowsave doctor" to diagnose connectivity issues.',
      };
    }

    return { message: msg };
  }

  return { message: String(err) };
}

/**
 * Handle a command error: stop spinner (if any), print message + hint, exit 1.
 *
 * @param err     - The caught error (any type)
 * @param spinner - Active ora spinner to stop, or undefined
 */
export function handleError(err: unknown, spinner?: Ora): never {
  const { message, hint } = classify(err);

  if (spinner) {
    spinner.fail(chalk.red(`✗ ${message}`));
  } else {
    console.error(chalk.red(`✗ ${message}`));
  }

  if (hint) {
    console.error(chalk.gray(`  ${hint}`));
  }

  process.exit(1);
}
