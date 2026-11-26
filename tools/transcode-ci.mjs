#!/usr/bin/env node
/**
 * yowat · 服务器端转码（CI 专用，也可以本地跑）
 * ---------------------------------------------------------------
 * 输入：_raw/{id}.part00、part01…（上传接口按 6MB 切的原片分块）
 * 输出：videos/{id}/{id}-360.mp4、{id}-240.mp4、cover.jpg，然后删掉 _raw 里那几块
 *
 * 为什么是 Node 而不是 workflow 里写一大段 bash：bash + set -euo pipefail
 * 在 GitHub runner 上出错时看不到具体哪条命令挂的（Actions 日志要登录才能看），
 * 逻辑放 Node 里能本地原样跑一遍，报错带着 ffmpeg 的 stderr。
 *
 * 本地用法：
 *   node tools/transcode-ci.mjs            # 处理 _raw 下所有
 *   node tools/transcode-ci.mjs --keep     # 保留 _raw（调试用）
 */

import { readdir, readFile, writeFile, mkdir, unlink, rmdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";

const run = promisify(execFile);

const RAW = "_raw";
const OUT = "videos";

/** 两个档位：短边像素 / CRF / 音频码率，和原来的打包器保持一致 */
const TIERS = [
    { height: 360, crf: 30, audioKbps: 64 },
    { height: 240, crf: 32, audioKbps: 48 }
];

const KEEP = process.argv.includes("--keep");

/** Pages 单文件上限 25MB，留 1MB 余量；超了就自动加 CRF 重压一次 */
const MAX_OUT = 24 * 1024 * 1024;

function log(...a) {
    console.log("[" + new Date().toISOString().slice(11, 19) + "]", ...a);
}

/**
 * 扫 _raw/，把要转码的原片分组。
 *
 * 现在的上传接口写的是 `_raw/{id}-{token}/partNN`（每次上传一个独立目录）：
 * videos 表的 id 会被复用，平铺成 `_raw/{id}.partNN` 时，上一笔没收尾的残留
 * 会和新的 part00 拼成坏文件 —— 2026-11-26 那次 CI 失败的原因就是这个。
 * 平铺格式仍然兼容，用来处理历史遗留。
 *
 * 返回 Map<group, { id, dir, files: [] }>，files 是相对 _raw 的路径。
 */
async function collect() {
    let entries;
    try {
        entries = await readdir(RAW, { withFileTypes: true });
    } catch (e) {
        return new Map();
    }

    const groups = new Map();

    for (const e of entries) {
        if (e.isDirectory()) {
            const m = /^(\d+)-[a-z0-9]+$/i.exec(e.name);
            if (!m) continue;

            let inside;
            try {
                inside = await readdir(path.join(RAW, e.name));
            } catch (err) {
                continue;
            }

            const parts = inside
                .filter((n) => /^part\d+$/.test(n))
                .sort((a, b) => Number(/\d+/.exec(a)[0]) - Number(/\d+/.exec(b)[0]));

            if (parts.length) {
                groups.set(e.name, {
                    id: Number(m[1]),
                    dir: e.name,
                    files: parts.map((n) => e.name + "/" + n)
                });
            }
            continue;
        }

        /* 历史遗留的平铺格式：_raw/3.part00 */
        const m = /^(\d+)\.part(\d+)$/.exec(e.name);
        if (!m) continue;
        const key = "#" + m[1];
        if (!groups.has(key)) groups.set(key, { id: Number(m[1]), dir: null, files: [] });
        groups.get(key).files.push({ name: e.name, seq: Number(m[2]) });
    }

    /* 平铺组按序号排好，去掉临时字段 */
    for (const g of groups.values()) {
        if (g.dir === null) {
            g.files.sort((a, b) => a.seq - b.seq);
            g.files = g.files.map((f) => f.name);
        }
    }

    return new Map([...groups.entries()].sort((a, b) => a[1].id - b[1].id));
}

async function ffprobe(src) {
    const { stdout } = await run("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-show_entries", "format=duration",
        "-of", "json",
        src
    ], { maxBuffer: 4 * 1024 * 1024 });

    const info = JSON.parse(stdout || "{}");
    const s = (info.streams && info.streams[0]) || {};
    return {
        width: Number(s.width) || 0,
        height: Number(s.height) || 0,
        duration: Math.round(Number(info.format && info.format.duration) || 0)
    };
}

/** 短边缩到目标值，不放大；另一边用 -2 自动取偶数（h264 的 yuv420p 要求） */
function scaleFilter(w, h, target) {
    if (!(w > 0) || !(h > 0) || !(target > 0)) return "";
    if (Math.min(w, h) <= target) return "";
    return w >= h ? "scale=-2:" + target : "scale=" + target + ":-2";
}

async function transcodeOne(group) {
    const id = group.id;
    const parts = group.files;
    const src = path.join(tmpdir(), "yowat-src-" + id + ".mp4");

    const chunks = [];
    for (const p of parts) {
        chunks.push(await readFile(path.join(RAW, p)));
    }
    await writeFile(src, Buffer.concat(chunks));

    const size = (await stat(src)).size;
    log("#" + id, "拼回原片", (size / 1048576).toFixed(1) + "MB，共 " + parts.length + " 块");

    const written = [];
    try {
        await encode(id, src, written);
    } catch (e) {
        /* 转了一半失败的话，别把残档留在 videos/ 里让页面播到半截 */
        for (const f of written) await unlink(f).catch(() => {});
        await unlink(src).catch(() => {});
        throw e;
    }

    await unlink(src).catch(() => {});

    if (!KEEP) {
        for (const p of parts) await unlink(path.join(RAW, p)).catch(() => {});
        if (group.dir) await rmdir(path.join(RAW, group.dir)).catch(() => {});
    }
}

/** 真正的转码：两个档位 + 封面，全部成功后写进 videos/{id}/ */
async function encode(id, src, written) {
    let meta;
    try {
        meta = await ffprobe(src);
    } catch (e) {
        throw new Error("ffprobe 失败：" + (e.stderr || e.message || e));
    }

    if (!meta.width || !meta.height) {
        throw new Error("读不出画面尺寸（不是视频？）");
    }

    log("#" + id, "尺寸 " + meta.width + "x" + meta.height + "，时长 " + meta.duration + "s");

    const dir = path.join(OUT, String(id));
    await mkdir(dir, { recursive: true });

    for (const tier of TIERS) {
        const outFile = path.join(dir, id + "-" + tier.height + ".mp4");
        const vf = scaleFilter(meta.width, meta.height, tier.height);

        for (let attempt = 0; attempt < 2; attempt++) {
            const crf = tier.crf + attempt * 8;
            const args = ["-y", "-hide_banner", "-loglevel", "error", "-i", src];
            if (vf) args.push("-vf", vf);
            args.push(
                "-c:v", "libx264",
                "-crf", String(crf),
                "-preset", "veryfast",
                "-profile:v", "main",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", tier.audioKbps + "k",
                "-ac", "2",
                "-movflags", "+faststart",
                outFile
            );

            const t0 = Date.now();
            try {
                await run("ffmpeg", args, { maxBuffer: 16 * 1024 * 1024 });
            } catch (e) {
                throw new Error(tier.height + "p 转码失败：" + (e.stderr || e.message || e));
            }

            const got = (await stat(outFile)).size;
            written.push(outFile);
            log("#" + id, "→ " + tier.height + "p（crf " + crf + "）", (got / 1048576).toFixed(2) + "MB",
                "用时 " + ((Date.now() - t0) / 1000).toFixed(1) + "s");

            /* Pages 单文件 25MB 是硬限制，超了整次部署都会失败，
               所以这里就地加 CRF 重压一次，而不是让部署报错 */
            if (got <= MAX_OUT || attempt === 1) break;
            log("#" + id, "  超过 24MB，加 CRF 重压一次");
        }
    }

    /* 封面：第 25% 处，最多不超过第 5 秒 */
    let at = (meta.duration || 1) * 0.25;
    if (at > 5) at = 5;
    if (at < 0.4) at = 0.4;

    const cover = path.join(dir, "cover.jpg");
    try {
        await run("ffmpeg", [
            "-y", "-hide_banner", "-loglevel", "error",
            "-ss", at.toFixed(2), "-i", src,
            "-frames:v", "1",
            "-vf", "scale=720:-2",
            "-q:v", "3",
            cover
        ], { maxBuffer: 8 * 1024 * 1024 });
        log("#" + id, "→ 封面", ((await stat(cover)).size / 1024).toFixed(0) + "KB");
    } catch (e) {
        log("#" + id, "!! 封面失败（不影响播放）：" + (e.stderr || e.message || e));
    }
}

async function main() {
    /* 先确认工具在不在：runner 上没有 ffmpeg 时，报错会是一句
       "spawn ffmpeg ENOENT"，看不出是环境问题还是文件问题 */
    for (const bin of ["ffmpeg", "ffprobe"]) {
        try {
            await run(bin, ["-version"]);
        } catch (e) {
            throw new Error("这台机器上没有 " + bin + "，先把 ffmpeg 装上再跑（apt-get install -y ffmpeg）");
        }
    }

    const map = await collect();

    if (map.size === 0) {
        log("_raw/ 里没有待转码的分块，什么都不做");
        return;
    }

    log("待处理：" + [...map.values()].map((g) => "#" + g.id + "（" + g.files.length + " 块）").join("、"));

    let failed = 0;
    for (const [key, group] of map) {
        try {
            await transcodeOne(group);
        } catch (e) {
            failed++;
            log("#" + group.id, "!! 失败（" + key + "）：" + (e && e.message ? e.message : e));
        }
    }

    if (failed) {
        log(failed + " 个视频转码失败");
        process.exit(1);
    }

    log("全部完成");
}

main().catch((e) => {
    console.error("转码脚本崩了：" + (e && e.stack ? e.stack : e));
    process.exit(1);
});
