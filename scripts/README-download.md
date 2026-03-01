# 永雏塔菲 原创曲 & 翻唱 下载脚本

从 B 站用户 **永雏塔菲** (UID: 1265680561) 的投稿中，下载全部原创曲和翻唱视频。

## 功能

- 获取 UP 主**全部投稿**（分页遍历，不遗漏）
- **播放量 ≥ 5 万** 过滤直播回放（直播回放通常播放较低）
- 分类：**原创曲** / **翻唱** 两个文件夹
- 文件名格式：`时间戳_标题.扩展名`（如 `20231201_好似喵.mp4`）
- 分类依据：B 站分区 (tid 28=原创音乐, 31=翻唱) + 标题关键词

## 反风控优化（参考 HachimiDownloader）

- **模拟浏览器 Cookie**：随机 buvid3、buvid4 等，降低被识别为脚本的概率
- **User-Agent 轮换**：每次请求随机选择 4 种 UA 之一
- **分页随机延迟**：每页请求间隔 1~3 秒
- **风控重试**：遇到 -352 时等待 10~20 秒后重试，每页最多 3 次
- **部分数据保留**：若中途风控，已获取的视频会保留并继续使用

## 环境要求

1. **Node.js**（项目已有）
2. **yt-dlp**：用于下载视频
   ```bash
   pip install yt-dlp
   # 或从 https://github.com/yt-dlp/yt-dlp 下载
   ```

## 使用方法

### 1. 仅列出将要下载的视频（不下载）

```bash
npm run download-taffy:list
# 或
node scripts/download-taffy-music.js --list-only
```

### 2. 开始下载

```bash
npm run download-taffy
# 或
node scripts/download-taffy-music.js
```

### 3. 按合集「塔菲唱歌喵」补全缺失视频

若本地缺少合集中的视频，可运行：

```bash
npm run download-taffy:playlist
# 或
node scripts/download-taffy-music.js --from-playlist
```

会对比合集与本地，只下载缺失的视频。

### 4. 若出现风控 -352 错误

B 站可能对未登录请求进行风控。请设置 Cookie 后重试：

1. 在浏览器登录 bilibili.com
2. F12 打开开发者工具 → Application → Cookies → 找到 `bilibili.com`
3. 复制 `SESSDATA` 的值（或整行 Cookie 字符串）
4. 设置环境变量后运行：

```bash
# Windows PowerShell
$env:BILI_COOKIE="SESSDATA=你的SESSDATA值"
npm run download-taffy

# 或完整 Cookie
$env:BILI_COOKIE="SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx"
npm run download-taffy
```

```bash
# Windows CMD
set BILI_COOKIE=SESSDATA=你的SESSDATA值
npm run download-taffy
```

## 输出目录

```
taffy-music/
├── 原创曲/     # 原创曲视频 + 对应 metadata.json
└── 翻唱/       # 翻唱视频 + 对应 metadata.json
```

每个视频会生成同名的 `metadata.json`，包含：

| 字段     | 说明                         |
|----------|------------------------------|
| 歌曲名   | 从 B 站标题/简介解析         |
| 演唱者   | 从 B 站标题/简介解析         |
| 歌词片段 | 需在网易云等平台查找后手动补充 |
| 封面     | 封面图片本地文件名（自动下载） |

### 为已有视频生成 metadata

若视频是之前下载的、尚未有 metadata，可运行：

```bash
npm run metadata
```

### 列出歌名便于在网易云搜索歌词

```bash
npm run metadata:list
```

会输出全部歌名，便于在网易云搜索后手动填入各 `metadata.json` 的「歌词片段」字段。

## 自定义

可在 `scripts/download-taffy-music.js` 中修改：

- `MIN_PLAY_COUNT`：播放量阈值（默认 50000）
- `ORIGINAL_KEYWORDS` / `COVER_KEYWORDS`：标题关键词
- `OUTPUT_BASE`：输出根目录
