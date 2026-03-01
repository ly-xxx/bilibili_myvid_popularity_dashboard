# bilibili_myvid_popularity_dashboard

一个本地运行的 B 站 UP 主视频热度看板：

- 自动抓取指定 UID 的最近视频
- 实时展示“正在看”人数、播放量
- 每卡片 1 小时趋势曲线（并持久化到 CSV）
- 详情页支持时间范围查询、双曲线叠加、平滑/折线切换、CSV 导出

## 技术栈

| 模块 | 技术 |
|------|------|
| **后端** | Node.js、Express 5.x、CORS |
| **看板前端** | 原生 HTML/JS、Tailwind CSS（CDN） |
| **taffy-music 播控** | 原生 HTML/JS、Tailwind CSS、Google Fonts（Noto Serif SC） |
| **B 站接口** | 原生 fetch、WBI 签名（`scripts/bilibili-wbi.js`） |
| **视频下载** | yt-dlp（外部依赖）、Node 脚本调用 |
| **数据持久化** | 本地 CSV、JSON 快照 |

无数据库、无构建工具，开箱即用。

## 主要特性

- **纯本地运行**：`Node.js + Express`，无需云服务
- **深色数据墙 UI**：卡片背景封面、状态灯、总在线人数
- **自适应轮询**：在线越高轮询越频繁（并限制最高频率）
- **历史持久化**：按视频写入 `data/history/<bvid>.csv`
- **可配置参数**：前端设置面板可直接调整 UID、轮询与刷新策略

## 环境要求

- Node.js 18+（建议 20+）
- npm

## 快速开始

```bash
npm install
npm start
```

启动后访问：

- 首页看板：`http://localhost:3000`
- 健康检查：`http://localhost:3000/health`

## 配置方式

### 1) 页面内设置（推荐）

点击首页顶部「设置」按钮，可直接调整并保存：

- `upMid`：UP 主 UID
- `maxVideos`：最近视频条数（1-100）
- `cacheMs`：数据缓存毫秒（1000-120000）
- `throttleMs`：单请求间隔毫秒（200-10000）
- `cycleSleepMs`：轮询循环间隔毫秒（1000-60000）
- `videosRefreshMs`：视频列表刷新毫秒（10000-86400000）
- `playRefreshMs`：播放量刷新毫秒（10000-3600000）

保存后立即生效，不需要重启。

### 2) 环境变量（启动前）

可通过环境变量设置默认值：

- `UP_MID`
- `BILI_MAX_VIDEOS`
- `BILI_CACHE_MS`
- `BILI_THROTTLE_MS`
- `BILI_CYCLE_SLEEP_MS`
- `BILI_VIDEOS_REFRESH_MS`
- `BILI_PLAY_REFRESH_MS`

## 数据与文件

- 历史 CSV：`data/history/<bvid>.csv`
  - 字段：`timestamp,online,play`
- 目录快照：`data/catalog-snapshot.json`
  - 用于在接口风控/失败时保留最近可用视频列表

> 说明：仓库默认忽略历史数据文件（见 `.gitignore`），避免提交本地采集数据。

## API 一览

- `GET /api/online-data`
  - 返回看板卡片所需数据（含 `history1h`）
- `GET /api/history?bvid=...&from=...&to=...`
  - 返回详情页曲线点位
- `GET /api/history/csv?bvid=...&from=...&to=...`
  - 导出指定时间范围的 CSV
- `GET /api/settings`
  - 获取当前配置
- `POST /api/settings`
  - 更新配置并立即生效
- `GET /api/cover?url=...`
  - 封面代理，降低防盗链问题

## 常见问题

- **出现 `arc/search api code -352`**
  - 通常是 B 站风控或频控波动，项目会保留最近可用目录并持续重试。
- **播放量看起来变化慢**
  - 播放量是低频刷新项，受 `playRefreshMs` 控制。
- **“1 人正在看”按 0 处理**
  - 前端按产品规则将 `1` 视为“本人观看”并显示/统计为 `0`。

## taffy-music 智能播控中心

`taffy-music/` 为永雏塔菲原创曲 & 翻唱的音乐播放器前端，已随项目发布在 GitHub。

**仓库中包含**：前端页面 `index.html`、元数据 `*.metadata.json`、歌词 `*.lrc`、封面 `*.jpg` 等。

**仓库中不包含**：视频文件（`.mp4` 等），因体积较大不提交。

### 如何放置下载到的视频

1. **下载视频**：使用项目自带的下载脚本（需安装 [yt-dlp](https://github.com/yt-dlp/yt-dlp)）：
   ```bash
   # 设置 Cookie 可减少风控（可选）
   $env:BILI_COOKIE="SESSDATA=你的SESSDATA值"
   npm run download-taffy
   # 或按合集补全：npm run download-taffy:playlist
   ```

2. **输出目录**：脚本会将视频下载到 `taffy-music/原创曲/` 和 `taffy-music/翻唱/`（及子目录如 `sum/`、`1/`、`2/` 等）。

3. **目录结构**：每个视频与同名的 `metadata.json`、`.lrc`、`.jpg` 放在同一目录。克隆仓库后，只需将下载好的 `.mp4` 放到对应子目录中，与现有 `metadata.json` 同名（如 `20260205_BV14VFYzXERQ.mp4` 与 `20260205_BV14VFYzXERQ.metadata.json` 同目录）。

4. **访问方式**：启动 `npm start` 后，访问 `http://localhost:3000/taffy-music/` 即可使用播控中心。

详细下载说明见 `scripts/README-download.md`。

---

## 发布前检查

- **敏感信息**：Cookie、API Key 等均通过环境变量 `BILI_COOKIE` 传入，不硬编码；`.env` 已加入 `.gitignore`
- **忽略项**：`data/history/`、`data/catalog-snapshot.json`、`taffy-music/**/*.mp4` 等不提交

## 免责声明

本项目仅用于个人数据观察与学习研究，请遵守 B 站平台规则与相关法律法规，避免高频抓取、批量滥用和商业化违规用途。
