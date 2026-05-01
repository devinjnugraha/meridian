import OpenAI from "openai";
import { jsonrepair } from "jsonrepair";
import { buildSystemPrompt } from "./prompt.js";
import { executeTool } from "./tools/executor.js";
import { tools } from "./tools/definitions.js";

export const AGENT_ROLE = {
    SCREENER: "SCREENER",
    GENERAL: "GENERAL",
    MANAGER: "MANAGER",
};

const ROLE_MODEL_MAP = {
    SCREENER: () => config.llm.screeningModel,
    GENERAL: () => config.llm.generalModel,
    MANAGER: () => config.llm.managementModel,
    DEFAULT: () => config.llm.defaultModel,
};

// ─── Read-only tools (safe for all roles, no state mutation) ────────────
const READ_ONLY_TOOLS = new Set([
    "get_wallet_balance",
    "get_my_positions",
    "get_wallet_positions",
    "get_position_pnl",
    "get_top_candidates",
    "get_active_bin",
    "get_pool_detail",
    "discover_pools",
    "search_pools",
    "get_token_info",
    "get_token_holders",
    "get_token_narrative",
    "check_smart_wallets_on_pool",
    "list_smart_wallets",
    "get_top_lpers",
    "study_top_lpers",
    "get_pool_memory",
    "get_cooldown_tokens",
    "get_pool_history",
    "get_performance_history",
    "get_recent_decisions",
    "list_lessons",
    "list_strategies",
    "get_strategy",
    "list_blacklist",
    "list_blocked_deployers",
    "get_config",
]);

// ─── Write tools (on-chain or persistent state mutation) ────────────────
// Also defined in executor.js WRITE_TOOLS — keep in sync.
const WRITE_TOOLS_AGENT = new Set([
    "deploy_position",
    "claim_fees",
    "close_position",
    "swap_token",
    "rebalance_position",
    "compound_fees",
    "add_liquidity_to_position",
    "clean_dust_tokens",
]);

const MANAGER_TOOLS = new Set([
    ...READ_ONLY_TOOLS,
    ...WRITE_TOOLS_AGENT,
    "update_config",
    "add_to_blacklist",
    "set_position_note",
    "add_pool_note",
    "get_performance_history",
]);
const SCREENER_TOOLS = new Set([
    ...READ_ONLY_TOOLS,
    "deploy_position",
    "skip_deploy",
    "update_config",
    "add_to_blacklist",
    "add_pool_note",
]);
// Intent → tool subsets for GENERAL role (write/meta tools only — read tools always included)
const INTENT_TOOLS = {
    decisions: new Set(["get_recent_decisions"]),
    deploy: new Set(["deploy_position", "add_pool_note"]),
    close: new Set(["close_position", "swap_token"]),
    claim: new Set(["claim_fees"]),
    swap: new Set(["swap_token"]),
    config: new Set(["update_config"]),
    blocklist: new Set(["add_to_blacklist", "remove_from_blacklist", "block_deployer", "unblock_deployer"]),
    selfupdate: new Set(["self_update"]),
    balance: new Set([]),
    positions: new Set(["set_position_note"]),
    strategy: new Set(["add_strategy", "remove_strategy", "set_active_strategy"]),
    screen: new Set([]),
    memory: new Set(["add_pool_note", "add_to_blacklist", "remove_from_blacklist"]),
    smartwallet: new Set(["add_smart_wallet", "remove_smart_wallet"]),
    study: new Set(["add_smart_wallet"]),
    performance: new Set([]),
    lessons: new Set(["add_lesson", "pin_lesson", "unpin_lesson", "clear_lessons"]),
    cleanup: new Set(["clean_dust_tokens"]),
};

const INTENT_PATTERNS = [
    {
        intent: "decisions",
        re: /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i,
    },
    { intent: "deploy", re: /\b(deploy|open|add liquidity|lp into|invest in)\b/i },
    { intent: "close", re: /\b(close|exit|withdraw|remove liquidity|shut down)\b/i },
    { intent: "claim", re: /\b(claim|harvest|collect)\b.*\bfee/i },
    { intent: "swap", re: /\b(swap|convert|sell|exchange)\b/i },
    { intent: "selfupdate", re: /\b(self.?update|git pull|pull latest|update (the )?bot|update (the )?agent|update yourself)\b/i },
    { intent: "blocklist", re: /\b(blacklist|block|unblock|blocklist|blocked deployer|rugger|block dev|block deployer)\b/i },
    { intent: "config", re: /\b(config|setting|threshold|update|set |change)\b/i },
    { intent: "balance", re: /\b(balance|wallet|sol|how much)\b/i },
    { intent: "positions", re: /\b(position|portfolio|open|pnl|yield|range)\b/i },
    { intent: "strategy", re: /\b(strategy|strategies)\b/i },
    { intent: "screen", re: /\b(screen|candidate|find pool|search|research|token)\b/i },
    { intent: "memory", re: /\b(memory|pool history|note|remember)\b/i },
    {
        intent: "smartwallet",
        re: /\b(smart wallet|kol|whale|watch.?list|add wallet|remove wallet|list wallet|tracked wallet|check pool|who.?s in|wallets in|add to (smart|watch|kol))\b/i,
    },
    { intent: "study", re: /\b(study top|top lpers?|best lpers?|who.?s lping|lp behavior|lpers?)\b/i },
    { intent: "performance", re: /\b(performance|history|how.?s the bot|how.?s it doing|stats|report)\b/i },
    { intent: "lessons", re: /\b(lesson|learned|teach|pin|unpin|clear lesson|what did you learn)\b/i },
    { intent: "cleanup", re: /\b(dust|cleanup|clean.?up|reclaim|sweep)\b/i },
];

function getToolsForRole(agentType, goal = "") {
    if (agentType === "MANAGER") return tools.filter((t) => MANAGER_TOOLS.has(t.function.name));
    if (agentType === "SCREENER") return tools.filter((t) => SCREENER_TOOLS.has(t.function.name));

    // GENERAL: always gets all read-only tools, plus intent-matched write/meta tools
    const matched = new Set([...READ_ONLY_TOOLS]);
    for (const { intent, re } of INTENT_PATTERNS) {
        if (re.test(goal)) {
            for (const t of INTENT_TOOLS[intent]) matched.add(t);
        }
    }

    // If no intent matched, return read-only only
    return tools.filter((t) => matched.has(t.function.name));
}
import { getWalletBalances } from "./tools/wallet.js";
import { getMyPositions } from "./tools/dlmm.js";
import { log } from "./logger.js";
import { config } from "./config.js";
import { getStateSummary } from "./state.js";
import { getLessonsForPrompt, getPerformanceSummary } from "./lessons.js";
import { getDecisionSummary } from "./decision-log.js";

// Supports OpenRouter (default) or any OpenAI-compatible local server (e.g. LM Studio)
// To use LM Studio: set LLM_BASE_URL=http://localhost:1234/v1 and LLM_API_KEY=lm-studio in .env
const client = new OpenAI({
    baseURL: process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1",
    apiKey: process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY,
    timeout: 5 * 60 * 1000,
});

const MUTATING_TOOL_INTENTS =
    /\b(deploy|open position|add liquidity|lp into|invest in|close|exit|withdraw|remove liquidity|claim|harvest|collect|swap|convert|sell|exchange|block|unblock|blacklist|add smart wallet|remove smart wallet|add wallet|remove wallet|pin|unpin|clear lesson|add lesson|set active strategy|remove strategy|add strategy|set |change |update |self.?update|pull latest|git pull|update yourself)\b/i;
const LIVE_DATA_TOOL_INTENTS =
    /\b(balance|wallet|position|portfolio|pnl|yield|range|show positions|open positions|screen|candidate|find pool|search|research|analyze|check pool|token holders|narrative|study top|top lpers?|lp behavior|who.?s lping|performance|history|stats|report|list smart wallets|list blacklist|list blocked deployers|list lessons)\b/i;
const CONFIG_READ_ONLY_INTENTS = /\b(check|show|what(?:'s| is)?|review|inspect|see)\b.*\b(config|settings?|thresholds?)\b/i;
const DECISION_EXPLANATION_INTENTS =
    /\b(why did you|why'd you|why was (?:this|that|it)|what made you|what was the reason|why no deploy|why didn't you deploy|why did you close|why did you deploy|why did you skip)\b/i;

function shouldRequireRealToolUse(goal, agentType, interactive = false) {
    if (agentType === "MANAGER") return false;
    if (DECISION_EXPLANATION_INTENTS.test(goal)) return false;
    if (CONFIG_READ_ONLY_INTENTS.test(goal)) return false;
    if (MUTATING_TOOL_INTENTS.test(goal)) return true;
    return interactive && LIVE_DATA_TOOL_INTENTS.test(goal);
}

function buildMessages(systemPrompt, sessionHistory, goal, providerMode = "system") {
    if (providerMode === "user_embedded") {
        return [
            ...sessionHistory,
            {
                role: "user",
                content: `[SYSTEM INSTRUCTIONS]\n${systemPrompt}\n\n[USER REQUEST]\n${goal}`,
            },
        ];
    }

    return [{ role: "system", content: systemPrompt }, ...sessionHistory, { role: "user", content: goal }];
}

function isSystemRoleError(error) {
    const message = String(error?.message || error?.error?.message || error || "");
    return /invalid message role:\s*system/i.test(message);
}

function isToolChoiceRequiredError(error) {
    const message = String(error?.message || error?.error?.message || error || "");
    return /tool.?choice/i.test(message);
}

/**
 * Core ReAct agent loop.
 *
 * @param {string} goal - The task description for the agent
 * @param {number} maxSteps - Safety limit on iterations (default 20)
 * @returns {string} - The agent's final text response
 */
export async function agentLoop(
    goal,
    maxSteps = config.llm.maxSteps,
    sessionHistory = [],
    agentType = AGENT_ROLE.GENERAL,
    maxOutputTokens = null,
    options = {},
) {
    const { interactive = false, onToolStart = null, onToolFinish = null, breakOnTools = null } = options;
    const model = ROLE_MODEL_MAP[agentType]?.() ?? ROLE_MODEL_MAP.DEFAULT();
    // Build dynamic system prompt with current portfolio state
    // SCREENER doesn't need wallet balance (no balance-dependent decisions) — skip to save 100 Helius credits/call
    const positions = await getMyPositions();
    const portfolio = agentType === "SCREENER" ? null : await getWalletBalances();
    const stateSummary = getStateSummary();
    const lessons = getLessonsForPrompt({ agentType });
    const perfSummary = getPerformanceSummary();
    const decisionSummary = getDecisionSummary();
    let weightsSummary = null;
    if (agentType === "SCREENER") {
        try {
            const { getWeightsSummary } = await import("./signal-weights.js");
            const { config } = await import("./config.js");
            if (config.darwin?.enabled) weightsSummary = getWeightsSummary();
        } catch {
            /* signal-weights not critical */
        }
    }
    const systemPrompt = buildSystemPrompt(
        agentType,
        portfolio,
        positions,
        stateSummary,
        lessons,
        perfSummary,
        weightsSummary,
        decisionSummary,
    );

    let providerMode = "system";
    let messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);

    // Track write tools fired this session — prevent the model from calling the same
    // destructive tool twice (e.g. deploy twice, swap twice after auto-swap)
    const ONCE_PER_SESSION = new Set(["deploy_position", "swap_token", "close_position"]);
    // These lock after first attempt regardless of success — retrying them is always wrong
    const NO_RETRY_TOOLS = new Set(["deploy_position"]);
    const firedOnce = new Set();
    const mustUseRealTool = shouldRequireRealToolUse(goal, agentType, interactive);
    let sawToolCall = false;
    let noToolRetryCount = 0;

    for (let step = 0; step < maxSteps; step++) {
        log(`agent|${agentType}`, `Step ${step + 1}/${maxSteps}`);

        try {
            // Retry up to 3 times on transient provider errors (502, 503, 529)
            const FALLBACK_MODEL = ROLE_MODEL_MAP.DEFAULT();
            let response;
            let usedModel = model;
            // Force a tool call on step 0 for action intents — prevents the model from inventing deploy/close outcomes
            const ACTION_INTENTS = /\b(deploy|open|add liquidity|close|exit|withdraw|claim|swap|block|unblock)\b/i;
            let toolChoice = step === 0 && (ACTION_INTENTS.test(goal) || mustUseRealTool) ? "required" : "auto";

            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const reqParams = {
                        model: usedModel,
                        messages,
                        tools: getToolsForRole(agentType, goal),
                        temperature: config.llm.temperature,
                        max_tokens: maxOutputTokens ?? config.llm.maxTokens,
                    };
                    if (toolChoice !== undefined) reqParams.tool_choice = toolChoice;
                    response = await client.chat.completions.create(reqParams);
                } catch (error) {
                    if (providerMode === "system" && isSystemRoleError(error)) {
                        providerMode = "user_embedded";
                        messages = buildMessages(systemPrompt, sessionHistory, goal, providerMode);
                        log(`agent|${agentType}`, "Provider rejected system role — retrying with embedded system instructions");
                        attempt -= 1;
                        continue;
                    }
                    if (isToolChoiceRequiredError(error)) {
                        const wanted = toolChoice;
                        toolChoice = undefined; // omit from request entirely
                        log(`agent|${agentType}`, `Provider rejected tool_choice=${wanted} — retrying without tool_choice`);
                        if (wanted === "required") {
                            // Nudge the model via a system message since we can't enforce via API
                            messages.push({
                                role: providerMode === "system" ? "system" : "user",
                                content:
                                    providerMode === "system"
                                        ? "IMPORTANT: You MUST call a tool before responding. Do not answer without using at least one tool."
                                        : "[SYSTEM REMINDER]\nIMPORTANT: You MUST call a tool before responding. Do not answer without using at least one tool.",
                            });
                        }
                        attempt -= 1;
                        continue;
                    }
                    throw error;
                }
                if (response.choices?.length) break;
                const errCode = response.error?.code;
                if (errCode === 502 || errCode === 503 || errCode === 529) {
                    const wait = (attempt + 1) * 5000;
                    if (attempt === 1 && usedModel !== FALLBACK_MODEL) {
                        usedModel = FALLBACK_MODEL;
                        log(`agent|${agentType}`, `Switching to fallback model ${FALLBACK_MODEL}`);
                    } else {
                        log(`agent|${agentType}`, `Provider error ${errCode}, retrying in ${wait / 1000}s (attempt ${attempt + 1}/3)`);
                        await new Promise((r) => setTimeout(r, wait));
                    }
                } else {
                    break;
                }
            }

            if (!response.choices?.length) {
                log("error", `Bad API response: ${JSON.stringify(response).slice(0, 200)}`);
                throw new Error(`API returned no choices: ${response.error?.message || JSON.stringify(response)}`);
            }
            const msg = response.choices[0].message;
            // Repair malformed tool call JSON before pushing to history —
            // the API rejects the next request if history contains invalid JSON args
            if (msg.tool_calls) {
                for (const tc of msg.tool_calls) {
                    if (tc.function?.arguments) {
                        try {
                            JSON.parse(tc.function.arguments);
                        } catch {
                            try {
                                tc.function.arguments = JSON.stringify(JSON.parse(jsonrepair(tc.function.arguments)));
                                log("warn", `Repaired malformed JSON args for ${tc.function.name}`);
                            } catch {
                                tc.function.arguments = "{}";
                                log("error", `Could not repair JSON args for ${tc.function.name} — cleared to {}`);
                            }
                        }
                    }
                }
            }
            messages.push(msg);

            // If the model didn't call any tools, it's done
            if (!msg.tool_calls || msg.tool_calls.length === 0) {
                // Hermes sometimes returns null content — pop the empty message and retry once
                if (!msg.content) {
                    messages.pop(); // remove the empty assistant message
                    log(`agent|${agentType}`, "Empty response, retrying...");
                    continue;
                }
                if (mustUseRealTool && !sawToolCall) {
                    noToolRetryCount += 1;
                    messages.pop();
                    log(`agent|${agentType}`, `Rejected no-tool final answer (${noToolRetryCount}/2) for tool-required request`);
                    if (noToolRetryCount >= 2) {
                        return {
                            content:
                                "I couldn't complete that reliably because no tool call was made. Please retry after checking the logs.",
                            userMessage: goal,
                        };
                    }
                    messages.push({
                        role: providerMode === "system" ? "system" : "user",
                        content:
                            providerMode === "system"
                                ? "You have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result."
                                : "[SYSTEM REMINDER]\nYou have not used any tool yet. This request requires real tool execution or live tool-backed data. Do not answer from memory or inference. Call the appropriate tool first, then report only the real result.",
                    });
                    continue;
                }
                log(`agent|${agentType}`, "Final answer reached");
                log(`agent|${agentType}`, msg.content);
                return { content: msg.content, userMessage: goal };
            }
            sawToolCall = true;

            // Execute each tool call in parallel
            const toolResults = await Promise.all(
                msg.tool_calls.map(async (toolCall) => {
                    const functionName = toolCall.function.name.replace(/<.*$/, "").trim();
                    let functionArgs;

                    try {
                        functionArgs = JSON.parse(toolCall.function.arguments);
                    } catch {
                        try {
                            functionArgs = JSON.parse(jsonrepair(toolCall.function.arguments));
                            log("warn", `Repaired malformed JSON args for ${functionName}`);
                        } catch (parseError) {
                            log("error", `Failed to parse args for ${functionName}: ${parseError.message}`);
                            functionArgs = {};
                        }
                    }

                    // Block once-per-session tools from firing a second time
                    if (ONCE_PER_SESSION.has(functionName) && firedOnce.has(functionName)) {
                        log(`agent|${agentType}`, `Blocked duplicate ${functionName} call — already executed this session`);
                        await onToolFinish?.({
                            name: functionName,
                            args: functionArgs,
                            result: {
                                blocked: true,
                                reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.`,
                            },
                            success: false,
                            step,
                        });
                        return {
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: JSON.stringify({
                                blocked: true,
                                reason: `${functionName} already attempted this session — do not retry. If it failed, report the error and stop.`,
                            }),
                        };
                    }

                    await onToolStart?.({ name: functionName, args: functionArgs, step });
                    const result = await executeTool(functionName, functionArgs);
                    await onToolFinish?.({
                        name: functionName,
                        args: functionArgs,
                        result,
                        success: result?.success !== false && !result?.error && !result?.blocked,
                        step,
                    });

                    // Lock deploy_position after first attempt regardless of outcome — retrying is never right
                    // For close/swap: only lock on success so genuine failures can be retried
                    if (NO_RETRY_TOOLS.has(functionName)) firedOnce.add(functionName);
                    else if (ONCE_PER_SESSION.has(functionName) && result.success === true) firedOnce.add(functionName);

                    return {
                        role: "tool",
                        tool_call_id: toolCall.id,
                        content: JSON.stringify(result),
                    };
                }),
            );

            messages.push(...toolResults);

            // Break early if a breakOnTool was called (e.g. screening: skip second LLM call)
            if (breakOnTools?.length) {
                const toolNames = msg.tool_calls.map((tc) => tc.function.name);
                if (toolNames.some((tn) => breakOnTools.includes(tn))) {
                    log(`agent|${agentType}`, `Breaking early after ${toolNames.join(", ")}`);
                    return {
                        content: msg.content,
                        userMessage: goal,
                        earlyStop: true,
                        assistantMessage: msg,
                        toolResults,
                    };
                }
            }
        } catch (error) {
            log("error", `Agent loop error at step ${step}: ${error.message}`);

            // If it's a rate limit, wait and retry
            if (error.status === 429) {
                log(`agent|${agentType}`, "Rate limited, waiting 30s...");
                await sleep(30000);
                continue;
            }

            // For other errors, break the loop
            throw error;
        }
    }

    log(`agent|${agentType}`, "Max steps reached without final answer");
    return { content: "Max steps reached. Review logs for partial progress.", userMessage: goal };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
