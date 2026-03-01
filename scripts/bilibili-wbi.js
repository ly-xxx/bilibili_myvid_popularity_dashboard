/**
 * B站 WBI 签名工具 - 用于 arc/search 等需要签名的 API
 */
const crypto = require("crypto");

const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.131 Safari/537.36 Edg/92.0.902.67",
];

const DEFAULT_HEADERS = {
  "user-agent": USER_AGENTS[0],
  referer: "https://www.bilibili.com/",
  accept: "application/json, text/plain, */*",
  "accept-language": "zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7",
};

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomStr(len, chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/** 生成模拟浏览器的 Cookie 字符串（不含 SESSDATA，用于降低风控） */
function buildBrowserCookies(sessdata = "") {
  const parts = [
    `buvid3=${randomStr(32)}_${randomStr(10)}infoc`,
    "innersign=0",
    `b_nut=${Math.floor(Date.now() / 1000)}`,
    "b_ut=5",
    `b_lsid=${randomStr(16)}`,
    "bsource=search_google",
    `_uuid=${randomStr(32)}infoc`,
    `buvid4=${randomStr(32)}-${randomStr(16)}-${randomStr(16)}-${randomStr(16)}`,
    `sid=${randomStr(8)}`,
  ];
  if (sessdata) parts.unshift(`SESSDATA=${sessdata}`);
  return parts.join("; ");
}

/** 获取带随机 UA 和模拟 Cookie 的请求头 */
function getRequestHeaders(sessdata = "", referer = "https://www.bilibili.com/") {
  const cookie = buildBrowserCookies(sessdata);
  return {
    ...DEFAULT_HEADERS,
    "user-agent": randomChoice(USER_AGENTS),
    referer,
    cookie,
  };
}

let wbiKeysCache = null;
let wbiKeysAt = 0;

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

async function getWbiKeys(extraHeaders = {}) {
  const now = Date.now();
  if (wbiKeysCache && now - wbiKeysAt < 10 * 60 * 1000) {
    return wbiKeysCache;
  }
  const navUrl = "https://api.bilibili.com/x/web-interface/nav";
  const headers = getRequestHeaders("", "https://www.bilibili.com/");
  if (extraHeaders.cookie) headers.cookie = (headers.cookie || "") + "; " + extraHeaders.cookie;
  const res = await fetch(navUrl, { headers });
  if (!res.ok) throw new Error(`nav http ${res.status}`);
  const data = await res.json();
  const imgUrl = data?.data?.wbi_img?.img_url;
  const subUrl = data?.data?.wbi_img?.sub_url;
  const imgKey = extractWbiKeyPart(imgUrl);
  const subKey = extractWbiKeyPart(subUrl);
  if (!imgKey || !subKey) throw new Error("wbi keys not found");
  wbiKeysCache = { imgKey, subKey };
  wbiKeysAt = now;
  return wbiKeysCache;
}

async function buildSignedWbiQuery(params, extraHeaders = {}) {
  const { imgKey, subKey } = await getWbiKeys(extraHeaders);
  const mixinKey = getMixinKey(imgKey, subKey);
  const query = { ...params, wts: Math.floor(Date.now() / 1000) };
  const ordered = Object.keys(query)
    .sort()
    .map((key) => `${key}=${sanitizeWbiValue(String(query[key]))}`)
    .join("&");
  const wRid = md5(`${ordered}${mixinKey}`);
  return `${ordered}&w_rid=${wRid}`;
}

function parseBiliNumber(value) {
  if (typeof value === "number") return value;
  let raw = String(value || "").trim();
  if (!raw || raw === "--") return 0;
  raw = raw.replace(/万\+?$/, "万").replace(/亿\+?$/, "亿");
  if (raw.endsWith("万")) {
    const base = Number(raw.slice(0, -1));
    return Number.isFinite(base) ? Math.round(base * 10000) : 0;
  }
  if (raw.endsWith("亿")) {
    const base = Number(raw.slice(0, -1));
    return Number.isFinite(base) ? Math.round(base * 100000000) : 0;
  }
  const numMatch = raw.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) {
    const parsed = Number(numMatch[1]);
    if (Number.isFinite(parsed)) return Math.floor(parsed);
  }
  const parsed = Number(raw.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

module.exports = {
  buildSignedWbiQuery,
  parseBiliNumber,
  DEFAULT_HEADERS,
  getRequestHeaders,
  USER_AGENTS,
};
