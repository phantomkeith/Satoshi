// Copies ../web into ./www for the native bundle. If GROKDESK_BACKEND is set, it is baked in
// as the default backend URL (users can still change it in Settings).
import fs from 'node:fs';
import path from 'node:path';
const src = path.resolve('../web'), dst = path.resolve('www');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
const backend = process.env.GROKDESK_BACKEND || '';
if (backend) {
  const f = path.join(dst, 'index.html');
  const html = fs.readFileSync(f, 'utf8').replace('<script src="chart.js">',
    `<script>try{if(!localStorage.getItem('backend'))localStorage.setItem('backend',${JSON.stringify(backend)})}catch(e){}</script>\n  <script src="chart.js">`);
  fs.writeFileSync(f, html);
}
console.log(`copied web -> www${backend ? ` (default backend ${backend})` : ''}`);
