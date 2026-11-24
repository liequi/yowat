/**
 * GET /api/videos          列表（前端主页 / 详情页的数据源）
 * GET /api/videos?tag=音乐&q=关键词&sort=views
 *
 * 数据来自 D1；D1 未绑定时返回 5000，前端会自动回退到 assets/js/videos.data.js
 *
 * 小坑：status 列是迁移 001 才加的。如果有人还没跑迁移就部署了这套代码，
 * 带 status 的 SQL 会报 no such column，所以这里带一层降级 ——
 * 宁可把软删的记录也列出来，也别让首页白屏。
 */

import { json, normalize, promoteIfLive } from "../_lib.js";

export async function onRequestGet({ env, request }) {
    if (!env.DB) {
        return json({
            code: 5000,
            message: "D1 未绑定：请在 Pages 项目 Settings → Bindings 里添加变量名 DB 的 D1 数据库",
            data: []
        }, 500);
    }

    try {
        const url = new URL(request.url);
        const q = (url.searchParams.get("q") || "").trim();
        const tag = (url.searchParams.get("tag") || "").trim();
        const sort = url.searchParams.get("sort") || "new";

        const order = sort === "views"
            ? "views DESC, created_at DESC"
            : sort === "long"
                ? "duration DESC, created_at DESC"
                : "created_at DESC, id DESC";

        const filters = [];
        const binds = [];

        if (q) {
            filters.push("(title LIKE ?" + (binds.length + 1) + " OR description LIKE ?" + (binds.length + 1) + ")");
            binds.push("%" + q + "%");
        }
        if (tag && tag !== "全部") {
            filters.push("tags LIKE ?" + (binds.length + 1));
            binds.push('%"' + tag + '"%');
        }

        const run = async (whereAll) => {
            const sql = "SELECT * FROM videos"
                + (whereAll.length ? " WHERE " + whereAll.join(" AND ") : "")
                + " ORDER BY " + order
                + " LIMIT 200";
            const stmt = env.DB.prepare(sql);
            const { results } = await (binds.length ? stmt.bind(...binds) : stmt).all();
            return results || [];
        };

        let rows;
        try {
            rows = await run(["status != 'deleted'"].concat(filters));
        } catch (err) {
            if (!/no such column|no such table/i.test(err.message || "")) throw err;
            /* 迁移 001 还没跑：退回不带 status 的老查询 */
            rows = await run(filters);
        }

        /* 列表里有「等构建」的记录时，顺手探一下真实文件是否已上线（最多 5 条） */
        const pending = rows.filter((r) => r && r.status === "processing").slice(0, 5);
        if (pending.length) {
            await Promise.all(pending.map((r) => promoteIfLive(env, request, r)));
        }

        return json({ code: 0, message: "success", data: rows.map(normalize) });
    } catch (err) {
        return json({ code: 5000, message: "查询失败：" + err.message, data: [] }, 500);
    }
}
