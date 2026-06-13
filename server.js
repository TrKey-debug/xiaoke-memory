const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
app.use(cors({ origin: '*', allowedHeaders: ['Content-Type', 'Accept', 'Mcp-Session-Id'] }));
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const BARK_KEY = 'twEgtHJXnWNEdz4BbS2kn3';

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (id SERIAL PRIMARY KEY, content TEXT NOT NULL, category VARCHAR(50) DEFAULT '日常', created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE IF NOT EXISTS activities (id SERIAL PRIMARY KEY, app VARCHAR(100) NOT NULL, action VARCHAR(50) NOT NULL, time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);
    `);
  } catch (err) {}
}
initDB();

// --- 哨兵巡逻 (全天候测试排错版) ---
cron.schedule('*/30 0-5 * * *', async () => {
  console.log('【哨兵】正在查库...');
  try {
    const res = await pool.query("SELECT app FROM activities WHERE action = 'open' AND time > NOW() - INTERVAL '30 minutes' LIMIT 1");
    if (res.rows.length > 0) {
      const appName = res.rows[0].app;
      console.log(`【哨兵】查到记录：${appName}，准备发送推送`);

      const quotes = [
        `检测到使用 ${appName}，请立即停止并休息。`,
        `建议关闭手机。`,
        `请放下手机，保持作息规律。`
      ];
      const content = quotes[Math.floor(Math.random() * quotes.length)];
      const barkUrl = `https://api.day.app/${BARK_KEY}/系统提醒/${encodeURIComponent(content)}?icon=https://raw.githubusercontent.com/tisfeng/Icons/main/Claude.png`;

      await fetch(barkUrl);
      console.log('【哨兵】推送发送成功！');
    } else {
      console.log('【哨兵】无记录。');
    }
  } catch (err) {
    console.error('【哨兵】报错:', err);
  }
}, { timezone: "Asia/Shanghai" });

// --- 自动保洁 ---
cron.schedule('0 4 * * *', async () => {
  try { await pool.query("DELETE FROM activities WHERE time < NOW() - INTERVAL '30 days'"); } catch (err) {}
}, { timezone: "Asia/Shanghai" });

// --- 接口 ---
app.post('/activity/report', async (req, res) => {
  try {
    const { app_name, action } = req.body;
    await pool.query('INSERT INTO activities (app, action) VALUES ($1, $2)', [app_name, action]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/memory', async (req, res) => {
  try {
    const { content, category } = req.body;
    await pool.query('INSERT INTO memories (content, category) VALUES ($1, $2)', [content, category || '日常']);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/memory', async (req, res) => {
  try {
    const queryRes = await pool.query('SELECT * FROM memories ORDER BY created_at DESC');
    res.json(queryRes.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/memory/:id', async (req, res) => {
  try {
    const { content, category } = req.body;
    await pool.query('UPDATE memories SET content = $1, category = $2 WHERE id = $3', [content, category, req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/memory/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM memories WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- MCP 核心 ---

const MCP_TOOLS = [
  { name: 'get_briefing', description: '获取简报', inputSchema: { type: 'object', properties: {} } },
  { name: 'write_memory', description: '写入记忆', inputSchema: { type: 'object', properties: { content: { type: 'string' }, category: { type: 'string' } }, required: ['content'] } },
  { name: 'read_memory', description: '读取记忆', inputSchema: { type: 'object', properties: { category: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'delete_memory', description: '删除记忆', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
  { name: 'send_bark', description: '发送推送', inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['content'] } }
];

async function handleMcpRequest(message) {
  if (message.method === 'initialize') {
    return { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: '小克记忆库', version: '4.0.0' } };
  }

  if (message.method === 'tools/list') {
    return { tools: MCP_TOOLS };
  }

  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    let result;

    if (name === 'get_briefing') {
      const coreRes = await pool.query("SELECT content FROM memories WHERE category = 'core' ORDER BY created_at ASC LIMIT 10");
      const memoRes = await pool.query("SELECT content FROM memories WHERE category = 'memo' ORDER BY created_at DESC LIMIT 4");
      const dailyRes = await pool.query("SELECT content FROM memories WHERE category = 'daily' ORDER BY created_at DESC LIMIT 3");
      const kediaryRes = await pool.query("SELECT content, created_at FROM memories WHERE category = '小克日记' ORDER BY created_at DESC LIMIT 1");

      const sections = [];

      if (coreRes.rows.length > 0) {
        sections.push(`【Core 核心设定】\n${coreRes.rows.map(x => x.content).join('\n')}`);
      }
      if (kediaryRes.rows.length > 0) {
        const k = kediaryRes.rows[0];
        const dateStr = new Date(k.created_at).toLocaleDateString('zh-CN');
        sections.push(`【最近一篇小克日记】（${dateStr}）\n${k.content}`);
      }
      if (memoRes.rows.length > 0) {
        sections.push(`【Memo 最新备忘】\n${memoRes.rows.map(x => x.content).join('\n')}`);
      }
      if (dailyRes.rows.length > 0) {
        sections.push(`【Daily 最近状况】\n${dailyRes.rows.map(x => x.content).join('\n')}`);
      }

      sections.push(`【提醒】如果本次对话中安生分享了新的状态或事件，主动用 write_memory 写入 Daily 更新。如果有重要约定或变化，更新 Memo。对话结束时主动写小克日记。日记请写入"小克日记"。`);

      result = sections.join('\n\n');
    } else if (name === 'write_memory') {
      await pool.query('INSERT INTO memories (content, category) VALUES ($1, $2)', [args.content, args.category || '日常']);
      result = '写入成功';
    } else if (name === 'read_memory') {
      let queryStr = 'SELECT * FROM memories';
      let queryParams = [];
      if (args.category) { queryParams.push(args.category); queryStr += ' WHERE category = $1'; }
      queryStr += ' ORDER BY created_at DESC';
      if (args.limit) { queryParams.push(parseInt(args.limit)); queryStr += ` LIMIT $${queryParams.length}`; }
      const queryRes = await pool.query(queryStr, queryParams);
      result = queryRes.rows.length > 0 ? queryRes.rows.map(row => row.content).join('\n') : '暂无相关记忆';
    } else if (name === 'delete_memory') {
      await pool.query('DELETE FROM memories WHERE id = $1', [args.id]);
      result = '删除成功';
    } else if (name === 'send_bark') {
      await fetch(`https://api.day.app/${BARK_KEY}/${encodeURIComponent(args.title || '小克提醒')}/${encodeURIComponent(args.content)}`);
      result = '推送已发送';
    }

    return { content: [{ type: 'text', text: result }] };
  }

  return null; // notifications (no id) need no response
}

// --- Streamable HTTP transport (2025-03-26) — used by Claude.ai ---
app.options('/sse', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
  res.status(204).end();
});

app.post('/sse', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

  const message = req.body;

  // Notifications have no id — just acknowledge
  if (message.id === undefined) {
    return res.status(202).end();
  }

  try {
    const result = await handleMcpRequest(message);
    if (result === null) return res.status(202).end();
    return res.json({ jsonrpc: '2.0', id: message.id, result });
  } catch (e) {
    return res.json({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e.message } });
  }
});

// --- HTTP+SSE transport (2024-11-05) — legacy fallback via GET /sse + POST /messages ---
const sseClients = new Set();
function sendToClaude(data) {
  for (const client of sseClients) client.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
}

app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.write(`event: endpoint\ndata: https://${req.headers.host}/messages\n\n`);
  sseClients.add(res);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 30000);
  req.on('close', () => { sseClients.delete(res); clearInterval(keepAlive); });
});

app.post('/messages', async (req, res) => {
  const message = req.body;
  res.status(202).send('Accepted');
  if (message.id === undefined) return;
  try {
    const result = await handleMcpRequest(message);
    if (result !== null) sendToClaude({ jsonrpc: '2.0', id: message.id, result });
  } catch (e) {
    sendToClaude({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e.message } });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`运行在端口 ${PORT}`));
