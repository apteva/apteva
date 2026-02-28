import React, { useState } from "react";
import { useAuth } from "../../context/AuthContext";

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const result = await login(username, password);

    if (!result.success) {
      setError(result.error || "Login failed");
    }

    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-2 mb-2">
            <span className="text-[var(--color-accent)] text-3xl">&gt;_</span>
            <span className="text-3xl tracking-wider">apteva</span>
          </div>
          <p className="text-[var(--color-text-muted)]">Run AI agents locally</p>
        </div>

        <div className="bg-[var(--color-surface)] card p-8">
          <h2 className="text-2xl font-semibold mb-2">Welcome back</h2>
          <p className="text-[var(--color-text-muted)] mb-6">Sign in to continue to apteva</p>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="username" className="block text-sm text-[var(--color-text-secondary)] mb-1">
                Username
              </label>
              <input
                id="username"
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="Enter your username"
                autoFocus
                required
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-4 py-3 focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm text-[var(--color-text-secondary)] mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
                className="w-full bg-[var(--color-bg)] border border-[var(--color-border-light)] rounded px-4 py-3 focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username || !password}
              className="w-full bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-3 rounded font-medium transition"
            >
              {loading ? "Signing in..." : "Sign In"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
