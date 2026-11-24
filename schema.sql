-- ===========================================================
-- yowat · D1 数据库结构
-- 用法：npx wrangler d1 execute yowat-db --remote --file=./schema.sql
-- ===========================================================

DROP TABLE IF EXISTS videos;

CREATE TABLE videos (
    id          INTEGER PRIMARY KEY,           -- 视频编号，也是目录名
    vid         INTEGER,                       -- 低清下载编号 /video/getvideo/back/{vid}
    title       TEXT    NOT NULL,
    description TEXT    DEFAULT '',
    src         TEXT    NOT NULL,              -- 原片地址（相对站点根目录）
    low         TEXT    DEFAULT '',            -- 低清地址
    cover       TEXT    DEFAULT '',            -- 封面
    duration    INTEGER DEFAULT 0,             -- 秒
    size        INTEGER DEFAULT 0,             -- 字节
    views       INTEGER DEFAULT 0,
    created_at  TEXT    DEFAULT (date('now')), -- YYYY-MM-DD
    tags        TEXT    DEFAULT '[]'           -- JSON 数组字符串，如 ["MV","音乐"]
);

CREATE INDEX idx_videos_created ON videos (created_at DESC, id DESC);
CREATE INDEX idx_videos_vid     ON videos (vid);

-- ---------------- 初始数据 ----------------
INSERT INTO videos (id, vid, title, description, src, low, cover, duration, size, views, created_at, tags)
VALUES (
    1,
    11092,
    'HARMONY OR DIE · 动画 MV',
    '平台上的第一个视频：一段动画 MV（512×384，约 4 分钟）。用于跑通「播放 · 下载 · 分享」整条链路。',
    'videos/1/1.mp4',
    'videos/1/1-low.mp4',
    'videos/1/cover.jpg',
    240,
    6166188,
    0,
    '2026-11-23',
    '["MV","音乐","动画"]'
);
