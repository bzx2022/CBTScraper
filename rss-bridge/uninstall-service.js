// Removes the MilkieRSSBridge Windows Service.
// Run from an ELEVATED prompt:  cd rss-bridge && node uninstall-service.js
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
  script: path.join(__dirname, 'server.js'),
});

svc.on('uninstall', () => console.log('MilkieRSSBridge service uninstalled.'));
svc.on('notinstalled', () => console.log('Service was not installed, nothing to remove.'));
svc.on('error', (err) => console.error('Service error:', err));

svc.uninstall();
