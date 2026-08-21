const fs = require('fs');
const path = require('path');

const src = 'C:\\Users\\RTX\\.gemini\\antigravity\\brain\\3e1f2d6b-1ab3-45c9-b9d5-b911c39d030f\\camera_clapper_icon_1787238731369.jpg';
const dest128 = 'e:\\AUTO KLIK\\Vids Goo\\extension\\icon128.png';
const dest48 = 'e:\\AUTO KLIK\\Vids Goo\\extension\\icon48.png';
const dest16 = 'e:\\AUTO KLIK\\Vids Goo\\extension\\icon16.png';

fs.copyFileSync(src, dest128);
fs.copyFileSync(src, dest48);
fs.copyFileSync(src, dest16);
console.log('Real image icon copied!');
