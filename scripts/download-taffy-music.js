#!/usr/bin/env node
/**
 * 下载永雏塔菲的全部原创曲和翻唱视频
 * - 原创曲、翻唱分两个文件夹
 * - 文件名最前面加时间戳
 * - 过滤直播回放：播放量 >= 5万
 * - 需安装 yt-dlp: https://github.com/yt-dlp/yt-dlp
 */

const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const {
  buildSignedWbiQuery,
  parseBiliNumber,
  getRequestHeaders,
} = require("./bilibili-wbi.js");
const { extractMusicMetadata } = require("./extract-music-metadata.js");

const MAX_RETRIES = 3;
const RETRY_SLEEP_MIN = 10000; // 风控时等待 10-20 秒
const RETRY_SLEEP_MAX = 20000;
const PAGE_SLEEP_MIN = 1000;
const PAGE_SLEEP_MAX = 3000;

function getHeaders(referer = "https://www.bilibili.com/") {
  const h = getRequestHeaders("", referer);
  if (BILI_COOKIE) h.cookie = (h.cookie || "") + "; " + BILI_COOKIE;
  return h;
}

function randomSleep(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, ms));
}

const TAFFY_UID = "1265680561";
const MIN_PLAY_COUNT = 50000; // 5万播放以上，过滤直播回放

// 可选：设置 BILI_COOKIE 环境变量传入登录 Cookie，可减少风控 -352
// 从浏览器登录 bilibili 后，F12 -> Application -> Cookies -> 复制 SESSDATA 等
const BILI_COOKIE = process.env.BILI_COOKIE || "";
const PS = 30; // 每页数量
const OUTPUT_BASE = path.join(__dirname, "..", "taffy-music");
const ORIGINAL_DIR = path.join(OUTPUT_BASE, "原创曲");
const COVER_DIR = path.join(OUTPUT_BASE, "翻唱");

// B站分区: 28=原创音乐, 31=翻唱
const TID_ORIGINAL = 28;
const TID_COVER = 31;

// 原创曲关键词（标题补充，优先级高）
const ORIGINAL_KEYWORDS = ["原创曲", "原创", "original"];
// 翻唱关键词
const COVER_KEYWORDS = ["翻唱", "cover", "Cover", "Cover曲"];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const BVID_CACHE_FILE = path.join(__dirname, "..", "taffy_bvids.txt");
const PLAYLIST_URL =
  "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=1265680561&season_id=971439&page_num=1&page_size=100";

/**
 * 步骤 1：用 yt-dlp --flat-playlist 获取 UP 主全部 BV 号（带文件缓存）
 */
function fetchBvidsViaYtDlp(mid) {
  return new Promise((resolve, reject) => {
    const url = `https://space.bilibili.com/${mid}/video`;
    const { spawnSync } = require("child_process");
    const result = spawnSync(
      "yt-dlp",
      ["--flat-playlist", "--print", "%(id)s", url],
      { encoding: "utf-8", timeout: 120000, shell: true, stdio: ["ignore", "pipe", "ignore"] }
    );
    const out = result.stdout || "";
    const ids = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.startsWith("BV"));
    if (ids.length > 0) {
      fs.writeFileSync(BVID_CACHE_FILE, ids.join("\n"), "utf-8");
      console.log(`  已缓存 ${ids.length} 个 BV 号到 ${BVID_CACHE_FILE}`);
      return resolve(ids);
    }
    if (fs.existsSync(BVID_CACHE_FILE)) {
      const cached = fs.readFileSync(BVID_CACHE_FILE, "utf-8")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.startsWith("BV"));
      if (cached.length > 0) {
        console.log(`  yt-dlp 失败，使用缓存的 ${cached.length} 个 BV 号`);
        return resolve(cached);
      }
    }
    reject(new Error(`yt-dlp 未获取到 BV 号且无缓存 (exit ${result.status})`));
  });
}

/**
 * 步骤 2：用 x/web-interface/view 获取单个视频详情（不需要 WBI 签名，风控较少）
 */
async function fetchVideoDetail(bvid) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const headers = getHeaders(`https://www.bilibili.com/video/${bvid}`);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`view http ${res.status}`);
      const json = await res.json();
      if (json.code === 0 && json.data) {
        const d = json.data;
        return {
          bvid: d.bvid,
          title: d.title || bvid,
          desc: d.desc || "",
          pic: d.pic || "",
          created: d.pubdate || d.ctime || 0,
          play: d.stat?.view || 0,
          length: "",
          tid: d.tid || 0,
        };
      }
      if (json.code === -352 || json.code === -412) {
        throw new Error(`view 风控 ${json.code}`);
      }
      return null;
    } catch (e) {
      if (attempt < MAX_RETRIES && (e.message.includes("风控") || e.message.includes("-352"))) {
        await randomSleep(RETRY_SLEEP_MIN, RETRY_SLEEP_MAX);
      } else {
        return null;
      }
    }
  }
  return null;
}

/** 从本地 taffy-music 目录提取已存在的 BV 号 */
function extractBvidsFromLocal() {
  const bvids = new Set();
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.(mp4|flv|mkv|webm)$/i.test(e.name)) {
        const m = e.name.match(/BV[\w]+/);
        if (m) bvids.add(m[0]);
      }
    }
  };
  walk(ORIGINAL_DIR);
  walk(COVER_DIR);
  return bvids;
}

/** 从合集 API 获取视频列表 */
async function fetchPlaylistArchives() {
  const res = await fetch(PLAYLIST_URL, {
    headers: getHeaders("https://space.bilibili.com/"),
  });
  if (!res.ok) throw new Error(`playlist http ${res.status}`);
  const json = await res.json();
  if (json.code !== 0 || !json.data?.archives) {
    throw new Error(json.message || "合集 API 返回异常");
  }
  return json.data.archives;
}

/**
 * 获取 UP 主全部投稿
 * 策略：yt-dlp 获取 BV 号列表 → 逐个查询视频详情
 */
async function fetchAllVideosByMid(mid) {
  console.log("📡 通过 yt-dlp 获取全部投稿 BV 号...");
  const bvids = await fetchBvidsViaYtDlp(mid);
  console.log(`✅ 获取到 ${bvids.length} 个 BV 号，开始查询视频详情...\n`);

  const BATCH = 5;
  const all = [];
  for (let i = 0; i < bvids.length; i += BATCH) {
    const batch = bvids.slice(i, i + BATCH);
    const results = await Promise.all(batch.map((bv) => fetchVideoDetail(bv)));
    for (const v of results) {
      if (v) all.push(v);
    }
    process.stdout.write(`\r  已查询 ${Math.min(i + BATCH, bvids.length)}/${bvids.length} ...`);
    await randomSleep(300, 800);
  }

  console.log(`\n✅ 共获取 ${all.length} 个视频详情`);
  return all;
}

/**
 * 分类：原创曲 / 翻唱 / 其他（不下载）
 * 优先用分区 tid，其次用标题关键词
 */
function classifyVideo(video) {
  const title = (video.title || "").toLowerCase();
  const titleRaw = video.title || "";
  const tid = Number(video.tid) || 0;

  const isOriginalByTid = tid === TID_ORIGINAL;
  const isCoverByTid = tid === TID_COVER;

  const isOriginalByTitle = ORIGINAL_KEYWORDS.some(
    (k) => title.includes(k.toLowerCase()) || titleRaw.includes(k)
  );
  const isCoverByTitle = COVER_KEYWORDS.some(
    (k) => title.includes(k.toLowerCase()) || titleRaw.includes(k)
  );

  if (isOriginalByTid || isOriginalByTitle) return "original";
  if (isCoverByTid || isCoverByTitle) return "cover";
  return null;
}

/**
 * 生成安全文件名：时间戳_标题
 */
function safeFilename(video, type) {
  const ts = video.created
    ? new Date(video.created * 1000).toISOString().slice(0, 10).replace(/-/g, "")
    : "00000000";
  const raw = (video.title || video.bvid)
    .replace(/[/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${ts}_${raw}`;
}

/**
 * 检查 yt-dlp 是否可用
 */
function checkYtDlp() {
  return new Promise((resolve) => {
    const p = spawn("yt-dlp", ["--version"], { stdio: "pipe" });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

/**
 * 使用 yt-dlp 下载视频
 */
function downloadWithYtDlp(bvid, outputDir, outputTemplate) {
  return new Promise((resolve, reject) => {
    const url = `https://www.bilibili.com/video/${bvid}`;
    const args = [
      "-o",
      path.join(outputDir, outputTemplate),
      "--no-overwrites",
      "--restrict-filenames",
      "--no-playlist",
      url,
    ];

    const p = spawn("yt-dlp", args, {
      stdio: "inherit",
      shell: true,
    });

    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exit ${code}`));
    });
    p.on("error", reject);
  });
}

async function main() {
  const listOnly = process.argv.includes("--list-only") || process.argv.includes("-l");
  const fromPlaylist = process.argv.includes("--from-playlist") || process.argv.includes("-p");

  console.log("🎵 永雏塔菲 原创曲 & 翻唱 下载脚本");
  console.log("====================================\n");

  if (!listOnly) {
    const hasYtDlp = await checkYtDlp();
    if (!hasYtDlp) {
      console.error("❌ 未检测到 yt-dlp，请先安装：");
      console.error("   pip install yt-dlp");
      console.error("   或访问 https://github.com/yt-dlp/yt-dlp");
      process.exit(1);
    }
  }

  let videos;

  if (fromPlaylist) {
    // 从合集「塔菲唱歌喵」获取，只下载本地缺失的
    console.log("📡 从合集「塔菲唱歌喵」获取视频列表...");
    const archives = await fetchPlaylistArchives();
    const localBvids = extractBvidsFromLocal();
    const missing = archives.filter((a) => !localBvids.has(a.bvid));
    console.log(`   合集 ${archives.length} 个，本地已有 ${localBvids.size} 个，缺失 ${missing.length} 个\n`);

    if (missing.length === 0) {
      console.log("✅ 合集中的视频本地已全部包含，无需下载。");
      process.exit(0);
    }

    // 获取完整详情（含 desc、pic）
    const BATCH = 3;
    videos = [];
    for (let i = 0; i < missing.length; i += BATCH) {
      const batch = missing.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((a) => fetchVideoDetail(a.bvid)));
      for (const v of results) {
        if (v) videos.push(v);
      }
      await randomSleep(400, 800);
    }
    // 合集模式：不按播放量过滤
  } else {
    // 1. 获取全部投稿
    videos = await fetchAllVideosByMid(TAFFY_UID);
  }

  // 2. 过滤播放量 >= 5万，并分类（合集模式不按播放量过滤）
  const filtered = fromPlaylist ? videos : videos.filter((v) => v.play >= MIN_PLAY_COUNT);
  if (!fromPlaylist) {
    console.log(`\n📌 播放量 >= ${MIN_PLAY_COUNT / 10000}万 的视频: ${filtered.length} 个\n`);
  } else {
    console.log(`\n📌 待下载: ${filtered.length} 个\n`);
  }

  const originalList = [];
  const coverList = [];

  for (const v of filtered) {
    const type = classifyVideo(v);
    if (type === "original") originalList.push(v);
    else if (type === "cover") coverList.push(v);
    else if (fromPlaylist) {
      // 合集模式：未分类的归入翻唱
      coverList.push(v);
    }
  }

  console.log(`📁 原创曲: ${originalList.length} 个`);
  console.log(`📁 翻唱: ${coverList.length} 个\n`);

  if (originalList.length === 0 && coverList.length === 0) {
    console.log("⚠️ 没有匹配到原创曲或翻唱视频。");
    console.log("   可调整 scripts/download-taffy-music.js 中的 ORIGINAL_KEYWORDS / COVER_KEYWORDS");
    process.exit(0);
  }

  if (listOnly) {
    console.log("【原创曲】");
    originalList.forEach((v) =>
      console.log(`  ${v.bvid} | ${(v.play / 10000).toFixed(1)}万 | ${v.title}`)
    );
    console.log("\n【翻唱】");
    coverList.forEach((v) =>
      console.log(`  ${v.bvid} | ${(v.play / 10000).toFixed(1)}万 | ${v.title}`)
    );
    console.log("\n使用 node scripts/download-taffy-music.js 开始下载（需安装 yt-dlp）");
    process.exit(0);
  }

  // 3. 创建输出目录
  fs.mkdirSync(ORIGINAL_DIR, { recursive: true });
  fs.mkdirSync(COVER_DIR, { recursive: true });

  // 4. 下载（用 BV号 作主文件名，避免路径过长），并写入 metadata.json
  const downloadCover = async (picUrl, savePath) => {
    if (!picUrl || !picUrl.startsWith("http")) return "";
    try {
      const headers = getHeaders("https://www.bilibili.com/");
      const res = await fetch(picUrl, { headers });
      if (!res.ok) return "";
      const buf = await res.arrayBuffer();
      fs.writeFileSync(savePath, Buffer.from(buf), "binary");
      return path.basename(savePath);
    } catch {
      return "";
    }
  };

  const writeMetadata = async (v, dir, type) => {
    const ts = v.created
      ? new Date(v.created * 1000).toISOString().slice(0, 10).replace(/-/g, "")
      : "00000000";
    const baseName = `${ts}_${v.bvid}`;
    const { 歌曲名, 演唱者 } = extractMusicMetadata(v.title, v.desc || "", type);

    let coverFile = "";
    if (v.pic) {
      const ext = /\.(jpg|jpeg|png|webp)$/i.test(v.pic)
        ? v.pic.match(/\.(jpg|jpeg|png|webp)$/i)[1].toLowerCase()
        : "jpg";
      coverFile = await downloadCover(v.pic, path.join(dir, `${baseName}.${ext}`));
    }

    const meta = {
      歌曲名: 歌曲名 || "",
      演唱者: 演唱者 || "",
      歌词片段: "",
      封面: coverFile || undefined,
      _source: { bvid: v.bvid, title: v.title },
    };
    if (!meta.封面) delete meta.封面;
    fs.writeFileSync(
      path.join(dir, `${baseName}.metadata.json`),
      JSON.stringify(meta, null, 2),
      "utf-8"
    );
  };

  const downloadOne = async (v, dir, label, type) => {
    const ts = v.created
      ? new Date(v.created * 1000).toISOString().slice(0, 10).replace(/-/g, "")
      : "00000000";
    const template = `${ts}_%(id)s.%(ext)s`;
    console.log(`\n⬇️ [${label}] ${v.bvid} ${v.title} (播放 ${(v.play / 10000).toFixed(1)}万)`);
    try {
      await downloadWithYtDlp(v.bvid, dir, template);
      await writeMetadata(v, dir, type);
      console.log(`   ✅ 完成`);
    } catch (e) {
      console.error(`   ❌ 失败: ${e.message}`);
    }
    await sleep(2000);
  };

  console.log("开始下载 原创曲...");
  for (const v of originalList) {
    await downloadOne(v, ORIGINAL_DIR, "原创曲", "original");
  }

  console.log("\n开始下载 翻唱...");
  for (const v of coverList) {
    await downloadOne(v, COVER_DIR, "翻唱", "cover");
  }

  console.log("\n✅ 全部完成！");
  console.log(`   原创曲: ${ORIGINAL_DIR}`);
  console.log(`   翻唱: ${COVER_DIR}`);
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
