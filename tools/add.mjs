#!/usr/bin/env node
/**
 * yowat · 一条命令加视频
 * ---------------------------------------------------------------
 * 把外部视频接进项目：拷进 _incoming/{id}.mp4 → 调 compress 压 360p+240p
 * → 源文件删掉，站点上只留两个小文件。
 *
 * 用法：
 *   node tools/add.mjs --file "D:\拍的.mp4"
 *        自动分配新 id
 *
 *   node tools/add.mjs --file "D:\拍的.mp4" --id 2
 *        指定 id。库里已有 2 号记录、但 videos/2/ 是空的？就是这种补文件场景
 *
 *   node tools/add.mjs --file "D:\拍的.mp4" --title "标题" --tags "日常,旅行" --register
 *        --register 连线上 /api/upload 登记元数据，id 用服务端分配的
 *
 * 其它参数：--desc "简介"  --no-compress（只拷进暂存区）  --site https://xxx  --dry-run
 */

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { probeFile, fmtBytes, fmtElapsed } from "./compress.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_DIR = path.join(ROOT, "videos");
const DATA_FILE = path.join(ROOT, "assets", "js", "videos.data.js");
const DEFAULT_SITE = "https://yowat.pages.dev";

/* =========================================================
   纯函数
   ========================================================= */

export function parseAddArgs(argv) {
    const o = {
        file: "", id: 0, title: "", desc: "", tags: [], register: false,
        compress: true, site: DEFAULT_SITE, dryRun: false, help: false
    };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => {
            const v = argv[++i];
            if (v === undefined) throw new Error(a + " 后面缺参数");
            return v;
        };
        switch (a) {
            case "--file": o.file = next(); break;
            case "--id": {
                const n = Number(next());
                if (!Number.isInteger(n) || n <= 0) throw new Error("--id 要正整数");
                o.id = n;
                break;
            }
            case "--title": o.title = next(); break;
            case "--desc": case "--description": o.desc = next(); break;
            case "--tags": o.tags = String(next()).split(/[,，\s]+/).filter(Boolean).slice(0, 5); break;
            case "--register": o.register = true; break;
            case "--no-compress": o.compress = false; break;
            case "--site": o.site = next().replace(/\/+$/, ""); break;
            case "--dry-run": o.dryRun = true; break;
            case "--help": case "-h": o.help = true; break;
            default:
                if (a.startsWith("-")) throw new Error("不认识的参数：" + a);
        }
    }
    return o;
}

/** 本地已有的最大 id（目录 + 兜底清单里取大的） */
export function maxLocalId(dirNames, dataText) {
    let max = 0;
    for (const name of dirNames || []) {
        if (/^\d+$/.test(String(name))) max = Math.max(max, Number(name));
    }
    const re = /\bid\s*:\s*(\d+)/g;
    let m;
    while ((m = re.exec(String(dataText || ""))) !== null) {
        max = Math.max(max, Number(m[1]));
    }
    return max;
}

/** 文件名 → 默认标题 */
export function titleFromFile(file) {
    const base = path.basename(String(file)).replace(/\.[^.]+$/, "");
    return base.slice(0, 50);
}

/* =========================================================
   主流程
   ========================================================= */

function usage() {
    console.log(`
yowat · 一条命令加视频

  node tools/add.mjs --file "D:\\拍的.mp4"
  node tools/add.mjs --file "D:\\拍的.mp4" --id 2          指定编号（补库里已有的记录）
  node tools/add.mjs --file "D:\\拍的.mp4" --title "标题" --tags "日常,旅行" --register

参数：--desc 简介  --no-compress  --site https://yowat.pages.dev  --dry-run
`);
}

function localIds() {
    if (!existsSync(VIDEO_DIR)) return [];
    return readdirSync(VIDEO_DIR).filter((n) => /^\d+$/.test(n));
}

async function registerRemote(opts, probe) {
    const body = {
        title: opts.title || titleFromFile(opts.file),
        description: opts.desc || "",
        duration: Math.round(probe.duration || 0),
        size: probe.size || 0,
        tags: opts.tags
    };

    const res = await fetch(opts.site + "/api/upload/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });
    const json = await res.json();
    if (!json || json.code !== 0) {
        throw new Error("登记失败：" + (json && json.message ? json.message : "HTTP " + res.status));
    }
    return json.data;
}

async function main() {
    const opts = parseAddArgs(process.argv.slice(2));
    if (opts.help) return usage();

    if (!opts.file) {
        usage();
        process.exitCode = 1;
        return;
    }

    const src = path.resolve(opts.file);
    if (!existsSync(src)) {
        console.error("找不到文件：" + src);
        process.exitCode = 1;
        return;
    }

    const probe = probeFile(src);
    const size = probe.size || statSync(src).size;
    console.log("");
    console.log("源文件  " + src);
    console.log("规格    " + probe.width + "×" + probe.height + " · " + fmtBytes(size) +
        " · " + Math.round(probe.duration) + "s" + (probe.fps ? " · " + probe.fps + "fps" : ""));

    /* ---------- 定 id ---------- */
    let id = opts.id;
    let registered = null;

    if (opts.register && !opts.dryRun) {
        console.log("登记    正在写 D1 …");
        registered = await registerRemote(opts, probe);
        id = Number(registered.video_id);
        console.log("登记    OK，video_id = " + id);
    }

    if (!id) {
        id = maxLocalId(localIds(), existsSync(DATA_FILE) ? readFileSync(DATA_FILE, "utf8") : "");
        id += 1;
        console.log("编号    本地最大 " + (id - 1) + "，这个用 " + id);
    }

    const dir = path.join(ROOT, "_incoming");
    const dest = path.join(dir, id + ".mp4");

    console.log("暂存    " + path.relative(ROOT, dest) + (existsSync(dest) ? "（已存在，会覆盖）" : ""));

    if (opts.dryRun) {
        console.log("\n（--dry-run，什么都没动）");
        return;
    }

    /* ---------- 拷进暂存区 ---------- */
    mkdirSync(dir, { recursive: true });
    copyFileSync(src, dest);
    console.log("拷贝    OK，" + fmtBytes(statSync(dest).size));

    /* ---------- 压 360p + 240p（源文件压完会被删） ---------- */
    if (opts.compress) {
        console.log("");
        const t0 = Date.now();
        const ok = await new Promise((resolve) => {
            const child = spawn(process.execPath, [path.join(ROOT, "tools", "compress.mjs"), "--id", String(id), "--yes"], {
                stdio: "inherit", shell: false
            });
            child.on("close", (code) => resolve(code === 0));
            child.on("error", () => resolve(false));
        });
        if (!ok) console.log("打包    失败，可以手动重跑：npm run pack -- --id " + id);
        else console.log("\n耗时    " + fmtElapsed((Date.now() - t0) / 1000));
    }

    /* ---------- 收尾 ---------- */
    console.log("");
    if (!registered) {
        const apiPath = [opts.title || titleFromFile(opts.file), opts.desc].filter(Boolean)
            .map(encodeURIComponent).join("/");
        const payload = '{"duration":' + Math.round(probe.duration) + ',"size":' + size +
            ',"tags":' + JSON.stringify(opts.tags) + '}';
        console.log("还差一步：元数据要进 D1，视频才会出现在首页。");
        console.log("  A) 打开 " + opts.site + "/upload.html 提交一次（id 会变，适合全新视频）");
        console.log("  B) 直接打接口：");
        console.log('     curl -X POST "' + opts.site + "/api/upload/" + apiPath + '/" ^');
        console.log('       -H "Content-Type: application/json" ^');
        console.log('       -d "' + payload.replace(/"/g, '\\"') + '"');
        console.log("  C) 加 --register 让脚本自己登记");
        console.log("");
        console.log("如果是补库里已有的记录（id " + id + " 已经存在），就别再登记了，直接部署：");
    }
    console.log("  npm run deploy");
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
    main().catch((err) => {
        console.error("\n出错了：" + err.message);
        process.exitCode = 1;
    });
}
