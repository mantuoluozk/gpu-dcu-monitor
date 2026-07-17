const crypto = require("crypto");

const COOKIE_NAME = "gpu_monitor_admin";
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;

function hashPassword(password, salt) {
  const normalized = String(password || "");
  if (normalized.length < 8) throw new Error("管理员密码至少需要 8 个字符");
  const saltBuffer = salt ? Buffer.from(salt, "hex") : crypto.randomBytes(16);
  const derived = crypto.scryptSync(normalized, saltBuffer, 32);
  return `scrypt$${saltBuffer.toString("hex")}$${derived.toString("hex")}`;
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt" || !/^[a-f0-9]+$/i.test(parts[1]) || !/^[a-f0-9]+$/i.test(parts[2])) return false;
  try {
    const expected = Buffer.from(parts[2], "hex");
    const actual = crypto.scryptSync(String(password || ""), Buffer.from(parts[1], "hex"), expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch (_) {
    return false;
  }
}

class AdminAuth {
  constructor(options) {
    const config = options || {};
    this.passwordHash = String(config.passwordHash || "").trim();
    this.sessionTtlMs = positiveNumber(config.sessionTtlMs, DEFAULT_SESSION_TTL_MS);
    this.rateWindowMs = positiveNumber(config.rateWindowMs, DEFAULT_RATE_WINDOW_MS);
    this.maxAttempts = positiveNumber(config.maxAttempts, DEFAULT_MAX_ATTEMPTS);
    this.forceSecureCookie = Boolean(config.forceSecureCookie);
    this.sessions = new Map();
    this.attempts = new Map();
  }

  get configured() {
    return verifyHashShape(this.passwordHash);
  }

  status(req, now) {
    const session = this.getSession(req, now);
    return { configured: this.configured, authenticated: Boolean(session), expiresAt: session ? new Date(session.expiresAt).toISOString() : null };
  }

  login(req, password, now) {
    const timestamp = numberOrNow(now);
    if (!this.configured) return { ok: false, status: 503, error: "管理员密码尚未配置" };
    const address = clientAddress(req);
    const blocked = this.blockedAttempt(address, timestamp);
    if (blocked) return { ok: false, status: 429, error: "登录尝试过于频繁，请稍后再试", retryAfterSeconds: Math.max(1, Math.ceil((blocked.resetAt - timestamp) / 1000)) };
    if (!verifyPassword(password, this.passwordHash)) {
      this.recordFailure(address, timestamp);
      return { ok: false, status: 401, error: "管理员密码不正确" };
    }
    this.attempts.delete(address);
    this.prune(timestamp);
    const token = crypto.randomBytes(32).toString("hex");
    const session = { expiresAt: timestamp + this.sessionTtlMs };
    this.sessions.set(token, session);
    return { ok: true, token, expiresAt: session.expiresAt };
  }

  logout(req) {
    const token = cookieValue(req, COOKIE_NAME);
    if (token) this.sessions.delete(token);
  }

  isAuthenticated(req, now) {
    return Boolean(this.getSession(req, now));
  }

  getSession(req, now) {
    const timestamp = numberOrNow(now);
    const token = cookieValue(req, COOKIE_NAME);
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= timestamp) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  sessionCookie(req, token) {
    const secure = this.forceSecureCookie || Boolean(req && req.socket && req.socket.encrypted) || String(req && req.headers && req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
    return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}${secure ? "; Secure" : ""}`;
  }

  clearCookie(req) {
    const secure = this.forceSecureCookie || Boolean(req && req.socket && req.socket.encrypted) || String(req && req.headers && req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
  }

  blockedAttempt(address, now) {
    const attempt = this.attempts.get(address);
    if (!attempt) return null;
    if (attempt.resetAt <= now) {
      this.attempts.delete(address);
      return null;
    }
    return attempt.count >= this.maxAttempts ? attempt : null;
  }

  recordFailure(address, now) {
    const current = this.attempts.get(address);
    const attempt = current && current.resetAt > now ? current : { count: 0, resetAt: now + this.rateWindowMs };
    attempt.count += 1;
    this.attempts.set(address, attempt);
  }

  prune(now) {
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token);
    for (const [address, attempt] of this.attempts) if (attempt.resetAt <= now) this.attempts.delete(address);
  }
}

function verifyHashShape(value) {
  return /^scrypt\$[a-f0-9]+\$[a-f0-9]+$/i.test(String(value || ""));
}

function cookieValue(req, name) {
  const header = String(req && req.headers && req.headers.cookie || "");
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0 || part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

function clientAddress(req) {
  return String(req && req.socket && req.socket.remoteAddress || "unknown");
}

function numberOrNow(value) {
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

module.exports = { AdminAuth, COOKIE_NAME, hashPassword, verifyPassword };
