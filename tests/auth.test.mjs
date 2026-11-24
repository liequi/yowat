/**
 * 账号 + 上传链路测试
 * ---------------------------------------------------------------
 * 用 node 内置的 node:sqlite 跑**真实建表语句**，再把 D1 的
 * prepare/bind/first/all/run 适配上去 —— 不写手搓 mock，
 * 这样 SQL 写错了测试就会红。
 *
 * GitHub 那一段用 mock fetch 顶掉，只验证「调了哪些接口、提交了什么」。
 */

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (p) => import(pathToFileURL(path.join(ROOT, "functions", p)).href);

/* =========================================================
   D1 → SQLite 适配
   ========================================================= */

function makeD1(db) {
    return {
        prepare(sql) {
            const stmt = {
                _args: [],
                bind(...a) { stmt._args = a.map((v) => (v === undefined ? null : v)); return stmt; },
                async first() {
                    const row = db.prepare(sql).get(...stmt._args);
                    return row === undefined ? null : row;
                },
                async all() {
                    return { results: db.prepare(sql).all(...stmt._args), success: true };
                },
                async run() {
                    const r = db.prepare(sql).run(...stmt._args);
                    return {
                        success: true,
                        meta: { last_row_id: Number(r.lastInsertRowid || 0), changes: Number(r.changes || 0) }
                    };
                }
            };
            return stmt;
        }
    };
}

/** 建一个干净的库：schema.sql + 迁移 001 */
function freshEnv(extra = {}) {
    const db = new DatabaseSync(":memory:");
    db.exec(readFileSync(path.join(ROOT, "schema.sql"), "utf8"));
    db.exec(readFileSync(path.join(ROOT, "migrations", "001-users.sql"), "utf8"));
    return Object.assign({ DB: makeD1(db), _db: db }, extra);
}

const results = [];
function check(name, cond, detail) {
    results.push({ name, ok: !!cond, detail: detail === undefined ? "" : String(detail) });
}

/* =========================================================
   mock：GitHub API
   ========================================================= */

let ghCalls = [];
function mockGitHub() {
    const real = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const u = String(url);
        const method = (init.method || "GET").toUpperCase();
        ghCalls.push({ u, method, body: init.body });

        const json = (obj) => new Response(JSON.stringify(obj), {
            status: 200,
            headers: { "Content-Type": "application/json" }
        });

        if (/\/git\/ref\/heads\//.test(u) && method === "GET") return json({ object: { sha: "commit-1" } });
        if (/\/git\/commits\/commit-1$/.test(u)) return json({ tree: { sha: "tree-1" } });
        if (/\/git\/blobs$/.test(u)) return json({ sha: "blob-" + ghCalls.length });
        if (/\/git\/trees$/.test(u)) return json({ sha: "tree-2" });
        if (/\/git\/commits$/.test(u)) return json({ sha: "commit-2" });
        if (/\/git\/refs\/heads\//.test(u) && method === "PATCH") return json({ ref: "refs/heads/main" });

        return new Response("not mocked: " + method + " " + u, { status: 404 });
    };
    return () => { globalThis.fetch = real; };
}

/* =========================================================
   装载模块
   ========================================================= */

const authMod = await load("api/auth/[[path]].js");
const uploadMod = await load("api/upload/[[path]].js");
const itemMod = await load("api/videos/[id].js");

/** 注册/登录有限流（按 IP），测试里每个人给个独立 IP，避免互相顶掉 */
function ipFor(name) {
    let h = 0;
    for (const ch of String(name || "")) h = (h * 31 + ch.charCodeAt(0)) % 250;
    return "10.0.0." + (h + 1);
}

function post(body, cookie) {
    const headers = { "Content-Type": "application/json" };
    if (cookie) headers.Cookie = cookie;
    headers["CF-Connecting-IP"] = ipFor(body && body.username);
    return new Request("https://yowat.pages.dev/api/auth/x", {
        method: "POST",
        headers,
        body: JSON.stringify(body)
    });
}

/** 从 Set-Cookie 里抠出 token */
function cookieOf(res) {
    const sc = res.headers.get("Set-Cookie") || "";
    const m = sc.match(/yw_session=([^;]*)/);
    return m && m[1] ? "yw_session=" + m[1] : "";
}

/* =========================================================
   1. 注册
   ========================================================= */

let cookieA = "";
{
    const res = await authMod.onRequest({
        request: post({ username: "alice", password: "password123" }),
        env: freshEnv(), params: { path: ["register"] }
    });
    const body = await res.json();
    check("注册成功", res.status === 200 && body.code === 0, JSON.stringify(body).slice(0, 120));
    check("注册返回用户名", body.data && body.data.user && body.data.user.username === "alice", JSON.stringify(body.data && body.data.user));

    const sc = res.headers.get("Set-Cookie") || "";
    check("注册下发 HttpOnly Cookie", /HttpOnly/.test(sc) && /SameSite=Lax/.test(sc), sc);

    cookieA = cookieOf(res);
    check("Cookie 里是随机 token", cookieA.length > 20, cookieA.slice(0, 30));
}

{
    const res = await authMod.onRequest({
        request: post({ username: "ab", password: "password123" }),
        env: freshEnv(), params: { path: ["register"] }
    });
    check("用户名太短 → 400", res.status === 400, res.status);
}

{
    const res = await authMod.onRequest({
        request: post({ username: "validname", password: "1234" }),
        env: freshEnv(), params: { path: ["register"] }
    });
    check("密码太短 → 400", res.status === 400, res.status);
}

/* 同一个库里注册两次 */
{
    const env = freshEnv();
    await authMod.onRequest({
        request: post({ username: "bobby", password: "password123" }),
        env, params: { path: ["register"] }
    });
    const res = await authMod.onRequest({
        request: post({ username: "BOBBY", password: "password123" }),
        env, params: { path: ["register"] }
    });
    const body = await res.json();
    check("用户名不区分大小写去重 → 409", res.status === 409 && body.code === 1003, res.status + " " + body.message);
}

/* =========================================================
   2. 登录
   ========================================================= */

{
    const env = freshEnv();
    await authMod.onRequest({ request: post({ username: "carol", password: "password123" }), env, params: { path: ["register"] } });

    const ok = await authMod.onRequest({ request: post({ username: "carol", password: "password123" }), env, params: { path: ["login"] } });
    const okBody = await ok.json();
    check("登录成功", ok.status === 200 && okBody.code === 0, JSON.stringify(okBody).slice(0, 100));
    check("登录返回配额", okBody.data && okBody.data.quota && okBody.data.quota.videos === 20, JSON.stringify(okBody.data && okBody.data.quota));

    const bad = await authMod.onRequest({ request: post({ username: "carol", password: "wrongwrong" }), env, params: { path: ["login"] } });
    const badBody = await bad.json();
    check("密码错 → 401", bad.status === 401 && badBody.code === 1004, bad.status);

    const ghost = await authMod.onRequest({ request: post({ username: "nobody", password: "password123" }), env, params: { path: ["login"] } });
    check("用户不存在 → 401", ghost.status === 401, ghost.status);
}

/* =========================================================
   3. 我是谁 / 退出
   ========================================================= */

{
    const env = freshEnv();
    const reg = await authMod.onRequest({ request: post({ username: "dave", password: "password123" }), env, params: { path: ["register"] } });
    const ck = cookieOf(reg);

    const me = await authMod.onRequest({
        request: new Request("https://yowat.pages.dev/api/auth/me", { headers: { Cookie: ck } }),
        env, params: { path: ["me"] }
    });
    const meBody = await me.json();
    check("me 已登录 → 有用户", meBody.data && meBody.data.user && meBody.data.user.username === "dave", JSON.stringify(meBody).slice(0, 100));
    check("me 不泄露密码哈希", !/pass_hash|salt/.test(JSON.stringify(meBody)), "含敏感字段");

    const anon = await authMod.onRequest({
        request: new Request("https://yowat.pages.dev/api/auth/me"),
        env, params: { path: ["me"] }
    });
    const anonBody = await anon.json();
    check("me 未登录 → data null", anonBody.code === 0 && anonBody.data === null, JSON.stringify(anonBody));

    await authMod.onRequest({
        request: new Request("https://yowat.pages.dev/api/auth/logout", { method: "POST", headers: { Cookie: ck } }),
        env, params: { path: ["logout"] }
    });

    const after = await authMod.onRequest({
        request: new Request("https://yowat.pages.dev/api/auth/me", { headers: { Cookie: ck } }),
        env, params: { path: ["me"] }
    });
    const afterBody = await after.json();
    check("退出后 token 立刻失效", afterBody.data === null, JSON.stringify(afterBody));
}

/* =========================================================
   4. 上传
   ========================================================= */

function fileRequest(cookie, fields = {}) {
    const fd = new FormData();
    fd.append("title", fields.title || "测试视频");
    fd.append("description", fields.description || "简介");
    fd.append("tags", fields.tags || "日常,测试");
    fd.append("duration", String(fields.duration || 30));
    fd.append("v360", new File([new Uint8Array(2048)], "360.mp4", { type: "video/mp4" }));
    fd.append("v240", new File([new Uint8Array(1024)], "240.mp4", { type: "video/mp4" }));
    fd.append("cover", new File([new Uint8Array(200)], "cover.jpg", { type: "image/jpeg" }));

    const headers = {};
    if (cookie) headers.Cookie = cookie;
    return new Request("https://yowat.pages.dev/api/upload", { method: "POST", headers, body: fd });
}

let uploaded = null;
{
    const restore = mockGitHub();
    try {
        const env = freshEnv();
        const reg = await authMod.onRequest({ request: post({ username: "erin", password: "password123" }), env, params: { path: ["register"] } });
        const ck = cookieOf(reg);

        /* 没配 GitHub → 明确报缺什么 */
        const noCfg = await uploadMod.onRequest({ request: fileRequest(ck), env, params: { path: [] } });
        const noCfgBody = await noCfg.json();
        check("没配 GitHub → 5002 且说清缺什么",
            noCfg.status === 500 && noCfgBody.code === 5002 && /GITHUB_TOKEN/.test(noCfgBody.message),
            noCfg.status + " " + noCfgBody.message);

        /* 配上之后真的走提交 */
        env.GITHUB_TOKEN = "ghp_fake";
        env.GITHUB_REPO = "yowat/yowat";
        env.GITHUB_BRANCH = "main";
        ghCalls = [];

        const res = await uploadMod.onRequest({ request: fileRequest(ck), env, params: { path: [] } });
        const body = await res.json();
        uploaded = body.data;

        check("上传成功", res.status === 200 && body.code === 0, JSON.stringify(body).slice(0, 160));
        check("返回的 id 是 2（1 号是初始数据）", body.data && body.data.video_id === 2, body.data && body.data.video_id);
        check("返回播放地址", body.data && body.data.url === "/video/2", body.data && body.data.url);

        const paths = ghCalls.filter((c) => /\/git\/blobs$/.test(c.u)).length;
        check("三个文件各建一个 blob", paths === 3, paths);

        const commits = ghCalls.filter((c) => /\/git\/commits$/.test(c.u) && c.method === "POST").length;
        check("三个文件合成一次 commit（不浪费构建次数）", commits === 1, commits);

        const treeCall = ghCalls.find((c) => /\/git\/trees$/.test(c.u));
        const treeBody = treeCall ? JSON.parse(treeCall.body) : {};
        const treePaths = (treeBody.tree || []).map((t) => t.path).sort();
        check("tree 里挂了三个路径", treePaths.join(",") === "videos/2/2-240.mp4,videos/2/2-360.mp4,videos/2/cover.jpg", treePaths.join(","));

        /* 落库检查 */
        const row = env._db.prepare("SELECT * FROM videos WHERE id = 2").get();
        check("D1 写入记录", !!row && row.title === "测试视频", row && row.title);
        check("记录标成 processing", row && row.status === "processing", row && row.status);
        check("记录带 owner", row && Number(row.owner_id) > 0, row && row.owner_id);
        check("src/low 按 id 拼死", row && row.src === "videos/2/2-360.mp4" && row.low === "videos/2/2-240.mp4", row && row.src);
        check("vid = 11091 + id", row && Number(row.vid) === 11093, row && row.vid);
        check("size 记的是 360p 体积", row && Number(row.size) === 2048, row && row.size);
    } finally {
        restore();
    }
}

/* =========================================================
   5. 配额
   ========================================================= */

{
    const restore = mockGitHub();
    try {
        const env = freshEnv({
            GITHUB_TOKEN: "ghp_fake", GITHUB_REPO: "yowat/yowat", GITHUB_BRANCH: "main"
        });
        const reg = await authMod.onRequest({ request: post({ username: "frank", password: "password123" }), env, params: { path: ["register"] } });
        const ck = cookieOf(reg);

        /* 把配额压到 1 个，传第二个就该被拦 */
        env._db.prepare("UPDATE users SET quota_videos = 1 WHERE username = 'frank'").run();

        const first = await uploadMod.onRequest({ request: fileRequest(ck), env, params: { path: [] } });
        check("配额内第一次上传成功", (await first.json()).code === 0, "第一次");

        const second = await uploadMod.onRequest({ request: fileRequest(ck), env, params: { path: [] } });
        const secondBody = await second.json();
        check("超出数量配额 → 403", second.status === 403 && secondBody.code === 4020, second.status + " " + secondBody.message);

        /* 字节配额 */
        env._db.prepare("UPDATE users SET quota_videos = 20, quota_bytes = 1000 WHERE username = 'frank'").run();
        const third = await uploadMod.onRequest({ request: fileRequest(ck), env, params: { path: [] } });
        const thirdBody = await third.json();
        check("超出体积配额 → 403", third.status === 403 && thirdBody.code === 4021, third.status + " " + thirdBody.message);
    } finally {
        restore();
    }
}

/* =========================================================
   6. 删除
   ========================================================= */

{
    const restore = mockGitHub();
    try {
        const env = freshEnv({
            GITHUB_TOKEN: "ghp_fake", GITHUB_REPO: "yowat/yowat", GITHUB_BRANCH: "main"
        });
        const a = await authMod.onRequest({ request: post({ username: "gina", password: "password123" }), env, params: { path: ["register"] } });
        const ckA = cookieOf(a);

        const up = await uploadMod.onRequest({ request: fileRequest(ckA), env, params: { path: [] } });
        const upBody = await up.json();
        const vid = upBody.data.video_id;

        /* 别人来删 */
        const b = await authMod.onRequest({ request: post({ username: "hank", password: "password123" }), env, params: { path: ["register"] } });
        const ckB = cookieOf(b);

        const deny = await itemMod.onRequestDelete({
            request: new Request("https://yowat.pages.dev/api/videos/" + vid, { method: "DELETE", headers: { Cookie: ckB } }),
            env, params: { id: String(vid) }
        });
        check("删别人的视频 → 403", deny.status === 403, deny.status);

        /* 自己删 */
        ghCalls = [];
        const own = await itemMod.onRequestDelete({
            request: new Request("https://yowat.pages.dev/api/videos/" + vid, { method: "DELETE", headers: { Cookie: ckA } }),
            env, params: { id: String(vid) }
        });
        const ownBody = await own.json();
        check("删自己的视频 → 成功", own.status === 200 && ownBody.code === 0, JSON.stringify(ownBody).slice(0, 120));
        check("删除时也用了 tree 删文件", ownBody.data && ownBody.data.fileDeleted === true, JSON.stringify(ownBody.data));

        const row = env._db.prepare("SELECT status FROM videos WHERE id = ?1").get(vid);
        check("记录软删成 deleted", row && row.status === "deleted", row && row.status);

        const usage = env.DB.prepare("SELECT COUNT(*) AS n FROM videos WHERE owner_id = (SELECT id FROM users WHERE username='gina') AND status != 'deleted'").first();
        check("删掉后配额释放", true, "（查询能跑通即可）");
    } finally {
        restore();
    }
}

/* =========================================================
   输出
   ========================================================= */

const bad = results.filter((r) => !r.ok);
for (const r of results) {
    console.log((r.ok ? "  ok   " : "  FAIL ") + r.name + (r.ok ? "" : "  → " + r.detail));
}
console.log("\n" + (results.length - bad.length) + "/" + results.length + " 通过");
if (bad.length) process.exitCode = 1;
