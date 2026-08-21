const fs = require('fs');
const path = require('path');

const src = 'C:\\Users\\RTX\\.gemini\\antigravity\\brain\\3e1f2d6b-1ab3-45c9-b9d5-b911c39d030f\\extension_icon_1787238641826.jpg';
const dest = 'e:\\AUTO KLIK\\Vids Goo\\extension\\icon.png';

fs.copyFileSync(src, dest);
console.log('Icon copied successfully!');
