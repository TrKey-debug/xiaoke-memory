const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const MEMORY_FILE = path.join('/tmp', 'memories.json');
const ACTIVITY_FILE = path.join('/tmp', 'activity.json');

function loadData(file) {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveData(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// SSE clients
const sseClients = new Set();

// MCP SSE endpoint
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Send endpoint info
  res.write(`event: endpoint\ndata: ${JSON.stringify({
    uri: '/messages'
  })}\n\n`);
  
  sseClients.add(res);
  
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// MCP messages endpoint
app.post('/messages', async (req, res) => {
  const message = req.body;
  
  if (message.method === 'initialize') {
    return res.json({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: '小克记忆库', version: '1.0.0' }
      }
    });
  }
  
  if (message.method === 'tools/list') {
    return res.json({
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
            name: 'send_bark',
            description: '发送推送通知到安生的手机',
            inputSchema: {
              type: 'object',
              properties: {
                key: { type: 'string', description: 'Bark Key' },
                title: { type: 'string', description: '通知标题' },
                content: { type: 'string', description: '通知内容' }
              },
              required: ['key', 'title', 'content']
            }
          },
          {
            name: 'read_activity',
            description: '读取今日手机使用记录',
            inputSchema: {
              type: 'object',
              properties: {}
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
        const memories = loadData(MEMORY_FILE);
        const entry = {
          id: Date.now(),
          content: args.content,
          category: args.category || '日常',
          created_at: new Date().toISOString()
        };
        memories.push(entry);
        saveData(MEMORY_FILE, memories);
        result = { success: true, entry };
      }
      else if (name === 'read_memory') {
        const memories = loadData(MEMORY_FILE);
        let data = memories;
        if (args.category) data = data.filter(m => m.category === args.category);
        if (args.limit) data = data.slice(-parseInt(args.limit));
        result = data;
      }
      else if (name === 'delete_memory') {
        let memories = loadData(MEMORY_FILE);
        memories = memories.filter(m => m.id !== args.id);
        saveData(MEMORY_FILE, memories);
        result = { success: true };
      }
      else if (name === 'send_bark') {
        const url = `https://api.day.app/${args.key}/${encodeURIComponent(args.title)}/${encodeURIComponent(args.content)}`;
        const response = await fetch(url);
        result = await response.json();
      }
      else if (name === 'read_activity') {
        const activities = loadData(ACTIVITY_FILE);
        const today = new Date().toDateString();
        result = activities.filter(a => new Date(a.time).toDateString() === today);
      }
      
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(result) }]
        }
      });
    } catch (e) {
      return res.json({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: e.message }
      });
    }
  }
  
  res.json({
    jsonrpc: '2.0',
    id: message.id,
    error: { code: -32601, message: 'Method not found' }
  });
});

// REST API endpoints
app.post('/memory', (req, res) => {
  const { content, category } = req.body;
  const memories = loadData(MEMORY_FILE);
  const entry = { id: Date.now(), content, category: category || '日常', created_at: new Date().toISOString() };
  memories.push(entry);
  saveData(MEMORY_FILE, memories);
  res.json({ success: true, entry });
});

app.get('/memory', (req, res) => {
  const memories = loadData(MEMORY_FILE);
  res.json(memories);
});

app.get('/activity/toggle/:app', (req, res) => {
  const appName = req.params.app;
  const activities = loadData(ACTIVITY_FILE);
  const last = activities.filter(a => a.app === appName).slice(-1)[0];
  const action = (!last || last.action === 'close') ? 'open' : 'close';
  const entry = { app: appName, action, time: new Date().toISOString() };
  activities.push(entry);
  saveData(ACTIVITY_FILE, activities.slice(-200));
  res.json({ success: true, entry });
});
// OAuth endpoints for Claude MCP
app.post('/register', (req, res) => {
  res.json({
    client_id: 'xiaoke-memory-client',
    client_secret: 'xiaoke-memory-secret'
  });
});

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.json({
    resource: `https://xiaoke-memory-production.up.railway.app`,
    authorization_servers: [`https://xiaoke-memory-production.up.railway.app`]
  });
});

app.get('/.well-known/oauth-authorization-server', (req, res) => {
  res.json({
    issuer: `https://xiaoke-memory-production.up.railway.app`,
    authorization_endpoint: `https://xiaoke-memory-production.up.railway.app/authorize`,
    token_endpoint: `https://xiaoke-memory-production.up.railway.app/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code']
  });
});

app.get('/authorize', (req, res) => {
  const { redirect_uri, state } = req.query;
  res.redirect(`${redirect_uri}?code=xiaoke-auth-code&state=${state}`);
});

app.post('/token', (req, res) => {
  res.json({
    access_token: 'xiaoke-memory-token',
    token_type: 'bearer',
    expires_in: 86400
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`小克记忆库运行在端口 ${PORT}`);
});
