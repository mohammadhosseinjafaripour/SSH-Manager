/**
 * Tiny local static mirror used only to work around this network's stalling
 * of node-HTTPS downloads from GitHub/CDNs (curl works fine). electron-builder
 * fetches from here; files are staged into .local-mirror/ via curl.
 *   node scripts/local-mirror.mjs   → serves http://127.0.0.1:8123/
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, normalize } from 'node:path'

const ROOT = join(process.cwd(), '.local-mirror')
const PORT = 8123

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
  const file = join(ROOT, rel)
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    console.log(`[404] ${req.url}`)
    res.writeHead(404).end('not found')
    return
  }
  console.log(`[200] ${req.url} (${statSync(file).size} bytes)`)
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size })
  createReadStream(file).pipe(res)
})

server.listen(PORT, '127.0.0.1', () => console.log(`mirror serving ${ROOT} on http://127.0.0.1:${PORT}`))
