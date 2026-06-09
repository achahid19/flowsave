/**
 * flowsave config init
 *
 * Interactive wizard that creates or overwrites ~/.flowsave/config.json.
 * Uses inquirer prompts — no API calls during setup.
 * Validates each field before writing.
 */

import { existsSync } from 'fs';
import inquirer from 'inquirer';
import chalk from 'chalk';
import type { Command } from 'commander';
import {
  readConfig,
  writeConfig,
  validateConfig,
  getConfigPath,
  getDefaultBackupDir,
  ConfigValidationError,
} from '@flowsave/core';

export function register(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage Flowsave configuration  (run "flowsave config --help" for subcommands)');

  // -------------------------------------------------------------------------
  // config show
  // -------------------------------------------------------------------------
  configCmd
    .command('show')
    .description('Print the current configuration (API key masked)')
    .action(() => {
      try {
        const config = readConfig();
        const masked = {
          ...config,
          apiKey: config.apiKey.slice(0, 8) + '••••••••' + config.apiKey.slice(-4),
        };
        console.log(chalk.bold('\nFlowsave Configuration'));
        console.log(chalk.gray('─'.repeat(40)));
        for (const [key, value] of Object.entries(masked)) {
          if (value !== undefined) {
            console.log(`  ${chalk.cyan(key.padEnd(16))} ${String(value)}`);
          }
        }
        console.log(chalk.gray(`\n  Config file: ${getConfigPath()}`));
      } catch (err) {
        const message = err instanceof ConfigValidationError
          ? err.message
          : 'No config found. Run "flowsave config init" to create one.';
        console.error(chalk.red(`✗ ${message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // config set
  // -------------------------------------------------------------------------
  configCmd
    .command('set <key> <value>')
    .description('Update a single config field (e.g. flowsave config set gitBranch dev)')
    .action((key: string, value: string) => {
      const allowed = ['instanceUrl', 'apiKey', 'containerName', 'backupDir', 'gitRemote', 'gitBranch', 'dashboardToken'];
      if (!allowed.includes(key)) {
        console.error(chalk.red(`✗ Unknown config key: "${key}"`));
        console.error(chalk.gray(`  Valid keys: ${allowed.join(', ')}`));
        process.exit(1);
      }
      try {
        const config = readConfig();
        const updated = validateConfig({ ...config, [key]: value || undefined });
        writeConfig(updated);
        console.log(chalk.green(`✓ ${key} updated`));
      } catch (err) {
        const message = err instanceof ConfigValidationError ? err.message : String(err);
        console.error(chalk.red(`✗ ${message}`));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // config init
  // -------------------------------------------------------------------------
  configCmd
    .command('init')
    .description('Create or update the Flowsave configuration interactively')
    .action(async () => {
      console.log(chalk.bold('\n🔧 Setting up Flowsave\n'));

      // If config already exists, ask before overwriting
      const configPath = getConfigPath();
      if (existsSync(configPath)) {
        const { overwrite } = await inquirer.prompt<{ overwrite: boolean }>([
          {
            type: 'confirm',
            name: 'overwrite',
            message: `Config already exists at ${configPath}. Overwrite?`,
            default: false,
          },
        ]);
        if (!overwrite) {
          console.log(chalk.gray('Aborted. Config unchanged.'));
          return;
        }
      }

      const answers = await inquirer.prompt<{
        instanceUrl: string;
        apiKey: string;
        containerName: string;
        backupDir: string;
        gitRemote: string;
        gitBranch: string;
      }>([
        {
          type: 'input',
          name: 'instanceUrl',
          message: 'n8n instance URL:',
          default: 'http://localhost:5678',
          validate: (input: string) => {
            try {
              new URL(input);
              return true;
            } catch {
              return 'Please enter a valid URL (e.g., http://localhost:5678)';
            }
          },
        },
        {
          type: 'password',
          name: 'apiKey',
          message: 'API key (from n8n Settings → API):',
          mask: '*',
          validate: (input: string) =>
            input.trim().length > 0 ? true : 'API key is required',
        },
        {
          type: 'input',
          name: 'containerName',
          message: 'Docker container name (leave blank to skip credential backup):',
        },
        {
          type: 'input',
          name: 'backupDir',
          message: 'Backup directory:',
          default: getDefaultBackupDir(),
        },
        {
          type: 'input',
          name: 'gitRemote',
          message: 'Git remote URL for automatic backups (optional, leave blank to skip):',
          default: '',
        },
        {
          type: 'input',
          name: 'gitBranch',
          message: 'Git branch:',
          default: 'main',
          when: (ans: { gitRemote: string }) => ans.gitRemote.trim().length > 0,
        },
      ]);

      // Build and validate the config object
      const raw = {
        instanceUrl: answers.instanceUrl.trim(),
        apiKey: answers.apiKey,
        ...(answers.containerName.trim() && { containerName: answers.containerName.trim() }),
        backupDir: answers.backupDir.trim() || getDefaultBackupDir(),
        ...(answers.gitRemote.trim() && { gitRemote: answers.gitRemote.trim() }),
        ...(answers.gitBranch && { gitBranch: answers.gitBranch.trim() }),
      };

      try {
        const config = validateConfig(raw);
        writeConfig(config);
        console.log(chalk.green(`\n✓ Config written to ${configPath}`));
        console.log(chalk.cyan("  Run 'flowsave backup' to take your first snapshot."));
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          console.error(chalk.red(`✗ Config validation failed: ${err.message}`));
        } else {
          console.error(chalk.red('✗ Failed to write config.'));
        }
        process.exit(1);
      }
    });
}
