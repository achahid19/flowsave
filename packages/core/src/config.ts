/**
 * @flowsave/core — Config read/write
 *
 * Manages ~/.flowsave/config.json using the schema defined in spec Section 7.
 * Never read or write config fields outside this module.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { FlowsaveConfig } from './types';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The root Flowsave data directory: ~/.flowsave */
export function getFlowsaveHome(): string {
  return join(homedir(), '.flowsave');
}

/** Absolute path to the config file: ~/.flowsave/config.json */
export function getConfigPath(): string {
  return join(getFlowsaveHome(), 'config.json');
}

/** Absolute path to the local snapshot registry: ~/.flowsave/index.json */
export function getIndexPath(): string {
  return join(getFlowsaveHome(), 'index.json');
}

/** Default backup directory: ~/.flowsave/backups */
export function getDefaultBackupDir(): string {
  return join(getFlowsaveHome(), 'backups');
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validate a config object. Throws ConfigValidationError if invalid.
 * Does NOT mutate the object — returns a new validated + normalized copy.
 */
export function validateConfig(raw: unknown): FlowsaveConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigValidationError('Config must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  // Required fields
  if (typeof obj['instanceUrl'] !== 'string' || obj['instanceUrl'].trim() === '') {
    throw new ConfigValidationError('instanceUrl is required and must be a non-empty string');
  }
  if (typeof obj['apiKey'] !== 'string' || obj['apiKey'].trim() === '') {
    throw new ConfigValidationError('apiKey is required and must be a non-empty string');
  }

  // Validate instanceUrl is a valid URL
  try {
    new URL(obj['instanceUrl'] as string);
  } catch {
    throw new ConfigValidationError(
      `instanceUrl is not a valid URL: "${obj['instanceUrl']}"`
    );
  }

  // Optional fields — type-check only if present
  if (obj['containerName'] !== undefined && typeof obj['containerName'] !== 'string') {
    throw new ConfigValidationError('containerName must be a string');
  }
  if (obj['backupDir'] !== undefined && typeof obj['backupDir'] !== 'string') {
    throw new ConfigValidationError('backupDir must be a string');
  }
  if (obj['gitRemote'] !== undefined && typeof obj['gitRemote'] !== 'string') {
    throw new ConfigValidationError('gitRemote must be a string');
  }
  if (obj['gitBranch'] !== undefined && typeof obj['gitBranch'] !== 'string') {
    throw new ConfigValidationError('gitBranch must be a string');
  }
  if (obj['dashboardToken'] !== undefined && typeof obj['dashboardToken'] !== 'string') {
    throw new ConfigValidationError('dashboardToken must be a string');
  }

  // Normalize: resolve backupDir, expand ~, apply defaults
  const backupDir = obj['backupDir']
    ? resolve(expandHome(obj['backupDir'] as string))
    : getDefaultBackupDir();

  return {
    instanceUrl: (obj['instanceUrl'] as string).trim().replace(/\/$/, ''), // strip trailing slash
    apiKey: obj['apiKey'] as string,
    ...(obj['containerName'] !== undefined && { containerName: obj['containerName'] as string }),
    backupDir,
    ...(obj['gitRemote'] !== undefined && { gitRemote: obj['gitRemote'] as string }),
    gitBranch: typeof obj['gitBranch'] === 'string' ? obj['gitBranch'] : 'main',
    ...(obj['dashboardToken'] !== undefined && { dashboardToken: obj['dashboardToken'] as string }),
  };
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

/**
 * Read and validate the config file.
 * Throws if the file doesn't exist or is invalid.
 */
export function readConfig(configPath = getConfigPath()): FlowsaveConfig {
  if (!existsSync(configPath)) {
    throw new ConfigValidationError(
      `Config file not found at ${configPath}. Run "flowsave config init" to create one.`
    );
  }

  let raw: unknown;
  try {
    const content = readFileSync(configPath, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`Failed to parse config file: ${message}`);
  }

  return validateConfig(raw);
}

/**
 * Write a validated config to disk.
 * Creates ~/.flowsave/ if it doesn't exist.
 */
export function writeConfig(config: FlowsaveConfig, configPath = getConfigPath()): void {
  const dir = join(configPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}
