import React, { useState } from "react";

interface CreateAccountStepProps {
  onComplete: (user: { username: string }) => void;
}

export function CreateAccountStep({ onComplete }: CreateAccountStepProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [email, setEmail] = useState("");
  const [showEmail, setShowEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate passwords match
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    setLoading(true);

    try {
      const res = await fetch("/api/onboarding/user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          ...(email && { email }), // Only include if provided
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to create account");
        setLoading(false);
        return;
      }

      // Auto-login after account creation
      const loginRes = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      if (!loginRes.ok) {
        setError("Account created but login failed. Please try logging in.");
        setLoading(false);
        return;
      }

      const loginData = await loginRes.json();

      // Store token for subsequent requests
      if (loginData.accessToken) {
        sessionStorage.setItem("accessToken", loginData.accessToken);
      }

      onComplete({ username });
    } catch (e) {
      setError("Failed to create account");
      setLoading(false);
    }
  };

  return (
    <>
      <h2 className="text-2xl font-semibold mb-2">Create your account</h2>
      <p className="text-[#666] mb-6">
        Set up your admin account to get started with apteva.
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="username" className="block text-sm text-[#888] mb-1">
            Username
          </label>
          <input
            id="username"
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="Choose a username"
            autoFocus
            required
            className="w-full bg-[#0a0a0a] border border-[#333] rounded px-4 py-3 focus:outline-none focus:border-[#f97316]"
          />
          <p className="text-xs text-[#666] mt-1">3-20 characters, letters, numbers, underscore</p>
        </div>

        <div>
          <label htmlFor="password" className="block text-sm text-[#888] mb-1">
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Enter a password"
            required
            className="w-full bg-[#0a0a0a] border border-[#333] rounded px-4 py-3 focus:outline-none focus:border-[#f97316]"
          />
          <p className="text-xs text-[#666] mt-1">Min 8 characters, uppercase, lowercase, number</p>
        </div>

        <div>
          <label htmlFor="confirmPassword" className="block text-sm text-[#888] mb-1">
            Confirm Password
          </label>
          <input
            id="confirmPassword"
            type="password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="Confirm your password"
            required
            className="w-full bg-[#0a0a0a] border border-[#333] rounded px-4 py-3 focus:outline-none focus:border-[#f97316]"
          />
        </div>

        {!showEmail ? (
          <button
            type="button"
            onClick={() => setShowEmail(true)}
            className="text-sm text-[#666] hover:text-[#888] transition"
          >
            + Add email for password recovery (optional)
          </button>
        ) : (
          <div>
            <label htmlFor="email" className="block text-sm text-[#888] mb-1">
              Email <span className="text-[#666]">(optional)</span>
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="For password recovery only"
              className="w-full bg-[#0a0a0a] border border-[#333] rounded px-4 py-3 focus:outline-none focus:border-[#f97316]"
            />
            <p className="text-xs text-[#666] mt-1">Only used for password recovery, never shared</p>
          </div>
        )}

        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded text-red-400 text-sm">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !username || !password || !confirmPassword}
          className="w-full bg-[#f97316] hover:bg-[#fb923c] disabled:opacity-50 disabled:cursor-not-allowed text-black px-4 py-3 rounded font-medium transition"
        >
          {loading ? "Creating account..." : "Create Account"}
        </button>
      </form>

      <p className="text-xs text-[#666] mt-4 text-center">
        This will be your admin account with full access to apteva.
      </p>
    </>
  );
}
