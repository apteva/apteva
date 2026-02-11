export interface Agent {
  id: string;
  name: string;
  model: string;
  provider: string;
  status: "running" | "stopped" | "error";
  port: number | null;
  projectId: string | null;
}

export interface User {
  id: string;
  username: string;
  role: string;
}

export class AptevaAPI {
  baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async checkConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/check`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetch(path: string, opts: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(opts.headers as Record<string, string> || {}),
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    return fetch(`${this.baseUrl}${path}`, { ...opts, headers });
  }

  async login(username: string, password: string): Promise<{ success: boolean; user?: User; error?: string }> {
    try {
      const res = await this.fetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { success: false, error: data.error || "Login failed" };
      }
      this.token = data.accessToken;
      return { success: true, user: data.user };
    } catch (err: any) {
      return { success: false, error: err.message || "Connection failed" };
    }
  }

  async getAgents(): Promise<Agent[]> {
    try {
      const res = await this.fetch("/api/agents");
      if (!res.ok) return [];
      const data = await res.json();
      return data.agents || [];
    } catch {
      return [];
    }
  }
}
