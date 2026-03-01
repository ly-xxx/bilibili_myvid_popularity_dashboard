/**
 * 从 B 站视频标题和简介中提取核心音乐信息
 * 用于生成 metadata.json：歌曲名、演唱者、歌词片段
 *
 * 歌词需在网易云等平台查找后手动补充，本脚本仅提取歌曲名和演唱者
 */

const TAFFY_NAME = "永雏塔菲";

/**
 * 从标题和简介提取 歌曲名、演唱者
 * @param {string} title - 视频标题
 * @param {string} desc - 视频简介
 * @param {string} type - "original" | "cover"
 * @returns {{ 歌曲名: string, 演唱者: string }}
 */
function extractMusicMetadata(title, desc, type) {
  let 歌曲名 = "";
  let 演唱者 = "";

  const t = (title || "").trim();
  const d = (desc || "").trim();

  // 1. 翻唱：XXX cover by 永雏塔菲 / XXX Cover 永雏塔菲
  const coverByMatch = t.match(
    /^(.+?)\s+(?:cover\s+by|Cover\s+by|cover\s*by)\s+(.+)$/i
  );
  if (coverByMatch) {
    歌曲名 = coverByMatch[1].trim();
    演唱者 = coverByMatch[2].trim();
    return { 歌曲名, 演唱者 };
  }

  const coverMatch = t.match(/^(.+?)\s+cover\s+(.+)$/i);
  if (coverMatch) {
    歌曲名 = coverMatch[1].trim();
    演唱者 = coverMatch[2].trim();
    return { 歌曲名, 演唱者 };
  }

  // 2. 原创曲：【塔菲原创曲】亲密孤单症候群 / 【原创曲】xxx
  const bracketMatch = t.match(/【[^】]*】(.+)$/);
  if (bracketMatch) {
    歌曲名 = bracketMatch[1].trim();
    演唱者 = TAFFY_NAME; // 原创曲默认演唱者为塔菲
    return { 歌曲名, 演唱者 };
  }

  // 3. 从简介提取：原曲：xxx / 原唱：xxx / 演唱：xxx
  const descPatterns = [
    /原曲[：:]\s*(.+?)(?:\n|$)/,
    /原唱[：:]\s*(.+?)(?:\n|$)/,
    /演唱[：:]\s*(.+?)(?:\n|$)/,
    /歌名[：:]\s*(.+?)(?:\n|$)/,
    /曲名[：:]\s*(.+?)(?:\n|$)/,
  ];
  for (const p of descPatterns) {
    const m = d.match(p);
    if (m) {
      if (!歌曲名 && (p.source.includes("原曲") || p.source.includes("歌名") || p.source.includes("曲名"))) {
        歌曲名 = m[1].trim();
      }
      if (!演唱者 && (p.source.includes("原唱") || p.source.includes("演唱"))) {
        演唱者 = m[1].trim();
      }
    }
  }

  // 4. 若仍无歌曲名，用标题（去掉常见后缀）
  if (!歌曲名) {
    歌曲名 = t
      .replace(/\s*(?:cover|Cover|翻唱|原创曲).*$/i, "")
      .replace(/^【[^】]*】\s*/, "")
      .trim() || t;
  }

  // 5. 翻唱类若无演唱者，默认为塔菲
  if (!演唱者 && (type === "cover" || /cover|翻唱/i.test(t))) {
    演唱者 = TAFFY_NAME;
  }

  return { 歌曲名, 演唱者 };
}

module.exports = { extractMusicMetadata, TAFFY_NAME };
