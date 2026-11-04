// Spike server: serves the scene and saves frames posted by the sim camera.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const types = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript',
};

await mkdir('frames', { recursive: true });

http
  .createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/frame') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { id, dataUrl, pose } = JSON.parse(body);
      await writeFile(`frames/${id}.jpg`, Buffer.from(dataUrl.split(',')[1], 'base64'));
      await writeFile(`frames/${id}.json`, JSON.stringify(pose));
      res.writeHead(200).end('ok');
      return;
    }
    const file = req.url === '/' ? 'scene.html' : req.url.slice(1).split('?')[0];
    try {
      const data = await readFile(file);
      res
        .writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' })
        .end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  })
  .listen(5199, () => console.log('http://localhost:5199'));
