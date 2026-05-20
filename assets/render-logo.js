// Render the Matryoshka avatar + wordmark logo to PNG files using
// @napi-rs/canvas (Node-side canvas, prebuilt binaries, no native compile).
//
// Mirrors the exact draw code from index.html and assets/logo.html so the
// avatar is visually identical to the in-game art.
//
// Run: node assets/render-logo.js
//
// Outputs:
//   assets/matryoshka-avatar-640.png    (Telegram bot avatar)
//   assets/matryoshka-avatar-1024.png   (high-res hero)
//   assets/matryoshka-logo-1080.png     (1080x1350 with wordmark)

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('@napi-rs/canvas');

const TIER_PALETTE = [
  { body:'#e63946', scarf:'#b21f3a', face:'#ffe6c8', apron:'#ffd166', accent:'#1d3557' },
  { body:'#f4a261', scarf:'#d17a3a', face:'#ffe6c8', apron:'#fff1c2', accent:'#603c10' },
  { body:'#e9c46a', scarf:'#b8902f', face:'#ffe6c8', apron:'#fff5b8', accent:'#5a4011' },
  { body:'#8ab17d', scarf:'#3f7d44', face:'#ffe6c8', apron:'#f5e8a8', accent:'#2c4329' },
  { body:'#2a9d8f', scarf:'#176d62', face:'#ffe6c8', apron:'#bff0e2', accent:'#0e3a35' },
  { body:'#457b9d', scarf:'#22506e', face:'#ffe6c8', apron:'#c4e2f3', accent:'#0a2c44' },
  { body:'#9b5de5', scarf:'#6c2eb5', face:'#ffe6c8', apron:'#e1cbff', accent:'#391d6d' },
  { body:'#f15bb5', scarf:'#b8328c', face:'#ffe6c8', apron:'#ffd0e7', accent:'#6e1748' },
  { body:'#f72585', scarf:'#a8125a', face:'#ffe6c8', apron:'#ffc3da', accent:'#530a31' },
  { body:'#fdc500', scarf:'#b88317', face:'#ffe6c8', apron:'#fff3b8', accent:'#5a3e08' },
  { body:'#f1faee', scarf:'#a51d30', face:'#ffe6c8', apron:'#ffb3b3', accent:'#a51d30', crown:true },
];
const HERO_TIER = 10;
const pal = TIER_PALETTE[HERO_TIER];

function drawMatryoshka(c, x, y, r) {
  c.save();
  c.translate(x, y);

  c.fillStyle = pal.body;
  c.beginPath(); c.ellipse(0, 0, r*0.95, r, 0, 0, Math.PI*2); c.fill();

  c.fillStyle = pal.apron;
  c.beginPath(); c.ellipse(0, r*0.18, r*0.7, r*0.62, 0, 0, Math.PI*2); c.fill();

  c.fillStyle = pal.scarf;
  c.beginPath();
  c.moveTo(-r*0.95, -r*0.05);
  c.quadraticCurveTo(0, -r*1.15, r*0.95, -r*0.05);
  c.quadraticCurveTo(r*0.4, -r*0.5, 0, -r*0.45);
  c.quadraticCurveTo(-r*0.4, -r*0.5, -r*0.95, -r*0.05);
  c.fill();

  c.fillStyle = pal.face;
  c.beginPath(); c.ellipse(0, -r*0.4, r*0.36, r*0.28, 0, 0, Math.PI*2); c.fill();

  c.fillStyle = pal.accent;
  c.beginPath();
  c.ellipse(-r*0.13, -r*0.4, r*0.04, r*0.06, 0, 0, Math.PI*2);
  c.ellipse( r*0.13, -r*0.4, r*0.04, r*0.06, 0, 0, Math.PI*2);
  c.fill();

  c.fillStyle = 'rgba(231,57,57,0.55)';
  c.beginPath();
  c.ellipse(-r*0.20, -r*0.32, r*0.06, r*0.05, 0, 0, Math.PI*2);
  c.ellipse( r*0.20, -r*0.32, r*0.06, r*0.05, 0, 0, Math.PI*2);
  c.fill();

  c.strokeStyle = pal.accent;
  c.lineWidth = Math.max(1, r*0.025);
  c.beginPath();
  c.arc(0, -r*0.30, r*0.08, 0.1*Math.PI, 0.9*Math.PI);
  c.stroke();

  // 5-petal flower on apron
  const fr = r*0.13;
  c.fillStyle = pal.scarf;
  c.beginPath(); c.arc(0, r*0.22, fr, 0, Math.PI*2); c.fill();
  c.fillStyle = pal.accent;
  c.beginPath(); c.arc(0, r*0.22, fr*0.5, 0, Math.PI*2); c.fill();
  c.fillStyle = pal.body;
  for (let i = 0; i < 5; i++) {
    const a = i * (Math.PI*2/5) - Math.PI/2;
    c.beginPath();
    c.ellipse(Math.cos(a)*fr*1.4, r*0.22 + Math.sin(a)*fr*1.4,
      fr*0.5, fr*0.3, a + Math.PI/2, 0, Math.PI*2);
    c.fill();
  }
  c.fillStyle = pal.scarf;
  c.beginPath(); c.arc(0, r*0.22, fr*0.55, 0, Math.PI*2); c.fill();
  c.fillStyle = pal.accent;
  c.beginPath(); c.arc(0, r*0.22, fr*0.25, 0, Math.PI*2); c.fill();

  c.strokeStyle = pal.accent;
  c.lineWidth = Math.max(1, r*0.03);
  c.beginPath(); c.ellipse(0, 0, r*0.95, r, 0, 0, Math.PI*2); c.stroke();

  c.beginPath();
  c.moveTo(-r*0.95, -r*0.05);
  c.quadraticCurveTo(-r*0.4, -r*0.5, 0, -r*0.45);
  c.quadraticCurveTo(r*0.4, -r*0.5, r*0.95, -r*0.05);
  c.stroke();

  // Crown
  c.fillStyle = '#fdc500';
  c.beginPath();
  c.moveTo(-r*0.35, -r*0.95);
  c.lineTo(-r*0.22, -r*1.18);
  c.lineTo(-r*0.08, -r*1.02);
  c.lineTo(0,       -r*1.22);
  c.lineTo( r*0.08, -r*1.02);
  c.lineTo( r*0.22, -r*1.18);
  c.lineTo( r*0.35, -r*0.95);
  c.closePath();
  c.fill();
  c.strokeStyle = '#b88317';
  c.stroke();
  c.fillStyle = '#e63946';
  c.beginPath(); c.arc(0, -r*1.05, r*0.05, 0, Math.PI*2); c.fill();

  c.restore();
}

function renderAvatar(size) {
  const cnv = createCanvas(size, size);
  const c = cnv.getContext('2d');
  // Background gradient
  const g = c.createRadialGradient(size/2, size*0.4, 10, size/2, size/2, size*0.78);
  g.addColorStop(0, '#d12a44');
  g.addColorStop(0.55, '#a01a30');
  g.addColorStop(1, '#6f0f1f');
  c.fillStyle = g; c.fillRect(0, 0, size, size);

  // Gold ring
  c.strokeStyle = 'rgba(255, 213, 122, 0.32)';
  c.lineWidth = size * 0.012;
  c.beginPath(); c.arc(size/2, size/2, size*0.46, 0, Math.PI*2); c.stroke();

  // Sparkles
  const sparkles = 28;
  for (let i = 0; i < sparkles; i++) {
    const angle = (i / sparkles) * Math.PI * 2 + 0.3;
    const rad = size * (0.40 + 0.06 * Math.sin(i * 1.7));
    const px = size/2 + Math.cos(angle) * rad;
    const py = size*0.55 + Math.sin(angle) * rad * 0.85;
    const sz = size * 0.005 * (1 + Math.sin(i*2.1));
    c.fillStyle = i % 3 === 0 ? '#fdc500' : 'rgba(255,255,255,0.55)';
    c.beginPath(); c.arc(px, py, Math.max(0.5, sz), 0, Math.PI*2); c.fill();
  }

  drawMatryoshka(c, size/2, size*0.56, size * 0.30);
  return cnv.toBuffer('image/png');
}

function renderWordmark(w) {
  const h = Math.round(w * 1.25);
  const cnv = createCanvas(w, h);
  const c = cnv.getContext('2d');
  const g = c.createRadialGradient(w/2, h*0.36, 10, w/2, h/2, h*0.7);
  g.addColorStop(0, '#d12a44');
  g.addColorStop(0.55, '#a01a30');
  g.addColorStop(1, '#6f0f1f');
  c.fillStyle = g; c.fillRect(0, 0, w, h);

  c.strokeStyle = 'rgba(255, 213, 122, 0.6)';
  c.lineWidth = h * 0.008;
  const pad = h * 0.04;
  c.strokeRect(pad, pad, w - pad*2, h - pad*2);

  // Sparkles — deterministic for reproducibility
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < 48; i++) {
    const px = pad + rand() * (w - pad*2);
    const py = pad + rand() * (h*0.65);
    const sz = h * 0.004 * (1 + rand());
    c.fillStyle = i % 3 === 0 ? '#fdc500' : 'rgba(255,255,255,0.5)';
    c.beginPath(); c.arc(px, py, Math.max(0.6, sz), 0, Math.PI*2); c.fill();
  }

  drawMatryoshka(c, w/2, h*0.42, h * 0.21);

  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.font = '800 ' + Math.round(h*0.075) + 'px sans-serif';
  c.fillText('MATRYOSHKA', w/2, h * 0.86);

  c.fillStyle = '#ffe6c2';
  c.font = '700 ' + Math.round(h*0.026) + 'px sans-serif';
  c.fillText('DROP · MERGE · REIGN', w/2, h * 0.93);

  return cnv.toBuffer('image/png');
}

const outDir = path.join(__dirname);
const targets = [
  { fn: () => renderAvatar(640),  name: 'matryoshka-avatar-640.png' },
  { fn: () => renderAvatar(1024), name: 'matryoshka-avatar-1024.png' },
  { fn: () => renderWordmark(1080), name: 'matryoshka-logo-1080.png' },
];
for (const t of targets) {
  const buf = t.fn();
  fs.writeFileSync(path.join(outDir, t.name), buf);
  console.log('wrote', t.name, '(' + buf.length + ' bytes)');
}
