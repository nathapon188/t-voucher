// Local development server: runs the same API code as the Netlify Function.
// Reads NETLIFY_DB_URL from .env.
import 'dotenv/config';
import express from 'express';
import { handleApi } from './api.js';

const app = express();
app.use(express.json());

app.all('/api/*', async (req, res) => {
  const request = new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers: { 'Content-Type': 'application/json' },
    body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {})
  });
  const response = await handleApi(request);
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(Buffer.from(await response.arrayBuffer()));
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));
