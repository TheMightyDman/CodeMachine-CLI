import type { EngineMetadata } from '../../core/base.js';

export const metadata: EngineMetadata = {
  id: 'kimi',
  name: 'Kimi CLI',
  description: 'Authenticate with Kimi CLI',
  cliCommand: 'kimi',
  cliBinary: 'kimi',
  installCommand: 'uv tool install --python 3.13 kimi-cli',
  defaultModel: 'kimi-for-coding',
  order: 5,
};
