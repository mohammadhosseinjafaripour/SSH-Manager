const fs = require('fs')
const path = require('path')

const readme = 'README.md'
const section = 'docs/_README_updates.md'

const lines = fs.readFileSync(readme, 'utf8').split('\n')
const block = fs.readFileSync(section, 'utf8').split('\n')

const anchor = lines.findIndex((l) => l.startsWith('## Staying connected'))
if (anchor === -1) {
  console.error('anchor "## Staying connected" not found')
  process.exit(1)
}

lines.splice(anchor, 0, ...block)
fs.writeFileSync(readme, lines.join('\n'))
fs.unlinkSync(section)
console.log('README updated at line', anchor + 1)
