/**
 * /api/upload —— 真正的上传入口
 *
 *   GET  /api/upload            → 跳转到上传页
 *   POST /api/upload            → multipart 上传（需要登录）
 *        fields: title, description, tags, duration
 *        files : file（必填，原始视频）
 *
 *   POST /api/upload/{标题}/{简介}/  → JSON 方式登记元数据（老接口，仅管理员）
 *
 * 上传流程（2026-11-24 重构：转码从浏览器搬到服务器）：
 *   鉴权 → 校验配额 → D1 占位拿 id → 原片分块 commit 到 _raw/ → 回填 D1
 *   → GitHub Actions（transcode.yml）拿完整的原片跑真 ffmpeg 转 360p/240p/封面
 *   → 提交回 videos/{id}/ → wrangler 部署 → 前端探测到文件就转 ready
 *
 * 为什么不再在浏览器里转码：ffmpeg.wasm 0.11 在 3 分钟级别的真实文件上会
 * 抛 `RuntimeError: function signature mismatch`，wasm 里直接崩，进度永远
 * 停在 0%（0.12 的单线程 core 从 CDN 拉 31MB 在部分网络下也拿不到）。
 * 服务器端用原生 ffmpeg，3 分钟视频十几秒就转完，还不用人守着页面。
 *
 * 为什么分块：Workers 单次执行内存 128MB，整个文件 arrayBuffer 拷贝一份
 * 再加 base64（×1.33）会顶到天花板。按 6MB 切片逐个建 blob，Actions 里
 * cat 拼回去。32MB 是实测下来留给解析开销的安全上限。
 */

import { json, fail, usageOf, fmtBytes } from "../../_lib.js";
import { currentUser } from "../../_auth.js";
import { commitFiles, configured, missingConfig, toBase64, pathsOf } from "../../_github.js";

/** 原片上限。再大就不是内存问题，而是「该上 R2 了」 */
const MAX_RAW = 32 * 1024 * 1024;

/** 分块大小：6MB 切片 → 8MB base64，单块内存可控 */
const CHUNK = 6 * 1024 * 1024;

const OK_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)$/i;

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

    const file = form.get("file");

    if (!isFile(file)) {
        return fail(1003, "没收到视频文件", 400);
    }
    if (!/^video\//.test(file.type || "") && !OK_EXT.test(file.name || "")) {
        return fail(1003, "这个不是视频文件", 400);
    }
    if (file.size > MAX_RAW) {
        return fail(1004,
            "原片 " + fmtBytes(file.size) + " 超过了 " + fmtBytes(MAX_RAW) +
            " 的上传上限。先剪短一点，或者用剪辑软件导出一个码率更低的版本", 413);
    }

    const usage = await usageOf(env, user.id);

    if (usage.videos + 1 > user.quotaVideos) {
        return fail(4020,
            "你的额度用完了：最多 " + user.quotaVideos + " 个视频，已经传了 " + usage.videos + " 个。删掉旧的再传。", 403);
    }
    if (usage.bytes + file.size > user.quotaBytes) {
        return fail(4021,
            "空间不够了：配额 " + fmtBytes(user.quotaBytes) + "，已用 " + fmtBytes(usage.bytes) +
            "，这次还要 " + fmtBytes(file.size) + "。", 403);
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
            file.size,
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
    const bytes = new Uint8Array(await file.arrayBuffer());

    /* ---------- 原片切片提交到 _raw/（Actions 会拼回去转码） ---------- */
    try {
        const files = [];
        for (let off = 0, n = 0; off < bytes.length; off += CHUNK, n++) {
            const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
            files.push({
                path: "_raw/" + id + ".part" + String(n).padStart(2, "0"),
                base64: toBase64(slice)
            });
        }

        await commitFiles(env, files, "上传视频 #" + id + "：" + title + "（原片，等待转码）");
    } catch (e) {
        /* 提交失败就把占位记录撤掉，别留一条没有文件的幽灵记录 */
        try {
            await env.DB.prepare("DELETE FROM videos WHERE id = ?1").bind(id).run();
        } catch (e2) { /* 尽力而为 */ }

        return fail(5003, "提交原片失败：" + e.message, 502);
    }

    /* ---------- 回填路径（文件名由 Actions 按约定生成，先写上） ---------- */
    try {
        await env.DB.prepare(
            "UPDATE videos SET vid = ?1, src = ?2, low = ?3, cover = ?4 WHERE id = ?5"
        ).bind(vid, p.v360, p.v240, p.cover, id).run();
    } catch (e) {
        /* 文件路径是按 id 拼的，库没更新也能播，忽略 */
    }

    return json({
        code: 0,
        message: "上传成功，服务器正在转码，大约 1~3 分钟后就能播放",
        data: {
            video_id: id,
            vid,
            url: "/video/" + id,
            watch: "/watch?id=" + id,
            files: p,
            size: file.size,
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
