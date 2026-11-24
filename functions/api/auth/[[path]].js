/**
 * /api/auth/* —— 注册 · 登录 · 退出 · 我是谁
 *
 *   POST /api/auth/register   { username, password }
 *   POST /api/auth/login      { username, password }
 *   POST /api/auth/logout
 *   GET  /api/auth/me         返回当前用户 + 配额用量（没登录返回 data:null）
 *
 * 密码用 PBKDF2-SHA256 + 每人独立随机盐，会话是 D1 里的随机 token，
 * 浏览器只拿到 HttpOnly Cookie。
 */

import { json, fail, usageOf } from "../../_lib.js";
import {
    checkCredentials, createSession, currentUser, dropSession, hashPassword,
    rateLimit, sessionCookie, clearCookie, sweepSessions, tokenFromRequest, verifyPassword
} from "../../_auth.js";

export async function onRequest({ request, env, params }) {
    const raw = params && params.path;
    const seg = Array.isArray(raw) ? raw : raw ? String(raw).split("/") : [];
    const action = (seg[0] || "").toLowerCase();

    if (!env || !env.DB) {
        return fail(5001, "D1 没绑定：Pages 项目里要有一个变量名 DB 的 D1 数据库", 500);
    }

    switch (action) {
        case "register": return onlyPost(request, () => register(request, env));
        case "login": return onlyPost(request, () => login(request, env));
        case "logout": return onlyPost(request, () => logout(request, env));
        case "me": return me(request, env);
        default: return fail(1001, "不认识的接口：" + (action || "(空)") + "，可用 register / login / logout / me", 404);
    }
}

function onlyPost(request, fn) {
    if (request.method.toUpperCase() !== "POST") {
        return new Response(JSON.stringify({ code: 405, message: "只接受 POST" }), {
            status: 405,
            headers: { "Content-Type": "application/json; charset=utf-8", Allow: "POST" }
        });
    }
    return fn();
}

function clientIp(request) {
    return request.headers.get("CF-Connecting-IP") || request.headers.get("X-Real-IP") || "unknown";
}

async function readJson(request) {
    try {
        return await request.json();
    } catch (e) {
        return null;
    }
}

/** 用户行 → 前端结构（绝不带 pass_hash / salt） */
function publicUser(u) {
    return {
        id: u.id,
        username: u.username,
        isAdmin: !!u.is_admin,
        createdAt: u.created_at || ""
    };
}

/* =========================================================
   注册
   ========================================================= */

async function register(request, env) {
    const ip = clientIp(request);
    if (!rateLimit("reg:" + ip, 5, 10 * 60 * 1000)) {
        return fail(4029, "注册太频繁了，等几分钟再试", 429);
    }

    const body = await readJson(request);
    if (!body) return fail(1001, "请求体要是 JSON", 400);

    const username = String(body.username || "").trim();
    const password = String(body.password || "");

    const err = checkCredentials(username, password);
    if (err) return fail(1002, err, 400);

    const lower = username.toLowerCase();
    const exists = await env.DB
        .prepare("SELECT id FROM users WHERE uname_lower = ?1 LIMIT 1")
        .bind(lower)
        .first();
    if (exists) return fail(1003, "这个用户名被用了，换一个", 409);

    const { hash, salt, iter } = await hashPassword(password);

    let userId;
    try {
        const r = await env.DB
            .prepare("INSERT INTO users (username, uname_lower, pass_hash, salt, iter) VALUES (?1, ?2, ?3, ?4, ?5)")
            .bind(username, lower, hash, salt, iter)
            .run();
        userId = r.meta && r.meta.last_row_id;
    } catch (e) {
        /* 并发注册同一个名字，UNIQUE 会在这里拦住 */
        if (/UNIQUE/i.test(e.message || "")) return fail(1003, "这个用户名被用了，换一个", 409);
        return fail(5000, "写库失败：" + e.message, 500);
    }

    if (!userId) return fail(5000, "注册失败：没拿到用户 id", 500);

    const { token, expires } = await createSession(env, userId, request.headers.get("User-Agent"));
    await sweepSessions(env);

    const res = json({
        code: 0,
        message: "注册成功",
        data: {
            user: { id: userId, username, isAdmin: false, createdAt: new Date().toISOString().slice(0, 10) },
            usage: { videos: 0, bytes: 0 },
            quota: { videos: 20, bytes: 209715200 }
        }
    });
    res.headers.set("Set-Cookie", sessionCookie(request, token, Math.floor((expires - Date.now()) / 1000)));
    return res;
}

/* =========================================================
   登录
   ========================================================= */

async function login(request, env) {
    const ip = clientIp(request);
    if (!rateLimit("login:" + ip, 12, 5 * 60 * 1000)) {
        return fail(4029, "登录尝试太多次了，等 5 分钟", 429);
    }

    const body = await readJson(request);
    if (!body) return fail(1001, "请求体要是 JSON", 400);

    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) return fail(1002, "用户名和密码都要填", 400);

    const lower = username.toLowerCase();
    const pool = await env.DB
        .prepare("SELECT * FROM users WHERE uname_lower = ?1 LIMIT 1")
        .bind(lower)
        .all();
    const user = pool.results && pool.results[0];

    /* 用户不存在时也跑一次哈希，避免「响应快 = 用户名不存在」被枚举 */
    if (!user) {
        await hashPassword(password, 30000);
        return fail(1004, "用户名或密码不对", 401);
    }

    const ok = await verifyPassword(user, password);
    if (!ok) return fail(1004, "用户名或密码不对", 401);

    const { token, expires } = await createSession(env, user.id, request.headers.get("User-Agent"));
    await sweepSessions(env);
    const usage = await usageOf(env, user.id);

    const res = json({
        code: 0,
        message: "登录成功",
        data: {
            user: publicUser(user),
            usage,
            quota: { videos: Number(user.quota_videos || 0), bytes: Number(user.quota_bytes || 0) }
        }
    });
    res.headers.set("Set-Cookie", sessionCookie(request, token, Math.floor((expires - Date.now()) / 1000)));
    return res;
}

/* =========================================================
   退出
   ========================================================= */

async function logout(request, env) {
    const token = tokenFromRequest(request);
    if (token) await dropSession(env, token);

    const res = json({ code: 0, message: "已退出", data: null });
    res.headers.set("Set-Cookie", clearCookie(request));
    return res;
}

/* =========================================================
   我是谁
   ========================================================= */

async function me(request, env) {
    const user = await currentUser(request, env);
    if (!user) return json({ code: 0, message: "未登录", data: null });

    const usage = await usageOf(env, user.id);
    return json({
        code: 0,
        message: "success",
        data: {
            user: { id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt },
            usage,
            quota: { videos: user.quotaVideos, bytes: user.quotaBytes }
        }
    });
}
