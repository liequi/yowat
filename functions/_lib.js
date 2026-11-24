/**
 * yowat · Pages Functions 公共工具
 * 文件名以下划线开头，不会被当成路由暴露。
 */

export function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*"
        }
    });
}

export function fail(code, message, status = 200) {
    return json({ code, message, data: null }, status);
}

/** 数据库行 → 前端使用的驼峰结构 */
export function normalize(row) {
    if (!row) return null;

    let tags = row.tags;
    if (typeof tags === "string") {
        try {
            tags = JSON.parse(tags);
        } catch (e) {
            tags = tags.split(",").map((s) => s.trim()).filter(Boolean);
        }
    }
    if (!Array.isArray(tags)) tags = [];

    return {
        id: Number(row.id),
        vid: Number(row.vid || row.id),
        title: row.title || "",
        description: row.description || "",
        src: row.src || "",
        low: row.low || "",
        cover: row.cover || "",
        duration: Number(row.duration || 0),
        size: Number(row.size || 0),
        views: Number(row.views || 0),
        createdAt: row.created_at || "",
        tags,
        /* processing = 已提交仓库、等 Pages 构建；ready = 文件已经在线 */
        status: row.status || "ready",
        uploader: row.uploader || "",
        ownerId: row.owner_id == null ? null : Number(row.owner_id)
    };
}

/** 按 id 或 vid 取一条记录 */
export async function findVideo(env, key, value) {
    if (!env.DB) return { error: "D1 未绑定：请在 Pages 项目里绑定变量名 DB 的 D1 数据库" };

    const column = key === "vid" ? "vid" : "id";
    const row = await env.DB
        .prepare(`SELECT * FROM videos WHERE ${column} = ?1 LIMIT 1`)
        .bind(Number(value))
        .first();

    if (!row) return { error: "没有这个视频" };
    return { video: normalize(row) };
}

/** 把相对路径转成绝对 URL */
export function absolute(request, path) {
    return new URL(path.startsWith("/") ? path : "/" + path, request.url).toString();
}

/**
 * 某人已经用掉的配额。
 * status = 'deleted' 的记录不计入（软删，文件还在 git 历史里但不算占用）。
 */
export async function usageOf(env, userId) {
    if (!env || !env.DB) return { videos: 0, bytes: 0 };
    const row = await env.DB
        .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM videos WHERE owner_id = ?1 AND status != 'deleted'")
        .bind(Number(userId))
        .first();
    return { videos: Number((row && row.n) || 0), bytes: Number((row && row.bytes) || 0) };
}

/**
 * 把「等构建」的记录推进成 ready。
 *
 * 别人上传后，文件要先提交进仓库、再由 Pages 构建，1~2 分钟后才真正在线。
 * 这段时间记录是 processing，前端会显示「构建中」。但没有别的东西会来改它，
 * 所以由读接口顺手探一次真实文件：Content-Type 是 video/* 才算上线。
 * （Pages 对不存在的路径会返回 200 + 首页 HTML，不能只看状态码。）
 *
 * 探到就落库成 ready，并且直接改掉传进来的对象，调用方不用再查一次库。
 * 探不到什么都不做 —— 构建还没完，下次刷新会再试。
 */
export async function promoteIfLive(env, request, video) {
    if (!video || video.status !== "processing" || !env || !env.DB) return video;

    const id = Number(video.id);
    if (!Number.isFinite(id)) return video;

    try {
        const res = await fetch(absolute(request, `/videos/${id}/${id}-360.mp4`), {
            method: "HEAD"
        });
        const type = res.headers.get("Content-Type") || "";
        if (res.ok && /^video\//i.test(type)) {
            await env.DB.prepare("UPDATE videos SET status = 'ready' WHERE id = ?1").bind(id).run();
            video.status = "ready";
        }
    } catch (e) {
        /* 探不到就维持 processing */
    }

    return video;
}

/** 字节数转成人看的单位 */
export function fmtBytes(n) {
    const v = Number(n) || 0;
    const units = ["B", "KB", "MB", "GB"];
    let x = v, i = 0;
    while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
    return (i === 0 ? Math.round(x) : x.toFixed(1)) + " " + units[i];
}
