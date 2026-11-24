/**
 * /video/* —— 文档里的三类链接都落在这里
 *
 *   GET /video/{id}                             → 跳转播放页 /watch?id=
 *   GET /video/getvideo/keyplus{id+1}/{id}      → 下载 360p 主版本（attachment）
 *   GET /video/getvideo/back/{vid}              → 下载 240p 省流版
 *
 * 站点上只有两个档位文件，路径按 id 拼死：
 *   videos/{id}/{id}-360.mp4   主版本
 *   videos/{id}/{id}-240.mp4   省流版
 * 高清原片不保留（上传页暂存到 _incoming/，打包后即删）。
 *
 * 跳转目标一律用“无扩展名”地址（/watch、/#videos）：
 * Pages 的 auto-trailing-slash 会把 /watch.html 再 308 掰成 /watch，
 * 直接写 /watch 可以少一跳，也不会和 _redirects 打架。
 *
 * 下载逻辑只存在于接口层，页面上不再有下载按钮。
 */

import { findVideo, absolute } from "../_lib.js";

const TIER_MAIN = 360;
const TIER_LOW = 240;

export async function onRequest({ request, env, params }) {
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const raw = params.path;
    const seg = Array.isArray(raw) ? raw : raw ? String(raw).split("/") : [];

    /* ---------- 1. 下载接口 ---------- */
    if (seg[0] === "getvideo") {
        return handleDownload(request, env, seg, method);
    }

    /* ---------- 2. 兼容旧路径 ---------- */
    if (seg.length >= 2) {
        /* /video/1/index.html → 播放页 */
        if (seg.length === 2 && seg[1] === "index.html") {
            return Response.redirect(new URL("/watch?id=" + encodeURIComponent(seg[0]), request.url).toString(), 302);
        }
        /* /video/1/1.mp4 → /videos/1/1.mp4 */
        const target = new URL("/videos/" + seg.map(encodeURIComponent).join("/"), request.url);
        return Response.redirect(target.toString(), 301);
    }

    /* ---------- 3. 播放页 /video/1 → /watch?id=1 ---------- */
    if (seg.length === 1) {
        const target = new URL("/watch?id=" + encodeURIComponent(seg[0]), request.url);
        return Response.redirect(target.toString(), 302);
    }

    /* ---------- 4. /video → 广场 ---------- */
    return Response.redirect(new URL("/#videos", request.url).toString(), 302);
}

async function handleDownload(request, env, seg, method) {
    const mode = seg[1] || "";
    const arg = seg[2] || "";

    let key, quality;
    if (/^keyplus/i.test(mode)) {
        key = "id";          // /video/getvideo/keyplus2/1 → id = 1
        quality = "hd";
    } else if (mode === "back") {
        key = "vid";         // /video/getvideo/back/11092 → vid = 11092
        quality = "low";
    } else {
        return jsonError(1001, "无法识别的下载方式，可用 keyplus{id+1}/{id} 或 back/{vid}");
    }

    if (!arg || !/^\d+$/.test(arg)) {
        return jsonError(1001, "缺少或非法的编号：" + (arg || "(空)"));
    }

    let found;
    try {
        found = await findVideo(env, key, arg);
    } catch (err) {
        return jsonError(5000, "查询失败：" + err.message, 500);
    }

    if (found.error) return jsonError(1004, found.error, 404);

    const video = found.video;
    const preferred = quality === "low" ? TIER_LOW : TIER_MAIN;
    /* 首选档位缺失时退到另一个档位，别让人拿到 404 */
    const candidates = [preferred, preferred === TIER_MAIN ? TIER_LOW : TIER_MAIN];

    let lastPath = "";
    for (const tier of candidates) {
        const rel = `videos/${video.id}/${video.id}-${tier}.mp4`;
        lastPath = rel;
        const res = await serve(request, absolute(request, rel), video, tier, method);
        if (res) return res;
    }

    return jsonError(1004, "这个视频还没有文件：" + lastPath +
        "（videos/" + video.id + "/ 下没有 -360.mp4 或 -240.mp4，先跑 npm run pack）", 404);
}

/**
 * 取一个文件并包成下载响应。
 * 文件不存在（Pages 会回 200 + 首页 HTML）时返回 null，交给上层换档位。
 */
async function serve(request, target, video, tier, method) {
    const headers = new Headers();
    const range = request.headers.get("Range");
    if (range) headers.set("Range", range);

    let upstream;
    try {
        upstream = await fetch(target, { method: method === "HEAD" ? "HEAD" : "GET", headers });
    } catch (err) {
        return null;
    }

    if (!upstream.ok && upstream.status !== 206) return null;

    /* 文件不存在时 Pages 可能回 200 + 首页 HTML，别把 HTML 当视频发出去 */
    const type = (upstream.headers.get("Content-Type") || "").toLowerCase();
    if (type && type.indexOf("video/") !== 0 && type.indexOf("application/octet-stream") !== 0) {
        return null;
    }

    const out = new Headers();
    out.set("Content-Type", upstream.headers.get("Content-Type") || "video/mp4");
    out.set("Content-Disposition", disposition(video.title, tier));
    out.set("Accept-Ranges", upstream.headers.get("Accept-Ranges") || "bytes");
    out.set("Cache-Control", "public, max-age=3600");

    const len = upstream.headers.get("Content-Length");
    if (len) out.set("Content-Length", len);
    const cr = upstream.headers.get("Content-Range");
    if (cr) out.set("Content-Range", cr);

    return new Response(method === "HEAD" ? null : upstream.body, {
        status: upstream.status === 206 ? 206 : 200,
        headers: out
    });
}

/** 中文文件名用 RFC 5987 编码，ASCII 兜底 */
function disposition(title, tier) {
    const suffix = "-" + tier + "p";
    const ascii = "yowat-video" + suffix + ".mp4";
    const utf8 = encodeURIComponent((title || "video") + suffix + ".mp4").replace(/['()*]/g, (c) =>
        "%" + c.charCodeAt(0).toString(16).toUpperCase()
    );
    return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

function jsonError(code, message, status = 400) {
    return new Response(JSON.stringify({ code, message, data: null }), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
    });
}
