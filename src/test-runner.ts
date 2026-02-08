import { AgentDB, generateId } from "./db";
import { TestCaseDB, TestRunDB, type TestCase, type TestRun } from "./db-tests";
import { agentFetch, startAgentProcess } from "./routes/api/agent-utils";
import { ProviderKeys, PROVIDERS } from "./providers";
import { telemetryBroadcaster, type TelemetryEvent } from "./server";

const TAG = "[test-runner]";

interface JudgeResult {
  pass: boolean;
  score: number;
  reasoning: string;
}

interface PlanResult {
  agent_id: string;
  agent_name: string;
  message: string;
  reasoning: string;
}

// 5-minute safety cap for stream consumption
const STREAM_SAFETY_TIMEOUT_MS = 5 * 60 * 1000;

// Broadcast a test telemetry event via SSE
function broadcastTestEvent(
  runId: string,
  testCaseId: string,
  type: string,
  data: Record<string, unknown> = {},
  agentId?: string,
) {
  const event: TelemetryEvent = {
    id: generateId(),
    agent_id: agentId || "system",
    timestamp: new Date().toISOString(),
    category: "test",
    type,
    level: "info",
    trace_id: runId,
    data: { test_case_id: testCaseId, ...data },
  };
  telemetryBroadcaster.broadcast([event]);
}

// Plan a behavior-driven test: AI picks the agent and generates the message
async function planTest(behavior: string, projectId: string | null): Promise<PlanResult> {
  console.log(`${TAG} Planning test for behavior: "${behavior.slice(0, 80)}..." (project: ${projectId || "all"})`);

  // Get available agents
  const agents = projectId
    ? AgentDB.findByProject(projectId)
    : AgentDB.findAll();

  console.log(`${TAG} Found ${agents.length} agent(s) for planning`);

  if (agents.length === 0) {
    throw new Error("No agents available to test");
  }

  const agentDescriptions = agents.map(a => {
    const features = [];
    if (a.features.memory) features.push("memory");
    if (a.features.tasks) features.push("tasks");
    if (a.features.mcp) features.push("MCP tools");
    if (a.features.operator) features.push("browser");
    if (a.features.vision) features.push("vision");
    if (a.features.realtime) features.push("realtime voice");
    const featureStr = features.length > 0 ? ` | Features: ${features.join(", ")}` : "";
    const promptSnippet = a.system_prompt.length > 200
      ? a.system_prompt.slice(0, 200) + "..."
      : a.system_prompt;
    return `- ID: ${a.id} | Name: ${a.name} | Status: ${a.status}${featureStr}\n  System prompt: ${promptSnippet}`;
  }).join("\n");

  const planPrompt = `You are a test planner for an AI agent platform. Given a behavior description, you must:
1. Pick the most appropriate agent to test this behavior
2. Generate a realistic user message that would trigger the described behavior

## Available Agents
${agentDescriptions}

## Behavior to Test
${behavior}

Pick the agent whose capabilities best match this behavior. Prefer running agents when possible.
Generate a natural user message that would test this specific behavior.

Respond with ONLY a JSON object (no markdown, no extra text):
{"agent_id": "the-agent-id", "message": "the message to send", "reasoning": "brief explanation of why this agent and message"}`;

  console.log(`${TAG} Calling LLM planner...`);
  const result = await callLLM(planPrompt);
  console.log(`${TAG} Planner raw response: ${result.slice(0, 300)}`);

  const jsonMatch = result.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Planner returned unparseable response: ${result.slice(0, 200)}`);
  }

  const parsed = JSON.parse(jsonMatch[0]);
  console.log(`${TAG} Planner chose agent_id="${parsed.agent_id}", message="${(parsed.message || "").slice(0, 80)}"`);

  if (!parsed.agent_id || !parsed.message) {
    throw new Error("Planner response missing agent_id or message");
  }

  // Validate the chosen agent exists
  const chosenAgent = agents.find(a => a.id === parsed.agent_id);
  if (!chosenAgent) {
    const fallback = agents[0];
    console.log(`${TAG} Planner picked invalid agent "${parsed.agent_id}", falling back to "${fallback.name}" (${fallback.id})`);
    return {
      agent_id: fallback.id,
      agent_name: fallback.name,
      message: parsed.message,
      reasoning: `${parsed.reasoning} (Note: planner picked invalid agent ${parsed.agent_id}, falling back to ${fallback.name})`,
    };
  }

  console.log(`${TAG} Plan complete: agent="${chosenAgent.name}" (${chosenAgent.id})`);
  return {
    agent_id: chosenAgent.id,
    agent_name: chosenAgent.name,
    message: parsed.message,
    reasoning: parsed.reasoning || "",
  };
}

// Run a single test case
export async function runTest(testCase: TestCase): Promise<TestRun> {
  console.log(`${TAG} ========== Running test "${testCase.name}" (${testCase.id}) ==========`);
  console.log(`${TAG} Test details: behavior=${testCase.behavior ? `"${testCase.behavior.slice(0, 60)}..."` : "null"}, agent_id=${testCase.agent_id || "null"}, input_message=${testCase.input_message ? `"${testCase.input_message.slice(0, 60)}"` : "null"}, project_id=${testCase.project_id || "null"}`);

  const run = TestRunDB.create(testCase.id);
  console.log(`${TAG} Created test run: ${run.id}`);
  const startTime = Date.now();

  broadcastTestEvent(run.id, testCase.id, "test_started", {
    test_name: testCase.name,
    behavior: testCase.behavior || undefined,
  });

  try {
    let agentId = testCase.agent_id;
    let inputMessage = testCase.input_message;
    let plannerReasoning: string | undefined;
    let selectedAgentId: string | undefined;
    let selectedAgentName: string | undefined;
    let generatedMessage: string | undefined;

    // Behavior-driven test: use AI planner to pick agent and generate message
    if (testCase.behavior && (!agentId || !inputMessage)) {
      console.log(`${TAG} Behavior-driven test — running planner (agentId=${agentId || "auto"}, inputMessage=${inputMessage ? "set" : "auto"})`);
      broadcastTestEvent(run.id, testCase.id, "test_planning", { test_name: testCase.name });
      const plan = await planTest(testCase.behavior, testCase.project_id);

      if (!agentId) {
        agentId = plan.agent_id;
        selectedAgentId = plan.agent_id;
        selectedAgentName = plan.agent_name;
        console.log(`${TAG} Planner selected agent: ${plan.agent_name} (${plan.agent_id})`);
      }
      if (!inputMessage) {
        inputMessage = plan.message;
        generatedMessage = plan.message;
        console.log(`${TAG} Planner generated message: "${plan.message.slice(0, 100)}"`);
      }
      plannerReasoning = plan.reasoning;
    }

    if (!agentId || !inputMessage) {
      console.log(`${TAG} ERROR: Missing agentId (${agentId}) or inputMessage (${inputMessage})`);
      return TestRunDB.complete(run.id, {
        status: "error",
        error: "Test requires either behavior description or explicit agent_id + input_message",
        duration_ms: Date.now() - startTime,
      })!;
    }

    console.log(`${TAG} Looking up agent: ${agentId}`);
    const agent = AgentDB.findById(agentId);
    if (!agent) {
      console.log(`${TAG} ERROR: Agent not found: ${agentId}`);
      return TestRunDB.complete(run.id, {
        status: "error",
        error: `Agent not found: ${agentId}`,
        duration_ms: Date.now() - startTime,
        selected_agent_id: selectedAgentId,
        selected_agent_name: selectedAgentName,
        generated_message: generatedMessage,
        planner_reasoning: plannerReasoning,
      })!;
    }

    console.log(`${TAG} Agent "${agent.name}": status=${agent.status}, port=${agent.port}`);

    // Start agent if not running
    if (agent.status !== "running" || !agent.port) {
      console.log(`${TAG} Agent not running, starting...`);
      const startResult = await startAgentProcess(agent, { silent: true });
      console.log(`${TAG} Start result: success=${startResult.success}, port=${startResult.port}, error=${startResult.error || "none"}`);
      if (!startResult.success) {
        return TestRunDB.complete(run.id, {
          status: "error",
          error: `Failed to start agent: ${startResult.error}`,
          duration_ms: Date.now() - startTime,
          selected_agent_id: selectedAgentId,
          selected_agent_name: selectedAgentName,
          generated_message: generatedMessage,
          planner_reasoning: plannerReasoning,
        })!;
      }
    }

    // Re-fetch agent to get updated port
    const runningAgent = AgentDB.findById(agentId)!;
    if (!runningAgent || runningAgent.status !== "running" || !runningAgent.port) {
      console.log(`${TAG} ERROR: Agent still not running after start. status=${runningAgent?.status}, port=${runningAgent?.port}`);
      return TestRunDB.complete(run.id, {
        status: "error",
        error: "Agent failed to start",
        duration_ms: Date.now() - startTime,
        selected_agent_id: selectedAgentId,
        selected_agent_name: selectedAgentName,
        generated_message: generatedMessage,
        planner_reasoning: plannerReasoning,
      })!;
    }

    console.log(`${TAG} Agent running on port ${runningAgent.port}`);

    // 1. Send message via /chat endpoint (thread created automatically by agent)
    console.log(`${TAG} Step 1: Sending message to /chat: "${inputMessage.slice(0, 100)}"`);
    broadcastTestEvent(run.id, testCase.id, "test_executing", {
      test_name: testCase.name,
      agent_name: selectedAgentName || runningAgent.name,
      message: inputMessage.slice(0, 100),
    }, agentId!);
    const chatBody = { message: inputMessage };

    const chatRes = await agentFetch(runningAgent.id, runningAgent.port!, "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chatBody),
    });

    if (!chatRes.ok) {
      const errBody = await chatRes.text();
      console.log(`${TAG} ERROR: Chat failed (${chatRes.status}): ${errBody}`);
      return TestRunDB.complete(run.id, {
        status: "error",
        error: `Chat failed: ${errBody}`,
        duration_ms: Date.now() - startTime,
        selected_agent_id: selectedAgentId,
        selected_agent_name: selectedAgentName,
        generated_message: generatedMessage,
        planner_reasoning: plannerReasoning,
      })!;
    }

    console.log(`${TAG} Chat response started (status ${chatRes.status}, content-type: ${chatRes.headers.get("content-type")})`);

    // 2. Consume the streaming response (5-min safety cap)
    console.log(`${TAG} Step 2: Consuming stream...`);
    const streamText = await consumeStream(chatRes);
    console.log(`${TAG} Stream consumed: ${streamText.length} chars (${(Date.now() - startTime) / 1000}s elapsed)`);

    // 3. Parse SSE events from stream — extract thread_id and assemble response text
    let threadId: string | null = null;
    let messages: any[] = [];
    const contentChunks: string[] = [];

    const lines = streamText.split("\n").filter(l => l.trim());
    let parsedCount = 0;
    for (const line of lines) {
      const sseData = line.startsWith("data: ") ? line.slice(6) : line;
      try {
        const evt = JSON.parse(sseData);
        parsedCount++;
        // Extract thread_id (agent sends type: "thread_id")
        if (evt.type === "thread_id" && evt.thread_id) {
          threadId = evt.thread_id;
          console.log(`${TAG} Found thread_id in SSE: ${threadId}`);
        }
        // Accumulate content chunks
        if (evt.type === "content" && evt.content) {
          contentChunks.push(evt.content);
        }
      } catch {
        // Not valid JSON
      }
    }
    console.log(`${TAG} Parsed ${parsedCount} SSE event(s), ${contentChunks.length} content chunks, threadId=${threadId || "none"}`);

    // Assemble the agent's full text response from content chunks
    const assembledResponse = contentChunks.join("");

    // If we got a threadId, try fetching full thread messages for a structured view
    if (threadId) {
      console.log(`${TAG} Step 3: Fetching thread ${threadId} messages...`);
      const messagesRes = await agentFetch(runningAgent.id, runningAgent.port!, `/threads/${threadId}/messages`, {
        method: "GET",
        headers: { "Accept": "application/json" },
      });

      if (messagesRes.ok) {
        const data = await messagesRes.json();
        messages = Array.isArray(data) ? data : (data.messages || []);
        console.log(`${TAG} Got ${messages.length} message(s) from thread`);
      } else {
        console.log(`${TAG} WARNING: Failed to fetch messages (${messagesRes.status}): ${await messagesRes.text()}`);
      }
    }

    // Fallback: build conversation from assembled SSE content
    if (messages.length === 0 && assembledResponse.length > 0) {
      console.log(`${TAG} Building conversation from SSE content (${assembledResponse.length} chars)`);
      messages = [
        { role: "user", content: inputMessage },
        { role: "assistant", content: assembledResponse },
      ];
    }

    const agentResponse = JSON.stringify(messages, null, 2);

    // 4. Run LLM judge — use behavior as criteria when available
    const evalCriteria = testCase.behavior || testCase.eval_criteria;
    console.log(`${TAG} Step 4: Running LLM judge with criteria: "${evalCriteria.slice(0, 80)}..."`);
    broadcastTestEvent(run.id, testCase.id, "test_judging", { test_name: testCase.name }, agentId!);
    const judgeResult = await judge(messages, evalCriteria);
    console.log(`${TAG} Judge result: pass=${judgeResult.pass}, score=${judgeResult.score}, reasoning="${judgeResult.reasoning.slice(0, 100)}"`);

    const totalMs = Date.now() - startTime;
    console.log(`${TAG} ========== Test "${testCase.name}" ${judgeResult.pass ? "PASSED" : "FAILED"} (score: ${judgeResult.score}/10, ${(totalMs / 1000).toFixed(1)}s) ==========`);

    broadcastTestEvent(run.id, testCase.id, "test_completed", {
      test_name: testCase.name,
      status: judgeResult.pass ? "passed" : "failed",
      score: judgeResult.score,
      duration_ms: totalMs,
      reasoning: judgeResult.reasoning.slice(0, 200),
    }, agentId!);

    return TestRunDB.complete(run.id, {
      status: judgeResult.pass ? "passed" : "failed",
      score: judgeResult.score,
      agent_response: agentResponse,
      judge_reasoning: judgeResult.reasoning,
      duration_ms: totalMs,
      selected_agent_id: selectedAgentId,
      selected_agent_name: selectedAgentName,
      generated_message: generatedMessage,
      planner_reasoning: plannerReasoning,
    })!;
  } catch (err: any) {
    const totalMs = Date.now() - startTime;
    console.log(`${TAG} ========== Test "${testCase.name}" ERROR (${(totalMs / 1000).toFixed(1)}s): ${err.message || err} ==========`);
    console.log(`${TAG} Stack: ${err.stack || "no stack"}`);

    broadcastTestEvent(run.id, testCase.id, "test_completed", {
      test_name: testCase.name,
      status: "error",
      duration_ms: totalMs,
      error: (err.message || String(err)).slice(0, 200),
    });

    return TestRunDB.complete(run.id, {
      status: "error",
      error: err.message || String(err),
      duration_ms: totalMs,
    })!;
  }
}

// Run multiple tests sequentially
export async function runAll(testCaseIds?: string[]): Promise<TestRun[]> {
  const testCases = testCaseIds
    ? testCaseIds.map(id => TestCaseDB.findById(id)).filter(Boolean) as TestCase[]
    : TestCaseDB.findAll();

  console.log(`${TAG} Running ${testCases.length} test(s)`);
  const results: TestRun[] = [];
  for (const tc of testCases) {
    results.push(await runTest(tc));
  }
  console.log(`${TAG} All ${results.length} test(s) complete: ${results.filter(r => r.status === "passed").length} passed, ${results.filter(r => r.status === "failed").length} failed, ${results.filter(r => r.status === "error").length} errors`);
  return results;
}

// Consume a streaming response (SSE or NDJSON) until done, with safety timeout
async function consumeStream(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    console.log(`${TAG} consumeStream: no body reader available`);
    return "";
  }

  const decoder = new TextDecoder();
  let fullText = "";
  let chunks = 0;

  const timeout = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("Stream safety timeout (5 min)")), STREAM_SAFETY_TIMEOUT_MS)
  );

  const consume = async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`${TAG} consumeStream: stream ended after ${chunks} chunks, ${fullText.length} chars`);
        break;
      }
      chunks++;
      const chunk = decoder.decode(value, { stream: true });
      fullText += chunk;
      if (chunks <= 3 || chunks % 10 === 0) {
        console.log(`${TAG} consumeStream: chunk #${chunks} (+${chunk.length} chars, total ${fullText.length})`);
      }
    }
  };

  try {
    await Promise.race([consume(), timeout]);
  } catch (err: any) {
    console.log(`${TAG} consumeStream: error — ${err.message}`);
    reader.cancel();
    if (err.message.includes("safety timeout")) {
      throw err;
    }
  }

  return fullText;
}

// LLM Judge: evaluate conversation thread against criteria
async function judge(messages: any[], criteria: string): Promise<JudgeResult> {
  // Format messages for the judge prompt
  const formattedMessages = messages.map((m: any) => {
    const role = m.role || "unknown";
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.content)) {
      content = m.content.map((block: any) => {
        if (block.type === "text") return block.text;
        if (block.type === "tool_use") return `[Tool Call: ${block.name}(${JSON.stringify(block.input)})]`;
        if (block.type === "tool_result") return `[Tool Result: ${block.content}${block.is_error ? " (ERROR)" : ""}]`;
        return JSON.stringify(block);
      }).join("\n");
    }
    return `${role}: ${content}`;
  }).join("\n\n");

  const judgePrompt = `You are a test evaluator for an AI agent platform. Given a conversation thread between a user and an AI agent, determine if the agent's behavior meets the success criteria.

## Success Criteria
${criteria}

## Conversation Thread
${formattedMessages}

Evaluate whether the agent met the success criteria. Also give a score from 1-10 (10 = perfect).

Respond with ONLY a JSON object (no markdown, no extra text):
{"pass": true, "score": 9, "reasoning": "brief explanation"}
or
{"pass": false, "score": 3, "reasoning": "brief explanation of what failed"}`;

  try {
    console.log(`${TAG} Judge: calling LLM with ${formattedMessages.length} chars of conversation...`);
    const result = await callLLM(judgePrompt);
    console.log(`${TAG} Judge raw response: ${result.slice(0, 200)}`);
    // Parse JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const score = typeof parsed.score === "number" ? Math.max(1, Math.min(10, parsed.score)) : (parsed.pass ? 8 : 3);
      return { pass: !!parsed.pass, score, reasoning: parsed.reasoning || "" };
    }
    return { pass: false, score: 1, reasoning: `Judge returned unparseable response: ${result.slice(0, 200)}` };
  } catch (err: any) {
    console.log(`${TAG} Judge error: ${err.message}`);
    return { pass: false, score: 1, reasoning: `Judge error: ${err.message}` };
  }
}

// Get an LLM provider + key, or throw
function getLLMProvider(): { providerId: string; apiKey: string; provider: any } {
  const configuredProviders = ProviderKeys.getConfiguredProviders();
  console.log(`${TAG} Configured providers: ${configuredProviders.join(", ") || "none"}`);

  const llmProvider = configuredProviders.find(id => {
    const p = PROVIDERS[id as keyof typeof PROVIDERS];
    return p && p.type === "llm" && p.models.length > 0;
  });

  if (!llmProvider) {
    throw new Error("No LLM provider configured");
  }

  const provider = PROVIDERS[llmProvider as keyof typeof PROVIDERS];
  const apiKey = ProviderKeys.getDecrypted(llmProvider);
  if (!apiKey) {
    throw new Error("Failed to retrieve API key for LLM");
  }

  console.log(`${TAG} Using LLM provider: ${llmProvider}`);
  return { providerId: llmProvider, apiKey, provider };
}

// Call LLM provider API
async function callLLM(prompt: string): Promise<string> {
  const { providerId, apiKey, provider } = getLLMProvider();

  // Pick a fast model if available
  const model = provider.models.find((m: any) => m.label?.toLowerCase().includes("fast"))?.value
    || provider.models.find((m: any) => m.label?.toLowerCase().includes("mini"))?.value
    || provider.models[0]?.value;

  console.log(`${TAG} callLLM: provider=${providerId}, model=${model}, prompt=${prompt.length} chars`);

  if (providerId === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    console.log(`${TAG} callLLM: Anthropic response status=${res.status}`);
    const data = await res.json() as any;
    if (!res.ok) {
      console.log(`${TAG} callLLM: Anthropic error: ${JSON.stringify(data).slice(0, 300)}`);
      throw new Error(`Anthropic API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
    }
    return data.content?.[0]?.text || JSON.stringify(data);
  }

  if (providerId === "gemini") {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 512 },
      }),
    });
    console.log(`${TAG} callLLM: Gemini response status=${res.status}`);
    const data = await res.json() as any;
    if (!res.ok) {
      console.log(`${TAG} callLLM: Gemini error: ${JSON.stringify(data).slice(0, 300)}`);
      throw new Error(`Gemini API error ${res.status}: ${JSON.stringify(data)}`);
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(data);
  }

  // OpenAI-compatible (openai, groq, xai, together, fireworks, moonshot)
  const baseUrls: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    groq: "https://api.groq.com/openai/v1",
    xai: "https://api.x.ai/v1",
    together: "https://api.together.xyz/v1",
    fireworks: "https://api.fireworks.ai/inference/v1",
    moonshot: "https://api.moonshot.cn/v1",
  };

  const baseUrl = baseUrls[providerId];
  if (!baseUrl) {
    throw new Error(`Unsupported provider: ${providerId}`);
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  console.log(`${TAG} callLLM: ${providerId} response status=${res.status}`);
  const data = await res.json() as any;
  if (!res.ok) {
    console.log(`${TAG} callLLM: ${providerId} error: ${JSON.stringify(data).slice(0, 300)}`);
    throw new Error(`${providerId} API error ${res.status}: ${data.error?.message || JSON.stringify(data)}`);
  }
  return data.choices?.[0]?.message?.content || JSON.stringify(data);
}
