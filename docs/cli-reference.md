# CLI Reference

Complete command-line interface reference for CodeMachine.

## Overview

CodeMachine provides a command-line interface for managing workflows, executing agents, and configuring your development environment.


**Basic Usage:**
```bash
codemachine [command] [options]
```

**Global Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `-d, --dir <path>` | Target workspace directory | `process.cwd()` |
| `--spec <path>` | Path to planning specification file | `.codemachine/inputs/specifications.md` |
| `-h, --help` | Display help for command | - |

**Package Binary:**
- Entry point: `./dist/index.js`
- Command name: `codemachine`

---

## Interactive Mode

When no command is provided, CodeMachine starts in interactive session mode.

**Usage:**
```bash
codemachine
codemachine -d /path/to/workspace
```

**Features:**
- Interactive shell session with keyboard controls
- Real-time workflow execution
- Template selection menu
- Authentication management
- Onboarding for new users

**Session Flow:**
1. CLI checks working directory (`-d` option or current directory)
2. Syncs configuration for all registered engines
3. Bootstraps `.codemachine/` folder if it doesn't exist
4. Enters interactive shell with main menu

**Workspace Structure:**
```
.codemachine/
├── inputs/
│   └── specifications.md     # Default spec file
├── template.json              # Selected template
└── [engine-specific-configs]
```

---

## Workflow Commands

Commands for managing and executing workflows.

### `start`

Run the workflow queue until completion in non-interactive mode.

**Syntax:**
```bash
codemachine start [options]
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--spec <path>` | Path to the planning specification file | `.codemachine/inputs/specifications.md` |

**Behavior:**
- Executes workflow queue sequentially
- Runs in non-interactive mode (no user prompts)
- Exits with status code on completion

**Exit Codes:**
- `0` - Workflow completed successfully
- `1` - Workflow failed

**Output Messages:**
- Success: `✓ Workflow completed successfully`
- Error: `✗ Workflow failed: [error message]`

**Examples:**
```bash
# Run workflow with default spec
codemachine start

# Run workflow with custom spec
codemachine start --spec ./custom/planning.md

# Run in specific directory
codemachine -d /path/to/project start

# Custom directory and spec
codemachine -d /path/to/project start --spec ./specs/feature.md
```

**Use Cases:**
- CI/CD pipeline automation
- Batch workflow execution
- Automated code generation scripts
- Testing workflows

**Technical Details:**
- Source: `src/cli/commands/start.command.ts`
- Non-blocking execution
- Error handling with detailed messages

---

### `templates`

List and select workflow templates interactively.

**Syntax:**
```bash
codemachine templates
```

**Arguments:** None

**Options:** None

**Behavior:**
- Lists all available workflow templates from `templates/workflows/`
- Displays interactive selection menu
- Auto-regenerates agents folder when template changes
- Saves selection to `.codemachine/template.json`

**Template Format:**
- Files ending with `.workflow.js`
- Located in `templates/workflows/` directory
- Export workflow configuration and agent definitions

**Examples:**
```bash
# List and select template interactively
codemachine templates

# Use in specific workspace
codemachine -d /path/to/project templates
```

**Template Storage:**
- Selection saved to: `.codemachine/template.json`
- Default template: `templates/workflows/codemachine.workflow.js`
- Example template: `templates/workflows/_example.workflow.js`

**Use Cases:**
- Switch between different workflow types
- Initialize new projects with specific templates
- Customize agent configurations per project

**Technical Details:**
- Source: `src/cli/commands/templates.command.ts`
- Supports both interactive and programmatic selection
- Triggers agent folder regeneration on template change

---

## Development Commands

Commands for executing agents and workflow steps during development.

### `run`

Execute single agents or orchestrate multiple agents with the unified run command.

**Syntax:**
```bash
codemachine run <script>
codemachine <engine-name> run <script>
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `<script>` | Yes | Agent execution script with optional orchestration syntax |

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--model <model>` | Model to use (overrides agent config) | Agent's configured model |
| `-d, --dir <directory>` | Working directory | `process.cwd()` |

**Script Syntax:**

The `<script>` parameter supports several formats:

1. **Simple agent execution:**
   ```
   "agent-id 'prompt'"
   ```

2. **Enhanced syntax with parameters:**
   ```
   "agent-id[input:file1.md;file2.md,tail:100] 'prompt'"
   ```

   Available parameters:
   - `input:<file>` or `input:<file1>;<file2>` - Include file content(s) in agent context
   - `tail:<number>` - Limit file content to last N lines

3. **Parallel execution (using `&`):**
   ```
   "agent1 'prompt1' & agent2 'prompt2' & agent3 'prompt3'"
   ```

4. **Sequential execution (using `&&`):**
   ```
   "agent1 'prompt1' && agent2 'prompt2' && agent3 'prompt3'"
   ```

5. **Mixed execution:**
   ```
   "agent1 'prompt1' && agent2 'prompt2' & agent3 'prompt3'"
   ```

**Engine-Specific Commands:**
Each registered engine can be invoked directly:
```bash
codemachine claude run "agent 'prompt'"
codemachine codex run "agent 'prompt'"
codemachine cursor run "agent 'prompt'"
```

**Examples:**

```bash
# Simple single agent execution
codemachine run "code-generator 'Build login feature'"

# Agent with input files
codemachine run "system-analyst[input:.codemachine/agents/system-analyst.md,tail:100] 'analyze architecture'"

# Multiple input files without prompt
codemachine run "arch-writer[input:file1.md;file2.md;file3.md]"

# Parallel orchestration
codemachine run "frontend[tail:50] 'UI' & backend[tail:50] 'API' & db[tail:30] 'schema'"

# Sequential orchestration
codemachine run "db 'Setup schema' && backend 'Create models' && api 'Build endpoints'"

# Mixed orchestration
codemachine run "db[tail:50] 'setup' && frontend[input:design.md,tail:100] & backend[input:api-spec.md,tail:100]"

# With specific engine
codemachine claude run "code-generator 'Create a login component'"

# Override model
codemachine run "code-generator 'Create component'" --model gpt-4

# In specific workspace
codemachine -d /my/project run "my-agent 'Generate tests'"
```

**Agent Resolution:**
1. Searches `config/main.agents.js`
2. Searches `config/sub.agents.js`
3. Throws error if agent ID not found

**Execution Behavior:**
- `&` operator: Agents execute in parallel
- `&&` operator: Agents execute sequentially (waits for previous completion)
- Mixed: Evaluates left-to-right with operator precedence
- Enhanced syntax allows including file contents and limiting output

**Use Cases:**
- Single agent execution for quick tasks
- Multi-agent orchestration for complex workflows
- Including specification files in agent context
- Parallel feature development across multiple agents
- Sequential pipeline execution (design → implement → test)

**Technical Details:**
- Source: `src/cli/commands/run.command.ts`
- Uses `CoordinatorService` for execution
- Parses scripts via `CoordinatorParser`
- Replaces both old `agent` and `orchestrate` commands
- Supports enhanced syntax not available in legacy commands

**Migration from Legacy Commands:**

If you were using the old `agent` command:
```bash
# Old
codemachine agent code-generator "Create login"

# New
codemachine run "code-generator 'Create login'"
```

If you were using the old `orchestrate` command:
```bash
# Old
codemachine orchestrate "frontend 'UI' & backend 'API'"

# New (same syntax, different command)
codemachine run "frontend 'UI' & backend 'API'"
```

---

### `step`

Execute a single workflow step using an agent from the main agents configuration.

**Syntax:**
```bash
codemachine step [options] <id> [prompt...]
```

**Arguments:**

| Argument | Required | Description |
|----------|----------|-------------|
| `<id>` | Yes | Agent ID from `config/main.agents.js` |
| `[prompt...]` | No | Optional additional prompt to append to agent's main prompt |

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--model <model>` | Model to use | Resolved from priority chain |
| `--engine <engine>` | Engine to use | Resolved from priority chain |
| `--reasoning <level>` | Reasoning effort: `low`, `medium`, or `high` | Agent's config or engine default |

**Option Resolution Priority:**

**Engine Resolution:**
1. CLI `--engine` override
2. Agent config `engine` property
3. First authenticated engine
4. Default engine (first registered)

**Model Resolution:**
1. CLI `--model` override
2. Agent config `model` property
3. Engine's default model

**Reasoning Resolution:**
1. CLI `--reasoning` override
2. Agent config `modelReasoningEffort`
3. Engine default reasoning level

**Behavior:**
- Executes main workflow agent in isolated step
- Requires engine authentication
- Displays formatted output with spinning indicators
- Stores last 2000 characters in memory

**Examples:**
```bash
# Execute step with agent's default config
codemachine step planner

# Execute with additional prompt
codemachine step planner "Focus on microservices architecture"

# Override engine
codemachine step planner --engine claude

# Override model
codemachine step planner --model gpt-4-turbo

# Override reasoning level
codemachine step planner --reasoning high

# Combine multiple overrides
codemachine step planner "Design API" --engine codex --model gpt-4 --reasoning high

# Execute in specific workspace
codemachine -d /project step implementation "Add error handling"
```

**Authentication:**
- Requires authenticated engine
- Error message if engine not authenticated:
  ```
  Engine '[engine-name]' requires authentication.
  Run: codemachine auth login
  ```

**Agent Source:**
- Only searches `config/main.agents.js`
- Does not search `config/sub.agents.js`
- Throws error if agent not found in main agents

**Use Cases:**
- Test individual workflow steps
- Debug main agents in isolation
- Experiment with different models/engines
- Run specific workflow phases manually

**Technical Details:**
- Source: `src/cli/commands/step.command.ts`
- Output formatting with typewriter effect
- Memory preservation for session context
- Authentication validation before execution

---

## Configuration Commands

Commands for managing authentication and system configuration.

### `auth`

Authentication management for AI engine providers.

**Subcommands:**
- `auth login` - Authenticate with a provider
- `auth logout` - Logout from a provider
- `auth status` - Inspect authentication status/details

---

#### `auth login`

Authenticate with CodeMachine AI engine services.

**Syntax:**
```bash
codemachine auth login
```

**Arguments:** None

**Options:** None

**Behavior:**
- Displays interactive provider selection menu
- Lists all registered engine providers
- Calls provider's authentication system
- Stores credentials securely per engine

**Provider Selection:**
Interactive menu shows:
- Provider name
- Authentication status (authenticated/not authenticated)

**Already Authenticated:**
If already authenticated, displays:
```
Already authenticated with [Provider].
Use `codemachine auth logout` to sign out.
```

**Examples:**
```bash
# Interactive provider login
codemachine auth login

# Returns to menu after authentication
# Can authenticate multiple providers
```

**Authentication Flow:**
1. Display registered providers
2. User selects provider
3. Provider-specific auth process (API key, OAuth, etc.)
4. Credentials stored in engine config
5. Confirmation message

**Use Cases:**
- Initial setup of AI engines

---

#### `auth status`

Inspect authentication status for a selected provider.

**Syntax:**
```bash
codemachine auth status
```

**Behavior:**
- Shows the same provider selection menu as `auth login`/`logout`.
- For Kimi CLI, prints detailed diagnostics: platform, CLI availability, inline env presence, resolved project root, override path, and every auth source (environment variables, override file, project file, legacy tmp) with existence/permissions info.
- For other providers, displays a concise ready/not ready message based on `isAuthenticated()`.

**Use Cases:**
- Debugging “already authenticated” vs missing key scenarios.
- Verifying which auth file (`CODEMACHINE_KIMI_AUTH_FILE`, project `.codemachine/kimi/auth.env`, or tmp) contains the stored key.
- Re-authenticate expired sessions
- Switch between different provider accounts
- Enable new engines in workspace

**Technical Details:**
- Source: `src/cli/commands/auth.command.ts`
- Providers loaded from engine registry
- Engine-specific authentication handlers
- Secure credential storage

---

#### `auth logout`

Logout from CodeMachine AI engine services.

**Syntax:**
```bash
codemachine auth logout
```

**Arguments:** None

**Options:** None

**Behavior:**
- Displays interactive provider selection menu
- Shows only authenticated providers
- Clears authentication for selected provider
- Updates engine configuration

**Logout Confirmation:**
```
Signed out from [Provider].
Next action will be `login`.
```

**Examples:**
```bash
# Interactive provider logout
codemachine auth logout

# Select provider from menu
# Credentials cleared
```

**Use Cases:**
- Switch provider accounts
- Remove expired credentials
- Security: clear credentials when sharing machine
- Testing unauthenticated flows

**Technical Details:**
- Source: `src/cli/commands/auth.command.ts`
- Clears provider-specific credentials
- Updates configuration files
- Preserves other provider authentications

---

## Utility Commands

Utility and informational commands.

### `version`

Display the CodeMachine CLI version.

**Syntax:**
```bash
codemachine version
codemachine --version
codemachine -V
```

**Arguments:** None

**Options:** None

**Output:**
```
CodeMachine v[version]
```

**Examples:**
```bash
codemachine version
# Output: CodeMachine v1.0.0
```

**Use Cases:**
- Verify installation
- Check for updates
- Bug reporting
- Compatibility checks

---

## Advanced Topics

### Engine-Specific Commands

CodeMachine dynamically registers engine-specific command variants for each registered AI engine.

**Pattern:**
```bash
codemachine <engine-name> run <script>
```

**Examples:**
```bash
# Claude-specific agent execution
codemachine claude run "my-agent 'Generate code'"

# Codex-specific agent execution
codemachine codex run "my-agent 'Generate code'"

# Cursor engine variant
codemachine cursor run "my-agent 'Generate code'"

# Kimi engine variant
codemachine kimi run "my-agent 'Generate code'"

# OpenCode engine variant
codemachine opencode run "build hello world"
```

**Behavior:**
- Same options and arguments as main `run` command
- Forces execution with specific engine
- Useful for engine comparison and testing

**Dynamic Registration:**
- Commands registered automatically at startup
- Based on engines in engine registry
- Each engine gets its own subcommand namespace

### OpenCode Environment Guardrails

The OpenCode provider needs explicit permission defaults to stay non-interactive. When you run `codemachine opencode ...` or `--engine opencode`, the CLI injects (unless already set):

- `OPENCODE_PERMISSION={"*":"allow","bash":{"*":"allow"}}`
- `OPENCODE_DISABLE_LSP_DOWNLOAD=1` and `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`
- `OPENCODE_CONFIG_DIR=$HOME/.codemachine/opencode` (can be overridden)

You can also set `CODEMACHINE_SKIP_OPENCODE=1` to dry-run pipelines without launching the CLI, or `CODEMACHINE_PLAIN_LOGS=1` to strip ANSI markers in log exports.

When OpenCode introduces a permission that is not covered by your current policy, CodeMachine now pauses execution, surfaces the request via the standard selection menu (`Allow once / Always allow / Reject`), rewrites `OPENCODE_PERMISSION` accordingly, and retries the run. Choosing **Always allow** remembers the approval for the current CLI session so subsequent steps inherit the updated policy automatically.

Important: Disable OpenCode sub‑agents. CodeMachine coordinates sub‑agents at the workflow level and does not yet handle OpenCode’s engine‑native sub‑agents. Keeping them enabled can disconnect the OpenCode process and provides no benefit because CodeMachine already scopes tasks to a single agent.

### Kimi CLI Integration Notes

- Install with `uv tool install --python 3.13 kimi-cli` and export `KIMI_API_KEY` (plus optional `KIMI_BASE_URL` / `KIMI_MODEL_NAME`).
- `codemachine auth login` prompts for the API key (masked) and stores it at `<project>/.codemachine/kimi/auth.env` (0600). Override with `CODEMACHINE_KIMI_AUTH_FILE`, inspect via `codemachine auth status`, and remove with `codemachine auth logout`.
- If `KIMI_BASE_URL` / `KIMI_MODEL_NAME` are unset we default to `https://api.kimi.com/coding/v1` and `kimi-for-coding` so print/wire mode works even when the upstream config file is empty.
- Pin the project root used for `.codemachine/kimi/auth.env` with `CODEMACHINE_PROJECT_ROOT=/absolute/workspace/path` when running from nested directories or CI sandboxes.
- Override the exact CLI path via `CODEMACHINE_KIMI_BINARY=/full/path/to/kimi` if you keep multiple installations around; otherwise we resolve `kimi` on `PATH`.
- Default print mode (`kimi --print`) streams JSONL for resilient CI runs. Set `CODEMACHINE_KIMI_MODE=wire` when you need the JSON-RPC wire UI (step/tool/status fidelity). Wire mode auto-approves CLI prompts.
- Provide additional MCP definitions through `KIMI_MCP_CONFIG_FILES=/path/a.json,/path/b.json`.
- `CODEMACHINE_SKIP_KIMI=1` performs dry-runs; `CODEMACHINE_PLAIN_LOGS=1` strips ANSI sequences from streamed output.
- Windows is not currently supported by the upstream CLI—use macOS, Linux, or WSL.

---

### Startup and Initialization

**CLI Startup Flow:**

1. **Parse Global Options**
   - Check for `-d/--dir` to set working directory
   - Check for `--spec` to override default specification path

2. **Pre-Action Hook**
   - Sync configuration for all registered engines
   - Validate workspace structure

3. **Bootstrap Workspace**
   - If `.codemachine/` doesn't exist:
     - Create directory structure
     - Initialize with default template
     - Create default spec file

4. **Register Commands**
   - Register all standard commands
   - Dynamically register engine-specific commands

5. **Execute Command or Enter Interactive Mode**
   - If command provided: execute and exit
   - If no command: enter interactive session shell

**Default Workspace Bootstrap:**
```
.codemachine/
├── inputs/
│   └── specifications.md     # Created with template
├── template.json              # Set to default template
└── [engine configs]           # Created on first auth
```
---

## Quick Reference

**Most Common Commands:**

```bash
# Start interactive session
codemachine

# Run workflow
codemachine start

# Select template
codemachine templates

# Authenticate
codemachine auth login

# Execute agent or orchestrate
codemachine run "<agent-id> 'prompt'"

# Execute workflow step
codemachine step <id>

# Check version
codemachine version
```

**With Options:**

```bash
# Set workspace
codemachine -d /path/to/project

# Custom spec
codemachine start --spec ./specs/custom.md

# Override model
codemachine step planner --model gpt-4

# Override engine and reasoning
codemachine step planner --engine claude --reasoning high
```
