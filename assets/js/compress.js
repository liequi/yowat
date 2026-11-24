/**
 * yowat · 浏览器端转码
 * ---------------------------------------------------------------
 * 把选中的视频在**访问者的浏览器里**压成 360p + 240p，并抽一帧当封面。
 * 这样服务器（GitHub 仓库）里永远只存两个几 MB 的小文件，
 * 高清原片一个字节都不上传。
 *
 * 引擎：ffmpeg.wasm 0.11（单线程 core，24MB）。选 0.11 而不是 0.12 的原因：
 * 0.12 的 worker 必须同源加载，跨域或子路径上很容易在别人的浏览器里静默失败；
 * 0.11 用 blob 建 worker，稳。
 *
 * 引擎的三个文件（ffmpeg-core.js / .wasm / .worker.js）同时放在两处：
 *   - 本仓库 assets/js/vendor/（兜底，永远可用）
 *   - jsDelivr / unpkg 的 @ffmpeg/core@0.11.0（首选）
 * 为什么不只用自托管：实测从 pages.dev 拉 24MB 只有 87KB/s，要下四五分钟；
 * 同一台机器从 jsDelivr 拉是 21MB/s。所以优先 CDN，失败自动回退到本站。
 *
 * 对外 API：
 *   YowatCompress.supported()            当前浏览器能不能转码
 *   YowatCompress.ensure(onNote)         预加载引擎（24MB，只下一次）
 *   YowatCompress.probe(file)            {width,height,duration}
 *   YowatCompress.compress(file, opts)   压两个档位 + 封面
 *
 * compress 的返回：
 *   {
 *     "360": { blob, size }, "240": { blob, size },
 *     cover: { blob, size },
 *     source: { width, height, duration }
 *   }
 */

(function (global) {
    "use strict";

    /* 引擎下载源，按顺序试。why：自托管在 Pages 上拉 24MB 实测 87KB/s，
       要四五分钟；jsDelivr 同机 21MB/s，1 秒就完。所以 CDN 优先，
       所有 CDN 都不可用时才回退到本站那份（永远在，不会 404）。 */
    var CORE_SOURCES = [
        { url: "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js", timeout: 45000, label: "jsDelivr" },
        { url: "https://unpkg.com/@ffmpeg/core@0.11.0/dist/ffmpeg-core.js", timeout: 45000, label: "unpkg" },
        { url: "assets/js/vendor/ffmpeg-core.js", timeout: 300000, label: "本站" }
    ];

    /** 两个档位：短边像素 + 画质。CRF 越大越糊越小，逐档 +2 与后端 tools/compress.mjs 一致 */
    var TIERS = [
        { height: 360, crf: 30, audioKbps: 64 },
        { height: 240, crf: 32, audioKbps: 48 }
    ];

    /** 源文件上限。wasm 要把整个文件读进内存，太大浏览器直接崩 */
    var MAX_SOURCE = 220 * 1024 * 1024;

    var instance = null;
    var loadingPromise = null;

    /* =========================================================
       能力检测
       ========================================================= */

    function supported() {
        if (typeof global.WebAssembly !== "object" || typeof global.Worker !== "function") return false;
        if (!global.FFmpeg || typeof global.FFmpeg.createFFmpeg !== "function") return false;
        return true;
    }

    /** 当前页面是不是跨域隔离的（有的话多线程更快，没有也能跑单线程） */
    function isolated() {
        return !!global.crossOriginIsolated;
    }

    /* =========================================================
       引擎加载
       ========================================================= */

    /** 给 promise 套一个超时，卡住的下载源不要拖着整个流程 */
    function withTimeout(p, ms) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () {
                reject(new Error("下载超时（" + Math.round(ms / 1000) + " 秒）"));
            }, ms);
            p.then(function (v) { clearTimeout(timer); resolve(v); },
                function (e) { clearTimeout(timer); reject(e); });
        });
    }

    function ensure(onNote) {
        if (instance) return Promise.resolve(instance);
        if (loadingPromise) return loadingPromise;

        if (!supported()) {
            return Promise.reject(new Error("这个浏览器不支持在本地转码（缺 WebAssembly 或 Worker）"));
        }

        var note = typeof onNote === "function" ? onNote : function () {};

        function tryFrom(i) {
            if (i >= CORE_SOURCES.length) {
                loadingPromise = null;
                return Promise.reject(new Error("转码引擎加载失败：所有下载源都连不上，检查网络后刷新重试"));
            }

            var src = CORE_SOURCES[i];
            note("正在加载转码引擎（约 24MB，下载源 " + (i + 1) + "/" + CORE_SOURCES.length + "：" + src.label + "）");

            var ff;
            try {
                ff = global.FFmpeg.createFFmpeg({
                    log: false,
                    corePath: new URL(src.url, location.href).href
                });
            } catch (e) {
                return tryFrom(i + 1);
            }

            return withTimeout(ff.load(), src.timeout).then(function () {
                instance = ff;
                note("转码引擎就绪");
                return ff;
            }).catch(function (err) {
                console.warn("[yowat] 引擎源失败：" + src.label + " — " + (err && err.message ? err.message : err));
                return tryFrom(i + 1);
            });
        }

        loadingPromise = tryFrom(0);
        return loadingPromise;
    }

    /* =========================================================
       工具
       ========================================================= */

    /** 和 tools/compress.mjs 的 planScale 同一套规则：短边缩到目标值，不放大 */
    function scaleFilter(w, h, target) {
        var width = Number(w) || 0, height = Number(h) || 0, t = Number(target) || 0;
        if (!(width > 0) || !(height > 0) || !(t > 0)) return "";
        if (Math.min(width, height) <= t) return "";
        /* -2 让另一边自动取偶数，h264 的 yuv420p 要求宽高都是偶数 */
        return width >= height ? "scale=-2:" + t : "scale=" + t + ":-2";
    }

    /** 读视频的宽高和时长（用 <video> 的元数据，比 ffprobe 快得多） */
    function probe(file) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file);
            var v = document.createElement("video");
            v.preload = "metadata";
            v.muted = true;

            var done = function (result) {
                URL.revokeObjectURL(url);
                v.removeAttribute("src");
                resolve(result);
            };

            v.addEventListener("loadedmetadata", function () {
                done({
                    width: v.videoWidth || 0,
                    height: v.videoHeight || 0,
                    duration: Math.round(v.duration) || 0
                });
            });

            v.addEventListener("error", function () {
                URL.revokeObjectURL(url);
                reject(new Error("这个文件浏览器读不了，可能不是标准的 MP4/WebM"));
            });

            v.src = url;
        });
    }

    function fmtBytes(n) {
        var v = Number(n) || 0;
        var units = ["B", "KB", "MB", "GB"];
        var i = 0;
        while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
        return (i === 0 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
    }

    /** 粗略估个耗时：wasm 单线程大约是实时的 1.2~2.5 倍，只能估个数量级 */
    function estimate(duration, isolatedFlag) {
        var d = Number(duration) || 0;
        if (!d) return "";
        var factor = isolatedFlag ? 0.9 : 1.6;
        var sec = Math.round(d * factor * 2);       // 两个档位
        if (sec < 60) return "大约 " + sec + " 秒";
        return "大约 " + Math.ceil(sec / 60) + " 分钟";
    }

    /* =========================================================
       跑一条 ffmpeg 命令
       ========================================================= */

    function runTo(ff, outputName, args, onRatio) {
        ff.setProgress(function (e) {
            if (onRatio && e && typeof e.ratio === "number" && isFinite(e.ratio)) {
                onRatio(Math.max(0, Math.min(1, e.ratio)));
            }
        });

        return ff.run.apply(ff, args).then(function () {
            var data = ff.FS("readFile", outputName);
            var type = /\.jpe?g$/i.test(outputName) ? "image/jpeg" : "video/mp4";
            /* readFile 返回的 Uint8Array 是 wasm 堆的视图，必须拷出来，
               否则下一次 run 会把它覆盖掉 */
            var copy = new Uint8Array(data.length);
            copy.set(data);
            try { ff.FS("unlink", outputName); } catch (e) { /* 没有就算了 */ }
            return new Blob([copy], { type: type });
        });
    }

    /* =========================================================
       主入口
       ========================================================= */

    /**
     * 压 360p + 240p + 封面。
     * opts.onStage(text, ratio) 报告当前阶段；ratio 是 0~1 或 -1（表示不确定）。
     */
    function compress(file, opts) {
        opts = opts || {};
        var onStage = typeof opts.onStage === "function" ? opts.onStage : function () {};

        if (!file) return Promise.reject(new Error("没有选文件"));
        if (file.size > MAX_SOURCE) {
            return Promise.reject(new Error(
                "文件 " + fmtBytes(file.size) + " 太大了，本地转码最多 " + fmtBytes(MAX_SOURCE) +
                "。先用剪辑软件剪短或降一下分辨率再传"
            ));
        }

        var ff = null;
        var srcName = "src" + (/\.webm$/i.test(file.name) ? ".webm" : ".mp4");
        var meta = { width: 0, height: 0, duration: 0 };

        return Promise.resolve()
            .then(function () { return ensure(opts.onNote); })
            .then(function (engine) { ff = engine; })
            .then(function () {
                onStage("读取视频信息", -1);
                return probe(file).catch(function () { return meta; });
            })
            .then(function (info) {
                meta = info || meta;
                onStage("把文件读进浏览器内存", 0);
                return global.FFmpeg.fetchFile(file);
            })
            .then(function (buf) {
                try { ff.FS("unlink", srcName); } catch (e) { /* 上次残留，忽略 */ }
                ff.FS("writeFile", srcName, buf);
                buf = null;                  // 让 GC 早点回收，省内存
            })
            .then(function () {
                var out = {};
                var chain = Promise.resolve();

                TIERS.forEach(function (tier) {
                    chain = chain.then(function () {
                        var filter = scaleFilter(meta.width, meta.height, tier.height);
                        var name = "out-" + tier.height + ".mp4";
                        var label = "压到 " + tier.height + "p";

                        onStage(label, 0);

                        var args = ["-i", srcName];
                        if (filter) args.push("-vf", filter);
                        args.push(
                            "-c:v", "libx264",
                            "-crf", String(tier.crf),
                            "-preset", "veryfast",
                            "-profile:v", "main",
                            "-pix_fmt", "yuv420p",
                            "-c:a", "aac",
                            "-b:a", tier.audioKbps + "k",
                            "-ac", "2",
                            "-movflags", "+faststart",
                            "-y", name
                        );

                        return runTo(ff, name, args, function (r) { onStage(label, r); })
                            .then(function (blob) {
                                out[tier.height] = { blob: blob, size: blob.size };
                            });
                    });
                });

                /* 封面：抽第 25% 处的一帧（和打包器同一策略），最多不超过第 5 秒 */
                chain = chain.then(function () {
                    var at = Math.min(5, Math.max(0.4, (meta.duration || 0) * 0.25)).toFixed(2);
                    onStage("抽封面", -1);
                    return runTo(ff, "cover.jpg", [
                        "-ss", String(at), "-i", srcName,
                        "-frames:v", "1",
                        "-vf", "scale=720:-2",
                        "-q:v", "3",
                        "-y", "cover.jpg"
                    ], null).then(function (blob) {
                        out.cover = { blob: blob, size: blob.size };
                    }).catch(function () {
                        out.cover = null;      // 封面失败不影响主流程
                    });
                });

                return chain.then(function () {
                    try { ff.FS("unlink", srcName); } catch (e) { /* 忽略 */ }
                    out.source = meta;
                    return out;
                });
            });
    }

    global.YowatCompress = {
        supported: supported,
        isolated: isolated,
        ensure: ensure,
        probe: probe,
        compress: compress,
        scaleFilter: scaleFilter,
        estimate: estimate,
        fmtBytes: fmtBytes,
        MAX_SOURCE: MAX_SOURCE,
        TIERS: TIERS
    };
})(window);
