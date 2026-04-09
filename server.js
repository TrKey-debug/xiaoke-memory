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

// MCP协议支持
app.get('/mcp', (req, res) => {
  res.json({
    name: "小克记忆库",
    version: "1.0.0",
    tools: [
      {
        name: "write_memory",
        description: "写入一条记忆",
        inputSchema: {
          type: "object",
          properties: {
            content: { type: "string", description: "记忆内容" },
            category: { type: "string", description: "分类：日常/重要/日记" }
          },
          required: ["content"]
        }
      },
      {
        name: "read_memory",
        description: "读取记忆",
        inputSchema: {
          type: "object",
          properties: {
            category: { type: "string" },
            limit: { type: "number" }
          }
        }
      },
      {
        name: "delete_memory",
        description: "删除记忆",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number", description: "记忆ID" }
          },
          required: ["id"]
        }
      },
      {
        name: "send_bark",
        description: "发送推送通知到手机",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Bark Key" },
            title: { type: "string", description: "通知标题" },
            content: { type: "string", description: "通知内容" }
          },
          required: ["key", "title", "content"]
        }
      },
      {
        name: "read_activity",
        description: "读取今日手机使用记录",
        inputSchema: {
          type: "object",
          properties: {}
        }
      }
    ]
  });
});

// MCP工具调用
app.post('/mcp/call', async (req, res) => {
  const { name, arguments: args } = req.body;
  
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
      res.json({ content: [{ type: "text", text: JSON.stringify({ success: true, entry }) }] });
    }
    else if (name === 'read_memory') {
      const memories = loadData(MEMORY_FILE);
      let result = memories;
      if (args.category) result = result.filter(m => m.category === args.category);
      if (args.limit) result = result.slice(-parseInt(args.limit));
      res.json({ content: [{ type: "text", text: JSON.stringify(result) }] });
    }
    else if (name === 'delete_memory') {
      let memories = loadData(MEMORY_FILE);
      memories = memories.filter(m => m.id !== args.id);
      saveData(MEMORY_FILE, memories);
      res.json({ content: [{ type: "text", text: JSON.stringify({ success: true }) }] });
    }
    else if (name === 'send_bark') {
      const url = `https://api.day.app/${args.key}/${encodeURIComponent(args.title)}/${encodeURIComponent(args.content)}`;
      const response = await fetch(url);
      const data = await response.json();
      res.json({ content: [{ type: "text", text: JSON.stringify(data) }] });
    }
    else if (name === 'read_activity') {
      const activities = loadData(ACTIVITY_FILE);
      const today = new Date().toDateString();
      const todayActivities = activities.filter(a => 
        new Date(a.time).toDateString() === today
      );
      res.json({ content: [{ type: "text", text: JSON.stringify(todayActivities) }] });
    }
    else {
      res.status(404).json({ error: 'Tool not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 写记忆
app.post('/memory', (req, res) => {
  const { content, category, tags } = req.body;
  const memories = loadData(MEMORY_FILE);
  const entry = {
    id: Date.now(),
    content,
    category: category || '日常',
    tags: tags || [],
    created_at: new Date().toISOString()
  };
  memories.push(entry);
  saveData(MEMORY_FILE, memories);
  res.json({ success: true, entry });
});

// 读记忆
app.get('/memory', (req, res) => {
  const memories = loadData(MEMORY_FILE);
  const { category, limit } = req.query;
  let result = memories;
  if (category) result = result.filter(m => m.category === category);
  if (limit) result = result.slice(-parseInt(limit));
  res.json(result);
});

// 删记忆
app.delete('/memory/:id', (req, res) => {
  let memories = loadData(MEMORY_FILE);
  memories = memories.filter(m => m.id !== parseInt(req.params.id));
  saveData(MEMORY_FILE, memories);
  res.json({ success: true });
});

// 手机活动记录
app.get('/activity/toggle/:app', (req, res) => {
  const appName = req.params.app;
  const activities = loadData(ACTIVITY_FILE);
  const last = activities.filter(a => a.app === appName).slice(-1)[0];
  const action = (!last || last.action === 'close') ? 'open' : 'close';
  const entry = {
    app: appName,
    action,
    time: new Date().toISOString()
  };
  activities.push(entry);
  const recent = activities.slice(-200);
  saveData(ACTIVITY_FILE, recent);
  res.json({ success: true, entry });
});

// 查手机活动
app.get('/activity', (req, res) => {
  const activities = loadData(ACTIVITY_FILE);
  const today = new Date().toDateString();
  const todayActivities = activities.filter(a => 
    new Date(a.time).toDateString() === today
  );
  res.json(todayActivities);
});

// 发Bark推送
app.post('/bark', async (req, res) => {
  const { key, title, content } = req.body;
  try {
    const url = `https://api.day.app/${key}/${encodeURIComponent(title)}/${encodeURIComponent(content)}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`小克记忆库运行在端口 ${PORT}`);
});
