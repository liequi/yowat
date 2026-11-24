/**
 * 打包工具（tools/compress.mjs）的纯函数测试
 * 不跑 ffmpeg，不碰真实视频。跑法：node tests/compress.test.mjs
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(pathToFileURL(path.join(ROOT, "tools", "compress.mjs")).href);

const {
    parseArgs, parseTiers, tierOptions, tierFile, tierPaths,
    planScale, fmtBytes, shrinkPct, readProbe, buildFfmpegArgs, fmtElapsed, DEFAULTS
} = mod;

const results = [];
function check(name, cond, detail) {
    results.push({ name, ok: !!cond, detail });
}

/* ---------------- 参数解析 ---------------- */
{
    const a = parseArgs(["--id", "3"]);
    check("--id 解析成数字", a.ids.length === 1 && a.ids[0] === 3, JSON.stringify(a.ids));
    check("默认两个档位", JSON.stringify(a.tiers) === "[360,240]", JSON.stringify(a.tiers));
    check("默认值不变", a.crf === 30 && a.preset === "slow", a.crf + "/" + a.preset);
    check("默认删源文件", a.keepSource === false, String(a.keepSource));
    check("默认同步数据库", a.db === true, String(a.db));
}
{
    const a = parseArgs(["--ids", "1, 2 ,5"]);
    check("--ids 逗号列表", JSON.stringify(a.ids) === "[1,2,5]", JSON.stringify(a.ids));
}
{
    const a = parseArgs(["--all", "--crf", "34", "--tiers", "480,360,240", "--yes"]);
    check("--all 与覆写参数", a.all && a.crf === 34 && a.yes === true, JSON.stringify(a));
    check("--tiers 降序保留三档", JSON.stringify(a.tiers) === "[480,360,240]", JSON.stringify(a.tiers));
}
{
    const a = parseArgs(["--pending"]);
    check("--pending 识别", a.pending === true, String(a.pending));
}
{
    const a = parseArgs(["--id", "2", "--from", "D:\\原始 视频.mp4", "--keep-source", "--no-db"]);
    check("--from 保留路径原样", a.from === "D:\\原始 视频.mp4", a.from);
    check("--keep-source 生效", a.keepSource === true, String(a.keepSource));
    check("--no-db 生效", a.db === false, String(a.db));
}
{
    const a = parseArgs(["--id", "1", "--height", "480"]);
    check("--height 是单档位简写", JSON.stringify(a.tiers) === "[480]", JSON.stringify(a.tiers));
}
{
    let threw = false;
    try { parseArgs(["--id", "abc"]); } catch (e) { threw = true; }
    check("--id 非数字要报错", threw);
}
{
    let threw = false;
    try { parseArgs(["--nonsense"]); } catch (e) { threw = true; }
    check("未知参数要报错", threw);
}
{
    let threw = false;
    try { parseArgs(["--crf"]); } catch (e) { threw = true; }
    check("缺值要报错", threw);
}

/* ---------------- 档位解析 ---------------- */
{
    check("去重并降序", JSON.stringify(parseTiers("240,360,240")) === "[360,240]", JSON.stringify(parseTiers("240,360,240")));
    check("中文逗号也行", JSON.stringify(parseTiers("360，240")) === "[360,240]", JSON.stringify(parseTiers("360，240")));
    let threw = false;
    try { parseTiers("0"); } catch (e) { threw = true; }
    check("0 要报错", threw);
    threw = false;
    try { parseTiers("360,480,720,1080"); } catch (e) { threw = true; }
    check("超过 3 档要报错", threw);
}

/* ---------------- 各档编码参数 ---------------- */
{
    const base = { crf: 30, preset: "slow", fps: 0, audioKbps: 64 };
    const main = tierOptions(360, 0, base);
    const low = tierOptions(240, 1, base);
    check("主档位用基准 CRF", main.crf === 30 && main.height === 360, JSON.stringify(main));
    check("低档位 CRF +2", low.crf === 32, String(low.crf));
    check("低档位音频降到 48k", low.audioKbps === 48, String(low.audioKbps));
    check("不传 fps 时不限帧", main.fps === 0, String(main.fps));
}
{
    const p = tierPaths(7);
    check("src 指向 360p", p.src === "videos/7/7-360.mp4", p.src);
    check("low 指向 240p", p.low === "videos/7/7-240.mp4", p.low);
    check("文件名按档位拼", tierFile(7, 240) === "7-240.mp4", tierFile(7, 240));
}

/* ---------------- 缩放计划 ---------------- */
{
    const p = planScale(512, 384, 360);
    check("横屏 512×384 → 压高度", p.needed && p.filter === "scale=-2:360", JSON.stringify(p));
}
{
    const p = planScale(1080, 1920, 360);
    check("竖屏 1080×1920 → 压宽度", p.needed && p.filter === "scale=360:-2", JSON.stringify(p));
}
{
    const p = planScale(320, 240, 240);
    check("正好 240 短边 → 不缩放", !p.needed && p.reason === "already-small", JSON.stringify(p));
}
{
    const p = planScale(320, 240, 360);
    check("已经比 360p 小 → 不缩放", !p.needed, JSON.stringify(p));
}
{
    const p = planScale(640, 360, 360);
    check("正好 360 高 → 不放大", !p.needed, JSON.stringify(p));
}
{
    const p = planScale(0, 0, 360);
    check("尺寸缺失不炸", !p.needed && p.reason === "unknown-size", JSON.stringify(p));
}
{
    const p = planScale(1080, 1080, 360);
    check("正方形按高度压", p.filter === "scale=-2:360", p.filter);
}

/* ---------------- 体积格式化 ---------------- */
{
    check("0 字节", fmtBytes(0) === "0 B", fmtBytes(0));
    check("1024 → 1.0 KB", fmtBytes(1024) === "1.0 KB", fmtBytes(1024));
    check("6.1MB", fmtBytes(6166188) === "5.9 MB", fmtBytes(6166188));
    check("负数给占位", fmtBytes(-1) === "—", fmtBytes(-1));
    check("非数字给占位", fmtBytes(undefined) === "—", fmtBytes(undefined));
}
{
    check("省 50% 记为 -50", shrinkPct(100, 50) === -50, String(shrinkPct(100, 50)));
    check("变大记为正", shrinkPct(100, 120) === 20, String(shrinkPct(100, 120)));
    check("原始为 0 不除零", shrinkPct(0, 10) === 0, String(shrinkPct(0, 10)));
}

/* ---------------- ffprobe 解析 ---------------- */
{
    const probe = readProbe({
        streams: [
            { codec_type: "video", codec_name: "h264", width: 512, height: 384, avg_frame_rate: "25/1" },
            { codec_type: "audio", codec_name: "aac" }
        ],
        format: { duration: "240.5", size: "6166188", bit_rate: "206000" }
    });
    check("读出宽高", probe.width === 512 && probe.height === 384, probe.width + "x" + probe.height);
    check("读出时长", probe.duration === 240.5, String(probe.duration));
    check("识别音轨", probe.hasAudio && probe.acodec === "aac", probe.acodec);
    check("帧率换算", probe.fps === 25, String(probe.fps));
}
{
    const probe = readProbe({ streams: [{ codec_type: "video", width: 640, height: 480 }], format: {} });
    check("没有音轨", probe.hasAudio === false, String(probe.hasAudio));
    check("缺字段不炸", probe.duration === 0 && probe.fps === 0, String(probe.fps));
}

/* ---------------- ffmpeg 参数 ---------------- */
{
    const probe = { width: 512, height: 384, hasAudio: true };
    const args = buildFfmpegArgs("in.mp4", "out.mp4", probe, { ...DEFAULTS, height: 360, fps: 0 });
    const s = args.join(" ");
    check("带缩放滤镜", s.includes("-vf scale=-2:360"), s.slice(0, 80));
    check("CRF 传进去", s.includes("-crf 30"), s);
    check("preset 传进去", s.includes("-preset slow"));
    check("yuv420p + faststart", s.includes("-pix_fmt yuv420p") && s.includes("-movflags +faststart"));
    check("有音轨就转 AAC 64k", s.includes("-c:a aac -b:a 64k"), s);
    check("输出在最后", args[args.length - 1] === "out.mp4", args[args.length - 1]);
    check("不加 -r 时不限帧率", !args.includes("-r"), "有 -r");
}
{
    const probe = { width: 320, height: 240, hasAudio: false };
    const args = buildFfmpegArgs("a.mp4", "b.mp4", probe, { height: 240, crf: 32, preset: "slow", fps: 30, audioKbps: 48 });
    const s = args.join(" ");
    check("小片不加 -vf", !s.includes("-vf"), s);
    check("没音轨用 -an", s.includes("-an"), s);
    check("限帧率生效", s.includes("-r 30"), s);
}

/* ---------------- 耗时格式 ---------------- */
{
    check("秒", fmtElapsed(12.34) === "12.3s", fmtElapsed(12.34));
    check("分秒", fmtElapsed(62) === "1m02s", fmtElapsed(62));
    check("异常值归零", fmtElapsed(NaN) === "0.0s", fmtElapsed(NaN));
}

/* ---------------- 输出 ---------------- */
const bad = results.filter((r) => !r.ok);
for (const r of results) {
    if (r.ok) console.log("  ok   " + r.name);
    else console.log("  FAIL " + r.name + "  →  " + (r.detail === undefined ? "" : r.detail));
}
console.log("");
console.log(results.length - bad.length + "/" + results.length + " 通过");
if (bad.length) process.exitCode = 1;
