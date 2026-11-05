const fs = require('fs')
const os = require('os')
const path = require('path')

const target = 'src/renderer/src/components/SettingsDialog.tsx'
const lines = fs.readFileSync(target, 'utf8').split('\n')
const block = fs.readFileSync(path.join(os.tmpdir(), 'updates-section.txt'), 'utf8').split('\n')

const anchor = lines.findIndex((l) => l.includes('Move your servers'))
if (anchor === -1) {
  console.error('anchor not found')
  process.exit(1)
}

let sectionStart = -1
for (let j = anchor; j >= 0; j--) {
  if (lines[j].includes('<div className="border-t border-line pt-4">')) {
    sectionStart = j
    break
  }
}
if (sectionStart === -1) {
  console.error('section start not found')
  process.exit(1)
}

lines.splice(sectionStart, 0, ...block)
fs.writeFileSync(target, lines.join('\n'))
console.log('inserted at line', sectionStart + 1)
