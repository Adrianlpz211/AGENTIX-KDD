const fs = require('fs');
['extension.js','package.json','icon.png'].forEach(f => {
  if (!fs.existsSync(require('path').join(__dirname, f))) {
    console.error('Missing: ' + f); process.exit(1);
  }
  console.log('OK: ' + f);
});
console.log('\nReady to publish: vsce package');
