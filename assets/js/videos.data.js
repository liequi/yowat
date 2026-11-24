/* ===========================================================
   yowat · 视频清单（D1 连不上时的兜底数据）
   -----------------------------------------------------------
   站点上每个视频只有两个档位文件，文件名按 id 拼死：
     videos/{id}/{id}-360.mp4   主版本（播放默认）
     videos/{id}/{id}-240.mp4   省流版
     videos/{id}/cover.jpg      封面（可选）
   高清原片不保留：上传页暂存到 _incoming/，npm run pack 压完即删。

   正常情况下数据来自 D1（GET /api/videos），这个文件只在
   file:// 打开或接口挂掉时生效，平时不用手改。
   =========================================================== */

window.YOWAT_VIDEOS = [
    {
        id: 1,
        vid: 11092,                       // 240p 下载用的编号（/video/getvideo/back/{vid}）
        title: "HARMONY OR DIE · 动画 MV",
        description: "平台上的第一个视频：一段动画 MV（512×384，约 4 分钟）。上传于 2026 年 11 月 23 日，用于跑通「播放 · 下载 · 分享」整条链路。",
        src: "videos/1/1-360.mp4",
        low: "videos/1/1-240.mp4",
        cover: "videos/1/cover.jpg",
        duration: 240,                    // 秒
        size: 3719718,                    // 字节（360p 主版本）
        views: 0,
        createdAt: "2026-11-23",
        tags: ["MV", "音乐", "动画"]
    }
];
