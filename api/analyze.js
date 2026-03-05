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

    const prompt = buildPrompt(choices);

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

    return res.status(200).json(parsed);
  } catch (err) {
    console.error('Unexpected error in /api/analyze', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

// 和前端 index.html 里保持一致的 prompt 构造与 system prompt
function buildPrompt(choices) {
  const lines = choices.map(c =>
    `- ${c.axis}：在「${c.round && c.round <= ROUNDS.length ? ROUNDS[c.round - 1].a.title : ''}」和「${c.round && c.round <= ROUNDS.length ? ROUNDS[c.round - 1].b.title : ''}」之间，选择了「${c.title}」by ${c.artist}`
  ).join('\n');
  return `用户在8次音乐对比中的选择如下：\n${lines}\n\n请分析这个人的音乐审美人格。`;
}

const SYSTEM_PROMPT = `你是一位资深音乐评论人和人格分析师。
根据用户在8次音乐对比中的选择，生成有温度、有洞察的音乐审美人格分析。
严格返回JSON，不要有任何其他文字：
{
  "type": "人格英文名（2-4个词，有创意，如 The Ghost）",
  "the": "The",
  "tagline": "一句诗意的中文短句，20字以内",
  "description": "两句中文性格描述，温暖且有洞察力，60字以内",
  "tags": ["标签1","标签2","标签3"],
  "artists": [["艺人名","genre"],["艺人名","genre"],["艺人名","genre"]],
  "axes": { "energy": 0到100, "mood": 0到100, "structure": 0到100 },
  "_key": "三位二进制字符串，如010，对应能量/色调/结构轴的0或1"
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

