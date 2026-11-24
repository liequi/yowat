/**
 * GET    /api/videos/{id}   单个视频的元数据（详情页、第三方调用）
 * POST   /api/videos/{id}   播放量 +1
 * DELETE /api/videos/{id}   作者删自己的视频（文件从仓库删掉，记录软删）
 */

import { json, findVideo, normalize, promoteIfLive } from "../../_lib.js";
import { currentUser } from "../../_auth.js";
import { deleteFiles, configured } from "../../_github.js";

export async function onRequestGet({ env, params, request }) {
    const id = Number(params.id);
    if (!Number.isFinite(id)) return json({ code: 1001, message: "参数错误", data: null }, 400);

    try {
        const { video, error } = await findVideo(env, "id", id);
        if (error) {
            const dbError = error.startsWith("D1");
            return json({ code: dbError ? 5000 : 1004, message: error, data: null }, dbError ? 500 : 404);
        }
        /* 刚上传的视频要等构建，这里探一次文件是否已经在线 */
        await promoteIfLive(env, request, video);
        return json({ code: 0, message: "success", data: video });
    } catch (err) {
        return json({ code: 5000, message: "查询失败：" + err.message, data: null }, 500);
    }
}

/** 播放量 +1，前端在真正开始播放时调用一次 */
export async function onRequestPost({ env, params }) {
    const id = Number(params.id);
    if (!Number.isFinite(id) || !env.DB) return json({ code: 1001, message: "参数错误", data: null }, 400);

    try {
        await env.DB.prepare("UPDATE videos SET views = views + 1 WHERE id = ?1").bind(id).run();
        const row = await env.DB.prepare("SELECT * FROM videos WHERE id = ?1").bind(id).first();
        return json({ code: 0, message: "success", data: normalize(row) });
    } catch (err) {
        return json({ code: 5000, message: "更新失败：" + err.message, data: null }, 500);
    }
}

/**
 * 删自己的视频。
 * 只认 owner_id —— 老数据（owner_id 是 NULL）只有管理员能删。
 * 先把仓库里的文件删掉（少占体积），再把记录标成 deleted 释放配额。
 */
export async function onRequestDelete({ request, env, params }) {
    const id = Number(params.id);
    if (!Number.isFinite(id) || !env.DB) return json({ code: 1001, message: "参数错误", data: null }, 400);

    const user = await currentUser(request, env);
    if (!user) return json({ code: 4010, message: "要先登录", data: null }, 401);

    let row;
    try {
        row = await env.DB.prepare("SELECT * FROM videos WHERE id = ?1 LIMIT 1").bind(id).first();
    } catch (err) {
        return json({ code: 5000, message: "查询失败：" + err.message, data: null }, 500);
    }

    if (!row) return json({ code: 1004, message: "没有这个视频", data: null }, 404);
    if (row.status === "deleted") {
        return json({ code: 0, message: "已经删过了", data: { video_id: id } });
    }

    const owner = row.owner_id == null ? null : Number(row.owner_id);
    if (owner !== user.id && !user.isAdmin) {
        return json({ code: 4012, message: "这不是你传的视频", data: null }, 403);
    }

    /* 文件删不掉也别拦着 —— 至少让它从站点上消失 */
    let fileDeleted = false;
    if (configured(env)) {
        try {
            await deleteFiles(env, [
                "videos/" + id + "/" + id + "-360.mp4",
                "videos/" + id + "/" + id + "-240.mp4",
                "videos/" + id + "/cover.jpg"
            ], "删除视频 #" + id + "：" + (row.title || ""));
            fileDeleted = true;
        } catch (e) {
            /* 记下来，返回里告诉前端 */
        }
    }

    try {
        await env.DB.prepare(
            "UPDATE videos SET status = 'deleted', src = '', low = '', cover = '' WHERE id = ?1"
        ).bind(id).run();
    } catch (err) {
        return json({ code: 5000, message: "记录没删掉：" + err.message, data: null }, 500);
    }

    return json({
        code: 0,
        message: fileDeleted ? "已删除" : "记录已删除，文件可能还留在仓库里",
        data: { video_id: id, fileDeleted }
    });
}
