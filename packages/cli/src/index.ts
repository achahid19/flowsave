#!/usr/bin/env node
/**
 * @flowsave/cli — Entry point
 *
 * Registers all commands and delegates to commander for argument parsing.
 * Zero business logic lives here — everything is in commands/ and @flowsave/core.
 */

import { Command } from 'commander';
import { register as registerBackup } from './commands/backup';
import { register as registerRestore } from './commands/restore';
import { register as registerMigrate } from './commands/migrate';
import { register as registerDiff } from './commands/diff';
import { register as registerPush } from './commands/push';
import { register as registerList } from './commands/list';
import { register as registerConfig } from './commands/config';
import { register as registerDoctor } from './commands/doctor';
import { register as registerDelete } from './commands/delete';
import { register as registerPrune } from './commands/prune';
import { register as registerShow } from './commands/show';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

const program = new Command();

program
  .name('flowsave')
  .description('Backup, restore, and migrate your n8n instance')
  .version(version, '-v, --version', 'Output the current version');

registerBackup(program);
registerRestore(program);
registerMigrate(program);
registerDiff(program);
registerPush(program);
registerList(program);
registerConfig(program);
registerDoctor(program);
registerDelete(program);
registerPrune(program);
registerShow(program);

program.addHelpText('after', `
Run 'flowsave <command> --help' for detailed options and flags.`);

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
});
