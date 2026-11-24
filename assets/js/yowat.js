/* ===========================================================
   yowat · 核心脚本
   -----------------------------------------------------------
   数据：优先 GET /api/videos（Cloudflare D1），失败时回退到
        assets/js/videos.data.js 里的本地清单，所以 file:// 也能跑。
   下载：只在接口层提供，页面上不出现下载按钮：
        GET /video/getvideo/keyplus{id+1}/{id}   360p
        GET /video/getvideo/back/{vid}           240p
   =========================================================== */

(function (global) {
    "use strict";

    var DATA = (global.YOWAT_VIDEOS || []).slice();
    var source = "local";          // local | d1
    var loading = null;

    /* ---------------- 数据加载 ---------------- */

    function load() {
        if (loading) return loading;

        if (global.location && location.protocol === "file:") {
            loading = Promise.resolve(DATA);
            return loading;
        }

        loading = fetch("api/videos", { headers: { Accept: "application/json" } })
            .then(function (res) {
                if (!res.ok) throw new Error("HTTP " + res.status);
                return res.json();
            })
            .then(function (body) {
                if (body && body.code === 0 && Array.isArray(body.data)) {
                    DATA = body.data;
                    source = "d1";
                }
                return DATA;
            })
            .catch(function () {
                source = "local";
                return DATA;
            });

        return loading;
    }

    /** 页面入口：等数据就绪后再渲染 */
    function ready(cb) {
        return load().then(function () {
            try { cb(); } catch (err) { console.error("[yowat]", err); }
        });
    }

    function dataSource() { return source; }

    /* ---------------- 格式化 ---------------- */

    function pad(n) { return n < 10 ? "0" + n : "" + n; }

    function fmtDuration(sec) {
        sec = Math.max(0, Math.round(Number(sec) || 0));
        var h = Math.floor(sec / 3600),
            m = Math.floor((sec % 3600) / 60),
            s = sec % 60;
        return h ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
    }

    function fmtCount(n) {
        n = Number(n) || 0;
        if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, "") + " 亿";
        if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + " 万";
        return String(n);
    }

    function fmtSize(bytes) {
        bytes = Number(bytes) || 0;
        if (bytes >= 1024 * 1024 * 1024) return (bytes / 1073741824).toFixed(2) + " GB";
        if (bytes >= 1024 * 1024) return (bytes / 1048576).toFixed(1) + " MB";
        if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
        return bytes + " B";
    }

    function fmtDate(s) {
        if (!s) return "";
        return String(s).slice(0, 10).replace(/-/g, ".");
    }

    function escapeHtml(s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    /* ---------------- 查询 ---------------- */

    function all() {
        return DATA.slice().sort(function (a, b) {
            return String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || b.id - a.id;
        });
    }

    function get(id) {
        id = Number(id);
        for (var i = 0; i < DATA.length; i++) if (Number(DATA[i].id) === id) return DATA[i];
        return null;
    }

    function allTags() {
        var map = {};
        DATA.forEach(function (v) {
            (v.tags || []).forEach(function (t) { map[t] = (map[t] || 0) + 1; });
        });
        return Object.keys(map).sort(function (a, b) { return map[b] - map[a] || a.localeCompare(b); });
    }

    function filter(opts) {
        opts = opts || {};
        var q = (opts.q || "").trim().toLowerCase();
        var tag = opts.tag || "全部";
        var by = opts.sort || "new";

        var list = all().filter(function (v) {
            if (tag !== "全部" && (v.tags || []).indexOf(tag) === -1) return false;
            if (!q) return true;
            var hay = [v.title, v.description].concat(v.tags || []).join(" ").toLowerCase();
            return hay.indexOf(q) !== -1;
        });

        if (by === "views") list.sort(function (a, b) { return (b.views || 0) - (a.views || 0); });
        else if (by === "long") list.sort(function (a, b) { return (b.duration || 0) - (a.duration || 0); });

        return list;
    }

    function stats() {
        var duration = 0, size = 0;
        DATA.forEach(function (v) { duration += v.duration || 0; size += v.size || 0; });
        return { count: DATA.length, duration: duration, size: size, tags: allTags().length };
    }

    /* ---------------- 路径 ----------------
       站点上只有两个档位文件，名字固定按 id 拼，不依赖数据库里存的字符串，
       这样即使库里的 src/low 是旧值也不会拼出 404 的地址。
         videos/{id}/{id}-360.mp4   主版本（播放默认）
         videos/{id}/{id}-240.mp4   省流版
    */

    var TIER_MAIN = 360;
    var TIER_LOW = 240;

    function tierOf(quality) {
        return (quality === "low" || quality === "240") ? TIER_LOW : TIER_MAIN;
    }

    function srcOf(v, quality) {
        return "videos/" + v.id + "/" + v.id + "-" + tierOf(quality) + ".mp4";
    }

    /** 省流档位是否可用（打包后一定有，保留给老数据兜底） */
    function hasLow(v) {
        return !!(v && v.id);
    }

    /** 默认播放源：360p */
    function bestSrc(v) {
        return srcOf(v, TIER_MAIN);
    }

    function pageUrl(v) {
        try { return new URL("watch.html?id=" + v.id, location.href).href; }
        catch (e) { return "watch.html?id=" + v.id; }
    }

    /** 文档里的下载接口路径（页面上不再暴露，只在 docs 里有） */
    function apiPath(v, quality) {
        return tierOf(quality) === TIER_LOW
            ? "/video/getvideo/back/" + (v.vid || v.id)
            : "/video/getvideo/keyplus" + (v.id + 1) + "/" + v.id;
    }

    function apiUrl(v, quality) {
        try { return new URL(apiPath(v, quality), location.href).href; }
        catch (e) { return apiPath(v, quality); }
    }

    function watchPath(v) { return "/video/" + v.id; }

    /* ---------------- DOM ---------------- */

    function el(html) {
        var t = document.createElement("template");
        t.innerHTML = String(html).trim();
        return t.content.firstElementChild;
    }

    var PLAY_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.53.85l10-6.5a1 1 0 0 0 0-1.7l-10-6.5A1 1 0 0 0 8 5.5Z"/></svg>';

    var toastTimer = null;
    function toast(msg) {
        var box = document.querySelector(".toast");
        if (!box) {
            box = el('<div class="toast" role="status"></div>');
            document.body.appendChild(box);
        }
        box.textContent = msg;
        requestAnimationFrame(function () { box.classList.add("is-on"); });
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { box.classList.remove("is-on"); }, 2200);
    }

    function copyText(text) {
        var done = function () { toast("已复制：" + (text.length > 46 ? text.slice(0, 46) + "…" : text)); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, legacy);
        } else legacy();

        function legacy() {
            var ta = document.createElement("textarea");
            ta.value = text;
            ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand("copy"); done(); } catch (e) { toast("复制失败，请手动选中"); }
            document.body.removeChild(ta);
        }
    }

    /* ---------------- 卡片 ---------------- */

    function coverHtml(v, cls) {
        if (v.cover) {
            return '<img src="' + escapeHtml(v.cover) + '" alt="' + escapeHtml(v.title) +
                '" loading="lazy" decoding="async" data-fallback="' + cls + '">';
        }
        return '<div class="' + cls + '">🎬</div>';
    }

    /* 封面 404（数据库有记录、文件还没打包时）→ 换成渐变占位，别露出破图。
       error 事件不冒泡，只能用捕获阶段挂一个全局监听。 */
    if (typeof document !== "undefined" && document.addEventListener) {
        document.addEventListener("error", function (e) {
            var t = e.target;
            if (!t || t.tagName !== "IMG" || t.dataset.coverDone === "1") return;
            t.dataset.coverDone = "1";
            var d = document.createElement("div");
            d.className = t.getAttribute("data-fallback") || "card__fallback";
            d.textContent = "🎬";
            t.replaceWith(d);
        }, true);
    }

    function metaLine(v) {
        return (v.views ? fmtCount(v.views) + " 次播放" : "新上传") + " · " + fmtDate(v.createdAt);
    }

    function renderCard(v, index) {
        var delay = Math.min(index || 0, 8) * 0.05;
        var card = el(
            '<article class="card" style="animation-delay:' + delay + 's" tabindex="0" role="button" aria-label="播放 ' + escapeHtml(v.title) + '">' +
                '<div class="card__cover">' +
                    coverHtml(v, "card__fallback") +
                    '<div class="card__overlay"><span class="card__play">' + PLAY_ICON + '</span></div>' +
                    '<span class="card__duration">' + fmtDuration(v.duration) + '</span>' +
                '</div>' +
                '<div class="card__body">' +
                    '<h3 class="card__title">' + escapeHtml(v.title) + '</h3>' +
                    (v.tags && v.tags.length
                        ? '<div class="card__tags">' + v.tags.slice(0, 3).map(function (t) {
                            return '<span class="card__tag">' + escapeHtml(t) + '</span>';
                          }).join("") + '</div>'
                        : "") +
                    '<div class="card__meta"><span>' + escapeHtml(metaLine(v)) + '</span></div>' +
                '</div>' +
            '</article>'
        );
        card.addEventListener("click", function () { openPlayer(v); });
        card.addEventListener("keydown", function (e) {
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPlayer(v); }
        });
        return card;
    }

    function renderMini(v) {
        return el(
            '<a class="mini" href="watch.html?id=' + v.id + '">' +
                '<div class="mini__cover">' +
                    coverHtml(v, "mini__fallback") +
                    '<span class="mini__dur">' + fmtDuration(v.duration) + '</span>' +
                '</div>' +
                '<div class="mini__body">' +
                    '<div class="mini__title">' + escapeHtml(v.title) + '</div>' +
                    '<div class="mini__meta">' + escapeHtml(metaLine(v)) + '</div>' +
                '</div>' +
            '</a>'
        );
    }

    /* ---------------- 播放弹窗 ---------------- */

    var modal, videoEl, lastFocus;
    var currentVideo = null;      // 当前弹窗里的视频
    var currentQuality = TIER_MAIN;

    function ensureModal() {
        if (modal) return;

        modal = el(
            '<div class="modal" role="dialog" aria-modal="true" aria-label="视频播放">' +
                '<div class="modal__backdrop" data-close></div>' +
                '<div class="modal__panel">' +
                    '<button class="modal__close" data-close aria-label="关闭">✕</button>' +
                    '<div class="player"><video controls playsinline preload="metadata"></video></div>' +
                    '<div class="modal__info">' +
                        '<h2 class="modal__title"></h2>' +
                        '<div class="modal__meta"></div>' +
                        '<p class="modal__desc"></p>' +
                        '<div class="modal__actions"></div>' +
                    '</div>' +
                '</div>' +
            '</div>'
        );
        document.body.appendChild(modal);
        videoEl = modal.querySelector("video");

        /* 360p 坏了就往 240p 退，别让人看黑屏 */
        videoEl.addEventListener("error", function () {
            if (!currentVideo) return;
            if (currentQuality === TIER_MAIN) {
                currentQuality = TIER_LOW;
                videoEl.src = srcOf(currentVideo, TIER_LOW);
                var p = videoEl.play();
                if (p && p.catch) p.catch(function () { });
                toast("360p 没加载出来，已切到 240p");
            } else {
                toast("视频文件没能加载，检查一下 " + srcOf(currentVideo, TIER_MAIN) + " 是否存在");
            }
        });

        modal.addEventListener("click", function (e) {
            if (e.target.closest("[data-close]")) closePlayer();
        });
        document.addEventListener("keydown", function (e) {
            if (modal.classList.contains("is-open") && e.key === "Escape") closePlayer();
        });
    }

    function openPlayer(v) {
        ensureModal();
        lastFocus = document.activeElement;
        currentVideo = v;
        currentQuality = TIER_MAIN;

        modal.querySelector(".modal__title").textContent = v.title;
        modal.querySelector(".modal__meta").innerHTML =
            '<span>时长 ' + fmtDuration(v.duration) + '</span><span class="sep">·</span>' +
            '<span>' + escapeHtml(metaLine(v)) + '</span><span class="sep">·</span>' +
            '<span>video_id ' + v.id + '</span>';
        modal.querySelector(".modal__desc").textContent = v.description || "这位创作者还没有填写简介。";

        var actions = modal.querySelector(".modal__actions");
        actions.innerHTML = "";
        actions.appendChild(btn("🔗 复制播放链接", "btn btn--ghost btn--sm", function () { copyText(pageUrl(v)); }));
        actions.appendChild(el('<a class="btn btn--primary btn--sm" href="watch.html?id=' + v.id + '">打开详情页</a>'));

        videoEl.poster = v.cover || "";
        videoEl.src = srcOf(v, currentQuality);
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
        document.body.style.overflow = "hidden";
        var p = videoEl.play();
        if (p && p.catch) p.catch(function () { /* 自动播放被拦截，保留控件 */ });
        modal.querySelector(".modal__close").focus();
    }

    function btn(label, cls, onClick) {
        var b = el('<button class="' + cls + '" type="button">' + label + "</button>");
        b.addEventListener("click", onClick);
        return b;
    }

    function closePlayer() {
        if (!modal || !modal.classList.contains("is-open")) return;
        currentVideo = null;
        videoEl.pause();
        videoEl.removeAttribute("src");
        videoEl.load();
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
        document.body.style.overflow = "";
        if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    /* ---------------- 导出 ---------------- */

    global.Yowat = {
        ready: ready,
        dataSource: dataSource,
        all: all,
        get: get,
        filter: filter,
        tags: allTags,
        stats: stats,
        srcOf: srcOf,
        hasLow: hasLow,
        bestSrc: bestSrc,
        pageUrl: pageUrl,
        apiPath: apiPath,
        apiUrl: apiUrl,
        watchPath: watchPath,
        openPlayer: openPlayer,
        closePlayer: closePlayer,
        renderCard: renderCard,
        renderMini: renderMini,
        copy: copyText,
        toast: toast,
        el: el,
        fmt: { duration: fmtDuration, count: fmtCount, size: fmtSize, date: fmtDate },
        PLAY_ICON: PLAY_ICON,

        /* docs.html 里各接口的落点 */
        api: {
            "GET  /api/videos": "视频清单（D1）",
            "GET  /api/videos/{id}": "单个视频元数据",
            "GET  /video/{video_id}": "跳转播放页 watch.html?id=",
            "GET  /video/getvideo/keyplus{id+1}/{video_id}": "原片下载（文件流）",
            "GET  /video/getvideo/back/{video_vid}": "低清下载（文件流）",
            "POST /api/upload/{title}/{desc}/": "登记元数据到 D1"
        }
    };
})(window);
