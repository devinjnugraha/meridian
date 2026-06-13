# Requirements Document

## Introduction

This specification covers the full modernisation of the Meridian autonomous DLMM liquidity provider agent from JavaScript to TypeScript, and its deployment onto AWS EC2. Meridian is a long-running Node.js process that manages Meteora DLMM liquidity positions on Solana using a dual-agent (Hunter Alpha / Healer Alpha) ReAct loop, cron scheduling, Telegram polling, a readline REPL, SQLite state persistence, and multiple external integrations (OpenRouter, Helius, Jupiter, OKX, DexScreener, Meteora APIs). The migration must preserve every existing capability while establishing a strongly-typed codebase, a reproducible AWS deployment, and secure secrets management via AWS Secrets Manager.

---

## Glossary

- **Meridian**: The Solana DLMM LP agent application being migrated.
- **TypeScript_Compiler**: The `tsc` compiler (TypeScript ≥ 5.x) that compiles `.ts` sources to JavaScript.
- **AWS_CDK**: AWS Cloud Development Kit used to define and deploy all infrastructure as TypeScript code.
- **EC2_Instance**: The AWS EC2 virtual machine that hosts the compiled Meridian process.
- **Secrets_Manager**: AWS Secrets Manager service that stores all application secrets.
- **EBS_Volume**: The Elastic Block Store volume attached to the EC2 Instance for persistent SQLite and JSON state files.
- **Migration_Build**: The fully compiled, all-at-once TypeScript rewrite of the Meridian codebase.
- **State_Files**: The JSON files used for persistent state (`state.json`, `pool-memory.json`, `signal-weights.json`, `lessons.json`, `decision-log.json`) and the SQLite database (`meridian.db`).
- **Agent_Role**: One of `SCREENER`, `MANAGER`, or `GENERAL` — controls which tools the LLM agent may call.
- **Tool**: A named callable function exposed to the LLM agent via the OpenAI tool-calling interface.
- **Cron_Scheduler**: The `node-cron`-based scheduling system that triggers management and screening cycles.
- **DRY_RUN**: A runtime flag that causes all on-chain transactions to be simulated without submission.
- **ReAct_Loop**: The Reasoning + Acting agent loop implemented in `agent.ts`.
- **HiveMind**: The optional collective intelligence sync server.
- **ESM**: ECMAScript Modules — the current module system used by the project (`"type": "module"` in `package.json`).

---

## Requirements

### Requirement 1: TypeScript Conversion — Full Codebase

**User Story:** As a developer, I want every JavaScript source file converted to TypeScript, so that the codebase benefits from static type checking, improved tooling, and reduced runtime errors.

#### Acceptance Criteria

1. THE Migration_Build SHALL convert all `.js` source files under the project root and `db/`, `tools/`, `scripts/`, and `test/` directories to `.ts` files, with no `.js` source files remaining in those locations.
2. THE TypeScript_Compiler SHALL be configured with `"strict": true` in `tsconfig.json`, enabling `strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, and all other strict-mode checks.
3. THE TypeScript_Compiler SHALL emit output to a `dist/` directory and SHALL target `ESNext` with `module` set to `NodeNext` to preserve ESM compatibility.
4. WHEN the command `npm run build` is executed, THE TypeScript_Compiler SHALL complete with zero type errors and zero warnings that block compilation.
5. THE Migration_Build SHALL define explicit TypeScript interfaces or types for all cross-module data contracts, including but not limited to: position state objects, config objects, tool argument shapes, tool result shapes, agent loop options, lesson records, performance records, and pool-memory records.
6. THE Migration_Build SHALL preserve the ESM module system (`"type": "module"`) with `import`/`export` syntax throughout.
7. WHERE a third-party package lacks bundled type definitions, THE Migration_Build SHALL add the corresponding `@types/*` package or include a local `.d.ts` declaration file.

---

### Requirement 2: Type-Safe Configuration System

**User Story:** As a developer, I want the configuration module to be fully typed, so that invalid config values are caught at compile time rather than silently failing at runtime.

#### Acceptance Criteria

1. THE Migration_Build SHALL define a `Config` interface (or equivalent type) that mirrors all fields in `user-config.json`, with no `any` types on config properties.
2. WHEN a required environment variable (`WALLET_PRIVATE_KEY`, `RPC_URL`, `OPENROUTER_API_KEY`) is absent at startup, THE Migration_Build SHALL throw a typed error with a descriptive message identifying the missing variable.
3. THE Migration_Build SHALL export `computeDeployAmount(walletSol: number): number` and `computeBinsBelow(volatility: number): number` with explicit parameter and return types.
4. THE Migration_Build SHALL export `reloadScreeningThresholds(): void` with an explicit return type.

---

### Requirement 3: Type-Safe Tool Definitions and Executor

**User Story:** As a developer, I want the tools layer to be fully typed, so that tool argument and result types are enforced at both the definition and execution sites.

#### Acceptance Criteria

1. THE Migration_Build SHALL define a discriminated union or individual interface for every Tool's argument object, ensuring the executor function cannot receive structurally invalid arguments without a compile-time error.
2. THE Migration_Build SHALL type every tool handler's return value with an explicit interface (e.g. `ToolResult<T>`) rather than returning `any` or untyped objects.
3. THE Migration_Build SHALL type the `toolMap` record so that each key corresponds to a known tool name and each value is a function with typed arguments and typed return.
4. WHEN a new tool is added to `tools/definitions.ts`, THE TypeScript_Compiler SHALL produce a compile error if a corresponding handler is not added to `tools/executor.ts` and the relevant role sets in `agent.ts`.

---

### Requirement 4: Type-Safe Agent Loop

**User Story:** As a developer, I want the agent loop to be fully typed, so that agent role values, session history, options, and return values are all statically verified.

#### Acceptance Criteria

1. THE Migration_Build SHALL define `AgentRole` as a TypeScript `enum` or `const` object with values `SCREENER`, `MANAGER`, and `GENERAL`, replacing the plain string constants.
2. THE Migration_Build SHALL type the `sessionHistory` parameter of `agentLoop` as `OpenAI.Chat.ChatCompletionMessageParam[]` (or equivalent from the `openai` SDK typings).
3. THE Migration_Build SHALL define an `AgentLoopOptions` interface covering `interactive`, `onToolStart`, `onToolFinish`, `breakOnTools`, `allowTools`, `toolsOverride`, and `source` fields with explicit types.
4. THE Migration_Build SHALL define an `AgentLoopResult` interface with `content: string`, `userMessage: string`, and optional `earlyStop`, `assistantMessage`, and `toolResults` fields, and `agentLoop` SHALL return `Promise<AgentLoopResult>`.

---

### Requirement 5: Type-Safe State Management

**User Story:** As a developer, I want the state module to be fully typed, so that position state mutations and exit-condition checks are statically verified.

#### Acceptance Criteria

1. THE Migration_Build SHALL define a `PositionState` interface covering all fields tracked in `state.json` (deploy timestamps, OOR tracking, pending confirmations, fee history, PnL snapshots, etc.).
2. THE Migration_Build SHALL define an `ExitResult` interface returned by `updatePnlAndCheckExits`, with a discriminated `action` field (`TRAILING_TP`, `STOP_LOSS`, `IL_STOP`, `OOR`, `LOW_YIELD`, `VOLUME_DECAY`).
3. THE Migration_Build SHALL define a `ManagementConfig` interface representing the management section of `Config` and SHALL use it as the parameter type wherever management thresholds are consumed.
4. THE Migration_Build SHALL preserve all existing state functions (`trackPosition`, `markOutOfRange`, `markInRange`, `updatePnlAndCheckExits`, `queuePeakConfirmation`, `resolvePendingPeak`, etc.) with explicit TypeScript signatures.

---

### Requirement 6: Type-Safe Lessons and Learning System

**User Story:** As a developer, I want the lessons and learning system to be fully typed, so that lesson records, performance records, and threshold evolution logic are statically verified.

#### Acceptance Criteria

1. THE Migration_Build SHALL define a `Lesson` interface covering `id`, `rule`, `tags`, `outcome`, `sourceType`, `confidence`, `context`, `pnl_pct`, `fees_earned_usd`, `initial_value_usd`, `range_efficiency`, `close_reason`, `pool`, `created_at`, and optional fields such as `pinned` and `role`.
2. THE Migration_Build SHALL define a `PerformanceRecord` interface covering all fields written by `recordPerformance`.
3. THE Migration_Build SHALL type `getLessonsForPrompt({ agentType }: { agentType: AgentRole }): string` with an explicit return type.
4. THE Migration_Build SHALL type `recordPerformance(perf: PerformanceRecord): void` and `evolveThresholds(): void` with explicit signatures.

---

### Requirement 7: AWS CDK Infrastructure Definition

**User Story:** As a developer, I want all AWS infrastructure defined as CDK TypeScript code, so that the deployment is reproducible, version-controlled, and reviewable.

#### Acceptance Criteria

1. THE AWS_CDK SHALL define a stack (`MeridianStack`) in a top-level `infra/` directory using TypeScript that provisions all resources required to run Meridian on EC2.
2. THE AWS_CDK SHALL define an EC2 Instance within a VPC, using an Amazon Linux 2023 or Ubuntu 22.04 LTS AMI, with an instance type configurable via CDK context (defaulting to `t3.small`).
3. THE AWS_CDK SHALL attach an EBS Volume of at least 20 GiB (gp3) to the EC2 Instance and SHALL define user-data scripts to mount it at `/data` for SQLite and state file persistence.
4. THE AWS_CDK SHALL define an IAM Instance Profile granting the EC2 Instance read access to the required Secrets Manager secrets and write access to CloudWatch Logs.
5. THE AWS_CDK SHALL define a Security Group that allows outbound HTTPS (port 443) and restricts inbound SSH (port 22) to a configurable CIDR range (default: no inbound SSH — access via AWS Systems Manager Session Manager).
6. WHEN the command `cdk deploy` is executed, THE AWS_CDK SHALL provision all defined resources without manual console steps, and all provisioned resources SHALL be accessible and operational after the command completes successfully.
7. THE AWS_CDK SHALL define a CloudWatch Log Group for Meridian application logs with a configurable retention period (default: 30 days).

---

### Requirement 8: Secrets Management via AWS Secrets Manager

**User Story:** As an operator, I want all application secrets stored in AWS Secrets Manager, so that private keys and API keys are never stored in plaintext on disk or in environment variables set manually.

#### Acceptance Criteria

1. THE EC2_Instance SHALL retrieve `WALLET_PRIVATE_KEY`, `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ALLOWED_USER_IDS`, `HELIUS_API_KEY`, and any other secret values exclusively from Secrets_Manager at startup, not from a `.env` file committed to the repository.
2. THE Migration_Build SHALL include a startup bootstrap script (or inline startup code in `index.ts`) that fetches secrets from Secrets_Manager and populates `process.env` before any module that reads those variables is initialised.
3. WHEN a Secrets_Manager fetch fails at startup, THE Migration_Build SHALL throw a typed error with a descriptive message and SHALL NOT start the agent loop.
4. THE AWS_CDK SHALL create or reference (by ARN/name) the required Secrets Manager secrets and SHALL grant the EC2 Instance Profile read access via an IAM policy with least-privilege permissions.
5. THE AWS_CDK SHALL store non-secret configuration (RPC URL, model names, scheduling intervals) as Systems Manager Parameter Store parameters rather than as Secrets Manager secrets, to reduce cost and separate concerns.

---

### Requirement 9: EC2 Process Management and Auto-Start

**User Story:** As an operator, I want Meridian to run as a managed system service on EC2, so that it restarts automatically after instance reboots or process crashes.

#### Acceptance Criteria

1. THE AWS_CDK user-data script SHALL install Node.js 20.x (LTS) on the EC2 Instance.
2. THE AWS_CDK user-data script SHALL install the compiled Meridian application from a deployment artefact (S3 or `git clone`) and install production npm dependencies.
3. THE AWS_CDK user-data script SHALL create a `systemd` service unit file for Meridian that sets `Restart=always` and `RestartSec=10`.
4. WHEN the EC2_Instance reboots, THE systemd service SHALL automatically start the Meridian process within 30 seconds of the OS reaching the multi-user target.
5. WHEN the Meridian process exits unexpectedly, THE systemd service SHALL restart it within 10 seconds.
6. THE systemd service SHALL direct stdout and stderr to the CloudWatch Logs agent so that all logs are captured in the defined CloudWatch Log Group.

---

### Requirement 10: Build, Test, and Deploy Pipeline

**User Story:** As a developer, I want a clear, documented build and deployment workflow, so that the migration can be verified and the application deployed repeatably.

#### Acceptance Criteria

1. THE Migration_Build SHALL define an `npm run build` script that invokes `tsc` and exits non-zero if any type errors are present.
2. THE Migration_Build SHALL define an `npm run typecheck` script that runs `tsc --noEmit` for fast type checking without emitting output files.
3. THE Migration_Build SHALL migrate all existing test files in `test/` to TypeScript and SHALL ensure `npm test` runs them without type errors.
4. THE Migration_Build SHALL define an `npm run deploy` script (or equivalent `Makefile` target) that runs `npm run build` followed by `cdk deploy`.
5. WHEN `npm run build` succeeds, THE resulting `dist/` directory SHALL contain a runnable `dist/index.js` entry point that starts Meridian.
6. THE Migration_Build SHALL include a `README` section documenting the local development setup, build steps, AWS prerequisites (`cdk bootstrap`, IAM permissions), and deployment commands.

---

### Requirement 11: Behavioural Parity

**User Story:** As an operator, I want the TypeScript build to behave identically to the JavaScript original, so that no existing functionality is lost or altered during the migration.

#### Acceptance Criteria

1. THE Migration_Build SHALL preserve all existing REPL commands (`auto`, `/status`, `/candidates`, `/learn`, `/thresholds`, `/evolve`, `/stop`, and free-form chat) with identical behaviour.
2. THE Migration_Build SHALL preserve all Telegram commands (`/positions`, `/close <n>`, `/set <n> <note>`) and notification events (cycle reports, OOR alerts, deploy/close/swap notifications) with identical behaviour.
3. THE Migration_Build SHALL preserve all existing cron schedules (management cycle, screening cycle, health check, dust cleanup, briefing) and their dynamic reconfiguration logic.
4. THE Migration_Build SHALL preserve all existing exit rules (trailing take-profit, stop-loss, OOR, low yield, fee-rate decay, volume decay, IL stop) with identical trigger logic and thresholds.
5. WHEN `DRY_RUN=true` is set, THE Migration_Build SHALL simulate all on-chain transactions without submission, identical to the JavaScript behaviour.
6. THE Migration_Build SHALL preserve the `ONCE_PER_SESSION` and `NO_RETRY_TOOLS` safety sets in the agent loop to prevent duplicate destructive tool calls.

---

### Requirement 12: Logging and Observability

**User Story:** As an operator, I want application logs to be available in CloudWatch, so that I can monitor the agent remotely without SSH access.

#### Acceptance Criteria

1. THE Migration_Build SHALL preserve the existing daily-rotating file logger (`logger.ts`) and its JSONL action audit trail.
2. THE EC2_Instance SHALL have the CloudWatch Unified Agent installed and configured to stream log files from the Meridian log directory to the CloudWatch Log Group defined in `MeridianStack`.
3. WHEN a third-party API error occurs (Meteora, Jupiter, Helius, OpenRouter, Telegram, OKX), THE Migration_Build SHALL log the service name, HTTP status code, and error message at `error` level, preserving the existing `checkAndNotify3rdPartyError` behaviour.
4. THE Migration_Build SHALL preserve the `DRY_RUN` mode log prefix `[DRY RUN]` on all simulated transaction log entries.
