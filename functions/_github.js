/**
 * yowat · GitHub 提交
 * ---------------------------------------------------------------
 * 视频不走 Pages 直传，而是 commit 进仓库，由 Pages 的 Git 集成
 * 自动构建 —— 所以别人上传完，等 1~2 分钟就能看，站长不用碰终端。
 *
 * 关键点：**三个文件合成一次 commit**。
 * 如果每个文件单独调 Contents API，就会触发 3 次 Pages 构建，
 * 白白消耗每月 500 次的额度。这里用 Git Data API：
 *   blobs（每个文件各建一个） → tree（一次挂三个） → commit → 更新 ref
 *
 * 需要的环境变量（Pages 项目的 Settings → Environment variables）：
 *   GITHUB_TOKEN   fine-grained token，只需 Contents: Read and write
 *   GITHUB_REPO    owner/repo，例如 yowat/yowat
 *   GITHUB_BRANCH  可选，默认 main
 */

export function configured(env) {
    return !!(env && env.GITHUB_TOKEN && env.GITHUB_REPO);
}

/** 配置缺什么，用一句人话讲清楚 */
export function missingConfig(env) {
    const lack = [];
    if (!env || !env.GITHUB_TOKEN) lack.push("GITHUB_TOKEN");
    if (!env || !env.GITHUB_REPO) lack.push("GITHUB_REPO");
    return lack;
}

/** Uint8Array → base64。分块拼，避免 apply 参数过多爆栈 */
export function toBase64(bytes) {
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

async function gh(env, apiPath, init) {
    const res = await fetch("https://api.github.com" + apiPath, {
        method: (init && init.method) || "GET",
        headers: {
            "Authorization": "Bearer " + env.GITHUB_TOKEN,
            "Accept": "application/vnd.github+json",
            "User-Agent": "yowat-upload",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json"
        },
        body: init && init.body ? JSON.stringify(init.body) : undefined
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* 不是 JSON，下面用原文报错 */ }

    if (!res.ok) {
        const msg = (data && (data.message || data.error)) || text.slice(0, 200) || "未知错误";
        const err = new Error("GitHub " + res.status + "：" + msg);
        err.status = res.status;
        throw err;
    }
    return data;
}

function branchOf(env) {
    return String(env.GITHUB_BRANCH || "main").trim();
}

/** 取分支当前的头指针和它的 tree */
async function head(env) {
    const repo = env.GITHUB_REPO;
    const branch = branchOf(env);

    const ref = await gh(env, "/repos/" + repo + "/git/ref/heads/" + branch);
    const sha = ref.object.sha;
    const commit = await gh(env, "/repos/" + repo + "/git/commits/" + sha);
    return { sha, tree: commit.tree.sha };
}

/**
 * 一次 commit 写入多个文件。
 * files: [{ path, base64 }]
 * 返回 commit sha。
 */
export async function commitFiles(env, files, message) {
    if (!configured(env)) {
        throw new Error("没配置 " + missingConfig(env).join(" / ") + "，无法提交文件");
    }
    if (!files || !files.length) throw new Error("没有要提交的文件");

    const repo = env.GITHUB_REPO;
    const branch = branchOf(env);

    /* 并发上传有可能撞 ref，重试一次够用 */
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const base = await head(env);

            const tree = [];
            for (const f of files) {
                const blob = await gh(env, "/repos/" + repo + "/git/blobs", {
                    method: "POST",
                    body: { content: f.base64, encoding: "base64" }
                });
                tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
            }

            const newTree = await gh(env, "/repos/" + repo + "/git/trees", {
                method: "POST",
                body: { base_tree: base.tree, tree }
            });

            const commit = await gh(env, "/repos/" + repo + "/git/commits", {
                method: "POST",
                body: {
                    message: message || "chore: 上传视频",
                    tree: newTree.sha,
                    parents: [base.sha]
                }
            });

            await gh(env, "/repos/" + repo + "/git/refs/heads/" + branch, {
                method: "PATCH",
                body: { sha: commit.sha, force: false }
            });

            return commit.sha;
        } catch (err) {
            lastErr = err;
            /* 422 = ref 落后了（别人刚提交过），重取一次头再来 */
            if (err.status !== 422 && err.status !== 409) break;
        }
    }

    throw lastErr || new Error("提交失败");
}

/**
 * 一次 commit 删除多个文件（树里把 path 设成 null 就是删）。
 * 用来支持「作者删自己的视频」。
 */
export async function deleteFiles(env, paths, message) {
    if (!configured(env)) {
        throw new Error("没配置 " + missingConfig(env).join(" / "));
    }
    if (!paths || !paths.length) return "";

    const repo = env.GITHUB_REPO;
    const branch = branchOf(env);
    const base = await head(env);

    const tree = paths.map((p) => ({ path: p, mode: "100644", type: "blob", sha: null }));

    const newTree = await gh(env, "/repos/" + repo + "/git/trees", {
        method: "POST",
        body: { base_tree: base.tree, tree }
    });

    const commit = await gh(env, "/repos/" + repo + "/git/commits", {
        method: "POST",
        body: { message: message || "chore: 删除视频", tree: newTree.sha, parents: [base.sha] }
    });

    await gh(env, "/repos/" + repo + "/git/refs/heads/" + branch, {
        method: "PATCH",
        body: { sha: commit.sha, force: false }
    });

    return commit.sha;
}

/** 三个文件的相对路径，前端和接口都按这个拼 */
export function pathsOf(id) {
    return {
        v360: "videos/" + id + "/" + id + "-360.mp4",
        v240: "videos/" + id + "/" + id + "-240.mp4",
        cover: "videos/" + id + "/cover.jpg"
    };
}
