const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  referer: "https://www.bilibili.com/",
};

const DEFAULT_BVIDS = ["BV1xx411c7mD", "BV1yy411c7mE"];
const DEFAULT_UP_MID = "291386365";
const upMid = String(process.env.UP_MID || DEFAULT_UP_MID).trim();
const configuredBvids = parseBvids(process.env.BVIDS);
const fallbackBvids = configuredBvids.length ? configuredBvids : DEFAULT_BVIDS;

const DEFAULT_CACHE_MS = Number(process.env.BILI_CACHE_MS || 30000);
const DEFAULT_THROTTLE_MS = Number(process.env.BILI_THROTTLE_MS || 3000);
const DEFAULT_CYCLE_SLEEP_MS = Number(process.env.BILI_CYCLE_SLEEP_MS || 15000);
const DEFAULT_VIDEOS_REFRESH_MS = Number(process.env.BILI_VIDEOS_REFRESH_MS || 600000);
const DEFAULT_MAX_VIDEOS = Number(process.env.BILI_MAX_VIDEOS || 20);
const DEFAULT_PLAY_REFRESH_MS = Number(process.env.BILI_PLAY_REFRESH_MS || 180000);
const HISTORY_DIR = path.join(__dirname, "data", "history");
const CATALOG_SNAPSHOT_FILE = path.join(__dirname, "data", "catalog-snapshot.json");
const HISTORY_HEADER = "timestamp,online,play\n";
const MAX_CACHE_POINTS = 4000;

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const cidCache = new Map();
const countCache = new Map();
const historyCache = new Map();
const lastPollAtCache = new Map();
const lastPlayPollAtCache = new Map();
let videoCatalog = new Map();
let activeVideoBvids = upMid ? [] : [...fallbackBvids];
let lastVideosRefreshAt = 0;
let wbiKeysCache = null;
let wbiKeysAt = 0;
const runtimeConfig = {
  upMid,
  maxVideos: DEFAULT_MAX_VIDEOS,
  cacheMs: DEFAULT_CACHE_MS,
  throttleMs: DEFAULT_THROTTLE_MS,
  cycleSleepMs: DEFAULT_CYCLE_SLEEP_MS,
  videosRefreshMs: DEFAULT_VIDEOS_REFRESH_MS,
  playRefreshMs: DEFAULT_PLAY_REFRESH_MS,
};

const state = {
  running: false,
  lastCycleAt: null,
  sourceMode: runtimeConfig.upMid ? "up_mid" : "bvid_list",
  lastCatalogError: null,
};

function parseBvids(envValue) {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function historyFilePath(bvid) {
  return path.join(HISTORY_DIR, `${bvid}.csv`);
}

async function ensureHistoryDir() {
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
}

async function saveCatalogSnapshot(mid, list) {
  try {
    await fsp.mkdir(path.dirname(CATALOG_SNAPSHOT_FILE), { recursive: true });
    await fsp.writeFile(
      CATALOG_SNAPSHOT_FILE,
      JSON.stringify({ mid, updatedAt: Date.now(), videos: list }, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error(`❌ 保存目录快照失败: ${error.message}`);
  }
}

async function loadCatalogSnapshot(mid) {
  try {
    if (!fs.existsSync(CATALOG_SNAPSHOT_FILE)) return [];
    const raw = await fsp.readFile(CATALOG_SNAPSHOT_FILE, "utf8");
    const json = JSON.parse(raw);
    if (String(json.mid || "") !== String(mid)) return [];
    const list = Array.isArray(json.videos) ? json.videos : [];
    return list.filter((v) => v && v.bvid);
  } catch (_error) {
    return [];
  }
}

async function appendHistoryCsv(bvid, timestamp, online, play) {
  if (!Number.isFinite(online) || !Number.isFinite(play)) return;
  const file = historyFilePath(bvid);
  if (!fs.existsSync(file)) {
    await fsp.writeFile(file, HISTORY_HEADER, "utf8");
  }
  await fsp.appendFile(file, `${timestamp},${online},${play}\n`, "utf8");
}

function cacheHistoryPoint(bvid, point) {
  const arr = historyCache.get(bvid) || [];
  arr.push(point);
  if (arr.length > MAX_CACHE_POINTS) {
    arr.splice(0, arr.length - MAX_CACHE_POINTS);
  }
  historyCache.set(bvid, arr);
}

async function recordHistoryPoint(bvid, timestamp, online, play) {
  cacheHistoryPoint(bvid, { timestamp, online, play });
  try {
    await appendHistoryCsv(bvid, timestamp, online, play);
  } catch (error) {
    console.error(`❌ 写入历史CSV失败 ${bvid}: ${error.message}`);
  }
}

function getHistoryFromCache(bvid, fromTs, toTs) {
  const arr = historyCache.get(bvid) || [];
  return arr.filter((p) => p.timestamp >= fromTs && p.timestamp <= toTs);
}

function downsampleHistory(points, target = 90) {
  if (points.length <= target) return points;
  const step = points.length / target;
  const out = [];
  for (let i = 0; i < target; i += 1) {
    out.push(points[Math.floor(i * step)]);
  }
  return out;
}

async function readHistoryFromCsv(bvid, fromTs, toTs) {
  const file = historyFilePath(bvid);
  if (!fs.existsSync(file)) return [];
  const raw = await fsp.readFile(file, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const points = [];
  for (let i = 1; i < lines.length; i += 1) {
    const [tsStr, onlineStr, playStr] = lines[i].split(",");
    const timestamp = Number(tsStr);
    const online = Number(onlineStr);
    const play = Number(playStr);
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp < fromTs || timestamp > toTs) continue;
    points.push({
      timestamp,
      online: Number.isFinite(online) ? online : 0,
      play: Number.isFinite(play) ? play : 0,
    });
  }
  return points;
}

function parseBiliNumber(value) {
  if (typeof value === "number") return value;
  let raw = String(value || "").trim();
  if (!raw || raw === "--") return 0;
  // 支持 "9.4万+"、"1人"、"1人在看" 等 B 站展示格式
  raw = raw.replace(/万\+?$/, "万").replace(/亿\+?$/, "亿");
  if (raw.endsWith("万")) {
    const base = Number(raw.slice(0, -1));
    return Number.isFinite(base) ? Math.round(base * 10000) : 0;
  }
  if (raw.endsWith("亿")) {
    const base = Number(raw.slice(0, -1));
    return Number.isFinite(base) ? Math.round(base * 100000000) : 0;
  }
  // 提取开头的数字（支持 "1人"、"28人在看" 等）
  const numMatch = raw.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) {
    const parsed = Number(numMatch[1]);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  const normalized = raw.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getAdaptivePollIntervalMs(onlineRaw) {
  // 降低轮询频率，避免请求过于频繁
  const online = Number(onlineRaw);
  if (!Number.isFinite(online)) return 90000;
  if (online >= 120) return 30000;
  if (online >= 80) return 35000;
  if (online >= 40) return 45000;
  if (online >= 15) return 55000;
  if (online >= 5) return 70000;
  return 90000;
}

function parsePositiveIntInRange(value, min, max) {
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function md5(input) {
  return crypto.createHash("md5").update(input).digest("hex");
}

function sanitizeWbiValue(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function getMixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return mixinKeyEncTab.map((idx) => raw[idx]).join("").slice(0, 32);
}

function extractWbiKeyPart(url) {
  const last = String(url || "").split("/").pop() || "";
  return last.split(".")[0];
}

async function getWbiKeys() {
  const now = Date.now();
  if (wbiKeysCache && now - wbiKeysAt < 10 * 60 * 1000) {
    return wbiKeysCache;
  }

  const navUrl = "https://api.bilibili.com/x/web-interface/nav";
  const res = await fetch(navUrl, { headers: DEFAULT_HEADERS });
  if (!res.ok) {
    throw new Error(`nav http ${res.status}`);
  }

  const data = await res.json();
  const imgUrl = data?.data?.wbi_img?.img_url;
  const subUrl = data?.data?.wbi_img?.sub_url;
  const imgKey = extractWbiKeyPart(imgUrl);
  const subKey = extractWbiKeyPart(subUrl);

  if (!imgKey || !subKey) {
    throw new Error("wbi keys not found");
  }

  wbiKeysCache = { imgKey, subKey };
  wbiKeysAt = now;
  return wbiKeysCache;
}

async function buildSignedWbiQuery(params) {
  const { imgKey, subKey } = await getWbiKeys();
  const mixinKey = getMixinKey(imgKey, subKey);
  const query = { ...params, wts: Math.floor(Date.now() / 1000) };
  const ordered = Object.keys(query)
    .sort()
    .map((key) => `${key}=${sanitizeWbiValue(String(query[key]))}`)
    .join("&");
  const wRid = md5(`${ordered}${mixinKey}`);
  return `${ordered}&w_rid=${wRid}`;
}

async function fetchRecentVideosByMid(mid, limit) {
  const signed = await buildSignedWbiQuery({
    mid,
    pn: 1,
    ps: limit,
    order: "pubdate",
  });
  const url = `https://api.bilibili.com/x/space/wbi/arc/search?${signed}`;
  const headers = { ...DEFAULT_HEADERS, referer: `https://space.bilibili.com/${mid}/video` };
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`arc/search http ${res.status}`);
  }

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`arc/search api code ${data.code}`);
  }

  const vlist = data?.data?.list?.vlist || [];
  return vlist.map((v) => ({
    bvid: v.bvid,
    title: v.title || `视频 ${v.bvid}`,
    cover: v.pic ? (v.pic.startsWith("http") ? v.pic : `https:${v.pic}`) : "",
    play: String(v.play ?? "--"),
    playNumber: parseBiliNumber(v.play),
  }));
}

function ensureFallbackCatalog() {
  if (videoCatalog.size > 0) return;
  fallbackBvids.forEach((bvid) => {
    videoCatalog.set(bvid, {
      bvid,
      title: `视频 ${bvid}`,
      cover: "",
      play: "--",
      playNumber: 0,
    });
  });
}

async function refreshVideoCatalogIfNeeded(force = false) {
  if (!runtimeConfig.upMid) {
    ensureFallbackCatalog();
    activeVideoBvids = [...fallbackBvids];
    return;
  }

  const now = Date.now();
  if (!force && now - lastVideosRefreshAt < runtimeConfig.videosRefreshMs && activeVideoBvids.length) {
    return;
  }

  const list = await fetchRecentVideosByMid(runtimeConfig.upMid, runtimeConfig.maxVideos);
  if (!list.length) {
    throw new Error("recent videos empty");
  }

  videoCatalog = new Map(list.map((item) => [item.bvid, item]));
  activeVideoBvids = list.map((item) => item.bvid);
  lastVideosRefreshAt = now;
  state.lastCatalogError = null;
  await saveCatalogSnapshot(runtimeConfig.upMid, list);
}

async function fetchCid(bvid) {
  const cached = cidCache.get(bvid);
  if (cached) return cached;

  const url = `https://api.bilibili.com/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`;
  const res = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!res.ok) {
    throw new Error(`pagelist http ${res.status}`);
  }

  const data = await res.json();
  if (data.code !== 0 || !data.data?.length) {
    throw new Error(`pagelist api code ${data.code}`);
  }

  const cid = data.data[0].cid;
  cidCache.set(bvid, cid);
  return cid;
}

async function fetchCount(bvid, cid) {
  const url = `https://api.bilibili.com/x/player/online/total?bvid=${encodeURIComponent(
    bvid
  )}&cid=${encodeURIComponent(cid)}`;
  const res = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!res.ok) {
    throw new Error(`online http ${res.status}`);
  }

  const data = await res.json();
  if (data.code !== 0 || !data.data) {
    throw new Error(`online api code ${data.code}`);
  }

  const total = data.data.total;
  const count = data.data.count;
  if (process.env.DEBUG_ONLINE === "1") {
    console.log(`[DEBUG] ${bvid} API raw: total=${JSON.stringify(total)} count=${JSON.stringify(count)}`);
  }

  // 仅使用 total（全端人数），与 B 站视频详情页显示的「正在看」一致
  // total 不可用时返回 null，由调用方复用缓存值，避免曲线突变
  if (total != null && String(total).trim()) {
    const parsed = parseBiliNumber(total);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (process.env.DEBUG_ONLINE === "1") {
    console.log(`[DEBUG] ${bvid} total 不可用，将复用缓存`);
  }
  return null;
}

async function fetchPlayCountByBvid(bvid) {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  const res = await fetch(url, { headers: DEFAULT_HEADERS });
  if (!res.ok) {
    throw new Error(`view http ${res.status}`);
  }
  const data = await res.json();
  if (data.code !== 0 || !data.data?.stat) {
    throw new Error(`view api code ${data.code}`);
  }
  const view = Number(data.data.stat.view);
  if (!Number.isFinite(view)) return 0;
  return view;
}

async function refreshOnce() {
  if (state.running) return;
  state.running = true;

  try {
    try {
      await refreshVideoCatalogIfNeeded();
    } catch (catalogError) {
      console.error(`❌ 拉取最近视频列表失败：${catalogError.message}`);
      state.lastCatalogError = catalogError.message;
      if (runtimeConfig.upMid) {
        if (!videoCatalog.size) {
          const snapshot = await loadCatalogSnapshot(runtimeConfig.upMid);
          if (snapshot.length) {
            videoCatalog = new Map(snapshot.map((item) => [item.bvid, item]));
          }
        }
        // Keep the last successful catalog if available; do not switch to demo BVIDs.
        activeVideoBvids = [...videoCatalog.keys()];
      } else {
        ensureFallbackCatalog();
        activeVideoBvids = [...fallbackBvids];
      }
    }

    for (const bvid of activeVideoBvids) {
      try {
        const now = Date.now();
        const lastPollAt = Number(lastPollAtCache.get(bvid) || 0);
        const lastOnline = Number(countCache.get(bvid)?.count || 0);
        const pollInterval = getAdaptivePollIntervalMs(lastOnline);
        if (lastPollAt && now - lastPollAt < pollInterval) {
          continue;
        }

        const cached = countCache.get(bvid);
        if (cached && now - cached.updatedAt < runtimeConfig.cacheMs) {
          continue;
        }

        const cid = await fetchCid(bvid);
        let count = await fetchCount(bvid, cid);
        // total 不可用时复用上次缓存值，避免曲线突变
        if (count == null || !Number.isFinite(Number(count))) {
          const prevCount = countCache.get(bvid)?.count;
          if (prevCount != null && Number.isFinite(Number(prevCount))) {
            count = prevCount;
          } else {
            count = 0;
          }
        }
        const numericCount = Number(count);
        let playNumber = videoCatalog.get(bvid)?.playNumber ?? 0;
        const nowForPlay = Date.now();
        const lastPlayPollAt = Number(lastPlayPollAtCache.get(bvid) || 0);
        if (!lastPlayPollAt || nowForPlay - lastPlayPollAt >= runtimeConfig.playRefreshMs) {
          try {
            const latestPlay = await fetchPlayCountByBvid(bvid);
            playNumber = latestPlay;
            const prevMeta = videoCatalog.get(bvid) || {
              bvid,
              title: `视频 ${bvid}`,
              cover: "",
              play: "--",
              playNumber: 0,
            };
            videoCatalog.set(bvid, {
              ...prevMeta,
              play: String(latestPlay),
              playNumber: latestPlay,
            });
          } catch (playError) {
            console.error(`❌ ${bvid} 播放量刷新失败：${playError.message}`);
          } finally {
            lastPlayPollAtCache.set(bvid, nowForPlay);
          }
        }
        countCache.set(bvid, {
          cid,
          count,
          updatedAt: Date.now(),
          source: "live",
        });
        lastPollAtCache.set(bvid, Date.now());
        await recordHistoryPoint(
          bvid,
          Date.now(),
          Number.isFinite(numericCount) ? numericCount : 0,
          Number.isFinite(playNumber) ? playNumber : 0
        );

        console.log(
          `[${new Date().toLocaleTimeString()}] ${bvid} 更新成功：${count} 人在看`
        );
      } catch (error) {
        const fallback = countCache.get(bvid);
        countCache.set(bvid, {
          cid: fallback?.cid ?? null,
          count: fallback?.count ?? "--",
          updatedAt: fallback?.updatedAt ?? null,
          source: "stale",
          error: error.message,
        });
        lastPollAtCache.set(bvid, Date.now());
        console.error(`❌ ${bvid} 更新失败：${error.message}`);
      }

      await sleep(runtimeConfig.throttleMs);
    }
  } finally {
    state.running = false;
    state.lastCycleAt = Date.now();
  }
}

async function pollingLoop() {
  while (true) {
    await refreshOnce();
    await sleep(runtimeConfig.cycleSleepMs);
  }
}

app.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: Date.now() });
});

// 调试：查看 countCache 当前状态，用于排查前后端数据不一致
app.get("/api/debug/count-cache", (req, res) => {
  const bvid = String(req.query.bvid || "").trim();
  const entries = [];
  for (const [k, v] of countCache) {
    if (!bvid || k === bvid) {
      entries.push({ bvid: k, ...v });
    }
  }
  res.json({ success: true, countCache: Object.fromEntries(countCache), entries });
});

app.get("/api/online-data", async (req, res) => {
  if (!activeVideoBvids.length) {
    try {
      await refreshVideoCatalogIfNeeded(true);
    } catch (err) {
      state.lastCatalogError = err.message;
      if (runtimeConfig.upMid) {
        if (!videoCatalog.size) {
          const snapshot = await loadCatalogSnapshot(runtimeConfig.upMid);
          if (snapshot.length) {
            videoCatalog = new Map(snapshot.map((item) => [item.bvid, item]));
          }
        }
        activeVideoBvids = [...videoCatalog.keys()];
      } else {
        ensureFallbackCatalog();
        activeVideoBvids = [...fallbackBvids];
      }
    }
  }

  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;

  const videos = await Promise.all(activeVideoBvids.map(async (bvid) => {
    const meta = videoCatalog.get(bvid) || {
      bvid,
      title: `视频 ${bvid}`,
      cover: "",
      play: "--",
      playNumber: 0,
    };
    const stat = countCache.get(bvid) || {
      cid: null,
      count: "--",
      updatedAt: null,
      source: "empty",
    };
    // Card sparkline data is loaded from persisted CSV to keep continuity across restarts.
    const historyFromCsv = await readHistoryFromCsv(bvid, oneHourAgo, now);
    // 显式使用 countCache 的 count，避免 meta 中任何字段覆盖（arc/search 等可能带额外字段）
    const onlineCount = stat.count;
    return {
      ...meta,
      cid: stat.cid,
      count: onlineCount,
      updatedAt: stat.updatedAt,
      source: stat.source,
      error: stat.error,
      history1h: downsampleHistory(historyFromCsv, 80),
    };
  }));

  const debugVideo = videos.find((v) => v.bvid === "BV1H3Aez9ESM");
  if (debugVideo && process.env.DEBUG_ONLINE === "1") {
    console.log(`[DEBUG] /api/online-data 返回 BV1H3Aez9ESM count=`, debugVideo.count);
  }
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.json({
    success: true,
    videos,
    config: {
      upMid: runtimeConfig.upMid || null,
      videoCount: videos.length,
      maxVideos: runtimeConfig.maxVideos,
      cacheMs: runtimeConfig.cacheMs,
      throttleMs: runtimeConfig.throttleMs,
      cycleSleepMs: runtimeConfig.cycleSleepMs,
      videosRefreshMs: runtimeConfig.videosRefreshMs,
      playRefreshMs: runtimeConfig.playRefreshMs,
    },
    state,
    timestamp: Date.now(),
  });
});

app.get("/api/history", async (req, res) => {
  const bvid = String(req.query.bvid || "").trim();
  const now = Date.now();
  const defaultFrom = now - 24 * 60 * 60 * 1000;
  const from = Number(req.query.from || defaultFrom);
  const to = Number(req.query.to || now);

  if (!bvid) {
    return res.status(400).json({ success: false, message: "缺少 bvid 参数" });
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ success: false, message: "时间范围无效" });
  }

  try {
    const points = await readHistoryFromCsv(bvid, from, to);
    const meta = videoCatalog.get(bvid) || {
      bvid,
      title: `视频 ${bvid}`,
      cover: "",
      play: "--",
      playNumber: 0,
    };
    return res.json({
      success: true,
      bvid,
      from,
      to,
      points,
      meta,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `读取历史失败: ${error.message}`,
    });
  }
});

app.get("/api/history/csv", async (req, res) => {
  const bvid = String(req.query.bvid || "").trim();
  const now = Date.now();
  const defaultFrom = now - 24 * 60 * 60 * 1000;
  const from = Number(req.query.from || defaultFrom);
  const to = Number(req.query.to || now);

  if (!bvid) {
    return res.status(400).json({ success: false, message: "缺少 bvid 参数" });
  }
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return res.status(400).json({ success: false, message: "时间范围无效" });
  }

  try {
    const points = await readHistoryFromCsv(bvid, from, to);
    const lines = ["timestamp,online,play"];
    for (const p of points) {
      lines.push(`${p.timestamp},${p.online},${p.play}`);
    }
    const csv = `${lines.join("\n")}\n`;
    const safeName = `${bvid}_${from}_${to}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    return res.status(200).send(csv);
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: `导出CSV失败: ${error.message}`,
    });
  }
});

app.get("/api/settings", (req, res) => {
  res.json({
    success: true,
    settings: {
      upMid: runtimeConfig.upMid || "",
      maxVideos: runtimeConfig.maxVideos,
      cacheMs: runtimeConfig.cacheMs,
      throttleMs: runtimeConfig.throttleMs,
      cycleSleepMs: runtimeConfig.cycleSleepMs,
      videosRefreshMs: runtimeConfig.videosRefreshMs,
      playRefreshMs: runtimeConfig.playRefreshMs,
    },
    defaults: {
      upMid: DEFAULT_UP_MID,
      maxVideos: DEFAULT_MAX_VIDEOS,
      cacheMs: DEFAULT_CACHE_MS,
      throttleMs: DEFAULT_THROTTLE_MS,
      cycleSleepMs: DEFAULT_CYCLE_SLEEP_MS,
      videosRefreshMs: DEFAULT_VIDEOS_REFRESH_MS,
      playRefreshMs: DEFAULT_PLAY_REFRESH_MS,
    },
  });
});

app.post("/api/settings", async (req, res) => {
  const midRaw = String(req.body?.upMid || "").trim();
  const maxRaw = Number(req.body?.maxVideos);
  const cacheMsRaw = parsePositiveIntInRange(req.body?.cacheMs, 1000, 120000);
  const throttleMsRaw = parsePositiveIntInRange(req.body?.throttleMs, 200, 10000);
  const cycleSleepMsRaw = parsePositiveIntInRange(req.body?.cycleSleepMs, 1000, 60000);
  const videosRefreshMsRaw = parsePositiveIntInRange(req.body?.videosRefreshMs, 10000, 86400000);
  const playRefreshMsRaw = parsePositiveIntInRange(req.body?.playRefreshMs, 10000, 3600000);

  if (!/^\d+$/.test(midRaw)) {
    return res.status(400).json({
      success: false,
      message: "UID 必须是纯数字",
    });
  }

  if (!Number.isInteger(maxRaw) || maxRaw < 1 || maxRaw > 100) {
    return res.status(400).json({
      success: false,
      message: "最近视频条数必须是 1-100 的整数",
    });
  }
  if (cacheMsRaw === null) {
    return res.status(400).json({ success: false, message: "数据缓存毫秒需在 1000-120000" });
  }
  if (throttleMsRaw === null) {
    return res.status(400).json({ success: false, message: "请求间隔毫秒需在 200-10000" });
  }
  if (cycleSleepMsRaw === null) {
    return res.status(400).json({ success: false, message: "轮询循环间隔毫秒需在 1000-60000" });
  }
  if (videosRefreshMsRaw === null) {
    return res.status(400).json({ success: false, message: "视频列表刷新毫秒需在 10000-86400000" });
  }
  if (playRefreshMsRaw === null) {
    return res.status(400).json({ success: false, message: "播放量刷新毫秒需在 10000-3600000" });
  }

  runtimeConfig.upMid = midRaw;
  runtimeConfig.maxVideos = maxRaw;
  runtimeConfig.cacheMs = cacheMsRaw;
  runtimeConfig.throttleMs = throttleMsRaw;
  runtimeConfig.cycleSleepMs = cycleSleepMsRaw;
  runtimeConfig.videosRefreshMs = videosRefreshMsRaw;
  runtimeConfig.playRefreshMs = playRefreshMsRaw;
  state.sourceMode = "up_mid";

  // Apply immediately in next cycle with a clean state.
  lastVideosRefreshAt = 0;
  videoCatalog = new Map();
  activeVideoBvids = [];
  cidCache.clear();
  countCache.clear();
  lastPollAtCache.clear();
  lastPlayPollAtCache.clear();
  state.lastCatalogError = null;

  return res.json({
    success: true,
    message: "设置已更新，下一轮抓取将按新配置执行",
    settings: {
      upMid: runtimeConfig.upMid,
      maxVideos: runtimeConfig.maxVideos,
      cacheMs: runtimeConfig.cacheMs,
      throttleMs: runtimeConfig.throttleMs,
      cycleSleepMs: runtimeConfig.cycleSleepMs,
      videosRefreshMs: runtimeConfig.videosRefreshMs,
      playRefreshMs: runtimeConfig.playRefreshMs,
    },
  });
});

app.get("/api/cover", async (req, res) => {
  const rawUrl = String(req.query.url || "").trim();
  if (!rawUrl) {
    return res.status(400).json({ success: false, message: "缺少 url 参数" });
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_err) {
    return res.status(400).json({ success: false, message: "封面 URL 无效" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ success: false, message: "仅支持 http/https 图片" });
  }

  try {
    const coverRes = await fetch(parsed.toString(), {
      headers: {
        ...DEFAULT_HEADERS,
        referer: "https://www.bilibili.com/",
      },
    });
    if (!coverRes.ok) {
      throw new Error(`cover http ${coverRes.status}`);
    }

    const contentType = coverRes.headers.get("content-type") || "image/jpeg";
    const arrayBuffer = await coverRes.arrayBuffer();
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.status(200).send(Buffer.from(arrayBuffer));
  } catch (error) {
    return res.status(502).json({
      success: false,
      message: `封面代理失败: ${error.message}`,
    });
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/taffy-music", express.static(path.join(__dirname, "taffy-music")));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ 本地服务已启动: http://localhost:${PORT}`);
  console.log(`📌 监控模式: ${runtimeConfig.upMid ? `UP_MID=${runtimeConfig.upMid}` : "BVIDS 列表"}`);
  console.log(`📌 当前监控上限: ${runtimeConfig.maxVideos} 条视频`);
  ensureHistoryDir()
    .then(() => pollingLoop())
    .catch((err) => {
      console.error("轮询异常退出：", err);
    });
});
