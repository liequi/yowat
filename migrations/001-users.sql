-- ===========================================================
-- yowat · 迁移 001：用户、会话、视频归属
-- -----------------------------------------------------------
-- 只跑一次：
--   npx wrangler d1 execute yowat-db --remote --file=./migrations/001-users.sql
--
-- 这个文件刻意「不 DROP 任何东西」——线上已经有视频记录，
-- 只加表、只加列。重复执行会因为列已存在而报错，这是预期的。
-- ===========================================================

/* ---------------- 用户 ---------------- */

CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,          -- 4~20 位字母数字下划线，存原始大小写
    uname_lower   TEXT    NOT NULL UNIQUE,          -- 小写，登录/查重都用这个，避免 Anna/anna 撞车
    pass_hash     TEXT    NOT NULL,                 -- PBKDF2-SHA256，base64
    salt          TEXT    NOT NULL,                 -- 16 字节随机盐，base64
    iter          INTEGER NOT NULL DEFAULT 150000,  -- 迭代次数，跟着密码一起存，以后能升级
    quota_videos  INTEGER NOT NULL DEFAULT 20,      -- 最多几个视频
    quota_bytes   INTEGER NOT NULL DEFAULT 209715200, -- 总共多少字节（200MB）
    is_admin      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

/* ---------------- 会话 ---------------- */

CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT    PRIMARY KEY,                -- 32 字节随机数，base64url
    user_id     INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,                   -- unix 毫秒
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    ua          TEXT    DEFAULT '',                 -- 只留前 120 字符，便于排查
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions (expires_at);

/* ---------------- videos 扩展 ---------------- */

-- 归属：谁传的。老数据（1、2 号）留 NULL，视为站长本人的。
ALTER TABLE videos ADD COLUMN owner_id INTEGER DEFAULT NULL;

-- ready = 文件已经构建上线；processing = 已提交 GitHub，等 Pages 构建（1~2 分钟）
ALTER TABLE videos ADD COLUMN status TEXT NOT NULL DEFAULT 'ready';

-- 作者名快照，列表页不用 JOIN 也能显示
ALTER TABLE videos ADD COLUMN uploader TEXT DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos (owner_id);

/* ---------------- 收尾 ---------------- */

-- 老记录统一标成 ready + 站长上传
UPDATE videos SET status = 'ready' WHERE status IS NULL OR status = '';
UPDATE videos SET uploader = '站长' WHERE owner_id IS NULL AND (uploader IS NULL OR uploader = '');
