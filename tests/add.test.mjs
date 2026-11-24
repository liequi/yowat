/**
 * add.mjs 的纯函数测试（不落盘、不联网）
 * 跑法：node tests/add.test.mjs
 */

import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { parseAddArgs, maxLocalId, titleFromFile } = await import(
    pathToFileURL(path.join(ROOT, "tools", "add.mjs")).href
);

const results = [];
function check(name, cond, detail) {
    results.push({ name, ok: !!cond, detail });
}

/* ---------------- 参数 ---------------- */
{
    const a = parseAddArgs(["--file", "D:\\拍 的.mp4"]);
    check("--file 原样保留（含空格中文）", a.file === "D:\\拍 的.mp4", a.file);
    check("默认会压缩", a.compress === true, String(a.compress));
    check("默认不登记", a.register === false, String(a.register));
    check("默认站点", a.site === "https://yowat.pages.dev", a.site);
}
{
    const a = parseAddArgs(["--file", "a.mp4", "--id", "2", "--title", "标题", "--tags", "日常, 旅行 音乐"]);
    check("--id 转数字", a.id === 2, String(a.id));
    check("--title", a.title === "标题", a.title);
    check("--tags 拆分最多 5 个", JSON.stringify(a.tags) === '["日常","旅行","音乐"]', JSON.stringify(a.tags));
}
{
    const a = parseAddArgs(["--file", "a.mp4", "--register", "--no-compress", "--site", "http://localhost:8788/"]);
    check("--register", a.register === true, String(a.register));
    check("--no-compress", a.compress === false, String(a.compress));
    check("--site 去掉末尾斜杠", a.site === "http://localhost:8788", a.site);
}
{
    let threw = false;
    try { parseAddArgs(["--file", "a.mp4", "--id", "0"]); } catch (e) { threw = true; }
    check("--id 0 要报错", threw);
}
{
    let threw = false;
    try { parseAddArgs(["--file", "a.mp4", "--id", "2.5"]); } catch (e) { threw = true; }
    check("--id 小数要报错", threw);
}
{
    let threw = false;
    try { parseAddArgs(["--file"]); } catch (e) { threw = true; }
    check("--file 缺值要报错", threw);
}
{
    let threw = false;
    try { parseAddArgs(["--file", "a.mp4", "--whatever"]); } catch (e) { threw = true; }
    check("未知参数要报错", threw);
}

/* ---------------- id 分配 ---------------- */
{
    check("空目录从 1 开始", maxLocalId([], "") === 0, String(maxLocalId([], "")));
    check("按目录取最大", maxLocalId(["1", "2", "7"], "") === 7, String(maxLocalId(["1", "2", "7"], "")));
    check("非数字目录忽略", maxLocalId(["1", "README.md", "abc"], "") === 1, String(maxLocalId(["1", "README.md"], "")));
}
{
    const data = "YOWAT_VIDEOS = [{ id: 1, title: 'a' }, { id: 5, title: 'b' }];";
    check("清单里的 id 也算", maxLocalId([], data) === 5, String(maxLocalId([], data)));
    check("目录与清单取大的", maxLocalId(["2"], data) === 5, String(maxLocalId(["2"], data)));
    check("id: 写法兼容空格", maxLocalId([], "{ id :  9 }") === 9, String(maxLocalId([], "{ id :  9 }")));
}
{
    const data = "videos: [{ id: 3 }]";
    check("空目录 + 清单 3", maxLocalId([], data) === 3, String(maxLocalId([], data)));
}

/* ---------------- 标题兜底 ---------------- */
{
    check("去掉扩展名", titleFromFile("D:\\x\\part.1 変異マクドナルド.mp4") === "part.1 変異マクドナルド",
        titleFromFile("D:\\x\\part.1 変異マクドナルド.mp4"));
    check("只去最后一段扩展名", titleFromFile("a.b.webm") === "a.b", titleFromFile("a.b.webm"));
    check("超长截断 50", titleFromFile("x".repeat(80) + ".mp4").length === 50, String(titleFromFile("x".repeat(80) + ".mp4").length));
}

/* ---------------- 输出 ---------------- */
const bad = results.filter((r) => !r.ok);
for (const r of results) {
    console.log(r.ok ? "  ok   " + r.name : "  FAIL " + r.name + "  →  " + (r.detail === undefined ? "" : r.detail));
}
console.log("");
console.log(results.length - bad.length + "/" + results.length + " 通过");
if (bad.length) process.exitCode = 1;
