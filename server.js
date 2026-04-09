const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// 数据库连接池
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 自动初始化数据库表
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id SERIAL PRIMARY KEY,
        content TEXT NOT NULL,
        category VARCHAR(50) DEFAULT '日常',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS activities (
        id SERIAL PRIMARY KEY,
        app VARCHAR(100) NOT NULL,
        action VARCHAR(50) NOT NULL,
        time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('数据库表初始化成功！');
  } catch (err) {
    console.error('初始化数据库失败:', err);
  }
}
initDB();

app.get('/', (req, res) => {
  res.json({ status: 'ok', name: '小克记忆库(数据库版)', version: '2.0.0' });
});

const sseClients = new Set();

function sendToClaude(data) {
  for (const client of sseClients) {
    client.write(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const host = req.headers.host;
  res.write(`event: endpoint\ndata: https://${host}/messages\n\n`);
  
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.post('/messages', async (req, res) => {
  const message = req.body;
  res.status(202).send('Accepted');
  
  if (message.method === 'initialize') {
    return sendToClaude({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '小克记忆库', version: '2.0.0' }
      }
    });
  }
  
  if (message.method === 'tools/list') {
    return sendToClaude({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'write_memory',
            description: '写入一条记忆到小克记忆库',
            inputSchema: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '记忆内容' },
                category: { type: 'string', description: '分类：日常/重要/日记' }
              },
              required: ['content']
            }
          },
          {
            name: 'read_memory',
            description: '从小克记忆库读取记忆',
            inputSchema: {
              type: 'object',
              properties: {
                category: { type: 'string', description: '按分类筛选' },
                limit: { type: 'number', description: '返回条数' }
              }
            }
          },
          {
            name: 'delete_memory',
            description: '删除一条记忆',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'number', description: '记忆ID' }
              },
              required: ['id']
            }
          },
          {
            name: 'read_activity',
            description: '读取手机使用记录',
            inputSchema: {
              type: 'object',
              properties: {
                 limit: { type: 'number', description: '返回最近几条记录，默认20' }
              }
            }
          }
        ]
      }
    });
  }
  
  if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    let result;
    
    try {
      if (name === 'write_memory') {
        const cat = args.category || '日常';
        const queryRes = await pool.query(
          'INSERT INTO memories (content, category) VALUES ($1, $2) RETURNING *',
          [args.content, cat]
        );
        result = { success: true, entry: queryRes.rows[0] };
      }
      else if (name === 'read_memory') {
        let queryStr = 'SELECT * FROM memories';
        let queryParams = [];
        let conditions = [];

        if (args.category) {
          queryParams.push(args.category);
          conditions.push(`category = $${queryParams.length}`);
        }
        
        if (conditions.length > 0) {
          queryStr += ' WHERE ' + conditions.join(' AND ');
        }
        
        queryStr += ' ORDER BY created_at DESC';
        
        if (args.limit) {
          queryParams.push(parseInt(args.limit));
          queryStr += ` LIMIT $${queryParams.length}`;
        }

        const queryRes = await pool.query(queryStr, queryParams);
        
        // 🔥 核心瘦身：纯文本返回，丢掉大括号和时间戳
        const texts = queryRes.rows.map(row => row.content);
        result = texts.length > 0 ? texts.join('\n') : '暂无相关记忆';
      }
      else if (name === 'delete_memory') {
        await pool.query('DELETE FROM memories WHERE id = $1', [args.id]);
        result = { success: true };
      }
      else if (name === 'read_activity') {
        const limit = args.limit || 20;
        const queryRes = await pool.query('SELECT * FROM activities ORDER BY time DESC LIMIT $1', [limit]);
        result = queryRes.rows;
      }
      
      return sendToClaude({
        jsonrpc: '2.0',
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] }
      });
    } catch (e) {
      console.error("Tool execution error:", e);
      return sendToClaude({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: '数据库操作失败: ' + e.message }
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`小克记忆库(数据库版)运行在端口 ${PORT}`);
});

