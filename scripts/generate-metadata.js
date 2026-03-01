#!/usr/bin/env node
/**
 * 为 taffy-music 目录下的每个视频生成 metadata.json
 *
 * metadata.json 包含：
 *   - 歌曲名：从 B 站视频标题/简介解析
 *   - 演唱者：从 B 站视频标题/简介解析
 *   - 歌词片段：需在网易云等平台查找后手动补充（脚本留空）
 *
 * 用法：
 *   node scripts/generate-metadata.js           # 为已有视频生成 metadata
 *   node scripts/generate-metadata.js --list   # 仅列出需补充歌词的歌名（便于在网易云搜索）
 */

const path = require("path");
const fs = require("fs");
const { getRequestHeaders } = require("./bilibili-wbi.js");
const { extractMusicMetadata, TAFFY_NAME } = require("./extract-music-metadata.js");

const OUTPUT_BASE = path.join(__dirname, "..", "taffy-music");
const ORIGINAL_DIR = path.join(OUTPUT_BASE, "原创曲");
const COVER_DIR = path.join(OUTPUT_BASE, "翻唱");
const BILI_COOKIE = process.env.BILI_COOKIE || "";

function getHeaders(referer = "https://www.bilibili.com/") {
  const h = getRequestHeaders("", referer);
  if (BILI_COOKIE) h.cookie = (h.cookie || "") + "; " + BILI_COOKIE;
  return h;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 下载 B 站视频封面到本地，返回本地文件名（失败返回空字符串） */
async function downloadCover(picUrl, savePath) {
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
}

/** 从文件名提取 BV 号，支持 日期_BV号.mp4 格式 */
function extractBvidFromFilename(name) {
  const m = name.match(/BV[\w]+/);
  return m ? m[0] : null;
}

/** 收集目录下所有视频文件及其 BV 号 */
function collectVideoFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir);
  const result = [];
  for (const f of files) {
    if (!/\.(mp4|flv|mkv|webm)$/i.test(f)) continue;
    const bvid = extractBvidFromFilename(f);
    if (bvid) result.push({ file: f, bvid, dir });
  }
  return result;
}

/** 调用 B 站 view API 获取视频详情（含 desc） */
async function fetchVideoDetail(bvid) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
  const headers = getHeaders(`https://www.bilibili.com/video/${bvid}`);
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code === 0 && json.data) {
      const d = json.data;
      return {
        bvid: d.bvid,
        title: d.title || "",
        desc: d.desc || "",
        pic: d.pic || "",
        tid: d.tid || 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 根据 tid 或标题判断类型 */
function getVideoType(detail) {
  const tid = Number(detail?.tid) || 0;
  const title = (detail?.title || "").toLowerCase();
  if (tid === 28 || /原创曲|原创|original/.test(title)) return "original";
  if (tid === 31 || /翻唱|cover/.test(title)) return "cover";
  return "cover"; // 默认
}

/** 生成 metadata.json 内容 */
function buildMetadata(detail, type, coverFile = "") {
  const { 歌曲名, 演唱者 } = extractMusicMetadata(
    detail.title,
    detail.desc,
    type
  );
  const meta = {
    歌曲名: 歌曲名 || "",
    演唱者: 演唱者 || "",
    歌词片段: "", // 需在网易云查找后手动补充
    _source: {
      bvid: detail.bvid,
      title: detail.title,
      desc: (detail.desc || "").slice(0, 200),
    },
  };
  if (coverFile) meta.封面 = coverFile;
  return meta;
}

async function main() {
  const listOnly = process.argv.includes("--list") || process.argv.includes("-l");

  console.log("🎵 为 taffy-music 视频生成 metadata.json\n");

  const all = [
    ...collectVideoFiles(ORIGINAL_DIR).map((x) => ({ ...x, type: "original" })),
    ...collectVideoFiles(COVER_DIR).map((x) => ({ ...x, type: "cover" })),
  ];

  if (all.length === 0) {
    console.log("⚠️ 未找到视频文件。请先运行 npm run download-taffy 下载视频。");
    process.exit(0);
  }

  console.log(`找到 ${all.length} 个视频文件\n`);

  if (listOnly) {
    console.log("【以下歌名可用于网易云搜索歌词】\n");
  }

  let success = 0;
  const songNames = [];

  for (const { file, bvid, dir, type } of all) {
    const baseName = path.basename(file, path.extname(file));
    const metaPath = path.join(dir, `${baseName}.metadata.json`);

    const detail = await fetchVideoDetail(bvid);
    if (!detail) {
      console.log(`  ⚠️ ${bvid} 获取详情失败，跳过`);
      await sleep(500);
      continue;
    }

    const videoType = getVideoType(detail);

    // 下载封面
    let coverFile = "";
    if (detail.pic && !listOnly) {
      const ext = /\.(jpg|jpeg|png|webp)$/i.test(detail.pic)
        ? detail.pic.match(/\.(jpg|jpeg|png|webp)$/i)[1].toLowerCase()
        : "jpg";
      const coverPath = path.join(dir, `${baseName}.${ext}`);
      coverFile = await downloadCover(detail.pic, coverPath);
      await sleep(200);
    }

    const meta = buildMetadata(detail, videoType, coverFile);
    meta._source.type = videoType;

    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
    success++;

    if (listOnly && meta.歌曲名) {
      songNames.push({ 歌曲名: meta.歌曲名, 演唱者: meta.演唱者, bvid });
    } else if (!listOnly) {
      const coverNote = coverFile ? ` | 封面: ${coverFile}` : "";
      console.log(`  ✅ ${bvid} | 歌曲: ${meta.歌曲名 || "-"} | 演唱: ${meta.演唱者 || "-"}${coverNote}`);
    }

    await sleep(400);
  }

  if (listOnly) {
    const seen = new Set();
    for (const { 歌曲名, 演唱者 } of songNames) {
      const key = `${歌曲名}|${演唱者}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  ${歌曲名}${演唱者 ? ` — ${演唱者}` : ""}`);
    }
    console.log("\n以上歌名可在网易云搜索，找到歌词后手动填入对应 .metadata.json 的「歌词片段」字段。");
  } else {
    console.log(`\n✅ 已为 ${success}/${all.length} 个视频生成 metadata.json`);
    console.log("   歌词片段需在网易云等平台查找后手动补充。");
    console.log("   运行 node scripts/generate-metadata.js --list 可列出全部歌名便于搜索。");
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
