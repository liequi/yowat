# videos/ —— 站点上的视频文件

这里只放**两个档位文件 + 封面**，跟着 `wrangler pages deploy` 一起上 Cloudflare Pages（免费带宽，不需要 R2）。
元数据（标题、简介、标签、时长）存在 Cloudflare **D1**，前端通过 `GET /api/videos` 取，文件和记录靠 `id` 对应。

## 目录结构

```
videos/
└── 1/
    ├── 1-360.mp4    # 主版本，播放页默认放它   → /video/getvideo/keyplus{id+1}/{id}
    ├── 1-240.mp4    # 省流版（体积约 2/3）      → /video/getvideo/back/{vid}
    └── cover.jpg    # 封面（打包时自动抽）
```

**高清原片不在这里**，也不该放进来。原始文件暂存在 `_incoming/{id}.mp4`（已被 `.assetsignore` 排除，不进 CDN），打包时压成两个档位后**直接删掉**。

## 加一个视频（两条命令）

```bash
npm run add -- --file "D:\拍的视频.mp4" --title "标题" --tags "日常,旅行"
npm run publish
```

`add` 干的事：分配 id → 拷进 `_incoming/` → 压 360p + 240p → 抽封面 → 删原片（`--no-compress` 可只暂存）。
`publish` = `pack` + `deploy`。

补「库里有记录、文件丢了」：`npm run add -- --file "D:\x.mp4" --id 2`

## 打包细节

```bash
npm run pack                    # 处理 _incoming/ 里所有待打包的
npm run pack -- --id 2          # 只处理某个
npm run pack -- --all           # 所有还能找到源文件的
npm run pack -- --dry-run       # 只估算，不动文件
npm run pack -- --id 2 --crf 34 # 想更小就调大 CRF（默认 30，240p 自动 +2）
npm run pack -- --id 2 --keep-source   # 保留源文件（默认删）
```

它做的事：`ffprobe` 读规格 → 短边压到 360 / 240（竖屏按宽度，已经更小就不放大）→ H.264 high + `+faststart` → AAC 64k / 48k（没音轨就 `-an`）→ 写 `{id}-360.mp4`、`{id}-240.mp4` → 抽封面 → 删源文件 → 更新 D1 的 `src`/`low`/`size`。

手动等价命令：

```bash
ffmpeg -i _incoming/2.mp4 -vf scale=-2:360 -c:v libx264 -crf 30 -preset slow \
       -pix_fmt yuv420p -c:a aac -b:a 64k -movflags +faststart videos/2/2-360.mp4

ffmpeg -i _incoming/2.mp4 -vf scale=-2:240 -c:v libx264 -crf 32 -preset slow \
       -pix_fmt yuv420p -c:a aac -b:a 48k -movflags +faststart videos/2/2-240.mp4

ffmpeg -ss 5 -i _incoming/2.mp4 -frames:v 1 -vf scale=720:-2 -q:v 3 videos/2/cover.jpg
```

## 元数据

- 上传页提交 / `npm run add -- --register` / `curl -X POST /api/upload/{标题}/{简介}/` 三种都行
- 或写 SQL：`wrangler d1 execute yowat-db --remote --file=add-video.sql`

## 硬限制（Pages 静态资源）

- 单个文件 ≤ **25MB**（现在只有两个档位文件，基本碰不到）
- 每次部署 ≤ 20000 个文件
- 建议 MP4（H.264 + AAC）；WebM 也能播

## 注意

- `id` 从 1 开始递增，不要复用已删除的 id，否则老链接会指到别的视频。
- 旧命名 `{id}.mp4` / `{id}-low.mp4` 已废弃：`npm run pack` 会自动清理 `{id}-low.mp4`，`{id}.mp4` 会被当作源文件压完删除。
- 本地没部署时页面退回 `assets/js/videos.data.js` 里的静态清单，可当备份偶尔同步。
