// /api/analyze
// 服务器端调用 DeepSeek Chat API，根据前端传来的 choices 生成人格结果

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { choices } = req.body || {};

    if (!Array.isArray(choices) || choices.length === 0) {
      return res.status(400).json({ error: 'choices is required' });
    }

    const banned = buildBanned(choices);
    const prompt = buildPrompt(choices, banned);

    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'DEEPSEEK_API_KEY is not set' });
    }

    // 使用 DeepSeek 的 OpenAI 兼容接口路径 /v1/chat/completions
    const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ],
        stream: false,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error('DeepSeek API error:', response.status, text);
      // 把 DeepSeek 的错误信息也带回前端，方便排查
      return res.status(502).json({ error: 'DeepSeek API error', status: response.status, body: text });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;

    let parsed;
    try {
      parsed = typeof content === 'string' ? JSON.parse(content) : content;
    } catch (e) {
      console.error('Failed to parse DeepSeek JSON content', e, content);
    }

    if (!parsed) {
      return res.status(500).json({ error: 'Invalid DeepSeek response format' });
    }

    parsed = sanitizeResult(parsed, banned);
    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Unexpected error in /api/analyze', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

// 和前端 index.html 里保持一致的 prompt 构造与 system prompt
function normalizeText(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[“”‘’]/g, '"')
    .trim();
}

function buildBanned(choices) {
  // 1) 禁用歌名：后端 ROUNDS 里的所有 A/B title + 用户最终选择 title
  const titles = new Set();
  for (const r of ROUNDS) {
    if (r?.a?.title) titles.add(r.a.title);
    if (r?.b?.title) titles.add(r.b.title);
  }
  for (const c of choices || []) {
    if (c?.title) titles.add(c.title);
  }

  // 2) 禁用歌手：目前后端只能拿到“用户选到的 artist”
  // 若你想连“没选到的歌手”也禁掉，需要前端把每轮 a/b 的 artist 一并传来。
  const artists = new Set();
  for (const c of choices || []) {
    if (c?.artist) artists.add(c.artist);
  }

  // 预先做一份规范化版本，便于后处理替换
  const titlesNorm = new Set(Array.from(titles).map(normalizeText));
  const artistsNorm = new Set(Array.from(artists).map(normalizeText));

  return { titles, artists, titlesNorm, artistsNorm };
}

function stripBannedTerms(text, banned) {
  if (!text) return text;
  let out = text.toString();

  // 先替换歌名，再替换歌手
  for (const t of banned.titles) {
    if (!t) continue;
    const re = new RegExp(escapeRegExp(t), 'gi');
    out = out.replace(re, '（那首歌）');
  }
  for (const a of banned.artists) {
    if (!a) continue;
    const re = new RegExp(escapeRegExp(a), 'gi');
    out = out.replace(re, '（某位音乐人）');
  }
  return out;
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function uniqArtists(list) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const name = item?.[0];
    const key = normalizeText(name);
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

// 给一个安全的推荐池（不想太像网易云，也避免你题库里的人）
// 你可以自由替换成你更喜欢的“气质歌手库”
const SAFE_ARTIST_POOL = [
  ["Mogwai", "Post-Rock"],
  ["Godspeed You! Black Emperor", "Post-Rock"],
  ["Explosions in the Sky", "Cinematic Post-Rock"],
  ["Tim Hecker", "Ambient / Noise"],
  ["Grouper", "Ambient Folk"],
  ["Arca", "Experimental"],
  ["Run The Jewels", "Hip Hop"],
  ["IDLES", "Post-Punk"],
  ["Death Grips", "Experimental Hip Hop"],
  ["Jon Hopkins", "Electronic"],
  ["Caribou", "Electronic"],
  ["Floating Points", "Electronic / Jazz"]
];

function pickSafeArtists(banned, n = 3) {
  const picked = [];
  for (const [name, genre] of SAFE_ARTIST_POOL) {
    if (picked.length >= n) break;
    if (banned.artistsNorm.has(normalizeText(name))) continue;
    picked.push([name, genre]);
  }
  // 实在不够就用占位
  while (picked.length < n) picked.push(["Various Artists", "Mixed"]);
  return picked;
}

function sanitizeResult(result, banned) {
  const out = { ...result };

  out.tagline = stripBannedTerms(out.tagline, banned);
  out.description = stripBannedTerms(out.description, banned);

  // tags 也简单过一遍，避免出现禁词
  if (Array.isArray(out.tags)) {
    out.tags = out.tags.map(t => stripBannedTerms(t, banned));
  }

  // artists：去重 + 移除禁用歌手 + 不足则补齐
  if (!Array.isArray(out.artists)) out.artists = [];
  out.artists = uniqArtists(out.artists);

  out.artists = out.artists.filter(pair => {
    const name = pair?.[0];
    if (!name) return false;
    return !banned.artistsNorm.has(normalizeText(name));
  });

  if (out.artists.length < 3) {
    const fill = pickSafeArtists(banned, 3 - out.artists.length);
    out.artists = out.artists.concat(fill);
  } else {
    out.artists = out.artists.slice(0, 3);
  }

  return out;
}
function buildPrompt(choices, banned) {
  const lines = choices.map(c =>
    `- ${c.axis}：在「${c.round && c.round <= ROUNDS.length ? ROUNDS[c.round - 1].a.title : ''}」和「${c.round && c.round <= ROUNDS.length ? ROUNDS[c.round - 1].b.title : ''}」之间，选择了「${c.title}」by ${c.artist}`
  ).join('\n');

  return `
用户在8次音乐对比中的选择如下：
${lines}

【禁用歌手名单】（这些名字禁止出现在任何字段里，包括 artists/tagline/description）：
${Array.from(banned.artists).join('、') || '（无）'}

【禁用歌名名单】（这些歌名禁止出现在任何字段里，包括 artists/tagline/description）：
${Array.from(banned.titles).join('、') || '（无）'}

请严格按 system 规则输出 JSON。
`.trim();
}

const SYSTEM_PROMPT = `你是一位资深音乐评论人，也是写短诗的人。
根据用户的8次AB选择，生成“音乐审美人格画像”：更像一段轻盈的散文诗，而不是年度总结或报告。

硬性规则（必须遵守）：
1) 禁止在任何字段里提到【禁用歌手名单】与【禁用歌名名单】中的任何词（包括中英文、大小写变体、全角半角变体）。
2) artists 推荐名单里的艺人必须全部“未出现在禁用歌手名单”中。
3) 不要使用“年度总结/你今年/Top1/统计/次数/最爱”等总结话术；避免模板化“你是一个…”开头。

输出必须严格为 JSON（不要输出额外文字），结构如下：
{
  "type": "人格英文名（2-4词，像绰号）",
  "the": "The",
  "tagline": "一句中文短句，像标题，24字以内（不要出现歌手/歌名）",
  "description": "三段短文字（用换行分段）：①一句像诗的判断 ②一个具体生活场景 ③一句你如何用音乐与自己相处。总字数120-180。",
  "tags": ["4个英文tag，简短不空泛"],
  "artists": [["艺人名","genre"],["艺人名","genre"],["艺人名","genre"]],
  "axes": { "energy": 0到100, "mood": 0到100, "structure": 0到100 },
  "_key": "三位二进制字符串，如010"
}`;

// 用一个精简版的 ROUNDS 只用于 prompt 展示原始选项
const ROUNDS = [
  {
    a: { title:"安和桥" },
    b: { title:"HUMBLE." }
  },
  {
    a: { title:"奇妙能力歌" },
    b: { title:"杀死那个石家庄人" }
  },
  {
    a: { title:"Waltz for Debby" },
    b: { title:"Everything In Its Right Place" }
  },
  {
    a: { title:"Holocene" },
    b: { title:"Happen Ending" }
  },
  {
    a: { title:"夜信" },
    b: { title:"Hoppípolla" }
  },
  {
    a: { title:"春风十里" },
    b: { title:"Says" }
  },
  {
    a: { title:"没有理想的人不伤心" },
    b: { title:"Near Light" }
  },
  {
    a: { title:"So What" },
    b: { title:"instagram" }
  }
];

