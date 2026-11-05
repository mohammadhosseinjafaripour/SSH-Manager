// Downloads beUI registry sources into .beui-src/ for vendoring.
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const outRoot = path.join(__dirname, '..', '.beui-src')
fs.mkdirSync(outRoot, { recursive: true })

for (const name of ['button', 'input', 'select']) {
  const jsonPath = path.join(outRoot, `${name}.json`)
  execFileSync('curl', ['-sL', '-m', '20', `https://beui.dev/r/${name}`, '-o', jsonPath])
  const j = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  for (const f of j.files) {
    if (f.path.includes('previews')) continue
    const fileName = path.basename(f.path)
    fs.writeFileSync(path.join(outRoot, fileName), f.content)
    console.log(`${name}: ${fileName} (${f.content.length} chars)`)
  }
}
console.log('done')
