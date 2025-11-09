import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

import { execa, execaSync } from 'execa';

import { metadata } from './metadata.js';

const TMP_NAMESPACE = ['codemachine', 'kimi'];
const AUTH_FILE_NAME = 'auth.env';
const PROJECT_ROOT_ENV = 'CODEMACHINE_PROJECT_ROOT';

type AuthSource = 'override' | 'project' | 'tmp';

interface AuthKeyInfo {
  key: string;
  source: AuthSource;
  path: string;
}

export interface KimiAuthDiagnostics {
  isWindows: boolean;
  cliInstalled: boolean;
  inlineKey: boolean;
  projectRoot: string;
  overridePath?: string;
  projectPath: string;
  legacyTmpPath: string;
  primaryAuthPath: string;
  sources: Array<{ source: AuthSource; path: string; hasKey: boolean; exists: boolean; mode?: string }>;
}

function isWindows(): boolean {
  return process.platform === 'win32';
}

function hasInlineKey(): boolean {
  return typeof process.env.KIMI_API_KEY === 'string' && process.env.KIMI_API_KEY.trim().length > 0;
}

function setInlineKey(value: string): void {
  process.env.KIMI_API_KEY = value.trim();
}

function isCiOrNonInteractive(): boolean {
  return process.env.CI === '1' || process.env.CODEMACHINE_NONINTERACTIVE === '1';
}

function isInteractiveShell(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !isCiOrNonInteractive());
}

function getTmpEnvPath(): string {
  return path.join(tmpdir(), ...TMP_NAMESPACE, AUTH_FILE_NAME);
}

function getOverrideAuthPath(): string | null {
  const override = process.env.CODEMACHINE_KIMI_AUTH_FILE?.trim();
  if (!override) return null;
  return path.resolve(override);
}

function resolveProjectRoot(): string {
  const explicit = process.env[PROJECT_ROOT_ENV]?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }

  const start = path.resolve(process.cwd());
  let current = start;

  while (true) {
    if (existsSync(path.join(current, '.codemachine'))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  try {
    const result = execaSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: start,
      reject: false,
    });
    const gitRoot = result?.stdout?.trim();
    if (result?.exitCode === 0 && gitRoot) {
      return path.resolve(gitRoot);
    }
  } catch {
    // ignore git lookup failures
  }

  return start;
}

function getProjectAuthPath(): string {
  return path.join(resolveProjectRoot(), '.codemachine', 'kimi', AUTH_FILE_NAME);
}

function getAuthEnvPath(): string {
  const override = getOverrideAuthPath();
  if (override) return override;
  return getProjectAuthPath();
}

function getAuthSources(): Array<{ source: AuthSource; path: string }> {
  const sources: Array<{ source: AuthSource; path: string }> = [];
  const seen = new Set<string>();

  const overridePath = getOverrideAuthPath();
  if (overridePath) {
    sources.push({ source: 'override', path: overridePath });
    seen.add(overridePath);
  }

  const projectPath = getProjectAuthPath();
  if (!seen.has(projectPath)) {
    sources.push({ source: 'project', path: projectPath });
    seen.add(projectPath);
  }

  const tmpPath = getTmpEnvPath();
  if (!seen.has(tmpPath)) {
    sources.push({ source: 'tmp', path: tmpPath });
    seen.add(tmpPath);
  }

  return sources;
}

async function readKeyFromPath(filePath: string): Promise<string | null> {
  try {
    const data = await readFile(filePath, 'utf8');
    const line = data
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('KIMI_API_KEY='));
    if (!line) {
      return null;
    }
    const value = line.replace('KIMI_API_KEY=', '').trim();
    return value || null;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readAuthKeyInfo(): Promise<AuthKeyInfo | null> {
  for (const candidate of getAuthSources()) {
    const key = await readKeyFromPath(candidate.path).catch(() => null);
    if (key) {
      return { key, source: candidate.source, path: candidate.path };
    }
  }
  return null;
}

async function persistInlineKeyIfMissing(key: string): Promise<void> {
  const existing = await readKeyFromPath(getAuthEnvPath()).catch(() => null);
  if (!existing) {
    await saveKey(key);
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(`[DEBUG] Kimi auth: persisted inline key to ${getAuthEnvPath()}`);
    }
  }
}

function shouldPersistToProject(): boolean {
  const overridePath = getOverrideAuthPath();
  const projectPath = getProjectAuthPath();
  return !overridePath || overridePath === projectPath;
}

async function persistProjectKeyIfMissing(key: string): Promise<void> {
  if (!shouldPersistToProject()) {
    return;
  }
  const projectPath = getProjectAuthPath();
  const existing = await readKeyFromPath(projectPath).catch(() => null);
  if (!existing) {
    await saveKey(key, projectPath);
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(`[DEBUG] Kimi auth: migrated key into ${projectPath}`);
    }
  }
}

async function saveKey(value: string, targetPath: string = getAuthEnvPath()): Promise<void> {
  const filePath = targetPath;
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  try {
    await chmod(dir, 0o700);
  } catch {
    // Ignore dir chmod issues on unsupported platforms
  }

  const trimmed = value.trim();
  const contents = `KIMI_API_KEY=${trimmed}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(tempPath, 0o600);
  } catch {
    // Ignore chmod errors on unsupported platforms
  }
  await rename(tempPath, filePath);
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Ignore chmod errors on unsupported platforms
  }
}

async function promptForKey(): Promise<string | undefined> {
  const { default: prompts } = await import('prompts');

  const apiKeyResponse = await prompts(
    {
      type: 'password',
      name: 'apiKey',
      message: 'Enter KIMI_API_KEY',
      validate: (value: string) => (value?.trim() ? true : 'API key cannot be empty'),
    },
    {
      onCancel: () => ({ apiKey: undefined }),
    },
  );

  const apiKey = typeof apiKeyResponse?.apiKey === 'string' ? apiKeyResponse.apiKey.trim() : undefined;
  return apiKey || undefined;
}

async function isCliInstalled(command: string): Promise<boolean> {
  try {
    const result = await execa(command, ['--version'], { timeout: 3000, reject: false });
    return typeof result.exitCode === 'number' && result.exitCode === 0;
  } catch {
    return false;
  }
}

function printInstallGuidance(): never {
  console.error(`\n────────────────────────────────────────────────────────────`);
  console.error(`  ⚠️  ${metadata.name} CLI Not Installed`);
  console.error(`────────────────────────────────────────────────────────────`);
  console.error(`\nThe '${metadata.cliBinary}' command is not available on this system.`);
  console.error(`Please install ${metadata.name} CLI first:\n`);
  console.error(`  ${metadata.installCommand}\n`);
  console.error(`────────────────────────────────────────────────────────────\n`);
  throw new Error(`${metadata.name} CLI is not installed.`);
}

function printEnvGuidance(): void {
  console.error(`\n────────────────────────────────────────────────────────────`);
  console.error(`  ℹ️  ${metadata.name} Authentication Required`);
  console.error(`────────────────────────────────────────────────────────────`);
  console.error(`\nSet the following environment variables before running CodeMachine:`);
  console.error(`  export KIMI_API_KEY="sk-..."`);
  console.error(`Optional overrides:`);
  console.error(`  export KIMI_BASE_URL="https://api.moonshot.cn/v1"`);
  console.error(`  export KIMI_MODEL_NAME="moonshot-v1-128k"`); // Example model
  console.error(`\nTip: run \`codemachine auth login\` to be prompted for the key. We store it at`);
  console.error(`  <project>/.codemachine/kimi/auth.env (0600) with a legacy tmp fallback.`);
  console.error(`  Override the file via CODEMACHINE_KIMI_AUTH_FILE if needed.`);
  console.error(`────────────────────────────────────────────────────────────\n`);
}

export async function isAuthenticated(): Promise<boolean> {
  if (isWindows()) {
    return false;
  }

  const installed = await isCliInstalled(metadata.cliBinary);
  if (!installed) {
    return false;
  }

  if (hasInlineKey()) {
    return true;
  }

  const info = await readAuthKeyInfo();
  return info !== null;
}

export async function ensureAuth(): Promise<boolean> {
  if (isWindows()) {
    console.error(`\n${metadata.name} currently supports macOS and Linux only.`);
    console.error('Run CodeMachine inside WSL or a Linux/macOS environment to use this engine.\n');
    throw new Error(`${metadata.name} CLI is not available on Windows yet.`);
  }

  const installed = await isCliInstalled(metadata.cliBinary);
  if (!installed) {
    printInstallGuidance();
  }

  if (process.env.LOG_LEVEL === 'debug') {
    console.error(`[DEBUG] Kimi ensureAuth: hasInlineKey=${hasInlineKey()} authFile=${getAuthEnvPath()} tmpFile=${getTmpEnvPath()}`);
  }

  if (hasInlineKey()) {
    try {
      await persistInlineKeyIfMissing(process.env.KIMI_API_KEY as string);
    } catch {
      // best-effort persistence, do not block auth
    }
    return true;
  }

  const storedKey = await readAuthKeyInfo();
  if (storedKey) {
    setInlineKey(storedKey.key);
    if (storedKey.source === 'tmp') {
      try {
        await persistProjectKeyIfMissing(storedKey.key);
      } catch {
        // best-effort migration
      }
    }
    if (process.env.LOG_LEVEL === 'debug') {
      console.error(`[DEBUG] Kimi ensureAuth: hydrated key from ${storedKey.source} (${storedKey.path})`);
    }
    return true;
  }

  if (!isInteractiveShell()) {
    printEnvGuidance();
    throw new Error('KIMI_API_KEY is required to run Kimi CLI.');
  }

  const apiKey = await promptForKey();
  if (!apiKey) {
    printEnvGuidance();
    throw new Error('KIMI_API_KEY is required to run Kimi CLI.');
  }

  setInlineKey(apiKey);
  await saveKey(apiKey);
  console.log(`\n🔐 Saved to ${getAuthEnvPath()} (remove via "codemachine auth logout").\n`);

  return true;
}

export async function clearAuth(): Promise<void> {
  const targets = new Set<string>([
    getAuthEnvPath(),
    getProjectAuthPath(),
    getTmpEnvPath(),
  ]);

  for (const target of targets) {
    try {
      await rm(target, { force: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  delete process.env.KIMI_API_KEY;
}

export async function nextAuthMenuAction(): Promise<'login' | 'logout'> {
  if (hasInlineKey()) {
    return 'logout';
  }

  const stored = await readAuthKeyInfo();
  return stored ? 'logout' : 'login';
}

export async function getAuthDiagnostics(): Promise<KimiAuthDiagnostics> {
  const overridePath = getOverrideAuthPath() ?? undefined;
  const projectPath = getProjectAuthPath();
  const legacyTmpPath = getTmpEnvPath();
  const sources: Array<{ source: AuthSource; path: string; hasKey: boolean; exists: boolean; mode?: string }> = [];
  const seen = new Set<string>();

  for (const candidate of getAuthSources()) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);

    let exists = false;
    let mode: string | undefined;
    try {
      const stats = await stat(candidate.path);
      exists = stats.isFile();
      if (exists) {
        mode = (stats.mode & 0o777).toString(8).padStart(3, '0');
      }
    } catch {
      exists = false;
    }

    let hasKey = false;
    if (exists) {
      const key = await readKeyFromPath(candidate.path).catch(() => null);
      hasKey = Boolean(key);
    }

    sources.push({
      source: candidate.source,
      path: candidate.path,
      hasKey,
      exists,
      mode,
    });
  }

  const cliInstalled = await isCliInstalled(metadata.cliBinary);

  return {
    isWindows: isWindows(),
    cliInstalled,
    inlineKey: hasInlineKey(),
    projectRoot: resolveProjectRoot(),
    overridePath,
    projectPath,
    legacyTmpPath,
    primaryAuthPath: getAuthEnvPath(),
    sources,
  };
}
