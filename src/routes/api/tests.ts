import { json } from "./helpers";
import { TestCaseDB, TestRunDB } from "../../db-tests";
import { AgentDB } from "../../db";
import { runTest, runAll } from "../../test-runner";

export async function handleTestRoutes(
  req: Request,
  path: string,
  method: string,
): Promise<Response | null> {
  // GET /api/tests - List test cases
  if (path === "/api/tests" && method === "GET") {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("project_id") || undefined;
    const tests = TestCaseDB.findAll(projectId);

    // Enrich with agent name and latest run
    const enriched = tests.map(tc => {
      const agent = tc.agent_id ? AgentDB.findById(tc.agent_id) : null;
      const lastRun = TestRunDB.getLatestByTestCase(tc.id);
      return {
        ...tc,
        agent_name: agent?.name || null,
        agent_status: agent?.status || null,
        last_run: lastRun ? {
          id: lastRun.id,
          status: lastRun.status,
          score: lastRun.score,
          duration_ms: lastRun.duration_ms,
          judge_reasoning: lastRun.judge_reasoning,
          generated_message: lastRun.generated_message,
          selected_agent_id: lastRun.selected_agent_id,
          selected_agent_name: lastRun.selected_agent_name,
          planner_reasoning: lastRun.planner_reasoning,
          created_at: lastRun.created_at,
        } : null,
      };
    });

    return json(enriched);
  }

  // POST /api/tests - Create test case
  if (path === "/api/tests" && method === "POST") {
    const body = await req.json() as any;

    // Behavior-driven: only name + behavior required
    // Legacy: name + agent_id + input_message + eval_criteria required
    if (!body.name) {
      return json({ error: "Missing required field: name" }, 400);
    }

    if (!body.behavior && (!body.agent_id || !body.input_message)) {
      return json({ error: "Either 'behavior' or both 'agent_id' and 'input_message' are required" }, 400);
    }

    // Validate agent if explicitly specified
    if (body.agent_id) {
      const agent = AgentDB.findById(body.agent_id);
      if (!agent) {
        return json({ error: "Agent not found" }, 404);
      }
    }

    const testCase = TestCaseDB.create({
      name: body.name,
      description: body.description,
      behavior: body.behavior,
      agent_id: body.agent_id || null,
      input_message: body.input_message || null,
      eval_criteria: body.eval_criteria,
      project_id: body.project_id,
    });

    return json(testCase, 201);
  }

  // PUT /api/tests/:id - Update test case
  const updateMatch = path.match(/^\/api\/tests\/([^/]+)$/);
  if (updateMatch && method === "PUT") {
    const body = await req.json() as any;
    const updated = TestCaseDB.update(updateMatch[1], body);
    if (!updated) {
      return json({ error: "Test case not found" }, 404);
    }
    return json(updated);
  }

  // DELETE /api/tests/:id - Delete test case
  if (updateMatch && method === "DELETE") {
    const deleted = TestCaseDB.delete(updateMatch[1]);
    if (!deleted) {
      return json({ error: "Test case not found" }, 404);
    }
    return json({ success: true });
  }

  // POST /api/tests/:id/run - Run single test
  const runSingleMatch = path.match(/^\/api\/tests\/([^/]+)\/run$/);
  if (runSingleMatch && method === "POST") {
    const testCase = TestCaseDB.findById(runSingleMatch[1]);
    if (!testCase) {
      return json({ error: "Test case not found" }, 404);
    }

    const result = await runTest(testCase);
    return json(result);
  }

  // POST /api/tests/run - Run all (or filtered) tests
  if (path === "/api/tests/run" && method === "POST") {
    const body = await req.json().catch(() => ({})) as any;
    const testCaseIds = body.test_case_ids as string[] | undefined;

    const results = await runAll(testCaseIds);
    const passed = results.filter(r => r.status === "passed").length;
    const failed = results.filter(r => r.status === "failed").length;
    const errors = results.filter(r => r.status === "error").length;

    return json({
      summary: { total: results.length, passed, failed, errors },
      results,
    });
  }

  // GET /api/tests/:id/runs - Get run history for a test
  const runsMatch = path.match(/^\/api\/tests\/([^/]+)\/runs$/);
  if (runsMatch && method === "GET") {
    const testCase = TestCaseDB.findById(runsMatch[1]);
    if (!testCase) {
      return json({ error: "Test case not found" }, 404);
    }
    const runs = TestRunDB.findByTestCase(runsMatch[1]);
    return json(runs);
  }

  // GET /api/tests/runs/:runId - Get single run details
  const runDetailMatch = path.match(/^\/api\/tests\/runs\/([^/]+)$/);
  if (runDetailMatch && method === "GET") {
    const run = TestRunDB.findById(runDetailMatch[1]);
    if (!run) {
      return json({ error: "Test run not found" }, 404);
    }
    return json(run);
  }

  return null;
}
