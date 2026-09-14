// Installs rss-bridge/server.js as a native Windows Service via node-windows.
// Run from an ELEVATED prompt:  cd rss-bridge && npm install && node install-service.js
const path = require('path');

let Service;
try {
  Service = require('node-windows').Service;
} catch (err) {
  console.error('node-windows is not installed. Run "npm install" inside rss-bridge first.');
  process.exit(1);
}

const svc = new Service({
  name: 'MilkieRSSBridge',
  description: 'Milkie watchlist RSS bridge for uTorrent 2.2.1 (plain HTTP on 127.0.0.1:8080)',
  script: path.join(__dirname, 'server.js'),
  nodeOptions: ['--harmony', '--max_old_space_size=256'],
  // Restart automatically if the bridge ever crashes.
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
});

svc.on('install', () => {
  console.log('Service installed. Starting MilkieRSSBridge...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('Service is already installed. Starting it...');
  svc.start();
});

svc.on('start', () => console.log('MilkieRSSBridge service started. Feed: http://127.0.0.1:8080/feed.xml'));
svc.on('error', (err) => console.error('Service error:', err));

svc.install();
