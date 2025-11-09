import type { Command } from 'commander';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import prompts from 'prompts';
import type { KimiAuthDiagnostics } from '../../infra/engines/providers/kimi/auth.js';
import { registry } from '../../infra/engines/index.js';
import { selectFromMenu, type SelectionChoice } from '../presentation/selection-menu.js';
import { expandHomeDir } from '../../shared/utils/index.js';

interface AuthProviderChoice extends SelectionChoice<string> {
  title: string;
  value: string;
  description?: string;
}

async function selectAuthProvider(): Promise<string | undefined> {
  const choices: AuthProviderChoice[] = registry.getAll().map(engine => ({
    title: engine.metadata.name,
    value: engine.metadata.id,
    description: engine.metadata.description
  }));

  return await selectFromMenu({
    message: 'Choose authentication provider:',
    choices,
    initial: 0
  });
}

function formatYesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

async function getKimiDiagnostics(): Promise<KimiAuthDiagnostics> {
  const { getAuthDiagnostics } = await import('../../infra/engines/providers/kimi/auth.js');
  return await getAuthDiagnostics();
}

function printKimiStatus(diag: KimiAuthDiagnostics, heading: string): void {
  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`  ${heading}`);
  console.log(`────────────────────────────────────────────────────────────`);
  console.log(`\nPlatform: ${diag.isWindows ? 'Windows (unsupported for Kimi CLI)' : 'macOS/Linux'}`);
  console.log(`CLI installed: ${formatYesNo(diag.cliInstalled)}`);
  console.log(`Inline env (current process): ${formatYesNo(diag.inlineKey)}`);
  console.log(`Project root: ${diag.projectRoot}`);
  if (diag.overridePath) {
    console.log(`Override file: ${diag.overridePath}`);
  }
  console.log(`Primary auth file: ${diag.primaryAuthPath}`);
  console.log(`Legacy tmp file: ${diag.legacyTmpPath}`);
  console.log(`\nAuth sources (highest priority first):`);
  diag.sources.forEach((source, index) => {
    const label = `${index + 1}) ${source.source.toUpperCase()}`;
    const meta = [`exists=${formatYesNo(source.exists)}`, `key=${formatYesNo(source.hasKey)}`];
    if (source.mode) {
      meta.push(`perms=${source.mode}`);
    }
    console.log(`  ${label}`);
    console.log(`     path: ${source.path}`);
    console.log(`     ${meta.join(', ')}`);
  });
  console.log(`\nUse \`codemachine auth status\` or \`codemachine auth logout\` to manage these files.`);
  console.log(`────────────────────────────────────────────────────────────\n`);
}

async function handleLogin(providerId: string): Promise<void> {
  const engine = registry.get(providerId);
  if (!engine) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const action = await engine.auth.nextAuthMenuAction();
  if (action === 'logout' && providerId !== 'kimi') {
    // Special handling for CCR - show configuration tip instead of generic message
    if (providerId === 'ccr') {
      console.log(`\n────────────────────────────────────────────────────────────`);
      console.log(`  ✅  ${engine.metadata.name} CLI Detected`);
      console.log(`────────────────────────────────────────────────────────────`);
      console.log(`\n💡 Tip: CCR is installed but you might still need to configure it`);
      console.log(`       (if you haven't already).\n`);
      console.log(`To configure CCR:`);
      console.log(`  1. Run: ccr ui`);
      console.log(`     Opens the web UI to add your providers\n`);
      console.log(`  2. Or manually edit: ~/.claude-code-router/config.json\n`);
      console.log(`🚀 Easiest way to use CCR inside Codemachine:`);
      console.log(`   Logout from all other engines using:`);
      console.log(`     codemachine auth logout`);
      console.log(`   This will run CCR by default for all engines.\n`);
      console.log(`   Or modify the template by adding ccr engine.`);
      console.log(`   For full guide, check:`);
      console.log(`   https://github.com/moazbuilds/CodeMachine-CLI/blob/main/docs/customizing-workflows.md\n`);
      console.log(`For more help, visit:`);
      console.log(`  https://github.com/musistudio/claude-code-router\n`);
      console.log(`────────────────────────────────────────────────────────────\n`);
    }
    // Special handling for OpenCode - supports multiple auth providers
    else if (providerId === 'opencode') {
      console.log(`\n────────────────────────────────────────────────────────────`);
      console.log(`  ✅  ${engine.metadata.name} Already Authenticated`);
      console.log(`────────────────────────────────────────────────────────────\n`);

      // Build XDG environment variables pointing to OPENCODE_HOME
      const opencodeHome = process.env.OPENCODE_HOME
        ? expandHomeDir(process.env.OPENCODE_HOME)
        : path.join(homedir(), '.codemachine', 'opencode');

      const xdgEnv = {
        ...process.env,
        XDG_CONFIG_HOME: path.join(opencodeHome, 'config'),
        XDG_CACHE_HOME: path.join(opencodeHome, 'cache'),
        XDG_DATA_HOME: path.join(opencodeHome, 'data'),
      };

      // Show current auth providers
      console.log(`Current authentication providers:\n`);
      try {
        await execa('opencode', ['auth', 'list'], {
          stdio: 'inherit',
          env: xdgEnv
        });
      } catch {
        console.log('(Unable to fetch auth list)');
      }

      console.log();

      // Ask if user wants to add another provider
      const response = await prompts({
        type: 'confirm',
        name: 'addAnother',
        message: 'Do you want to add another authentication provider?',
        initial: false
      });

      if (response.addAnother) {
        // Force login to add another provider
        await engine.auth.ensureAuth(true);
        console.log(`\n${engine.metadata.name} authentication provider added successfully.`);
      } else {
        console.log(`\nTo sign out and clear all data: codemachine auth logout`);
        console.log(`────────────────────────────────────────────────────────────\n`);
      }
    } else {
      console.log(`Already authenticated with ${engine.metadata.name}. Use \`codemachine auth logout\` to sign out.`);
    }
  }

  if (providerId === 'kimi') {
    // Ensure we actually capture a key and populate the auth file during login.
    delete (process.env as Record<string, string | undefined>).KIMI_API_KEY;
    await engine.auth.ensureAuth();
    const diag = await getKimiDiagnostics();
    printKimiStatus(diag, `✅  ${engine.metadata.name} Ready`);
  } else {
    await engine.auth.ensureAuth();
    console.log(`${engine.metadata.name} authentication successful.`);
  }
}

async function handleLogout(providerId: string): Promise<void> {
  const engine = registry.get(providerId);
  if (!engine) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Special handling for CCR - no logout needed
  if (providerId === 'ccr') {
    console.log(`\n────────────────────────────────────────────────────────────`);
    console.log(`  ℹ️  ${engine.metadata.name} Logout`);
    console.log(`────────────────────────────────────────────────────────────`);
    console.log(`\nCCR authentication is managed by the CCR CLI itself.`);
    console.log(`There is no logout action required in Codemachine.\n`);
    console.log(`To reconfigure CCR, simply run: ccr ui\n`);
    console.log(`────────────────────────────────────────────────────────────\n`);
    return;
  }

  await engine.auth.clearAuth();
  console.log(`Signed out from ${engine.metadata.name}. Next action will be \`login\`.`);
}

async function handleStatus(providerId: string): Promise<void> {
  const engine = registry.get(providerId);
  if (!engine) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  if (providerId === 'kimi') {
    const diag = await getKimiDiagnostics();
    const heading = diag.inlineKey || diag.sources.some(source => source.hasKey)
      ? `✅  ${engine.metadata.name} Authentication Status`
      : `⚠️  ${engine.metadata.name} Authentication Status`;
    printKimiStatus(diag, heading);
    return;
  }

  const authed = await engine.auth.isAuthenticated();
  if (authed) {
    console.log(`✅  ${engine.metadata.name} is authenticated.`);
  } else {
    console.log(`⚠️  ${engine.metadata.name} is not authenticated. Run \`codemachine auth login\`.`);
  }
}

export function registerAuthCommands(program: Command): void {
  const authCommand = program
    .command('auth')
    .description('Authentication helpers');

  authCommand
    .command('login')
    .description('Authenticate with Codemachine services')
    .action(async () => {
      const provider = await selectAuthProvider();
      if (!provider) {
        console.log('No provider selected.');
        return;
      }
      await handleLogin(provider);
    });

  authCommand
    .command('logout')
    .description('Log out of Codemachine services')
    .action(async () => {
      const provider = await selectAuthProvider();
      if (!provider) {
        console.log('No provider selected.');
        return;
      }
      await handleLogout(provider);
    });

  authCommand
    .command('status')
    .description('Show authentication status')
    .action(async () => {
      const provider = await selectAuthProvider();
      if (!provider) {
        console.log('No provider selected.');
        return;
      }
      await handleStatus(provider);
    });
}
