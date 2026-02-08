import React, { useState, useEffect, useRef } from "react";
import { useAuth, useProjects } from "../../context";
import { useTelemetry } from "../../context/TelemetryContext";
import { useConfirm } from "../common/Modal";
import { Select } from "../common/Select";

interface TestCase {
  id: string;
  name: string;
  description: string | null;
  behavior: string | null;
  agent_id: string | null;
  input_message: string | null;
  eval_criteria: string;
  timeout_ms: number;
  project_id: string | null;
  created_at: string;
  updated_at: string;
  agent_name: string | null;
  agent_status: string | null;
  last_run: {
    id: string;
    status: string;
    score: number | null;
    duration_ms: number | null;
    judge_reasoning: string | null;
    generated_message: string | null;
    selected_agent_id: string | null;
    selected_agent_name: string | null;
    planner_reasoning: string | null;
    created_at: string;
  } | null;
}

interface TestRun {
  id: string;
  test_case_id: string;
  status: string;
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

interface AgentOption {
  id: string;
  name: string;
  status: string;
  provider: string;
  model: string;
  projectId: string | null;
}

export function TestsPage() {
  const { authFetch } = useAuth();
  const { currentProjectId } = useProjects();
  const { confirm, ConfirmDialog } = useConfirm();

  const [tests, setTests] = useState<TestCase[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingTest, setEditingTest] = useState<TestCase | null>(null);
  const [runningTests, setRunningTests] = useState<Set<string>>(new Set());
  const [runningAll, setRunningAll] = useState(false);
  const [selectedRuns, setSelectedRuns] = useState<{ testId: string; runs: TestRun[] } | null>(null);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  // Live test status from telemetry SSE
  const [liveStatus, setLiveStatus] = useState<Record<string, { phase: string; detail?: string }>>({});

  // Form state
  const [formName, setFormName] = useState("");
  const [formBehavior, setFormBehavior] = useState("");
  const [formAgentId, setFormAgentId] = useState(""); // empty = auto

  const activeProjectId = currentProjectId && currentProjectId !== "all" && currentProjectId !== "unassigned"
    ? currentProjectId : null;

  // Filter agents to current project
  const projectAgents = activeProjectId
    ? agents.filter(a => a.projectId === activeProjectId)
    : agents;

  // Subscribe to test telemetry events for live status
  const { events: testEvents } = useTelemetry({ category: "test", limit: 50 });
  const processedEventsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const evt of testEvents) {
      if (processedEventsRef.current.has(evt.id)) continue;
      processedEventsRef.current.add(evt.id);

      const testCaseId = evt.data?.test_case_id as string;
      if (!testCaseId) continue;

      if (evt.type === "test_started") {
        setLiveStatus(prev => ({ ...prev, [testCaseId]: { phase: "starting" } }));
        setRunningTests(prev => new Set(prev).add(testCaseId));
      } else if (evt.type === "test_planning") {
        setLiveStatus(prev => ({ ...prev, [testCaseId]: { phase: "planning" } }));
      } else if (evt.type === "test_executing") {
        const agentName = evt.data?.agent_name as string;
        setLiveStatus(prev => ({ ...prev, [testCaseId]: { phase: "executing", detail: agentName } }));
      } else if (evt.type === "test_judging") {
        setLiveStatus(prev => ({ ...prev, [testCaseId]: { phase: "judging" } }));
      } else if (evt.type === "test_completed") {
        setLiveStatus(prev => {
          const next = { ...prev };
          delete next[testCaseId];
          return next;
        });
        setRunningTests(prev => {
          const next = new Set(prev);
          next.delete(testCaseId);
          return next;
        });
        // Refresh test list to get updated results
        fetchTests();
      }
    }
    // Cap processed set to prevent unbounded growth
    if (processedEventsRef.current.size > 500) {
      processedEventsRef.current = new Set([...processedEventsRef.current].slice(-200));
    }
  }, [testEvents]);

  const fetchTests = async () => {
    try {
      const params = activeProjectId ? `?project_id=${activeProjectId}` : "";
      const res = await authFetch(`/api/tests${params}`);
      if (res.ok) setTests(await res.json());
    } catch { /* ignore */ }
    setLoading(false);
  };

  const fetchAgents = async () => {
    try {
      const res = await authFetch("/api/agents");
      if (res.ok) {
        const data = await res.json();
        setAgents((data.agents || data).map((a: any) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          provider: a.provider,
          model: a.model,
          projectId: a.projectId || null,
        })));
      }
    } catch { /* ignore */ }
  };

  useEffect(() => {
    fetchTests();
    fetchAgents();
  }, [currentProjectId]);

  const openCreate = () => {
    setEditingTest(null);
    setFormName("");
    setFormBehavior("");
    setFormAgentId("");
    setShowForm(true);
  };

  const openEdit = (tc: TestCase) => {
    setEditingTest(tc);
    setFormName(tc.name);
    setFormBehavior(tc.behavior || "");
    setFormAgentId(tc.agent_id || "");
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!formName || !formBehavior) return;

    const body: any = {
      name: formName,
      behavior: formBehavior,
      agent_id: formAgentId || null,
      project_id: activeProjectId || undefined,
    };

    if (editingTest) {
      await authFetch(`/api/tests/${editingTest.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } else {
      await authFetch("/api/tests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    setShowForm(false);
    fetchTests();
  };

  const handleDelete = async (id: string) => {
    const ok = await confirm("Delete this test case? Run history will also be deleted.");
    if (!ok) return;
    await authFetch(`/api/tests/${id}`, { method: "DELETE" });
    fetchTests();
  };

  const handleRun = async (id: string) => {
    setRunningTests(prev => new Set(prev).add(id));
    try {
      await authFetch(`/api/tests/${id}/run`, { method: "POST" });
      // Telemetry SSE handles live status updates; final refresh on completion
      await fetchTests();
    } catch { /* ignore */ }
    // Cleanup in case telemetry didn't fire
    setRunningTests(prev => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setLiveStatus(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleRunAll = async () => {
    setRunningAll(true);
    try {
      const ids = tests.map(t => t.id);
      setRunningTests(new Set(ids));
      await authFetch("/api/tests/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test_case_ids: ids }),
      });
      await fetchTests();
    } catch { /* ignore */ }
    setRunningTests(new Set());
    setRunningAll(false);
  };

  const viewRuns = async (testId: string) => {
    try {
      const res = await authFetch(`/api/tests/${testId}/runs`);
      if (res.ok) {
        setSelectedRuns({ testId, runs: await res.json() });
      }
    } catch { /* ignore */ }
  };

  const phaseLabels: Record<string, { label: string; color: string }> = {
    starting: { label: "Starting", color: "bg-blue-900/50 text-blue-400 border-blue-500/30" },
    planning: { label: "Planning", color: "bg-purple-900/50 text-purple-400 border-purple-500/30" },
    executing: { label: "Executing", color: "bg-cyan-900/50 text-cyan-400 border-cyan-500/30" },
    judging: { label: "Judging", color: "bg-amber-900/50 text-amber-400 border-amber-500/30" },
  };

  const statusBadge = (status: string) => {
    const colors: Record<string, string> = {
      passed: "bg-green-900/50 text-green-400",
      failed: "bg-red-900/50 text-red-400",
      error: "bg-yellow-900/50 text-yellow-400",
      running: "bg-blue-900/50 text-blue-400",
    };
    return (
      <span className={`px-2 py-0.5 rounded text-xs font-medium ${colors[status] || "bg-[#222] text-[#666]"}`}>
        {status.toUpperCase()}
      </span>
    );
  };

  const liveBadge = (testCaseId: string) => {
    const live = liveStatus[testCaseId];
    if (!live) return null;
    const phase = phaseLabels[live.phase] || phaseLabels.starting;
    return (
      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium border ${phase.color} animate-pulse`}>
        <span className="w-1.5 h-1.5 rounded-full bg-current" />
        {phase.label}{live.detail ? ` \u00b7 ${live.detail}` : ""}
      </span>
    );
  };

  return (
    <div className="flex-1 overflow-auto p-6">
      {ConfirmDialog}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold">Tests</h1>
          <p className="text-sm text-[#666] mt-1">
            Describe behavior, AI handles the rest
          </p>
        </div>
        <div className="flex gap-2">
          {tests.length > 0 && (
            <button
              onClick={handleRunAll}
              disabled={runningAll}
              className="px-4 py-2 bg-[#1a1a1a] hover:bg-[#222] text-[#e0e0e0] rounded text-sm font-medium transition disabled:opacity-50"
            >
              {runningAll ? "Running..." : "Run All"}
            </button>
          )}
          <button
            onClick={openCreate}
            className="px-4 py-2 bg-[#f97316] hover:bg-[#fb923c] text-white rounded text-sm font-medium transition"
          >
            + New Test
          </button>
        </div>
      </div>

      {/* Test list */}
      {loading ? (
        <div className="text-[#666] text-sm">Loading...</div>
      ) : tests.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-[#333] text-4xl mb-4">
            <svg className="w-12 h-12 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <p className="text-[#666] mb-2">No tests yet</p>
          <p className="text-xs text-[#555] mb-4">Describe what your agents should do and let AI verify it</p>
          <button
            onClick={openCreate}
            className="px-4 py-2 bg-[#f97316] hover:bg-[#fb923c] text-white rounded text-sm font-medium transition"
          >
            Create your first test
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {tests.map(tc => (
            <div key={tc.id} className="bg-[#111] border border-[#1a1a1a] rounded-lg p-4">
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-sm">{tc.name}</span>
                    {liveStatus[tc.id]
                      ? liveBadge(tc.id)
                      : tc.last_run && (<>
                          {statusBadge(tc.last_run.status)}
                          {tc.last_run.score != null && (
                            <span className="text-xs text-[#888] font-mono">{tc.last_run.score}/10</span>
                          )}
                        </>)
                    }
                  </div>
                  {tc.behavior && (
                    <p className="text-xs text-[#888] mb-1.5 line-clamp-2">{tc.behavior}</p>
                  )}
                  <div className="text-xs text-[#666] space-y-0.5">
                    <div>
                      Agent:{" "}
                      <span className="text-[#888]">
                        {tc.agent_name || (tc.last_run?.selected_agent_name
                          ? `${tc.last_run.selected_agent_name} (auto-selected)`
                          : "Auto (AI picks)")}
                      </span>
                    </div>
                    {tc.last_run?.generated_message && (
                      <div className="truncate">
                        Message: <span className="text-[#888]">"{tc.last_run.generated_message}"</span>
                      </div>
                    )}
                    {tc.input_message && !tc.last_run?.generated_message && (
                      <div className="truncate">
                        Message: <span className="text-[#888]">"{tc.input_message}"</span>
                      </div>
                    )}
                    {tc.last_run && (
                      <div>
                        Last run:{" "}
                        <span className="text-[#888]">
                          {tc.last_run.duration_ms ? `${(tc.last_run.duration_ms / 1000).toFixed(1)}s` : "---"}
                          {tc.last_run.judge_reasoning && ` --- "${tc.last_run.judge_reasoning.slice(0, 80)}${tc.last_run.judge_reasoning.length > 80 ? "..." : ""}"`}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 ml-3 shrink-0">
                  <button
                    onClick={() => viewRuns(tc.id)}
                    className="px-2 py-1 text-xs text-[#666] hover:text-[#888] hover:bg-[#1a1a1a] rounded transition"
                    title="View run history"
                  >
                    History
                  </button>
                  <button
                    onClick={() => handleRun(tc.id)}
                    disabled={runningTests.has(tc.id)}
                    className="px-3 py-1 text-xs bg-[#1a1a1a] hover:bg-[#222] text-[#e0e0e0] rounded transition disabled:opacity-50"
                  >
                    {runningTests.has(tc.id) ? "Running..." : "Run"}
                  </button>
                  <button
                    onClick={() => openEdit(tc)}
                    className="px-2 py-1 text-xs text-[#666] hover:text-[#888] hover:bg-[#1a1a1a] rounded transition"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(tc.id)}
                    className="px-2 py-1 text-xs text-[#666] hover:text-red-400 hover:bg-[#1a1a1a] rounded transition"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Run History Panel */}
      {selectedRuns && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-[#888]">Run History</h2>
            <button
              onClick={() => { setSelectedRuns(null); setExpandedRun(null); }}
              className="text-xs text-[#666] hover:text-[#888]"
            >
              Close
            </button>
          </div>
          {selectedRuns.runs.length === 0 ? (
            <p className="text-sm text-[#666]">No runs yet</p>
          ) : (
            <div className="space-y-2">
              {selectedRuns.runs.map(run => (
                <div key={run.id} className="bg-[#0d0d0d] border border-[#1a1a1a] rounded p-3">
                  <div
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                  >
                    <div className="flex items-center gap-3">
                      {statusBadge(run.status)}
                      <span className="text-xs text-[#666]">
                        {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(1)}s` : "---"}
                      </span>
                      {run.score != null && (
                        <span className="text-xs text-[#888] font-mono">{run.score}/10</span>
                      )}
                      {run.selected_agent_name && (
                        <span className="text-xs text-[#555]">
                          Agent: {run.selected_agent_name}
                        </span>
                      )}
                      <span className="text-xs text-[#555]">
                        {new Date(run.created_at).toLocaleString()}
                      </span>
                    </div>
                    <span className="text-xs text-[#555]">{expandedRun === run.id ? "---" : "+"}</span>
                  </div>
                  {expandedRun === run.id && (
                    <div className="mt-3 space-y-2">
                      {run.planner_reasoning && (
                        <div>
                          <div className="text-xs text-[#666] mb-1">Planner:</div>
                          <div className="text-sm text-[#aaa] bg-[#0a0a0a] p-2 rounded">
                            {run.selected_agent_name && <span className="text-[#f97316]">{run.selected_agent_name}</span>}
                            {run.selected_agent_name && " --- "}
                            {run.planner_reasoning}
                          </div>
                        </div>
                      )}
                      {run.generated_message && (
                        <div>
                          <div className="text-xs text-[#666] mb-1">Generated Message:</div>
                          <div className="text-sm text-[#aaa] bg-[#0a0a0a] p-2 rounded">"{run.generated_message}"</div>
                        </div>
                      )}
                      {run.judge_reasoning && (
                        <div>
                          <div className="text-xs text-[#666] mb-1">Judge:</div>
                          <div className="text-sm text-[#aaa] bg-[#0a0a0a] p-2 rounded">{run.judge_reasoning}</div>
                        </div>
                      )}
                      {run.error && (
                        <div>
                          <div className="text-xs text-red-400 mb-1">Error:</div>
                          <div className="text-sm text-red-300 bg-[#0a0a0a] p-2 rounded">{run.error}</div>
                        </div>
                      )}
                      {run.agent_response && (
                        <div>
                          <div className="text-xs text-[#666] mb-1">Agent Response (Thread):</div>
                          <pre className="text-xs text-[#888] bg-[#0a0a0a] p-2 rounded overflow-auto max-h-64">
                            {run.agent_response}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create/Edit Form Modal */}
      {showForm && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center" onClick={() => setShowForm(false)}>
          <div className="bg-[#111] border border-[#1a1a1a] rounded-lg w-full max-w-lg mx-4 p-6" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold mb-4">{editingTest ? "Edit Test" : "New Test"}</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-[#666] mb-1">Name</label>
                <input
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g. Social Media Posting"
                  className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#f97316]"
                />
              </div>

              <div>
                <label className="block text-xs text-[#666] mb-1">Behavior</label>
                <textarea
                  value={formBehavior}
                  onChange={e => setFormBehavior(e.target.value)}
                  placeholder="Describe what should happen, e.g. 'When asked to post on social media, the agent creates a proper post with relevant hashtags and confirms it was published'"
                  rows={3}
                  className="w-full bg-[#0a0a0a] border border-[#222] rounded px-3 py-2 text-sm focus:outline-none focus:border-[#f97316] resize-none"
                />
                <p className="text-xs text-[#555] mt-1">AI will generate the test message and evaluate results based on this</p>
              </div>

              <div>
                <label className="block text-xs text-[#666] mb-1">Agent</label>
                <Select
                  value={formAgentId}
                  onChange={setFormAgentId}
                  placeholder="Auto (AI picks the best agent)"
                  options={projectAgents.map(a => ({
                    value: a.id,
                    label: `${a.name} (${a.status})`,
                  }))}
                />
                <p className="text-xs text-[#555] mt-1">Leave empty to let AI choose the right agent</p>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setShowForm(false)}
                className="px-4 py-2 text-sm text-[#888] hover:text-[#e0e0e0] transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!formName || !formBehavior}
                className="px-4 py-2 bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 text-white rounded text-sm font-medium transition"
              >
                {editingTest ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
