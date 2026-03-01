#!/usr/bin/env node
/**
 * 对比 B 站合集与本地 taffy-music 目录，找出未包含的视频
 * 用法: node scripts/check-playlist.js
 */

const path = require("path");
const fs = require("fs");

const PLAYLIST_URL =
  "https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?mid=1265680561&season_id=971439&page_num=1&page_size=100";
const OUTPUT_BASE = path.join(__dirname, "..", "taffy-music");
const ORIGINAL_DIR = path.join(OUTPUT_BASE, "原创曲");
const COVER_DIR = path.join(OUTPUT_BASE, "翻唱");

function getHeaders() {
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36",
    referer: "https://www.bilibili.com/",
    accept: "application/json, text/plain, */*",
  };
}

function extractBvidsFromLocal() {
  const dirs = [ORIGINAL_DIR, COVER_DIR];
  const bvids = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const walk = (d) => {
      const entries = fs.readdirSync(d, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(mp4|flv|mkv|webm)$/i.test(e.name)) {
          const m = e.name.match(/BV[\w]+/);
          if (m) bvids.add(m[0]);
        }
      }
    };
    walk(dir);
  }
  return bvids;
}

async function fetchPlaylist() {
  const res = await fetch(PLAYLIST_URL, { headers: getHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0 || !json.data?.archives) {
    throw new Error(json.message || "API 返回异常");
  }
  return json.data.archives;
}

async function main() {
  console.log("📋 对比合集「塔菲唱歌喵」与本地 taffy-music\n");

  const [playlist, localBvids] = await Promise.all([
    fetchPlaylist(),
    Promise.resolve(extractBvidsFromLocal()),
  ]);

  const playlistBvids = new Set(playlist.map((a) => a.bvid));
  const missing = playlist.filter((a) => !localBvids.has(a.bvid));
  const extra = [...localBvids].filter((b) => !playlistBvids.has(b));

  console.log(`合集视频数: ${playlist.length}`);
  console.log(`本地视频数: ${localBvids.size}\n`);

  if (missing.length > 0) {
    console.log("❌ 合集中有但本地未包含的视频：\n");
    missing.forEach((a, i) => {
      const view = (a.stat?.view || 0) / 10000;
      console.log(`  ${i + 1}. ${a.bvid}`);
      console.log(`      ${a.title}`);
      console.log(`      播放: ${view.toFixed(1)}万 | https://www.bilibili.com/video/${a.bvid}\n`);
    });
  } else {
    console.log("✅ 合集中的视频本地已全部包含。\n");
  }

  if (extra.length > 0) {
    console.log("📌 本地有但不在合集中的视频（可能是播放量筛选或分类差异）：\n");
    extra.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  }
}

main().catch((e) => {
  console.error("❌", e.message);
  process.exit(1);
});
