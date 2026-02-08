import { getDb, generateId } from "./db";

export interface TestCase {
  id: string;
  name: string;
  description: string | null;
  behavior: string | null;
  agent_id: string | null; // null = auto-select by AI
  input_message: string | null; // null = AI-generated
  eval_criteria: string;
  timeout_ms: number;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestRun {
  id: string;
  test_case_id: string;
  status: "running" | "passed" | "failed" | "error";
  score: number | null;
  agent_response: string | null;
  judge_reasoning: string | null;
  duration_ms: number | null;
  error: string | null;
  generated_message: string | null;
  selected_agent_id: string | null;
  selected_agent_name: string | null;
  planner_reasoning: string | null;
  created_at: string;
}

export const TestCaseDB = {
  findAll(projectId?: string): TestCase[] {
    const db = getDb();
    if (projectId) {
      return db.query("SELECT * FROM test_cases WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as TestCase[];
    }
    return db.query("SELECT * FROM test_cases ORDER BY created_at DESC").all() as TestCase[];
  },

  findById(id: string): TestCase | null {
    const db = getDb();
    return db.query("SELECT * FROM test_cases WHERE id = ?").get(id) as TestCase | null;
  },

  findByAgent(agentId: string): TestCase[] {
    const db = getDb();
    return db.query("SELECT * FROM test_cases WHERE agent_id = ? ORDER BY created_at DESC").all(agentId) as TestCase[];
  },

  create(data: {
    name: string;
    behavior?: string;
    description?: string;
    agent_id?: string | null;
    input_message?: string | null;
    eval_criteria?: string;
    timeout_ms?: number;
    project_id?: string | null;
  }): TestCase {
    const db = getDb();
    const id = generateId();
    const now = new Date().toISOString();
    // For behavior-driven tests, eval_criteria defaults to behavior
    const evalCriteria = data.eval_criteria || data.behavior || "";
    db.run(
      `INSERT INTO test_cases (id, name, description, behavior, agent_id, input_message, eval_criteria, timeout_ms, project_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, data.name, data.description || null, data.behavior || null, data.agent_id || null, data.input_message || null, evalCriteria, data.timeout_ms || 300000, data.project_id || null, now, now]
    );
    return this.findById(id)!;
  },

  update(id: string, data: Partial<Pick<TestCase, "name" | "description" | "behavior" | "agent_id" | "input_message" | "eval_criteria" | "timeout_ms" | "project_id">>): TestCase | null {
    const db = getDb();
    const existing = this.findById(id);
    if (!existing) return null;

    const fields: string[] = [];
    const values: any[] = [];

    if (data.name !== undefined) { fields.push("name = ?"); values.push(data.name); }
    if (data.description !== undefined) { fields.push("description = ?"); values.push(data.description); }
    if (data.behavior !== undefined) { fields.push("behavior = ?"); values.push(data.behavior); }
    if (data.agent_id !== undefined) { fields.push("agent_id = ?"); values.push(data.agent_id); }
    if (data.input_message !== undefined) { fields.push("input_message = ?"); values.push(data.input_message); }
    if (data.eval_criteria !== undefined) { fields.push("eval_criteria = ?"); values.push(data.eval_criteria); }
    if (data.timeout_ms !== undefined) { fields.push("timeout_ms = ?"); values.push(data.timeout_ms); }
    if (data.project_id !== undefined) { fields.push("project_id = ?"); values.push(data.project_id); }

    if (fields.length === 0) return existing;

    fields.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);

    db.run(`UPDATE test_cases SET ${fields.join(", ")} WHERE id = ?`, values);
    return this.findById(id);
  },

  delete(id: string): boolean {
    const db = getDb();
    const result = db.run("DELETE FROM test_cases WHERE id = ?", [id]);
    return result.changes > 0;
  },
};

export const TestRunDB = {
  findByTestCase(testCaseId: string, limit = 20): TestRun[] {
    const db = getDb();
    return db.query("SELECT * FROM test_runs WHERE test_case_id = ? ORDER BY created_at DESC LIMIT ?").all(testCaseId, limit) as TestRun[];
  },

  findById(id: string): TestRun | null {
    const db = getDb();
    return db.query("SELECT * FROM test_runs WHERE id = ?").get(id) as TestRun | null;
  },

  findRecent(limit = 50): TestRun[] {
    const db = getDb();
    return db.query("SELECT * FROM test_runs ORDER BY created_at DESC LIMIT ?").all(limit) as TestRun[];
  },

  create(testCaseId: string): TestRun {
    const db = getDb();
    const id = generateId();
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO test_runs (id, test_case_id, status, created_at) VALUES (?, ?, 'running', ?)",
      [id, testCaseId, now]
    );
    return this.findById(id)!;
  },

  complete(id: string, data: {
    status: "passed" | "failed" | "error";
    score?: number;
    agent_response?: string;
    judge_reasoning?: string;
    duration_ms?: number;
    error?: string;
    generated_message?: string;
    selected_agent_id?: string;
    selected_agent_name?: string;
    planner_reasoning?: string;
  }): TestRun | null {
    const db = getDb();
    db.run(
      `UPDATE test_runs SET status = ?, score = ?, agent_response = ?, judge_reasoning = ?, duration_ms = ?, error = ?,
       generated_message = ?, selected_agent_id = ?, selected_agent_name = ?, planner_reasoning = ?
       WHERE id = ?`,
      [
        data.status,
        data.score ?? null,
        data.agent_response || null,
        data.judge_reasoning || null,
        data.duration_ms || null,
        data.error || null,
        data.generated_message || null,
        data.selected_agent_id || null,
        data.selected_agent_name || null,
        data.planner_reasoning || null,
        id,
      ]
    );
    return this.findById(id);
  },

  getLatestByTestCase(testCaseId: string): TestRun | null {
    const db = getDb();
    return db.query("SELECT * FROM test_runs WHERE test_case_id = ? ORDER BY created_at DESC LIMIT 1").get(testCaseId) as TestRun | null;
  },
};
