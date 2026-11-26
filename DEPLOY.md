# yowat 部署手册（Cloudflare Pages + D1）

照着从上往下做，大约 10 分钟。需要：Node 18+、一个 Cloudflare 账号、一个终端。

> 我没有你的账号，所以下面的命令得你在自己机器上跑一次。跑完之后，以后每次改内容只要重复第 5 步就行。

---

## 0. 先搞清楚钱的事（重要）

| 项目                | 免费额度                       | 说明                            |
| ----------------- | -------------------------- | ----------------------------- |
| **Pages（网页本体）**   | 请求数、带宽**不计费**，每月 500 次构建   | 你的 HTML/CSS/JS 和视频都放这里        |
| **Functions（接口）** | 每天 10 万次请求                 | `/api/*`、`/video/*` 都算，个人站完全够 |
| **D1（文字数据）**      | 5GB 存储、每天 500 万行读 / 10 万行写 | 存视频标题、简介、标签，用不到零头             |
| **R2（可选，放视频）**    | 10GB 存储 + 出站流量免费           | 超出才收费；**开通需要绑支付方式**           |
| **Stream（视频转码）**  | 无免费额度                      | 按分钟收费，**我们不用它**               |

结论：**视频不花钱**。它作为静态文件跟着 Pages 一起部署，走的是 Pages 的免费带宽，不碰 Stream/R2。  
唯一的硬限制是 **单个文件 ≤ 25MB**、每次部署 ≤ 20000 个文件。你现在的视频 5.9MB，低清版 2.7MB，都在范围内。

什么时候才需要开 R2：单个视频超过 25MB，或者总视频量很大（几百个）导致每次部署很慢。那时把 `videos/` 挪到 R2，清单里的 `src` 换成 R2 的公网地址即可，其它代码不用动。

---

## 1. 安装 wrangler 并登录

```bash
npm i -g wrangler
wrangler login
```

会弹出浏览器让你授权，点同意即可。验证：

```bash
wrangler whoami
```

### 装完提示 `wrangler: command not found`（这台机器已经踩过）

根因：`~/.npmrc` 里写了 `prefix=G:\npm-global`，包其实装好了，只是 **PATH 里没有 `G:\npm-global`**（只有旧的 `C:\Users\HPH\AppData\Roaming\npm`）。自查：

```bash
npm config get prefix                            # 输出 G:\npm-global
ls "$(npm config get prefix)" | grep wrangler    # 有 wrangler / wrangler.cmd 就是装好了
```

**本机已做的修复（无需再操作）**：在 `C:\Users\HPH\AppData\Roaming\npm\`（本来就在 PATH 里、原本是空目录）放了两个转发器，指向 `G:\npm-global`：

| 文件             | 作用                   |
| -------------- | -------------------- |
| `wrangler`     | 给 Git Bash / MSYS 用  |
| `wrangler.cmd` | 给 cmd / PowerShell 用 |

好处是不用重启终端、所有 shell 都生效。**不想要了直接删这两个文件即可**，不会影响任何数据。

另外 `~/.bashrc` 和 `~/.bash_profile` 里也加了 `PATH="$PATH:/g/npm-global"`，作用是让**放在 G 盘的其它全局命令**（比如同样装在那儿的 `playwright`）新开终端也能直接用。换机器重装 node 时按这个思路加 PATH：

```bash
echo 'export PATH="$PATH:/g/npm-global"' >> ~/.bashrc    # 盘符 G: → /g/
```

或者走图形界面：Win+R 输入 `sysdm.cpl` → 高级 → 环境变量 → 编辑用户变量 `Path` → 新增 `G:\npm-global` → 重开终端。

实在不想管 PATH，也能直接给全路径：

```bash
"/g/npm-global/wrangler" login
```

> 如果出现 `Proxy environment variables detected` 警告但命令正常走完，可以忽略；若登录卡在 fetch 阶段，先 `unset HTTP_PROXY HTTPS_PROXY ALL_PROXY` 再试。

> 如果出现 `Proxy environment variables detected` 警告但命令正常走完，可以忽略；若登录卡在 fetch 阶段，先 `unset HTTP_PROXY HTTPS_PROXY ALL_PROXY` 再试。

---

## 2. 创建 D1 数据库

在项目目录 `G:\yowat` 下执行：

```bash
wrangler d1 create yowat-db
```

输出里会有一行：

```
database_id = "a1b2c3d4-...."
```

**把这串 id 复制，打开 `wrangler.toml`，替换掉 `REPLACE_WITH_YOUR_DATABASE_ID`**：

```toml
[[d1_databases]]
binding = "DB"
database_name = "yowat-db"
database_id = "a1b2c3d4-...."   ← 换成你的
```

---

## 3. 建表 + 灌入现有数据

```bash
wrangler d1 execute yowat-db --remote --file=./schema.sql
```

它会重建 `videos` 表并插入现在这个视频（id=1）。确认一下：

```bash
wrangler d1 execute yowat-db --remote --command "SELECT id, title, src FROM videos;"
```

---

## 4. 创建 Pages 项目

```bash
wrangler pages project create yowat --production-branch=main
```

项目名 `yowat` 对应域名 `yowat.pages.dev`（如果被占用，换个名字，同时改 `wrangler.toml` 里的 `name`）。

---

## 5. 部署（这一步会把视频一起传上去）

```bash
cd /g/yowat          # 或者 G:\yowat
wrangler pages deploy
```

因为 `wrangler.toml` 里写了 `pages_build_output_dir = "."`，不需要再指定目录。第一次会提示确认，选 `y`。

部署完会打印一个预览地址，形如：

```
https://xxxxx.yowat.pages.dev
```

生产地址就是 `https://yowat.pages.dev`。

**视频文件不用单独上传**——`videos/` 目录跟着这次部署一起上线了。

---

## 6. 确认 D1 绑定生效

打开 [Cloudflare 控制台](https://dash.cloudflare.com) → Workers & Pages → `yowat` → Settings → **Bindings / 绑定**，  
应该能看到：

| Variable name | Type        | 值          |
| ------------- | ----------- | ---------- |
| `DB`          | D1 database | `yowat-db` |

`wrangler.toml` 里的 `[[d1_databases]]` 正常会自动带上。**如果这里没有**，手动加一条：  
`Add → D1 database → Variable name: DB → 选 yowat-db → Save`，然后 **重新部署一次**（再跑第 5 步）。

---

## 7. 验证（复制到浏览器或 curl）

```bash
# 1) 数据接口：应返回 code 0 和视频数组
curl https://yowat.pages.dev/api/videos

# 2) 播放页跳转：应 302 到 /watch?id=1
curl -I https://yowat.pages.dev/video/1

# 3) 360p 下载接口：应 200，video/mp4，带 attachment，文件名带 -360p
curl -I https://yowat.pages.dev/video/getvideo/keyplus2/1

# 4) 240p 下载接口：同上，文件名带 -240p
curl -I https://yowat.pages.dev/video/getvideo/back/11092

# 4.5) 两个档位文件都在、原片已删
curl -o /dev/null -w "%{http_code} %{size_download}\n" https://yowat.pages.dev/videos/1/1-360.mp4
curl -o /dev/null -w "%{http_code} %{size_download}\n" https://yowat.pages.dev/videos/1/1-240.mp4
curl -o /dev/null -w "%{http_code}\n" "https://yowat.pages.dev/videos/1/1.mp4?nocache=1"   # 期望 404

# 5) 两个入口页：都应直接 200（不能出现 308 跳回自己）
curl -o /dev/null -w "%{http_code}\n" https://yowat.pages.dev/docs
curl -o /dev/null -w "%{http_code}\n" https://yowat.pages.dev/upload
```

首页页脚会显示「数据源：Cloudflare D1」——显示这个就说明数据库通了；  
如果显示「本地清单（未连库）」说明第 6 步没绑上，页面仍在用 `assets/js/videos.data.js` 兜底。

---

## 8. 以后加新视频

站点上每个视频**只有两个档位文件**，高清原片不保留：

```
videos/{id}/{id}-360.mp4   主版本，播放页默认放它
videos/{id}/{id}-240.mp4   省流版，体积约 360p 的三分之二
videos/{id}/cover.jpg      封面（打包时自动抽）
```

**方式一：浏览器上传 + 一条命令（最顺手）**

1. 打开 `https://yowat.pages.dev/upload`，点 **「连接项目目录」**，选 `G://yowat` —— 只需授权一次，句柄存在浏览器里
2. 把视频拖进去、填标题标签、提交：元数据进 D1，**原始文件暂存在 `_incoming/{id}.mp4`**（不进部署）
3. 回终端跑 `npm run publish`

**方式二：纯命令行（一条命令做完）**

```bash
npm run add -- --file "D://拍的视频.mp4" --title "标题" --tags "日常,旅行" --register
```

干的事：分配 id → 拷进 `_incoming/` → 压 360p + 240p → 抽封面 → **删掉原始高清** → 把元数据写进 D1。
`--register` 用服务端分配的 id，不加就自己再登记一次。

补「库里有记录、但文件丢了」的情况，指定已有 id：

```bash
npm run add -- --file "D://拍的视频.mp4" --id 2
```

**方式三：直接调接口登记**

```bash
curl -X POST "https://yowat.pages.dev/api/upload/我的新视频/一句话简介/" ^
  -H "Content-Type: application/json" ^
  -d "{\"duration\":128,\"size\":52428800,\"tags\":[\"日常\",\"旅行\"]}"
```

响应里的 `data.video_id` 就是新编号。之后跑 `npm run pack -- --id {id} --from "D://拍的.mp4"` 出两个档位。

**方式四：写 SQL**（适合批量，路径按 id 拼即可）

```sql
INSERT INTO videos (id, vid, title, description, src, low, cover, duration, size, created_at, tags)
VALUES (2, 11093, '标题', '简介', 'videos/2/2-360.mp4', 'videos/2/2-240.mp4', 'videos/2/cover.jpg',
        128, 52428800, date('now'), '["日常"]');
```

> `videos.data.js` 只在连不上 D1 时当兜底，平时不用手改。

---

## 8.5 两个档位（360p + 240p），不留高清

### 一条命令

```bash
npm run pack                    # 处理 _incoming/ 里所有待打包的
npm run pack -- --id 2          # 只处理 2 号
npm run pack -- --all           # 所有还能找到源文件的
npm run pack -- --dry-run       # 只看会压成多大
npm run publish                 # 打包 + 部署（= pack + deploy）
```

源文件按顺序找：`_incoming/{id}.mp4` → `videos/{id}/{id}.mp4`（老的放法）→ `--from` 指定的路径。
**压完默认删源文件**，所以站点上永远不会出现高清原片；`--keep-source` 可以保留。

实测（1 号视频，512×384，240 秒，源 5.9 MB）：

| 档位 | 分辨率 | 体积 | 用途 |
|---|---|---|---|
| 360p | 480×360 | 3.6 MB | 播放页默认，`keyplus` 接口 |
| 240p | 320×240 | 2.5 MB | 省流，`back` 接口 |

部署体积从 9.3 MB（原片 + 旧 320p）降到 6.1 MB，单个观众看一遍只下 3.6 MB。

### 调画质和体积

```bash
npm run pack -- --id 1 --crf 34          # 画质换体积，默认 30（240p 会自动 +2）
npm run pack -- --id 1 --preset veryslow # 编码更慢、文件更小
npm run pack -- --all --fps 30           # 60fps 素材压到 30fps，省一大截
npm run pack -- --id 1 --tiers 360,240   # 默认就是这个，可改成 480,360,240
```

> CRF 30→36 在这片上差异很小（3.6→3.0 MB），因为源本身只有 206 kbps。手机直出的高码率素材收益会大得多。

### 25MB 上限不再碍事

Pages 单文件上限 25MB，但**原片根本不进部署**：它躺在 `_incoming/`，压完就删。哪怕原始文件 500MB 也没关系。

---

## 9. 本地预览（带接口）

```bash
wrangler pages dev . --d1 DB=yowat-db
```

打开 `http://localhost:8788`。这时 `/api/videos`、`/video/getvideo/...` 都能在本地跑，  
D1 用的是本地模拟库，不影响线上数据。

只想看页面不想跑接口？直接双击 `index.html` 也行，会走 `videos.data.js` 兜底。

---

## 10. 改完代码先跑一遍测试（不用联网）

```bash
npm test
```

等于依次跑两个文件：

- `tests/functions.test.mjs` —— 28 条断言，用假的 D1 和假的 fetch 覆盖 `/video/{id}` 跳转、两个下载接口（含 Range 透传、中文文件名、404/400 分支）、`/api/videos` 列表、上传登记。
- `tests/compress.test.mjs` —— 43 条断言，覆盖压缩工具的参数解析、缩放决策（横屏压高度、竖屏压宽度、不放大）、ffmpeg 参数拼装、体积格式化。

全部 `ok` 再部署，能省掉很多来回试的时间。

---

## 11. 常见问题

**数据库里有记录，但站点上没有文件**  
上传页跑在浏览器沙箱里，**写不了你硬盘上的文件**——它只负责把元数据写进 D1、把原始文件暂存到 `_incoming/`。真正的档位文件得靠本地 ffmpeg 生成，所以流程是「上传 → 终端跑一条命令」。

上传页右侧的 **「有视频还没落盘」** 面板会自动列出这种记录：

1. 点 **「连接项目目录」**，选 `G:\yowat`（没连的话面板会写「先连目录」，这时点补文件不会有任何反应）
2. 在对应条目上点 **「补文件」** 选视频 → 写入 `_incoming/{id}.mp4`
3. 终端跑 `npm run publish`

纯命令行也行：

```bash
npm run add -- --file "D:\拍的视频.mp4" --id 2   # 压 360p+240p、抽封面、删原片
npm run deploy
```

判断方法：`curl -o /dev/null -w "%{http_code}\n" https://yowat.pages.dev/videos/2/2-360.mp4`，404 就是还没打包。

**打开 `/docs` 或 `/upload` 报「重定向次数过多」**  
已踩过的坑。原因是 `_redirects` 里写了 `200` 重写到 `xxx.html`：

```
/docs    /docs.html    200     ← 内部改写到 /docs.html
```

而 Pages 默认 `html_handling = "auto-trailing-slash"`，它认为 `/docs` 才是规范地址，会把 `/docs.html` 再 308 掰回 `/docs`，两条逻辑互相踢皮球就无限循环。

**正确做法：这类短链一条都不要写。** Pages 原生支持省略扩展名，`/docs`、`/upload`、`/watch` 自动命中对应 html。`_redirects` 现在只留注释不用改。  
判断方法：`curl -o /dev/null -w "%{http_code} %{redirect_url}\n" https://yowat.pages.dev/docs`，如果 308 的目标又是它自己，就是这个问题。

**`/api/videos` 返回 `code: 5000`，说 D1 未绑定**  
第 6 步的绑定没生效。去控制台加绑定，然后**重新部署**（绑定变更需要新版本才生效）。

**下载接口返回 404「这个视频还没有文件」**  
`videos/{id}/` 下没有 `{id}-360.mp4` / `{id}-240.mp4`。跑 `npm run pack -- --id {id}` 再 `npm run deploy`。  
用 `curl -I https://yowat.pages.dev/videos/1/1-360.mp4` 能验证文件在不在。

**下载下来的文件名乱码**  
接口用的是 RFC 5987 编码（`filename*=UTF-8''...`），Chrome/Edge 正常。极老的客户端会退回 `yowat-video.mp4`。

**视频超过 25MB 传不上去**  
Pages 单文件上限 25MB —— 但现在原片根本不进部署（`_incoming/` 被 `.assetsignore` 排除），两个档位文件远小于 25MB，所以这条基本不会再碰到。真要调档位：

```bash
ffmpeg -i input.mp4 -vf scale=-2:720 -c:v libx264 -crf 26 -preset medium -c:a aac -b:a 96k output.mp4
```

还是超，就开 R2 并把 `wrangler.toml` 里 `[[r2_buckets]]` 的注释打开（见文件内说明）。

**改了页面但线上没变**  
Pages 有 CDN 缓存，HTML 一般即时生效；`assets/*` 带同名文件可能被缓存，强制刷新（Ctrl+F5）或给引用加 `?v=2`。

**部署太慢**  
每次部署都会上传整个 `videos/`。视频多了以后建议上 R2。

---

## 12. 开放上传：账号 + GitHub 自动构建

> 这一节是把站从「只有站长能传」变成「别人注册后能自己传」。
> 不接 GitHub 的话，上传页对别人来说没有意义 —— 因为 Pages 直传
> 必须由你本机发一条命令，别人点了按钮什么也不会发生。

### 为什么是 GitHub Actions，而不是 Pages 的 Git 集成

`yowat` 这个 Pages 项目是在 Cloudflare 后台以外、用 `wrangler pages deploy` 直传建的
（API 里 `source: null`，Dashboard 显示的 Git Provider 是 `No`）。
**Cloudflare 不允许 Direct Upload 项目之后改接 Git 仓库**，只能新建一个项目 ——
而新建项目就意味着地址会变成 `yowat-xxxx.pages.dev`，`yowat.pages.dev` 无法迁移
（`*.pages.dev` 子域名既不能改名也不能转移）。

所以走的是：**仓库 push → GitHub Actions 跑 `wrangler pages deploy` → 还是传到原来那个项目**。
地址、域名、D1 绑定、现有两条视频全都不动。

代价是三条硬限制，都绕不过去：

- **单文件 25MiB**（Pages 的上限，所以转码这一步不能省）
- **仓库只增不减**（视频进了 git 历史就永远在，删了也占地方。100 个视频约 300MB）
- **每次上传要等一次完整部署**（约 1~2 分钟）
  GitHub Actions 免费额度：public 仓库不限，private 每月 2000 分钟，够跑几百次。

已经做完的部分（本轮已执行，不用你动手）：

- 数据库迁移已在生产 D1 上跑完
- `G:\yowat` 已 `git init` 并提交了第一个 commit
- `.github/workflows/deploy.yml` 已写好


### 12.1 数据库迁移（已完成，不用再跑）

`users` / `sessions` 两张表和 `videos` 的 `owner_id` / `status` / `uploader` 三列
已经在你的生产 D1 上建好了，两条老视频记录完好。

想复查的话：

```bash
npx wrangler d1 execute yowat-db --remote --command "SELECT id,title,status,owner_id FROM videos"
```

重复执行迁移文件会因列已存在而报错，这是正常的，别慌。

### 12.2 把项目推到 GitHub

本地仓库已经建好了（`git init` + 首个 commit 都做完了），只差一个远端地址。

在 GitHub 上建一个**空仓库**（不要勾 README / .gitignore / license，否则会和本地冲突），
然后：

```bash
cd /g/yowat
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

第一次 push 会弹出一个浏览器窗口让你登录 GitHub，登录授权一次，以后就不再问了。

推完之后仓库应该看到 44 个文件，其中 `assets/js/vendor/ffmpeg-core.wasm` 是 24MB，
这是转码引擎，**必须跟着仓库走**，不然上传页在别人电脑上跑不起来。

### 12.3 生成一个 token

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token：

- Repository access：只选这个仓库
- Permissions → Repository permissions → **Contents: Read and write**
- Expiration：按自己习惯，过期了要重新生成并更新到 Cloudflare

拿到形如 `github_pat_xxx` 的字符串，**只显示一次**，复制好。

### 12.4 在 Cloudflare 加两个变量（Worker 提交文件用）

Dashboard → Workers & Pages → `yowat` → Settings → **Variables and Secrets** →
Environment 选 **Production**（Preview 也加一份更好）：

| 名称 | 值 | 类型 |
| --- | --- | --- |
| `GITHUB_TOKEN` | 12.3 拿到的 `github_pat_xxx` | **Secret**（加密） |
| `GITHUB_REPO` | `用户名/仓库名`，例如 `ruolin/yowat` | 明文 |
| `GITHUB_BRANCH` | 可选，默认 `main` | 明文 |

顺手确认同一页面的 **Bindings** 里 D1 变量名是 `DB`，
否则接口会全部报 5001。

改完点 **Deploy** / **Redeploy** 一次让变量生效。

### 12.5 在 GitHub 加两个 Secret（Actions 部署用）

打开你的仓库 → **Settings** → 左侧 **Secrets and variables** → **Actions** →
**New repository secret**，加两条：

**第一条 `CLOUDFLARE_API_TOKEN`**

Cloudflare Dashboard → 右上头像 → **My Profile** → 左侧 **API Tokens** →
**Create Token** → 最下面 **Create Custom Token**：

- Token name：`yowat-github-actions`
- Permissions：`Account` → `Cloudflare Pages` → **Edit**
- Account Resources：`Include` → 你的账号
- 其它留空（不要给 Zone、不要给 Workers Scripts）
- TTL 按习惯设，到期要重新生成并更新到 GitHub

创建后那串 token **只显示一次**，复制下来。

**第二条 `CLOUDFLARE_ACCOUNT_ID`**

值直接抄这个（已经是你账号的 ID）：

```
15887767d0fd3add2aa1a526b1661925
```

> 为什么是两个平台各配一份：Cloudflare 那份让**网站后端**能往仓库写文件，
> GitHub 那份让 **Actions** 能把代码推上 Cloudflare。两边各管一头，互不需要对方的完整权限。

### 12.6 验证（分两步，别跳过第一步）

**第一步：先确认部署通道是通的**

仓库 → **Actions** → 左侧 `Deploy` → 右侧 **Run workflow** → 绿色按钮。
等 1~3 分钟，出现绿色对勾就是成功，这时 `https://yowat.pages.dev` 应该和现在一模一样。

这一步不通就别往下走，先看失败日志里缺了哪个 Secret。

**第二步：再验证上传**

1. 打开 `https://yowat.pages.dev/upload`
2. 注册一个账号（用户名 4~20 位字母数字下划线，密码 8 位以上）
3. 选一个短视频（建议先用 30 秒以内的测试）
4. 页面会显示「压到 360p → 压到 240p → 上传 → 等待上线」
5. 看到「上传成功 #3」后，去 GitHub 仓库 commits 看有没有新的提交
6. Actions 会自动跑起来，等它变绿，打开 `/video/3` 就能播

失败时去看 Cloudflare 的 Functions 日志，错误码对应：

| 码 | 意思 |
| --- | --- |
| 5002 | 没配 `GITHUB_TOKEN` / `GITHUB_REPO` |
| 5003 | GitHub 拒绝了提交（token 权限不对，或分支名写错） |
| 4010 | 没登录 |
| 4020 / 4021 | 配额用完了（默认每人 20 个 / 200MB） |

### 12.6.1 别人上传后，你本地要记得先 pull

网页上传是**服务端直接往 GitHub 写的提交**，你本机的 `G:\yowat` 不会自动同步。
如果不 pull 就在本地改东西再 push，会被 GitHub 顶回来（`non-fast-forward`）。

所以每次在本机动手之前，先拉一下：

```bash
cd /g/yowat
git pull
```

有冲突就 `git pull --rebase`。日常只往网页传视频、不动代码的话，不 pull 也没影响。

### 12.7 转码是怎么跑的（2026-11-26 起：在服务器上，不在浏览器里）

**为什么改**：浏览器端的 `ffmpeg.wasm` 撑不住真东西。0.11 在 3 分钟级别的
真实文件上直接抛 `RuntimeError: function signature mismatch`（wasm 里崩，
进度永远 0%，还不报错）；0.12 的单线程 core 是 31MB，部分网络拉不下来。
两条路都在真文件上验证失败，所以整套搬到服务器。

现在的链路（用户只需要做第一步）：

1. 上传页把原片 POST 到 `/api/upload`，进度条显示真实上传百分比
   —— 8MB 大概 20 秒，传完页面就可以关
2. 接口按 6MB 切片，提交到 `_raw/{id}-{随机串}/partNN`（一次 commit）
3. `transcode.yml` 被 `_raw/**` 触发：拼回原片 → 原生 ffmpeg 转 360p / 240p
   + 抽封面 → 提交到 `videos/{id}/` → 删掉 `_raw` 那一坨 → 自己跑一次
   `wrangler pages deploy`
4. 播放页读接口时 `promoteIfLive()` 往 `/videos/{id}/{id}-360.mp4` 发 HEAD，
   Content-Type 是 `video/*` 才把状态从 `processing` 翻成 `ready`

3 分钟 576×432 的片子，runner 上转码约 20 秒，加上部署，**从传完到能播 1~2 分钟**。

几条要记住的：

- **源片上限 32MB**（Workers 单次执行内存 128MB，切片 + base64 要留余量）。
  超了接口直接返回 1004，上传页会红字说明
- **单档输出 ≤ 25MB**（Pages 硬限制，超了整次部署失败）。`tools/transcode-ci.mjs`
  会在超过 24MB 时自动加 CRF 重压一次
- **runner 上没有预装 ffmpeg**，workflow 里 `apt-get install -y ffmpeg` 显式装。
  之前写成 `ffmpeg -version | head -1`，命令不存在时退出码被管道吃掉，
  结果是「显示成功、下一步才炸、日志还看不到」
- **`_raw` 必须按上传分目录**：`videos.id` 是 `INTEGER PRIMARY KEY`（没有
  AUTOINCREMENT），删掉记录后 id 会被下一笔复用，平铺成 `_raw/{id}.partNN`
  就会把上一笔没清掉的残留拼进新文件，转出一个坏 mp4
- **CI 的运行日志在 `_ci/last-run.md`**（每次跑完跟着结果一起提交）。
  GitHub 的 Actions 日志接口要仓库写权限，浏览器里点不到，这个文件是唯一的
  排查入口
- 转码失败时原片会留在 `_raw/` 里没被删，修好后去 Actions 页面点
  **Transcode → Run workflow** 重跑就行（也可以往 `_raw/` 里推个空改动触发）
- 同一个视频 id 的旧文件不会被覆盖删除：Pages 直传不删历史文件，
  所以「删视频」只影响列表，二进制还留在 CDN 上

想再快、或者要传更大的片子，就得换 R2 + 服务端转码，见 12.8。

### 12.8 换成 R2 的逃生通道

如果仓库被撑大了，或者嫌浏览器压缩太慢，可以换 R2：

- 10GB 存储免费、**出站流量永久免费**、不需要重新部署
- 但开通要绑支付方式（额度内不扣钱）
- 代码上是把 `functions/api/upload/[[path]].js` 里提交 GitHub 那一段
  换成 `env.BUCKET.put()`，播放侧把 `/videos/{id}/...` 的取文件改成从 R2 读

`wrangler.toml` 里已经预留了 `[[r2_buckets]]` 的注释块。

---

## 13. 站长自己加视频（老流程，仍然可用）

不想走网页上传，或者视频在本机、懒得等浏览器压，还是走命令行：

```bash
npm run add -- --file "D:\某个视频.mp4" --id 3 --register
```

这条命令会压 360p + 240p、抽封面、删原片、写线上数据库。

**但文件还得进仓库才算真正上线**，接着补一条：

```bash
git add videos/3 && git commit -m "add video 3" && git push
```

push 之后 Actions 自动部署，1~3 分钟生效。

> ⚠️ 以后尽量只用 `git push` 上线。`npm run deploy` 是直传，它会把**本地目录**
> 推上去；如果本地有仓库里还没有的东西，下次 Actions 一跑就会把它覆盖掉，
> 后台和仓库就对不上了。直传只在紧急修 bug、且改完会立刻 push 的时候用。

---

## 文件对照表

| 文件                                                        | 作用                                   |
| --------------------------------------------------------- | ------------------------------------ |
| `index.html` / `watch.html` / `upload.html` / `docs.html` | 页面                                   |
| `assets/js/yowat.js`                                      | 前端核心：拉数据、渲染、播放器                      |
| `assets/js/compress.js`                                   | 浏览器端转码封装（ffmpeg.wasm）                |
| `assets/js/vendor/ffmpeg.min.js`                          | ffmpeg 包装器（22KB，自托管）                 |
| `assets/js/vendor/ffmpeg-core.wasm`                       | 转码引擎（23MB，自托管，低于 Pages 25MB 上限）      |
| `assets/js/videos.data.js`                                | 本地兜底清单（连不上 D1 时用）                    |
| `videos/{id}/{id}-360.mp4` / `-240.mp4` / `cover.jpg`     | 站点上仅有的三个文件，原片不留                      |
| `functions/api/videos.js`                                 | `GET /api/videos` 清单                 |
| `functions/api/videos/[id].js`                            | `GET` 单个 · `POST` 播放量 · `DELETE` 删除  |
| `functions/api/upload/[[path]].js`                        | 上传入口：鉴权 → 配额 → 提交 GitHub → 写 D1     |
| `functions/api/auth/[[path]].js`                          | 注册 / 登录 / 退出 / 我是谁                   |
| `functions/video/[[path]].js`                             | 播放跳转 + 两个下载接口                        |
| `functions/_lib.js`                                       | 函数公共工具（含配额统计）                        |
| `functions/_auth.js`                                      | 密码哈希、会话、Cookie、限流                     |
| `functions/_github.js`                                    | Git Data API：多文件一次 commit / 删文件      |
| `schema.sql`                                              | D1 建表与初始数据                           |
| `migrations/001-users.sql`                                | 用户、会话、视频归属（**已在生产跑过**）               |
| `wrangler.toml`                                           | Pages + D1 配置（记得填 database_id）       |
| `_redirects` / `_headers`                                 | 短链；上传页的跨域隔离头                         |
| `.github/workflows/deploy.yml`                            | **push 后自动部署**（保住 yowat.pages.dev 的关键） |
| `tests/functions.test.mjs`                                | 接口单测                                 |
| `tests/auth.test.mjs`                                     | 账号 + 上传链路测试（跑真 SQLite）               |
| `.assetsignore`                                           | 不随站点上传的文件（文档、SQL、测试等）                |
