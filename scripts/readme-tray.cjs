const fs=require('fs')
const p='README.md'
let s=fs.readFileSync(p,'utf8')
const anchor='## Updates'
if (!s.includes(anchor)) { console.log('MISS'); process.exit(1) }
const block=[
'## System tray',
'',
'Closing the window while sessions are connected does **not** exit the app — it hides to',
'the system tray and your connections keep running. A balloon explains it the first time;',
'the tray tooltip shows the live-session count.',
'',
'- Click the tray icon (or **Show SSH Vault** in its menu) to reopen the window',
'- **Quit (closes all sessions)** ends every connection and exits the app',
'- Closing the window with **nothing** connected exits normally, as expected',
'',
].join('\n')
s=s.replace(anchor, block + anchor)
fs.writeFileSync(p,s)
console.log('readme tray section added')
