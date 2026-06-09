/**
 * @flowsave/cli — Config guard
 *
 * loadConfigOrExit() is called at the top of every command that needs the
 * Flowsave config. It wraps readConfig() and converts any ConfigValidationError
 * into a human-readable terminal message + process.exit(1).
 */

import chalk from 'chalk';
import { readConfig, ConfigValidationError } from '@flowsave/core';
import type { FlowsaveConfig } from '@flowsave/core';

/**
 * Read and validate ~/.flowsave/config.json.
 * On any error: print a human-readable message and exit with code 1.
 */
export function loadConfigOrExit(): FlowsaveConfig {
  try {
    return readConfig();
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      console.error(chalk.red(`✗ ${err.message}`));
    } else {
      console.error(chalk.red('✗ Failed to load config. Run "flowsave config init" to set up.'));
    }
    process.exit(1);
  }
}
