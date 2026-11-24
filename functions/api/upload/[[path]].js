/**
 * /api/upload —— 真正的上传入口
 *
 *   GET  /api/upload            → 跳转到上传页
 *   POST /api/upload            → multipart 上传（需要登录）
 *        fields: title, description, tags, duration
 *        files : v360（必填，360p mp4）、v240（必填，240p mp4）、cover（可选，jpg）
 *
 *   POST /api/upload/{标题}/{简介}/  → JSON 方式登记元数据（老接口，仅管理员）
 *
 * 上传流程：
 *   鉴权 → 校验配额 → D1 占位拿 id → 一次 commit 写三个文件 → 回填 D1
 *
 * 为什么不是「上传完立刻能播」：文件进的是 GitHub 仓库，Pages 的 Git
 * 集成会自动构建，1~2 分钟后文件才出现在线上。记录先标 processing，
 * 前端探测到文件存在就当 ready 处理。
 */

import { json, fail, usageOf, fmtBytes } from "../../_lib.js";
import { currentUser } from "../../_auth.js";
import { commitFiles, configured, missingConfig, toBase64, pathsOf } from "../../_github.js";

/** 单个文件上限。Pages 单文件 25MiB，留点余量 */
const MAX_VIDEO = 20 * 1024 * 1024;
const MAX_COVER = 3 * 1024 * 1024;

export async function onRequest({ request, env, params }) {
    const method = request.method.toUpperCase();
    const raw = params.path;
    const seg = Array.isArray(raw) ? raw : raw ? String(raw).split("/") : [];

    if (method === "GET" || method === "HEAD") {
        const splat = seg.map(encodeURIComponent).join("/");
        const target = new URL("/upload" + (splat ? "?splat=" + splat : ""), request.url);
        return Response.redirect(target.toString(), 302);
    }

    if (method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"
            }
        });
    }

    if (method !== "POST") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, POST, OPTIONS" } });
    }

    if (!env.DB) {
        return fail(5001, "D1 没绑定：Pages 项目里要有一个变量名 DB 的 D1 数据库", 500);
    }

    const user = await currentUser(request, env);
    if (!user) return fail(4010, "要先登录才能上传", 401);

    const type = request.headers.get("Content-Type") || "";

    if (type.indexOf("multipart/form-data") === 0) {
        return uploadFiles(request, env, user, seg);
    }

    /* 老接口：只登记元数据，不传文件。留给管理员手动补记录用。 */
    return registerMeta(request, env, user, seg);
}

/* =========================================================
   真上传
   ========================================================= */

async function uploadFiles(request, env, user, seg) {
    if (!configured(env)) {
        return fail(5002,
            "服务器还没配 GitHub 提交：缺 " + missingConfig(env).join(" 和 ") +
            "。站长去 Pages 项目 Settings → Variables 里加上就能用了。", 500);
    }

    let form;
    try {
        form = await request.formData();
    } catch (e) {
        return fail(1001, "表单解析失败：" + e.message, 400);
    }

    const title = String(form.get("title") || "").trim();
    const description = String(form.get("description") || "").trim();
    const duration = Math.max(0, Math.round(Number(form.get("duration")) || 0));
    const tagsRaw = String(form.get("tags") || "");
    const tags = tagsRaw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);

    if (!title) return fail(1002, "标题不能为空", 400);
    if (title.length > 50) return fail(1002, "标题最长 50 字", 400);
    if (description.length > 200) return fail(1002, "简介最长 200 字", 400);

    const v360 = form.get("v360");
    const v240 = form.get("v240");
    const cover = form.get("cover");

    if (!isFile(v360) || !isFile(v240)) {
        return fail(1003, "没收到 360p / 240p 文件，浏览器转码可能没成功", 400);
    }
    if (!/^video\//.test(v360.type || "") && !/\.mp4$/i.test(v360.name || "")) {
        return fail(1003, "360p 那个不是视频文件", 400);
    }
    if (v360.size > MAX_VIDEO || v240.size > MAX_VIDEO) {
        return fail(1004,
            "单个文件超过 " + fmtBytes(MAX_VIDEO) + " 上限（Pages 限制 25MB）。压得再狠一点，或者把视频剪短", 413);
    }

    const totalBytes = v360.size + v240.size;
    const usage = await usageOf(env, user.id);

    if (usage.videos + 1 > user.quotaVideos) {
        return fail(4020,
            "你的额度用完了：最多 " + user.quotaVideos + " 个视频，已经传了 " + usage.videos + " 个。删掉旧的再传。", 403);
    }
    if (usage.bytes + totalBytes > user.quotaBytes) {
        return fail(4021,
            "空间不够了：配额 " + fmtBytes(user.quotaBytes) + "，已用 " + fmtBytes(usage.bytes) +
            "，这次还要 " + fmtBytes(totalBytes) + "。", 403);
    }

    /* ---------- 先在库里占个位子，拿到 id ---------- */
    let id;
    try {
        const ins = await env.DB.prepare(
            "INSERT INTO videos (vid, title, description, src, low, cover, duration, size, views, created_at, tags, owner_id, status, uploader) " +
            "VALUES (0, ?1, ?2, '', '', '', ?3, ?4, 0, ?5, ?6, ?7, 'processing', ?8)"
        ).bind(
            title,
            description,
            duration,
            v360.size,
            new Date().toISOString().slice(0, 10),
            JSON.stringify(tags),
            user.id,
            user.username
        ).run();

        id = Number(ins.meta && ins.meta.last_row_id);
        if (!id) throw new Error("没拿到自增 id");
    } catch (e) {
        return fail(5000, "写库失败：" + e.message, 500);
    }

    const p = pathsOf(id);
    const vid = 11091 + id;

    /* ---------- 提交文件 ---------- */
    try {
        const bytes360 = new Uint8Array(await v360.arrayBuffer());
        const bytes240 = new Uint8Array(await v240.arrayBuffer());

        const files = [
            { path: p.v360, base64: toBase64(bytes360) },
            { path: p.v240, base64: toBase64(bytes240) }
        ];

        if (isFile(cover) && cover.size > 0 && cover.size <= MAX_COVER) {
            files.push({ path: p.cover, base64: toBase64(new Uint8Array(await cover.arrayBuffer())) });
        }

        await commitFiles(env, files, "上传视频 #" + id + "：" + title);
    } catch (e) {
        /* 提交失败就把占位记录撤掉，别留一条没有文件的幽灵记录 */
        try {
            await env.DB.prepare("DELETE FROM videos WHERE id = ?1").bind(id).run();
        } catch (e2) { /* 尽力而为 */ }

        return fail(5003, "提交到仓库失败：" + e.message, 502);
    }

    /* ---------- 回填路径 ---------- */
    try {
        await env.DB.prepare(
            "UPDATE videos SET vid = ?1, src = ?2, low = ?3, cover = ?4 WHERE id = ?5"
        ).bind(vid, p.v360, p.v240, p.cover, id).run();
    } catch (e) {
        /* 文件已经进去了，路径是按 id 拼的，库没更新也能播，只提示一下 */
    }

    return json({
        code: 0,
        message: "上传成功，正在构建，大约 1~2 分钟后就能播放",
        data: {
            video_id: id,
            vid,
            url: "/video/" + id,
            watch: "/watch?id=" + id,
            files: p,
            size: totalBytes,
            status: "processing",
            download: {
                hd: "/video/getvideo/keyplus" + (id + 1) + "/" + id,
                low: "/video/getvideo/back/" + vid
            }
        }
    });
}

function isFile(v) {
    return v && typeof v === "object" && typeof v.size === "number" && typeof v.arrayBuffer === "function";
}

/* =========================================================
   老接口：只登记元数据（文件已经在仓库里了）
   ========================================================= */

async function registerMeta(request, env, user, seg) {
    if (!user.isAdmin) {
        return fail(4011, "这个接口只给管理员用。普通上传请走上传页的 multipart 表单。", 403);
    }

    let body;
    try {
        body = await request.json();
    } catch (e) {
        return fail(1001, "请求体不是合法 JSON", 400);
    }

    const pathTitle = seg[0] ? decodeURIComponent(seg[0]) : "";
    const pathDesc = seg[1] ? decodeURIComponent(seg[1]) : "";
    const title = String(pathTitle || body.title || "").trim();
    const description = String(pathDesc || body.description || "").trim();

    if (!title) return fail(1001, "标题不能为空", 400);
    if (title.length > 50) return fail(1001, "标题最长 50 字", 400);
    if (description.length > 200) return fail(1001, "简介最长 200 字", 400);

    try {
        const maxRow = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM videos").first();
        const id = Number((maxRow && maxRow.m) || 0) + 1;
        const vid = Number(body.vid) || 11091 + id;

        const src = String(body.src || `videos/${id}/${id}-360.mp4`);
        const low = String(body.low || `videos/${id}/${id}-240.mp4`);
        const cover = String(body.cover || `videos/${id}/cover.jpg`);
        const duration = Number(body.duration) || 0;
        const size = Number(body.size) || 0;
        const tags = JSON.stringify(Array.isArray(body.tags) ? body.tags.slice(0, 5) : []);
        const createdAt = String(body.createdAt || new Date().toISOString().slice(0, 10));

        await env.DB.prepare(
            "INSERT INTO videos (id, vid, title, description, src, low, cover, duration, size, views, created_at, tags, owner_id, status, uploader) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?11, ?12, 'ready', ?13)"
        ).bind(id, vid, title, description, src, low, cover, duration, size, createdAt, tags, user.id, user.username).run();

        return json({
            code: 0,
            message: "登记成功",
            data: { video_id: id, vid, url: "/video/" + id, download: "/video/getvideo/keyplus" + (id + 1) + "/" + id }
        });
    } catch (err) {
        return fail(5000, "写入失败：" + err.message, 500);
    }
}
