import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "functions");
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const ROW = {
    id: 1, vid: 11092, title: "HARMONY OR DIE · 动画 MV", description: "d",
    src: "videos/1/1-360.mp4", low: "videos/1/1-240.mp4", cover: "videos/1/cover.jpg",
    duration: 240, size: 6166188, views: 0, created_at: "2026-11-23", tags: '["MV","音乐"]'
};

function makeEnv(opts = {}) {
    return {
        DB: {
            prepare(sql) {
                const stmt = {
                    _v: null,
                    _sql: sql,
                    bind(v) { stmt._v = v; return stmt; },
                    async first() {
                        if (/MAX\(id\)/i.test(stmt._sql)) return { m: opts.empty ? 0 : 1 };
                        return opts.empty ? null : ROW;
                    },
                    async all() { return { results: opts.empty ? [] : [ROW] }; },
                    async run() { return { success: true }; }
                };
                return stmt;
            }
        }
    };
}

let fetched = [];
globalThis.fetch = async (url, init = {}) => {
    fetched.push({ url: String(url), method: init.method || "GET", range: (init.headers && init.headers.get && init.headers.get("Range")) || null });
    return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "Content-Type": "video/mp4", "Content-Length": "4", "Accept-Ranges": "bytes" }
    });
};

const videoMod = await load("video/[[path]].js");
const listMod = await load("api/videos.js");
const itemMod = await load("api/videos/[id].js");
const uploadMod = await load("api/upload/[[path]].js");

const results = [];
function check(name, cond, detail) {
    results.push({ name, ok: !!cond, detail });
}

function req(path, opts = {}) {
    return new Request("https://yowat.pages.dev" + path, opts);
}

/* --- /video/1 播放跳转 --- */
{
    const res = await videoMod.onRequest({ request: req("/video/1"), env: makeEnv(), params: { path: ["1"] } });
    check("/video/1 → 302", res.status === 302, res.status + " " + res.headers.get("Location"));
    check("跳转目标正确", (res.headers.get("Location") || "").endsWith("/watch?id=1"), res.headers.get("Location"));
}

/* --- 原片下载 --- */
{
    fetched = [];
    const res = await videoMod.onRequest({ request: req("/video/getvideo/keyplus2/1"), env: makeEnv(), params: { path: ["getvideo", "keyplus2", "1"] } });
    const cd = res.headers.get("Content-Disposition") || "";
    check("keyplus 下载 200", res.status === 200, String(res.status));
    check("Content-Type=video/mp4", res.headers.get("Content-Type") === "video/mp4", res.headers.get("Content-Type"));
    check("Content-Disposition=attachment", cd.startsWith("attachment"), cd);
    check("中文名 RFC5987 编码", cd.includes("filename*=UTF-8''"), cd);
    check("keyplus 取的是 360p", fetched[0] && fetched[0].url.endsWith("/videos/1/1-360.mp4"), fetched[0] && fetched[0].url);
    const body = await res.arrayBuffer();
    check("返回了文件流", body.byteLength === 4, String(body.byteLength));
}

/* --- 低清下载（走 vid） --- */
{
    fetched = [];
    const res = await videoMod.onRequest({ request: req("/video/getvideo/back/11092"), env: makeEnv(), params: { path: ["getvideo", "back", "11092"] } });
    check("back 下载 200", res.status === 200, String(res.status));
    check("back 取的是 240p", fetched[0] && fetched[0].url.endsWith("/videos/1/1-240.mp4"), fetched[0] && fetched[0].url);
}

/* --- Range 透传 --- */
{
    fetched = [];
    const res = await videoMod.onRequest({
        request: new Request("https://yowat.pages.dev/video/getvideo/keyplus2/1", { headers: { Range: "bytes=0-1" } }),
        env: makeEnv(), params: { path: ["getvideo", "keyplus2", "1"] }
    });
    check("Range 透传给上游", fetched[0] && fetched[0].range === "bytes=0-1", fetched[0] && fetched[0].range);
    check("Range 请求仍返回 200/206", res.status === 200 || res.status === 206, String(res.status));
}

/* --- 不存在 / 参数错 --- */
{
    const res = await videoMod.onRequest({ request: req("/video/getvideo/back/999"), env: makeEnv({ empty: true }), params: { path: ["getvideo", "back", "999"] } });
    const body = await res.json();
    check("不存在的视频 → 404", res.status === 404 && body.code === 1004, res.status + " " + JSON.stringify(body));
}
{
    const res = await videoMod.onRequest({ request: req("/video/getvideo/oops/1"), env: makeEnv(), params: { path: ["getvideo", "oops", "1"] } });
    check("未知下载方式 → 400", res.status === 400, String(res.status));
}
{
    const res = await videoMod.onRequest({ request: req("/video/getvideo/keyplus2/abc"), env: makeEnv(), params: { path: ["getvideo", "keyplus2", "abc"] } });
    check("非法 id → 400", res.status === 400, String(res.status));
}

/* --- 旧静态路径兼容 --- */
{
    const res = await videoMod.onRequest({ request: req("/video/1/1.mp4"), env: makeEnv(), params: { path: ["1", "1.mp4"] } });
    check("/video/1/1.mp4 → 301 到 /videos/", res.status === 301 && (res.headers.get("Location") || "").includes("/videos/1/1.mp4"), res.status + " " + res.headers.get("Location"));
}
{
    const res = await videoMod.onRequest({ request: req("/video/1/index.html"), env: makeEnv(), params: { path: ["1", "index.html"] } });
    check("/video/1/index.html → 播放页", res.status === 302 && (res.headers.get("Location") || "").includes("watch?id=1"), res.status + " " + res.headers.get("Location"));
}

/* --- params.path 是字符串时也能工作（不同 wrangler 版本行为差异） --- */
{
    const res = await videoMod.onRequest({ request: req("/video/2"), env: makeEnv(), params: { path: "2" } });
    check("path 为字符串时正常", res.status === 302 && (res.headers.get("Location") || "").includes("id=2"), res.status + " " + res.headers.get("Location"));
}

/* --- /api/videos 列表 --- */
{
    const res = await listMod.onRequestGet({ env: makeEnv(), request: req("/api/videos") });
    const body = await res.json();
    check("列表接口 code 0", res.status === 200 && body.code === 0, res.status + " " + JSON.stringify(body).slice(0, 90));
    check("tags 反序列化为数组", Array.isArray(body.data[0].tags) && body.data[0].tags[0] === "MV", JSON.stringify(body.data[0].tags));
    check("驼峰字段", body.data[0].createdAt === "2026-11-23" && body.data[0].id === 1, JSON.stringify(body.data[0].createdAt));
}
{
    const res = await listMod.onRequestGet({ env: {}, request: req("/api/videos") });
    const body = await res.json();
    check("未绑 D1 → 5000", res.status === 500 && body.code === 5000, res.status + " " + body.message);
}

/* --- /api/videos/:id --- */
{
    const res = await itemMod.onRequestGet({ env: makeEnv(), params: { id: "1" } });
    const body = await res.json();
    check("单个视频 200", res.status === 200 && body.data.id === 1, String(res.status));
}
{
    const res = await itemMod.onRequestGet({ env: makeEnv({ empty: true }), params: { id: "9" } });
    check("单个视频不存在 → 404", res.status === 404, String(res.status));
}

/* --- /api/upload：GET 跳转上传页 --- */
{
    const res = await uploadMod.onRequest({ request: req("/api/upload/我的标题/我的简介/"), env: makeEnv(), params: { path: ["我的标题", "我的简介"] } });
    check("GET 上传接口 → 302 到上传页", res.status === 302 && (res.headers.get("Location") || "").includes("/upload?splat="), res.status + " " + res.headers.get("Location"));
}

/* --- /api/upload：没登录一律拒绝 --- */
{
    const res = await uploadMod.onRequest({
        request: new Request("https://yowat.pages.dev/api/upload/新视频/简介/", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ duration: 30, size: 1024, tags: ["日常"] })
        }),
        env: makeEnv(), params: { path: ["新视频", "简介"] }
    });
    const body = await res.json();
    check("未登录登记元数据 → 401", res.status === 401 && body.code === 4010, res.status + " " + JSON.stringify(body));
}
{
    const res = await uploadMod.onRequest({
        request: new Request("https://yowat.pages.dev/api/upload", {
            method: "POST",
            headers: { "Content-Type": "multipart/form-data; boundary=1" },
            body: "x"
        }),
        env: makeEnv(), params: { path: [] }
    });
    const body = await res.json();
    check("未登录传文件 → 401", res.status === 401 && body.code === 4010, res.status + " " + JSON.stringify(body));
}

/* --- 源文件不在、Pages 用 200 + 首页 HTML 顶包时，不能把 HTML 当视频发出去 --- */
{
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response("<!DOCTYPE html><html><body>home</body></html>", {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" }
    });
    try {
        const res = await videoMod.onRequest({
            request: req("/video/getvideo/keyplus2/1"), env: makeEnv(), params: { path: ["getvideo", "keyplus2", "1"] }
        });
        const body = await res.json();
        check("HTML 顶包 → 404 报源文件不存在", res.status === 404 && body.code === 1004, res.status + " " + JSON.stringify(body));
    } finally {
        globalThis.fetch = realFetch;
    }
}

/* --- 首选档位缺失时退到另一个档位 --- */
{
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith("-360.mp4")) {
            return new Response("<!DOCTYPE html><html></html>", {
                status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }
            });
        }
        return new Response(new Uint8Array([9, 9]), {
            status: 200, headers: { "Content-Type": "video/mp4", "Content-Length": "2" }
        });
    };
    try {
        const res = await videoMod.onRequest({
            request: req("/video/getvideo/keyplus2/1"), env: makeEnv(), params: { path: ["getvideo", "keyplus2", "1"] }
        });
        const body = await res.arrayBuffer();
        check("360p 缺失自动退到 240p", res.status === 200 && body.byteLength === 2, res.status + " len=" + body.byteLength);
    } finally {
        globalThis.fetch = realFetch;
    }
}

/* --- 输出 --- */
let bad = 0;
for (const r of results) {
    if (!r.ok) bad++;
    console.log((r.ok ? "  ok   " : "  FAIL ") + r.name + (r.ok ? "" : "   → " + r.detail));
}
console.log("\n" + (results.length - bad) + "/" + results.length + " 通过");
process.exit(bad ? 1 : 0);
