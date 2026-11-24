#!/usr/bin/env node
/**
 * yowat · 视频打包（360p + 240p，不留高清）
 * ---------------------------------------------------------------
 * 一次产出两个档位，压完把源文件删掉——站点上永远只有小文件：
 *
 *   videos/{id}/{id}-360.mp4   主版本，播放页默认放这个
 *   videos/{id}/{id}-240.mp4   省流版，切换清晰度 / back 接口用
 *   videos/{id}/cover.jpg      封面（缺了才抽）
 *
 * 源文件从哪来（按顺序找）：
 *   1) _incoming/{id}.mp4      上传页暂存的原始文件（不进部署）
 *   2) videos/{id}/{id}.mp4    老的放法（压完会删掉）
 *   3) --from 指定的外部路径
 *
 * 用法（在项目根目录）：
 *   npm run pack                   处理 _incoming/ 里所有待打包的
 *   npm run pack -- --id 2         只处理 2 号
 *   npm run pack -- --all          所有还能找到源的 id
 *   npm run pack -- --id 3 --from "D:\\原始.mp4"
 *   npm run pack -- --id 2 --dry-run    只看会压成多大
 *
 * 常用参数：
 *   --tiers 360,240   档位（短边像素），默认 360 与 240
 *   --crf 30          360p 的画质，数字越大越小越糊；低档位自动 +2
 *   --preset slow     x264 预设
 *   --fps 30          超过就压到 30 帧
 *   --keep-source     压完保留源文件（默认删）
 *   --no-cover        不抽封面
 *   --no-db           不同步数据库（默认会更新 src/low/size）
 *   --yes             非交互确认
 *
 * 依赖：本机装了 ffmpeg / ffprobe。
 */

import { spawn, spawnSync } from "node:child_process";
import {
    copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_DIR = path.join(ROOT, "videos");
const INCOMING_DIR = path.join(ROOT, "_incoming");

export const DEFAULTS = Object.freeze({
    tiers: [360, 240],
    crf: 30,
    preset: "slow",
    audioKbps: 64,
    fps: 0
});

/** 主档位（播放页默认）与省流档位 */
export const TIER_MAIN = 360;
export const TIER_LOW = 240;

/* =========================================================
   纯函数（给测试用，不碰磁盘）
   ========================================================= */

/** "360,240" → [360,240]，去重、降序、限 3 档 */
export function parseTiers(raw) {
    const list = String(raw || "")
        .split(/[,，\s]+/)
        .filter(Boolean)
        .map((s) => {
            const n = Number(s);
            if (!Number.isFinite(n) || n <= 0) throw new Error("--tiers 里有非法值：" + s);
            return Math.round(n);
        });

    const uniq = list.filter((v, i) => list.indexOf(v) === i).sort((a, b) => b - a);
    if (!uniq.length) throw new Error("--tiers 至少要有一个档位");
    if (uniq.length > 3) throw new Error("--tiers 最多 3 档");
    return uniq;
}

/** 第 i 档的实际编码参数：越低档 CRF 越大、音频码率越低 */
export function tierOptions(height, index, opts) {
    return {
        height,
        crf: Math.min(51, Number(opts.crf) + index * 2),
        preset: opts.preset,
        fps: Number(opts.fps) || 0,
        audioKbps: index === 0 ? Number(opts.audioKbps) : Math.max(32, Number(opts.audioKbps) - 16)
    };
}

/** 某个视频在某个档位下的文件名 */
export function tierFile(id, height) {
    return id + "-" + height + ".mp4";
}

/** 解析命令行参数。非法数字直接抛错，别让 ffmpeg 拿到垃圾参数。 */
export function parseArgs(argv) {
    const o = {
        ids: [], all: false, pending: false, from: "",
        tiers: DEFAULTS.tiers.slice(), crf: DEFAULTS.crf, preset: DEFAULTS.preset,
        fps: DEFAULTS.fps, audioKbps: DEFAULTS.audioKbps,
        dryRun: false, yes: false, keepSource: false, cover: true, db: true, help: false
    };

    const num = (raw, flag) => {
        const n = Number(raw);
        if (!Number.isFinite(n) || n <= 0) throw new Error(flag + " 需要一个正数，收到：" + raw);
        return n;
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(a + " 后面缺参数");
            return v;
        };
        switch (a) {
            case "--id": o.ids.push(num(next(), "--id")); break;
            case "--ids": String(next()).split(",").forEach((s) => {
                if (s.trim()) o.ids.push(num(s.trim(), "--ids"));
            }); break;
            case "--all": o.all = true; break;
            case "--pending": o.pending = true; break;
            case "--from": o.from = next(); break;
            case "--tiers": o.tiers = parseTiers(next()); break;
            case "--height": o.tiers = [num(next(), "--height")]; break;
            case "--crf": o.crf = num(next(), "--crf"); break;
            case "--preset": o.preset = next(); break;
            case "--fps": o.fps = num(next(), "--fps"); break;
            case "--keep-source": o.keepSource = true; break;
            case "--no-cover": o.cover = false; break;
            case "--no-db": o.db = false; break;
            case "--db": o.db = true; break;
            case "--dry-run": o.dryRun = true; break;
            case "--yes": case "-y": o.yes = true; break;
            case "--help": case "-h": o.help = true; break;
            default:
                if (a.startsWith("-")) throw new Error("不认识的参数：" + a);
        }
    }
    return o;
}

/**
 * 算缩放滤镜。360p 指的是「短边 360」：横屏压高度，竖屏压宽度。
 * 原片短边已经 ≤ 目标值就不放大（放大只会更糊更大）。
 */
export function planScale(width, height, target = TIER_MAIN) {
    const w = Number(width), h = Number(height), t = Number(target);
    if (!(w > 0) || !(h > 0)) return { needed: false, filter: null, reason: "unknown-size" };
    if (!(t > 0)) return { needed: false, filter: null, reason: "unknown-size" };

    const shortSide = Math.min(w, h);
    if (shortSide <= t) return { needed: false, filter: null, reason: "already-small" };

    return {
        needed: true,
        // -2 让另一边自动取偶数，h264 的 yuv420p 要求宽高都是偶数
        filter: w >= h ? "scale=-2:" + t : "scale=" + t + ":-2",
        reason: "downscale"
    };
}

/** 按 ISO 存储单位显示体积 */
export function fmtBytes(n) {
    const v0 = Number(n);
    if (!Number.isFinite(v0) || v0 < 0) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let v = v0, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    if (i === 0) return Math.round(v) + " B";
    return (v < 10 ? v.toFixed(1) : String(Math.round(v))) + " " + units[i];
}

/** 体积变化百分比，负数代表省了多少 */
export function shrinkPct(before, after) {
    const b = Number(before), a = Number(after);
    if (!(b > 0) || !(a >= 0)) return 0;
    return Math.round((a / b - 1) * 100);
}

/** ffprobe 的 JSON → 我们关心的字段 */
export function readProbe(data) {
    const streams = (data && data.streams) || [];
    const v = streams.find((s) => s.codec_type === "video") || {};
    const a = streams.find((s) => s.codec_type === "audio");
    const fmt = (data && data.format) || {};

    let fps = 0;
    if (v.avg_frame_rate) {
        const parts = String(v.avg_frame_rate).split("/").map(Number);
        fps = parts[1] ? parts[0] / parts[1] : 0;
    }

    return {
        width: Number(v.width || 0),
        height: Number(v.height || 0),
        duration: Number(fmt.duration || v.duration || 0),
        size: Number(fmt.size || 0),
        bitrate: Number(fmt.bit_rate || 0),
        fps: Math.round(fps * 100) / 100,
        vcodec: v.codec_name || "",
        acodec: a ? a.codec_name || "aac" : "",
        hasAudio: !!a
    };
}

/** 拼 ffmpeg 参数：视频永远重编码，音频有就带 AAC，没有就 -an */
export function buildFfmpegArgs(input, output, probe, opts) {
    const plan = planScale(probe.width, probe.height, opts.height);
    const args = ["-y", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", input];

    if (plan.needed) args.push("-vf", plan.filter);

    args.push(
        "-c:v", "libx264",
        "-crf", String(opts.crf),
        "-preset", opts.preset,
        "-profile:v", "high",
        "-level", "3.1",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart"
    );

    if (opts.fps > 0) args.push("-r", String(opts.fps));

    if (probe.hasAudio) args.push("-c:a", "aac", "-b:a", opts.audioKbps + "k", "-ac", "2");
    else args.push("-an");

    args.push("-sn", "-dn", "-map_metadata", "-1");
    args.push("-progress", "pipe:1", "-nostats", output);

    return args;
}

/** 秒 → 1m02s */
export function fmtElapsed(sec) {
    const s = Math.max(0, Number(sec) || 0);
    if (s < 60) return s.toFixed(1) + "s";
    return Math.floor(s / 60) + "m" + String(Math.round(s % 60)).padStart(2, "0") + "s";
}

/** 一条记录要写到库里的路径（档位文件名是固定的，前端和接口都按这个拼） */
export function tierPaths(id) {
    return {
        src: "videos/" + id + "/" + tierFile(id, TIER_MAIN),
        low: "videos/" + id + "/" + tierFile(id, TIER_LOW)
    };
}

/* =========================================================
   进程调用
   ========================================================= */

function which(bin) {
    const r = spawnSync(bin, ["-version"], { stdio: "ignore", shell: false });
    return r.status === 0;
}

export function probeFile(file) {
    const r = spawnSync(
        "ffprobe",
        ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
        { encoding: "utf8", shell: false, maxBuffer: 8 * 1024 * 1024 }
    );
    if (r.status !== 0) {
        throw new Error("ffprobe 读不了这个文件：" + file + "\n" + (r.stderr || "").trim());
    }
    return readProbe(JSON.parse(r.stdout));
}

/** 跑 ffmpeg，顺便按 out_time 画进度 */
function runFfmpeg(args, duration, label) {
    return new Promise((resolve, reject) => {
        const child = spawn("ffmpeg", args, { shell: false });
        let stderr = "";
        let buf = "";
        let pct = 0;
        const tty = process.stdout.isTTY;

        child.stdout.on("data", (chunk) => {
            buf += chunk.toString();
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const line of lines) {
                if (!line.startsWith("out_time_ms=")) continue;
                const us = Number(line.slice("out_time_ms=".length));
                if (!duration || !Number.isFinite(us)) continue;
                pct = Math.min(99, Math.round((us / 1e6 / duration) * 100));
                if (tty) process.stdout.write("\r    " + label + " 进度 " + String(pct).padStart(3) + "%");
                else if (pct % 25 < 2) process.stdout.write("    " + label + " 进度 " + pct + "%\n");
            }
        });

        child.stderr.on("data", (c) => { stderr += c.toString(); });
        child.on("error", reject);
        child.on("close", (code) => {
            if (tty && pct > 0) process.stdout.write("\r    " + label + " 进度 100%\n");
            if (code === 0) resolve();
            else reject(new Error("ffmpeg 退出码 " + code + "\n" + stderr.trim().slice(-1200)));
        });
    });
}

/* =========================================================
   主流程
   ========================================================= */

function usage() {
    console.log(`
yowat · 视频打包（360p + 240p，不留高清）

  npm run pack                       处理 _incoming/ 里待打包的
  npm run pack -- --id 2             只处理 2 号
  npm run pack -- --all              所有能找到源文件的
  npm run pack -- --id 3 --from "D:\\原始.mp4"

参数：--tiers 360,240  --crf 30  --preset slow  --fps 30
      --keep-source（保留源文件）  --no-cover  --no-db  --dry-run  --yes
`);
}

/** 在 _incoming/ 里找某个 id 的源文件（任意扩展名） */
function incomingSource(id) {
    if (!existsSync(INCOMING_DIR)) return "";
    for (const name of readdirSync(INCOMING_DIR)) {
        if (path.parse(name).name === String(id) && /\.(mp4|webm|mov|mkv)$/i.test(name)) {
            return path.join(INCOMING_DIR, name);
        }
    }
    return "";
}

function legacySource(id) {
    const p = path.join(VIDEO_DIR, String(id), id + ".mp4");
    return existsSync(p) ? p : "";
}

/** 找要处理的视频 */
function resolveTargets(args) {
    const found = [];

    if (args.from) {
        if (args.ids.length !== 1) throw new Error("--from 需要配合 --id 指定目标编号，例如 --id 3 --from D:\\\\a.mp4");
        if (!existsSync(args.from)) throw new Error("找不到这个文件：" + args.from);
        const id = args.ids[0];
        found.push({ id, src: path.resolve(args.from), external: true });
        return found;
    }

    if (args.pending) {
        if (!existsSync(INCOMING_DIR)) return found;
        for (const name of readdirSync(INCOMING_DIR)) {
            const base = path.parse(name).name;
            if (!/^\d+$/.test(base)) continue;
            if (!/\.(mp4|webm|mov|mkv)$/i.test(name)) continue;
            found.push({ id: Number(base), src: path.join(INCOMING_DIR, name) });
        }
        found.sort((a, b) => a.id - b.id);
        return found;
    }

    if (args.all) {
        const ids = new Set();

        if (existsSync(INCOMING_DIR)) {
            for (const name of readdirSync(INCOMING_DIR)) {
                const base = path.parse(name).name;
                if (/^\d+$/.test(base) && /\.(mp4|webm|mov|mkv)$/i.test(name)) ids.add(Number(base));
            }
        }
        if (existsSync(VIDEO_DIR)) {
            for (const dir of readdirSync(VIDEO_DIR)) {
                if (!/^\d+$/.test(dir)) continue;
                if (existsSync(path.join(VIDEO_DIR, dir, dir + ".mp4"))) ids.add(Number(dir));
            }
        }

        return Array.from(ids).sort((a, b) => a - b).map((id) => ({
            id,
            src: incomingSource(id) || legacySource(id)
        }));
    }

    for (const id of args.ids) {
        const src = incomingSource(id) || legacySource(id);
        if (!src) {
            throw new Error("找不到 " + id + " 号的源文件。找过：_incoming/" + id + ".mp4、" +
                "videos/" + id + "/" + id + ".mp4。用 --from 指定原始文件，或先在 /upload 页补文件");
        }
        found.push({ id, src });
    }

    return found;
}

/**
 * 用临时文件替换目标文件。
 * Windows 上目标文件被播放器/杀软占用时 rename 会报 EPERM，
 * 所以退化成「先删再换」，再不行就复制过去。
 */
function replaceFile(tmp, dest) {
    try {
        renameSync(tmp, dest);
        return;
    } catch (e) {
        if (e.code !== "EPERM" && e.code !== "EACCES" && e.code !== "EBUSY") throw e;
    }

    try {
        if (existsSync(dest)) rmSync(dest, { force: true });
        renameSync(tmp, dest);
        return;
    } catch (e) { /* 继续降级 */ }

    copyFileSync(tmp, dest);
    rmSync(tmp, { force: true });
}

/** 抽一帧做封面（保留原比例，宽最多 720） */
function makeCover(src, dest, duration) {
    const at = Math.min(5, Math.max(0.4, (duration || 0) * 0.25)).toFixed(2);
    const r = spawnSync("ffmpeg", [
        "-y", "-hide_banner", "-nostdin", "-loglevel", "error",
        "-ss", String(at), "-i", src, "-frames:v", "1",
        "-vf", "scale=720:-2", "-q:v", "3", dest
    ], { encoding: "utf8", shell: false });
    return r.status === 0 && existsSync(dest);
}

/** 把 src/low/size 写回 D1（失败不致命，只是首页统计会旧） */
function syncDb(rows) {
    if (!rows.length) return true;
    mkdirSync(INCOMING_DIR, { recursive: true });
    const sqlFile = path.join(INCOMING_DIR, "update-db.sql");
    const sql = rows.map((r) =>
        "UPDATE videos SET src = '" + r.src + "', low = '" + r.low + "', size = " + r.size +
        " WHERE id = " + r.id + ";"
    ).join("\n") + "\n";
    writeFileSync(sqlFile, sql, "utf8");

    const bin = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
    const r = spawnSync(bin, ["d1", "execute", "yowat-db", "--remote", "--file=" + sqlFile], {
        encoding: "utf8", shell: process.platform === "win32"
    });

    const out = (r.stdout || "") + (r.stderr || "");
    if (r.status === 0 && !/ERROR|error:/i.test(out)) return true;

    console.log("  提示    数据库没同步成功（不影响播放，路径是按 id 拼的）。");
    console.log("          稍后可以手动跑：npx wrangler d1 execute yowat-db --remote --file=_incoming/update-db.sql");
    if (out.trim()) console.log("          " + out.trim().split("\n").slice(-2).join(" "));
    return false;
}

async function packOne(target, args) {
    const { id, src } = target;
    if (!existsSync(src)) throw new Error("源文件不存在：" + src);

    const before = probeFile(src);
    const dir = path.join(VIDEO_DIR, String(id));
    mkdirSync(dir, { recursive: true });

    console.log("");
    console.log("▶ " + id + " 号视频");
    console.log("  源文件  " + path.relative(ROOT, src));
    console.log("  原始    " + before.width + "×" + before.height + " · " + fmtBytes(before.size) + " · " +
        (before.duration ? before.duration.toFixed(0) + "s" : "?") +
        (before.bitrate ? " · " + Math.round(before.bitrate / 1000) + " kbps" : ""));
    console.log("  档位    " + args.tiers.map((t) => t + "p").join(" + ") +
        " · CRF " + args.crf + "（逐档 +2）· " + args.preset);

    if (args.dryRun) {
        console.log("  （--dry-run，只估算不动手）");
        return { id, before, tiers: [], skipped: true };
    }

    const outputs = [];
    let mainSize = 0;

    for (let i = 0; i < args.tiers.length; i++) {
        const height = args.tiers[i];
        const opts = tierOptions(height, i, args);
        const dest = path.join(dir, tierFile(id, height));
        const tmp = path.join(dir, "." + id + "-" + height + ".tmp.mp4");
        if (existsSync(tmp)) rmSync(tmp, { force: true });

        const t0 = Date.now();
        try {
            await runFfmpeg(buildFfmpegArgs(src, tmp, before, opts), before.duration, height + "p");
        } catch (err) {
            if (existsSync(tmp)) rmSync(tmp, { force: true });
            throw err;
        }

        const after = probeFile(tmp);
        replaceFile(tmp, dest);
        outputs.push({ height, size: after.size, width: after.width, heightPx: after.height, cost: (Date.now() - t0) / 1000 });
        if (i === 0) mainSize = after.size;

        console.log("  " + String(height + "p").padEnd(6) + path.relative(ROOT, dest).padEnd(26) +
            fmtBytes(after.size).padStart(9) + " · " + after.width + "×" + after.height +
            " · " + fmtElapsed((Date.now() - t0) / 1000));
    }

    /* ---------- 封面 ---------- */
    const cover = path.join(dir, "cover.jpg");
    if (args.cover && !existsSync(cover)) {
        console.log(makeCover(src, cover, before.duration)
            ? "  封面    " + path.relative(ROOT, cover) + " · " + fmtBytes(statSync(cover).size)
            : "  封面    抽帧失败（不影响播放），可手动补：" + path.relative(ROOT, cover));
    }

    /* ---------- 清掉老文件：高清源 + 旧的 -low ---------- */
    const legacyLow = path.join(dir, id + "-low.mp4");
    if (existsSync(legacyLow)) {
        rmSync(legacyLow, { force: true });
        console.log("  清理    删掉旧的 " + path.relative(ROOT, legacyLow) + "（已被 -" + TIER_MAIN + ".mp4 取代）");
    }

    if (!args.keepSource && !target.external) {
        try {
            rmSync(src, { force: true });
            console.log("  清理    源文件已删除（不留高清）：" + path.relative(ROOT, src));
        } catch (e) {
            console.log("  提示    源文件删不掉（" + e.code + "），稍后手动删：" + path.relative(ROOT, src));
        }
    } else if (target.external) {
        console.log("  说明    --from 用的是站外文件，没动它");
    }

    const total = outputs.reduce((s, o) => s + o.size, 0);
    console.log("  合计    " + fmtBytes(before.size) + " → " + fmtBytes(total) +
        "（" + shrinkPct(before.size, total) + "%）" +
        (before.size - total > 0 ? "，省出 " + fmtBytes(before.size - total) : ""));

    return { id, before, tiers: outputs, mainSize };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) return usage();

    const explicit = args.all || args.pending || args.ids.length;
    if (!explicit) {
        args.pending = true;          // 不带参数等于「处理暂存区」
    }

    if (!which("ffmpeg") || !which("ffprobe")) {
        console.error("找不到 ffmpeg / ffprobe。装一个再跑：https://www.gyan.dev/ffmpeg/builds/");
        process.exitCode = 1;
        return;
    }

    const targets = resolveTargets(args);
    if (!targets.length) {
        /* 默认模式（什么都指）下暂存区空着是正常情况，不该报错中断 npm run publish */
        if (args.pending && !args.all && !args.ids.length) {
            console.log("暂存区 _incoming/ 是空的，没有要打包的文件。");
            console.log("把视频拖到 " + path.relative(ROOT, INCOMING_DIR) + "/{id}.mp4，或跑 npm run add -- --file \"视频路径\"");
            return;
        }
        console.error("没有找到可打包的视频。");
        console.error("找过：_incoming/{id}.mp4、videos/{id}/{id}.mp4 —— 用 --from 指定原始文件，或先在 /upload 页补文件");
        process.exitCode = 1;
        return;
    }

    const results = [];
    let failed = 0;

    for (const t of targets) {
        try {
            results.push(await packOne(t, args));
        } catch (err) {
            failed++;
            console.error("  ✗ " + t.id + " 号失败：" + err.message);
        }
    }

    /* ---------- 汇总 ---------- */
    const done = results.filter((r) => r.tiers && r.tiers.length);

    if (done.length > 1) {
        console.log("");
        console.log("汇总");
        console.log("  id   原始              " + TIER_MAIN + "p          " + TIER_LOW + "p          合计节省");
        let b = 0, a = 0;
        for (const r of done) {
            const total = r.tiers.reduce((s, o) => s + o.size, 0);
            b += r.before.size; a += total;
            console.log(
                "  " + String(r.id).padEnd(4) +
                (fmtBytes(r.before.size) + " " + r.before.width + "×" + r.before.height).padEnd(18) +
                fmtBytes(r.tiers[0].size).padEnd(13) +
                fmtBytes(r.tiers[1] ? r.tiers[1].size : 0).padEnd(13) +
                shrinkPct(r.before.size, total) + "%"
            );
        }
        console.log("  合计 " + fmtBytes(b) + " → " + fmtBytes(a) + "（" + shrinkPct(b, a) + "%）");
    }

    if (done.length) {
        if (args.db) {
            console.log("");
            console.log("数据库");
            syncDb(done.map((r) => {
                const p = tierPaths(r.id);
                return { id: r.id, src: p.src, low: p.low, size: r.mainSize };
            }));
        }

        console.log("");
        console.log("下一步：npm run deploy");
    }

    if (failed) process.exitCode = 1;
}

/* 只有直接运行才跑 CLI，被 import 时只导出函数（测试要用） */
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    main().catch((err) => {
        console.error("\n出错了：" + err.message);
        process.exitCode = 1;
    });
}
