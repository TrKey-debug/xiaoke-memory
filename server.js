const express = require('express');
const { Pool } = require('pg');
const cron = require('node-cron');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// 🔑 你的专属 Key 已经写好啦
const BARK_KEY = 'twEgtHJXnWNEdz4BbS2kn3'; 

// 自动初始化数据库
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memories (id SERIAL PRIMARY KEY, content TEXT, category VARCHAR(50), created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS activities (id SERIAL PRIMARY KEY, app VARCHAR(100), action VARCHAR(50), time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP);
  `);
}
initDB();

// --- 哨兵巡逻 (克制冷静版) ---
cron.schedule('*/30 0-5 * * *', async () => {
  try {
    const res = await pool.query("SELECT app FROM activities WHERE action = 'open' AND time > NOW() - INTERVAL '30 minutes' LIMIT 1");
    if (res.rows.length > 0) {
      const appName = res.rows[0].app;
      const quotes = [
        `检测到凌晨使用 ${appName}，请立即停止并休息。`,
        `当前时间已超过预设睡眠时段，建议关闭手机。`,
        `睡眠监测：请放下手机，保持作息规律。`
      ];
      const content = quotes[Math.floor(Math.random() * quotes.length)];
      const barkUrl = `https://api.day.app/${BARK_KEY}/系统提醒/${encodeURIComponent(content)}?icon=https://raw.githubusercontent.com/tisfeng/Icons/main/Claude.png`;
      await fetch(barkUrl);
    }
  } catch (err) {}
});

// --- 给快捷指令用的接口 ---
app.post('/activity/report', async (req, res) => {
  const { app_name, action } = req.body;
  await pool.query('INSERT INTO activities (app, action) VALUES ($1, $2)', [app_name, action]);
  res.json({ success: true });
});

// --- 给网页用的接口 ---
app.get('/memory', async (req, res) => {
  const data = await pool.query('SELECT * FROM memories ORDER BY created_at DESC');
  res.json(data.rows);
});

app.post('/memory', async (req, res) => {
  await pool.query('INSERT INTO memories (content, category) VALUES ($1, $2)', [req.body.content, req.body.category]);
  res.json({ success: true });
});

// --- MCP 核心与工具 ---
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
  req.on('close', () => sseClients.delete(res));
});

app.post('/messages', async (req, res) => {
  const message = req.body;
  res.status(202).send('Accepted');
  
  if (message.method === 'initialize') {
    return sendToClaude({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '小克全能管家', version: '6.0.0' } } });
  }

  if (message.method === 'tools/list') {
    return sendToClaude({
      jsonrpc: '2.0', id: message.id, result: {
        tools: [
          { name: 'get_briefing', description: '获取核心记忆、备忘、以及手机使用记录', inputSchema: { type: 'object', properties: {} } },
          { name: 'write_memory', description: '写入记忆', inputSchema: { type: 'object', properties: { content: { type: 'string' }, category: { type: 'string' } }, required: ['content'] } },
          { name: 'send_bark', description: '给用户手机发推送', inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['content'] } }
        ]
      }
    });
  }

  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    try {
      if (name === 'get_briefing') {
        const core = await pool.query("SELECT content FROM memories WHERE category = 'core' LIMIT 5");
        const memo = await pool.query("SELECT content FROM memories WHERE category = 'memo' LIMIT 3");
        const acts = await pool.query("SELECT app, action, time FROM activities ORDER BY time DESC LIMIT 5");
        const actText = acts.rows.length > 0 ? acts.rows.map(a => `${a.time.toLocaleString()}: ${a.action === 'open' ? '打开了' : '关闭了'} ${a.app}`).join('\n') : '暂无记录';
        const result = `【核心设定】\n${core.rows.map(r=>r.content).join('\n')}\n\n【手机近况】\n${actText}\n\n【最新备忘】\n${memo.rows.map(r=>r.content).join('\n')}`;
        return sendToClaude({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: result }] } });
      }
      if (name === 'send_bark') {
        const url = `https://api.day.app/${BARK_KEY}/${encodeURIComponent(args.title || '小克提醒')}/${encodeURIComponent(args.content)}`;
        await fetch(url);
        return sendToClaude({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '推送已发送' }] } });
      }
      if (name === 'write_memory') {
        await pool.query('INSERT INTO memories (content, category) VALUES ($1, $2)', [args.content, args.category || '日常']);
        return sendToClaude({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: '记忆已存入' }] } });
      }
    } catch (e) {
      return sendToClaude({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e.message } });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`服务器已启动！`));

