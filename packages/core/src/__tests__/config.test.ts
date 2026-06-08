import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ConfigValidationError,
  readConfig,
  validateConfig,
  writeConfig,
} from '../config';
import type { FlowsaveConfig } from '../types';

describe('validateConfig', () => {
  const validRaw = {
    instanceUrl: 'http://localhost:5678',
    apiKey: 'n8n_api_test123',
  };

  it('accepts a minimal valid config', () => {
    const config = validateConfig(validRaw);
    expect(config.instanceUrl).toBe('http://localhost:5678');
    expect(config.apiKey).toBe('n8n_api_test123');
    expect(config.gitBranch).toBe('main'); // default
  });

  it('strips trailing slash from instanceUrl', () => {
    const config = validateConfig({ ...validRaw, instanceUrl: 'http://localhost:5678/' });
    expect(config.instanceUrl).toBe('http://localhost:5678');
  });

  it('throws if instanceUrl is missing', () => {
    expect(() => validateConfig({ apiKey: 'key' })).toThrow(ConfigValidationError);
  });

  it('throws if apiKey is missing', () => {
    expect(() => validateConfig({ instanceUrl: 'http://localhost:5678' })).toThrow(
      ConfigValidationError
    );
  });

  it('throws if instanceUrl is not a valid URL', () => {
    expect(() =>
      validateConfig({ ...validRaw, instanceUrl: 'not-a-url' })
    ).toThrow(ConfigValidationError);
  });

  it('throws if input is not an object', () => {
    expect(() => validateConfig('string')).toThrow(ConfigValidationError);
    expect(() => validateConfig(null)).toThrow(ConfigValidationError);
    expect(() => validateConfig(42)).toThrow(ConfigValidationError);
  });

  it('accepts optional fields when present', () => {
    const config = validateConfig({
      ...validRaw,
      containerName: 'n8n',
      gitRemote: 'git@github.com:user/repo.git',
      gitBranch: 'develop',
      dashboardToken: 'tok_123',
    });
    expect(config.containerName).toBe('n8n');
    expect(config.gitRemote).toBe('git@github.com:user/repo.git');
    expect(config.gitBranch).toBe('develop');
    expect(config.dashboardToken).toBe('tok_123');
  });

  it('throws if containerName is not a string', () => {
    expect(() => validateConfig({ ...validRaw, containerName: 123 })).toThrow(
      ConfigValidationError
    );
  });
});

describe('readConfig / writeConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'flowsave-config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const validConfig: FlowsaveConfig = {
    instanceUrl: 'http://localhost:5678',
    apiKey: 'n8n_api_test123',
    backupDir: '/tmp/flowsave-backups',
    gitBranch: 'main',
  };

  it('writes and reads back a config correctly', () => {
    const configPath = join(tmpDir, 'config.json');
    writeConfig(validConfig, configPath);
    const read = readConfig(configPath);
    expect(read.instanceUrl).toBe(validConfig.instanceUrl);
    expect(read.apiKey).toBe(validConfig.apiKey);
  });

  it('throws ConfigValidationError if file does not exist', () => {
    expect(() => readConfig(join(tmpDir, 'nonexistent.json'))).toThrow(
      ConfigValidationError
    );
  });

  it('throws ConfigValidationError if file contains invalid JSON', () => {
    const configPath = join(tmpDir, 'bad.json');
    writeFileSync(configPath, 'not json');
    expect(() => readConfig(configPath)).toThrow(ConfigValidationError);
  });
});
