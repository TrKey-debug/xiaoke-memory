module.exports = {
  apps: [{
    name: 'xiaoke-memory',
    script: 'server.js',
    env: {
      PORT: 3001,
      DATABASE_URL: 'postgresql://xiaoke_user:Gl080204@localhost:5432/xiaoke'
    }
  }]
};
