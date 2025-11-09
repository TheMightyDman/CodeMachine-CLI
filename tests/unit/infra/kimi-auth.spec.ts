import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const promptsMock = vi.fn();
const execaMock = vi.fn();

vi.mock('prompts', () => ({
  default: promptsMock,
}));

vi.mock('execa', () => ({
  execa: execaMock,
}));

let kimiAuth: typeof import('../../../src/infra/engines/providers/kimi/auth.js');

describe('Kimi auth module', () => {
  const originalEnv = { ...process.env };
  const originalStdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  const originalStdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const originalTmpdir = process.env.TMPDIR;
  const tmpRoot = path.join(process.cwd(), '.tmp-tests', 'kimi-auth');
  const overrideAuthFile = path.join(tmpRoot, 'override', 'codemachine', 'kimi', 'auth.env');
  const legacyTmpPath = path.join(tmpRoot, 'codemachine', 'kimi', 'auth.env');
  const projectRoot = path.join(tmpRoot, 'project-root');

  beforeAll(async () => {
    await mkdir(tmpRoot, { recursive: true });
    process.env.TMPDIR = tmpRoot;
    process.env.CODEMACHINE_KIMI_AUTH_FILE = overrideAuthFile;
    process.env.CODEMACHINE_PROJECT_ROOT = projectRoot;
    kimiAuth = await import('../../../src/infra/engines/providers/kimi/auth.js');
  });

  afterAll(async () => {
    if (originalTmpdir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = originalTmpdir;
    }
    if (originalStdoutTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalStdoutTTY);
    }
    if (originalStdinTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalStdinTTY);
    }
    delete process.env.CODEMACHINE_PROJECT_ROOT;
    await rm(path.join(process.cwd(), '.tmp-tests'), { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.TMPDIR = tmpRoot;
    process.env.CODEMACHINE_KIMI_AUTH_FILE = overrideAuthFile;
    process.env.CODEMACHINE_PROJECT_ROOT = projectRoot;
    execaMock.mockResolvedValue({ exitCode: 0 });
    promptsMock.mockReset();
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });

  afterEach(async () => {
    await kimiAuth.clearAuth();
  });

  const overrideEnvPath = overrideAuthFile;

  it('succeeds immediately when env key is already present', async () => {
    process.env.KIMI_API_KEY = 'sk-existing';

    await expect(kimiAuth.ensureAuth()).resolves.toBe(true);
    expect(promptsMock).not.toHaveBeenCalled();
    const contents = await readFile(overrideEnvPath, 'utf8');
    expect(contents).toContain('KIMI_API_KEY=sk-existing');
  });

  it('prompts and caches the key when interactive', async () => {
    promptsMock.mockResolvedValueOnce({ apiKey: 'sk-interactive' });

    await expect(kimiAuth.ensureAuth()).resolves.toBe(true);
    expect(process.env.KIMI_API_KEY).toBe('sk-interactive');
    const tmpStat = await stat(overrideEnvPath);
    expect(tmpStat.isFile()).toBe(true);
    const contents = await readFile(overrideEnvPath, 'utf8');
    expect(contents).toContain('KIMI_API_KEY=sk-interactive');
  });

  it('throws when non-interactive and no key is available', async () => {
    process.env.CI = '1';

    await expect(kimiAuth.ensureAuth()).rejects.toThrow(/KIMI_API_KEY is required/i);
    expect(promptsMock).not.toHaveBeenCalled();
  });

  it('loads key from cached tmp store without prompting', async () => {
    await mkdir(path.dirname(overrideEnvPath), { recursive: true });
    await writeFile(overrideEnvPath, 'KIMI_API_KEY=sk-from-cache\n');

    await expect(kimiAuth.ensureAuth()).resolves.toBe(true);
    expect(process.env.KIMI_API_KEY).toBe('sk-from-cache');
    expect(promptsMock).not.toHaveBeenCalled();
  });

  it('clearAuth removes cached tmp key', async () => {
    await mkdir(path.dirname(overrideEnvPath), { recursive: true });
    await writeFile(overrideEnvPath, 'KIMI_API_KEY=sk-delete\n');
    await mkdir(path.dirname(legacyTmpPath), { recursive: true });
    await writeFile(legacyTmpPath, 'KIMI_API_KEY=sk-legacy\n');

    await kimiAuth.clearAuth();
    await expect(stat(overrideEnvPath)).rejects.toThrow();
    await expect(stat(legacyTmpPath)).rejects.toThrow();
  });

  it('isAuthenticated detects cached key without mutating env', async () => {
    await mkdir(path.dirname(overrideEnvPath), { recursive: true });
    await writeFile(overrideEnvPath, 'KIMI_API_KEY=sk-hydrate\n');

    await expect(kimiAuth.isAuthenticated()).resolves.toBe(true);
    expect(process.env.KIMI_API_KEY).toBeUndefined();
  });

  it('nextAuthMenuAction reports logout when cached key exists without hydrating env', async () => {
    await mkdir(path.dirname(overrideEnvPath), { recursive: true });
    await writeFile(overrideEnvPath, 'KIMI_API_KEY=sk-menu\n');

    await expect(kimiAuth.nextAuthMenuAction()).resolves.toBe('logout');
    expect(process.env.KIMI_API_KEY).toBeUndefined();
  });

  it('migrates legacy tmp key into project auth file when override is unset', async () => {
    delete process.env.CODEMACHINE_KIMI_AUTH_FILE;
    await kimiAuth.clearAuth();
    await mkdir(path.dirname(legacyTmpPath), { recursive: true });
    await writeFile(legacyTmpPath, 'KIMI_API_KEY=sk-migrate\n');

    await expect(kimiAuth.ensureAuth()).resolves.toBe(true);
    expect(process.env.KIMI_API_KEY).toBe('sk-migrate');

    const projectAuthPath = path.join(projectRoot, '.codemachine', 'kimi', 'auth.env');
    const projectContents = await readFile(projectAuthPath, 'utf8');
    expect(projectContents).toContain('KIMI_API_KEY=sk-migrate');
  });
});
