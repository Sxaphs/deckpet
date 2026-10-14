// 本地 mock OpenAI 兼容服务：验证 openai-http driver 的 SSE 流式路径
import http from 'node:http';

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const words = ['你好', '，', '我是', ' mock ', '后端', '，', '切换', '成功', '！'];
      // 长回复模式：body 含 "long" 时输出超长文本，验证气泡折叠
      const wantLong = body.includes('long');
      const longText =
        '这是第一段要点：长回复会被折叠成精华版显示在气泡里。\n\n' +
        Array.from({ length: 12 }, (_, i) => `第 ${i + 2} 段：这里是补充细节内容，用来撑长整段文字以便触发折叠阈值与展开全部按钮。`).join('\n\n');
      const payload = wantLong ? longText : null;
      let i = 0;
      const timer = setInterval(() => {
        if (payload) {
          const chunkSize = 40;
          const pos = i * chunkSize;
          if (pos < payload.length) {
            res.write(
              `data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(pos, pos + chunkSize) } }] })}\n\n`,
            );
            i++;
            return;
          }
        } else if (i < words.length) {
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: words[i++] } }] })}\n\n`,
          );
          return;
        }
        res.write('data: [DONE]\n\n');
        clearInterval(timer);
        res.end();
      }, 30);
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(58931, '127.0.0.1', () => console.log('mock listening'));
setTimeout(() => process.exit(0), 60000);
