const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const svgPath = path.join(__dirname, 'public', 'favicon.svg');
const svgContent = fs.readFileSync(svgPath, 'utf8');

async function generatePngs() {
  // Use edge or chrome installed on system
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true
  });
  
  const page = await browser.newPage();
  
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          * { margin: 0; padding: 0; }
          body { background: transparent; display: flex; align-items: center; justify-content: center; width: 100vw; height: 100vh; overflow: hidden; }
          svg { width: 100%; height: 100%; }
        </style>
      </head>
      <body>
        ${svgContent}
      </body>
    </html>
  `;
  
  await page.setContent(htmlContent);
  
  const sizes = [16, 48, 128, 256];
  for (const size of sizes) {
    await page.setViewportSize({ width: size, height: size });
    const buffer = await page.screenshot({ omitBackground: true });
    
    if (size === 16) {
      fs.writeFileSync(path.join(__dirname, 'extension', 'icon16.png'), buffer);
    } else if (size === 48) {
      fs.writeFileSync(path.join(__dirname, 'extension', 'icon48.png'), buffer);
    } else if (size === 128) {
      fs.writeFileSync(path.join(__dirname, 'extension', 'icon128.png'), buffer);
      fs.writeFileSync(path.join(__dirname, 'extension', 'icon.png'), buffer);
    }
    
    if (size === 256) {
      fs.writeFileSync(path.join(__dirname, 'icon256.png'), buffer);
    }
  }
  
  await browser.close();
  console.log('All PNG icons generated successfully!');
}

generatePngs().catch(console.error);
