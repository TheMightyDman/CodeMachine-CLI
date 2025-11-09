export interface KimiCommand {
  command: string;
  args: string[];
}

export interface KimiPrintCommandOptions {
  prompt: string;
  workingDir: string;
  model?: string;
  mcpConfigFiles?: string[];
}

export interface KimiWireCommandOptions {
  workingDir: string;
  model?: string;
  mcpConfigFiles?: string[];
}

function appendModel(args: string[], model?: string): void {
  if (model && model.trim().length > 0) {
    args.push('-m', model.trim());
  }
}

function appendMcpConfigs(args: string[], mcpConfigFiles?: string[]): void {
  if (!mcpConfigFiles?.length) {
    return;
  }

  for (const file of mcpConfigFiles) {
    if (file.trim().length === 0) continue;
    args.push('--mcp-config-file', file.trim());
  }
}

export function buildKimiPrintCommand(options: KimiPrintCommandOptions): KimiCommand {
  const args: string[] = [
    '--print',
    '--output-format',
    'stream-json',
    '--work-dir',
    options.workingDir,
    '--yolo',
  ];

  appendModel(args, options.model);
  appendMcpConfigs(args, options.mcpConfigFiles);

  args.push('--command', options.prompt);

  return {
    command: 'kimi',
    args,
  };
}

export function buildKimiWireCommand(options: KimiWireCommandOptions): KimiCommand {
  const args: string[] = [
    '--ui',
    'wire',
    '--work-dir',
    options.workingDir,
  ];

  appendModel(args, options.model);
  appendMcpConfigs(args, options.mcpConfigFiles);

  return {
    command: 'kimi',
    args,
  };
}
