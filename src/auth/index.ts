import { createHmac, randomBytes } from "crypto";
import { join } from "path";
import { homedir } from "os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { UserDB, SessionDB, generateId, type User } from "../db";

// ============ Configuration ============

const ACCESS_TOKEN_EXPIRY = 15 * 60; // 15 minutes in seconds
const REFRESH_TOKEN_EXPIRY = 7 * 24 * 60 * 60; // 7 days in seconds

// ============ Secret Key Management ============

let authSecret: string | null = null;

function getAuthSecretPath(): string {
  const homeDir = process.env.DATA_DIR || join(homedir(), ".apteva");
  return join(homeDir, "auth.key");
}

function getAuthSecret(): string {
  if (authSecret) return authSecret;

  if (process.env.AUTH_SECRET) {
    authSecret = process.env.AUTH_SECRET;
    return authSecret;
  }

  const secretPath = getAuthSecretPath();
  if (existsSync(secretPath)) {
    authSecret = readFileSync(secretPath, "utf-8").trim();
    return authSecret;
  }

  authSecret = randomBytes(64).toString("hex");

  const dir = process.env.DATA_DIR || join(homedir(), ".apteva");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(secretPath, authSecret, { mode: 0o600 });

  return authSecret;
}

// ============ Password Hashing ============

export async function hashPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 12,
  });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

// ============ Password Validation ============

export interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

export function validatePassword(password: string): PasswordValidation {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push("Password must be at least 8 characters");
  }
  if (!/[a-z]/.test(password)) {
    errors.push("Password must contain a lowercase letter");
  }
  if (!/[A-Z]/.test(password)) {
    errors.push("Password must contain an uppercase letter");
  }
  if (!/[0-9]/.test(password)) {
    errors.push("Password must contain a number");
  }

  return { valid: errors.length === 0, errors };
}

// ============ JWT Token Handling ============

interface TokenPayload {
  userId: string;
  username: string;
  role: string;
  type: "access" | "refresh";
  iat: number;
  exp: number;
}

function base64UrlEncode(data: string): string {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64UrlDecode(data: string): string {
  const padded = data + "=".repeat((4 - (data.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
}

function createToken(payload: Omit<TokenPayload, "iat" | "exp">, expiresIn: number): string {
  const secret = getAuthSecret();
  const now = Math.floor(Date.now() / 1000);

  const fullPayload: TokenPayload = {
    ...payload,
    iat: now,
    exp: now + expiresIn,
  };

  const header = { alg: "HS256", typ: "JWT" };
  const headerEncoded = base64UrlEncode(JSON.stringify(header));
  const payloadEncoded = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = createHmac("sha256", secret)
    .update(`${headerEncoded}.${payloadEncoded}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return `${headerEncoded}.${payloadEncoded}.${signature}`;
}

function verifyToken(token: string): TokenPayload | null {
  try {
    const secret = getAuthSecret();
    const [headerEncoded, payloadEncoded, signature] = token.split(".");

    if (!headerEncoded || !payloadEncoded || !signature) {
      return null;
    }

    const expectedSignature = createHmac("sha256", secret)
      .update(`${headerEncoded}.${payloadEncoded}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    if (signature !== expectedSignature) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(payloadEncoded)) as TokenPayload;
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp < now) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// ============ Token Generation ============

export function generateAccessToken(user: User): string {
  return createToken(
    { userId: user.id, username: user.username, role: user.role, type: "access" },
    ACCESS_TOKEN_EXPIRY
  );
}

export function generateRefreshToken(user: User): string {
  return createToken(
    { userId: user.id, username: user.username, role: user.role, type: "refresh" },
    REFRESH_TOKEN_EXPIRY
  );
}

export function verifyAccessToken(token: string): TokenPayload | null {
  const payload = verifyToken(token);
  if (!payload || payload.type !== "access") {
    return null;
  }
  return payload;
}

export function verifyRefreshToken(token: string): TokenPayload | null {
  const payload = verifyToken(token);
  if (!payload || payload.type !== "refresh") {
    return null;
  }
  return payload;
}

// ============ Session Management ============

export function hashToken(token: string): string {
  return createHmac("sha256", getAuthSecret()).update(token).digest("hex");
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export async function createSession(user: User): Promise<AuthTokens> {
  const accessToken = generateAccessToken(user);
  const refreshToken = generateRefreshToken(user);
  const refreshTokenHash = hashToken(refreshToken);

  const expiresAt = new Date();
  expiresAt.setSeconds(expiresAt.getSeconds() + REFRESH_TOKEN_EXPIRY);

  SessionDB.create({
    user_id: user.id,
    refresh_token_hash: refreshTokenHash,
    expires_at: expiresAt.toISOString(),
  });

  UserDB.updateLastLogin(user.id);

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_EXPIRY };
}

export async function refreshSession(refreshToken: string): Promise<AuthTokens | null> {
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) {
    return null;
  }

  const tokenHash = hashToken(refreshToken);
  const session = SessionDB.findByTokenHash(tokenHash);
  if (!session) {
    return null;
  }

  if (new Date(session.expires_at) < new Date()) {
    SessionDB.delete(session.id);
    return null;
  }

  const user = UserDB.findById(payload.userId);
  if (!user) {
    SessionDB.delete(session.id);
    return null;
  }

  SessionDB.delete(session.id);
  return createSession(user);
}

export function invalidateSession(refreshToken: string): boolean {
  const tokenHash = hashToken(refreshToken);
  return SessionDB.deleteByTokenHash(tokenHash);
}

export function invalidateAllSessions(userId: string): number {
  return SessionDB.deleteByUser(userId);
}

// ============ Auth Check ============

export interface AuthStatus {
  hasUsers: boolean;
  authenticated: boolean;
  user?: { id: string; username: string; role: string };
}

export function getAuthStatus(accessToken?: string): AuthStatus {
  const hasUsers = UserDB.hasUsers();

  if (!accessToken) {
    return { hasUsers, authenticated: false };
  }

  const payload = verifyAccessToken(accessToken);
  if (!payload) {
    return { hasUsers, authenticated: false };
  }

  const user = UserDB.findById(payload.userId);
  if (!user) {
    return { hasUsers, authenticated: false };
  }

  return {
    hasUsers,
    authenticated: true,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

// ============ User Creation ============

export interface CreateUserResult {
  success: boolean;
  user?: User;
  error?: string;
}

export async function createUser(data: {
  username: string;
  password: string;
  email?: string;
  role?: "admin" | "user";
}): Promise<CreateUserResult> {
  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!usernameRegex.test(data.username)) {
    return { success: false, error: "Username must be 3-20 characters (letters, numbers, underscore)" };
  }

  const existing = UserDB.findByUsername(data.username);
  if (existing) {
    return { success: false, error: "Username already taken" };
  }

  if (data.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.email)) {
      return { success: false, error: "Invalid email format" };
    }
  }

  const passwordValidation = validatePassword(data.password);
  if (!passwordValidation.valid) {
    return { success: false, error: passwordValidation.errors.join(". ") };
  }

  const passwordHash = await hashPassword(data.password);

  const user = UserDB.create({
    username: data.username,
    password_hash: passwordHash,
    email: data.email || null,
    role: data.role || "user",
  });

  return { success: true, user };
}

// ============ Login ============

export interface LoginResult {
  success: boolean;
  tokens?: AuthTokens;
  user?: { id: string; username: string; role: string };
  error?: string;
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const user = UserDB.findByUsername(username);
  if (!user) {
    return { success: false, error: "Invalid username or password" };
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return { success: false, error: "Invalid username or password" };
  }

  const tokens = await createSession(user);

  return {
    success: true,
    tokens,
    user: { id: user.id, username: user.username, role: user.role },
  };
}

// ============ Cleanup ============

export function cleanupExpiredSessions(): number {
  return SessionDB.deleteExpired();
}

// ============ Exports ============

export { ACCESS_TOKEN_EXPIRY, REFRESH_TOKEN_EXPIRY };
