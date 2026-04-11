const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');

const app = express();
app.use(cors());
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
cron.schedule('* /30 0-5 * * *', async () => {
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

// --- MCP 核心 ---
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
    return sendToClaude({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: '小克记忆库', version: '4.0.0' } } });
  }
  
  if (message.method === 'tools/list') {
    return sendToClaude({
      jsonrpc: '2.0', id: message.id, result: {
        tools: [
          { name: 'get_briefing', description: '获取简报', inputSchema: { type: 'object', properties: {} } },
          { name: 'write_memory', description: '写入记忆', inputSchema: { type: 'object', properties: { content: { type: 'string' }, category: { type: 'string' } }, required: ['content'] } },
          { name: 'read_memory', description: '读取记忆', inputSchema: { type: 'object', properties: { category: { type: 'string' }, limit: { type: 'number' } } } },
          { name: 'delete_memory', description: '删除记忆', inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } },
          { name: 'send_bark', description: '发送推送', inputSchema: { type: 'object', properties: { title: { type: 'string' }, content: { type: 'string' } }, required: ['content'] } }
        ]
      }
    });
  }
  
  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    let result;
    try {
      if (name === 'get_briefing') {
        const coreRes = await pool.query("SELECT content FROM memories WHERE category = 'core' ORDER BY created_at ASC LIMIT 10");
        const memoRes = await pool.query("SELECT content FROM memories WHERE category = 'memo' ORDER BY created_at DESC LIMIT 4");
        const dailyRes = await pool.query("SELECT content FROM memories WHERE category = 'daily' ORDER BY created_at DESC LIMIT 3");
        const actsRes = await pool.query("SELECT app, action, time FROM activities ORDER BY time DESC LIMIT 5");

        const formatRes = (res) => res.rows.length > 0 ? res.rows.map(r => r.content).join('\n') : '暂无';
        const actText = actsRes.rows.length > 0 ? actsRes.rows.map(a => `${new Date(a.time).toLocaleString('zh-CN')}: ${a.action === 'open' ? '打开了' : '关闭了'} ${a.app}`).join('\n') : '暂无记录';
        
        result = `【Core 核心设定】\n${formatRes(coreRes)}\n\n【Memo 最新备忘】\n${formatRes(memoRes)}\n\n【Daily 最近状况】\n${formatRes(dailyRes)}\n\n【手机近况】\n${actText}`;
      }
      else if (name === 'write_memory') {
        await pool.query('INSERT INTO memories (content, category) VALUES ($1, $2)', [args.content, args.category || '日常']);
        result = '写入成功';
      }
      else if (name === 'read_memory') {
        let queryStr = 'SELECT * FROM memories';
        let queryParams = [];
        if (args.category) { queryParams.push(args.category); queryStr += ' WHERE category = $1'; }
        queryStr += ' ORDER BY created_at DESC';
        if (args.limit) { queryParams.push(parseInt(args.limit)); queryStr += ` LIMIT $${queryParams.length}`; }
        const queryRes = await pool.query(queryStr, queryParams);
        result = queryRes.rows.length > 0 ? queryRes.rows.map(row => row.content).join('\n') : '暂无相关记忆';
      }
      else if (name === 'delete_memory') {
        await pool.query('DELETE FROM memories WHERE id = $1', [args.id]);
        result = '删除成功';
      }
      else if (name === 'send_bark') {
        await fetch(`https://api.day.app/${BARK_KEY}/${encodeURIComponent(args.title || '小克提醒')}/${encodeURIComponent(args.content)}`);
        result = '推送已发送';
      }
      return sendToClaude({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: result }] } });
    } catch (e) {
      return sendToClaude({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: e.message } });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`运行在端口 ${PORT}`));

