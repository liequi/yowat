# _raw/ —— 上传原片的暂存区

上传接口把原片按 6MB 切片写进 `_raw/{id}-{随机串}/partNN`，
`.github/workflows/transcode.yml` 在 Actions 里拼回来、转成 360p / 240p + 封面，
然后把这个目录删掉。

- 每次上传一个独立目录：`videos` 表的 id 会被复用，平铺成 `{id}.partNN`
  时上一笔没收尾的残留会和新文件拼成坏文件。
- 这个目录不会发布到 CDN（见 `.assetsignore`）。
- 转码失败时原片会留在这里，修好之后点 Actions 的 Run workflow 重跑即可。
