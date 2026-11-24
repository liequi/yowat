/**
 * yowat · 鉴权公共库
 * ---------------------------------------------------------------
 * Workers 免费版单次请求的 CPU 时间只有 10ms，所以所有密码学操作
 * 都必须「短、准、不超」。实测 PBKDF2-SHA256 在本机的耗时：
 *      10k → 1.4ms     20k → 2.6ms     50k → 6.7ms     100k → 13ms
 * 连 importKey 一起算，20k 在 node 里跑一次完整 hashPassword 约 6ms，
 * 于是定在 20k，剩下的预算留给 D1 查询和签名。想更硬可以去付费
 * 老用户的 iter 是跟着记录存的，升级后老密码仍然能验。
 *
 * 会话：32 字节随机 token 存 D1，浏览器只拿到 HttpOnly Cookie，
 * JS 读不到，XSS 也偷不走。
 */

/** 密码哈希迭代次数（受 10ms CPU 限制，见文件头） */
export const PBKDF2_ITERS = 20000;

/** Cookie 名 */
export const COOKIE = "yw_session";

/** 会话有效期：30 天 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/* =========================================================
   编码工具
   ========================================================= */

export function b64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

export function unb64(str) {
    const bin = atob(String(str || ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** base64url，用于 token（可以安全放进 Cookie 和 URL） */
export function b64url(bytes) {
    return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** n 字节密码学随机数 */
export function randomBytes(n) {
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    return buf;
}

export function randomToken() {
    return b64url(randomBytes(32));
}

/** 两端等长的字符串常量时间比较，防时序侧信道 */
export function safeEqual(a, b) {
    const x = String(a || ""), y = String(b || "");
    if (x.length !== y.length) return false;
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
}

/* =========================================================
   密码
   ========================================================= */

/** 用 PBKDF2-SHA256 派生 32 字节，返回 base64 */
export async function derive(password, saltB64, iter = PBKDF2_ITERS) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: unb64(saltB64), iterations: Number(iter) || PBKDF2_ITERS, hash: "SHA-256" },
        key,
        256
    );
    return b64(new Uint8Array(bits));
}

/** 新密码 → 可直接写库的三个字段 */
export async function hashPassword(password, iter = PBKDF2_ITERS) {
    const salt = b64(randomBytes(16));
    const hash = await derive(password, salt, iter);
    return { hash, salt, iter };
}

/** 校验密码，返回布尔 */
export async function verifyPassword(user, password) {
    if (!user || !user.pass_hash || !user.salt) return false;
    const hash = await derive(password, user.salt, user.iter);
    return safeEqual(hash, user.pass_hash);
}

/* =========================================================
   用户名校验
   ========================================================= */

export const USERNAME_RE = /^[A-Za-z0-9_]{4,20}$/;
export const PASSWORD_MIN = 8;

/** 返回错误文案，没问题返回空串 */
export function checkCredentials(username, password) {
    if (!USERNAME_RE.test(String(username || ""))) {
        return "用户名要 4~20 位，只能用字母、数字、下划线";
    }
    const p = String(password || "");
    if (p.length < PASSWORD_MIN) return "密码至少 " + PASSWORD_MIN + " 位";
    if (p.length > 128) return "密码太长了，128 位以内";
    return "";
}

/* =========================================================
   会话
   ========================================================= */

/** 建会话，返回 token */
export async function createSession(env, userId, ua) {
    const token = randomToken();
    const expires = Date.now() + SESSION_TTL_MS;
    await env.DB
        .prepare("INSERT INTO sessions (token, user_id, expires_at, ua) VALUES (?1, ?2, ?3, ?4)")
        .bind(token, Number(userId), expires, String(ua || "").slice(0, 120))
        .run();
    return { token, expires };
}

export async function dropSession(env, token) {
    if (!token) return;
    await env.DB.prepare("DELETE FROM sessions WHERE token = ?1").bind(token).run();
}

/** 从 Cookie 头取 token */
export function tokenFromRequest(request) {
    const raw = request.headers.get("Cookie") || "";
    for (const part of raw.split(";")) {
        const i = part.indexOf("=");
        if (i < 0) continue;
        if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
    return "";
}

/** 清掉过期会话，顺手做，失败不影响主流程 */
export async function sweepSessions(env) {
    try {
        await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(Date.now()).run();
    } catch (e) { /* 忽略 */ }
}

/**
 * 取当前登录用户。没登录、过期、库没绑都返回 null（不抛错）。
 * 返回的 user 里不含 pass_hash，可以安全地吐给前端。
 */
export async function currentUser(request, env) {
    if (!env || !env.DB) return null;
    const token = tokenFromRequest(request);
    if (!token) return null;

    let row;
    try {
        row = await env.DB
            .prepare(
                "SELECT u.id, u.username, u.quota_videos, u.quota_bytes, u.is_admin, u.created_at, s.expires_at " +
                "FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?1 LIMIT 1"
            )
            .bind(token)
            .first();
    } catch (e) {
        return null;
    }

    if (!row) return null;
    if (Number(row.expires_at) < Date.now()) {
        await dropSession(env, token);
        return null;
    }

    return {
        id: Number(row.id),
        username: row.username,
        quotaVideos: Number(row.quota_videos || 0),
        quotaBytes: Number(row.quota_bytes || 0),
        isAdmin: Number(row.is_admin || 0) === 1,
        createdAt: row.created_at || ""
    };
}

/** 拼 Set-Cookie。本地 http 不能带 Secure，否则浏览器不存。 */
export function sessionCookie(request, token, maxAgeSec) {
    const https = new URL(request.url).protocol === "https:";
    const parts = [
        COOKIE + "=" + token,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=" + Math.max(0, Math.floor(maxAgeSec))
    ];
    if (https) parts.push("Secure");
    return parts.join("; ");
}

/** 退出时让浏览器立刻丢掉 cookie */
export function clearCookie(request) {
    return sessionCookie(request, "", 0);
}

/* =========================================================
   简单限流（内存版，够挡脚本爆破；实例重启就清零）
   ========================================================= */

const hits = new Map();

/** 返回 true 表示这次放行 */
export function rateLimit(key, limit, windowMs) {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
        hits.set(key, { start: now, n: 1 });
        if (hits.size > 5000) hits.clear();       // 防内存无限涨
        return true;
    }
    rec.n++;
    return rec.n <= limit;
}
