const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

/**
 * Google Vids AI Generator Automation
 * 
 * Usage:
 *   node index.js --prompt "A futuristic city skyline at sunset" --ratio 16:9 --url "https://docs.google.com/videos/d/1sJwkpurtxh1hpSRRKm59ot7AcCaTdYyln4tSbfdZnEk/edit?scene=id.p#scene=id.p"
 */

async function main() {
  const args = require('minimist')(process.argv.slice(2));
  
  const targetUrl = args.url || 'https://docs.google.com/videos/d/1sJwkpurtxh1hpSRRKm59ot7AcCaTdYyln4tSbfdZnEk/edit?scene=id.p#scene=id.p';
  const promptText = args.prompt || 'A scenic overview of mountains with soft morning light';
  const ratio = args.ratio || '16:9'; // Supported values depend on Google Vids options (e.g. lanskap / Lanskap, potret / Potret)
  const userDataDir = path.join(__dirname, 'user_data');

  console.log('[+] Starting browser session...');
  
  // Launch persistent context so login session is remembered after manual login once
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: ['--disable-blink-features=AutomationControlled']
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  
  console.log(`[+] Navigating to URL: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: 'networkidle' });

  // Check if login is needed
  if (page.url().includes('accounts.google.com')) {
    console.log('[!] Please log in to your Google Account in the opened browser window.');
    console.log('[!] Waiting for navigation back to Google Vids...');
    await page.waitForURL(url => url.toString().includes('docs.google.com/videos'), { timeout: 300000 });
  }

  console.log('[+] Google Vids loaded.');

  // 1. Click 'Video AI' sidebar button if visible
  const videoAiBtn = page.locator('text="Video AI"').or(page.locator('button:has-text("Video AI")'));
  if (await videoAiBtn.isVisible()) {
    await videoAiBtn.click();
    await page.waitForTimeout(1000);
  }

  // 2. Click 'Buat' tab if present
  const buatTab = page.locator('button:has-text("Buat")').or(page.locator('text="Buat"'));
  if (await buatTab.isVisible()) {
    await buatTab.click();
    await page.waitForTimeout(1000);
  }

  // 3. Set Ratio / Orientation if dropdown exists
  // Dropdown options in UI (e.g., "Lanskap", "Potret", "Persegi")
  const ratioDropdown = page.locator('button:has-text("Lanskap"), button:has-text("Potret"), button:has-text("Persegi")');
  if (await ratioDropdown.isVisible()) {
    await ratioDropdown.click();
    await page.waitForTimeout(500);

    let targetRatioText = 'Lanskap';
    if (ratio === '9:16' || ratio.toLowerCase() === 'potret') targetRatioText = 'Potret';
    if (ratio === '1:1' || ratio.toLowerCase() === 'persegi') targetRatioText = 'Persegi';

    const ratioOption = page.locator(`[role="option"]:has-text("${targetRatioText}"), [role="menuitem"]:has-text("${targetRatioText}")`).or(page.locator(`text="${targetRatioText}"`));
    if (await ratioOption.isVisible()) {
      await ratioOption.click();
      console.log(`[+] Selected aspect ratio: ${targetRatioText}`);
    }
  }

  // 4. Fill Prompt Input
  console.log(`[+] Typing prompt: "${promptText}"`);
  const textarea = page.locator('textarea, div[contenteditable="true"]').filter({ hasText: '' }).first();
  await textarea.click();
  await textarea.fill(promptText);

  // 5. Click Generate (Arrow Up button)
  console.log('[+] Submitting video generation request...');
  const submitBtn = page.locator('button:has([data-icon="arrow-up"]), button:has(path)');
  await submitBtn.last().click();

  console.log('[+] Request sent. Waiting for generation process...');
  await page.waitForTimeout(15000);

  // 6. Download Video
  console.log('[+] Attempting video export/download...');
  const fileMenu = page.locator('text="File"');
  if (await fileMenu.isVisible()) {
    await fileMenu.click();
    await page.waitForTimeout(500);

    const downloadOption = page.locator('text="Download"').or(page.locator('text="Unduh"'));
    if (await downloadOption.isVisible()) {
      const [ download ] = await Promise.all([
        page.waitForEvent('download'),
        downloadOption.click()
      ]);

      const downloadPath = path.join(__dirname, 'output.mp4');
      await download.saveAs(downloadPath);
      console.log(`[+] Video successfully downloaded to: ${downloadPath}`);
    }
  }

  console.log('[+] Process completed.');
}

main().catch(err => {
  console.error('[-] Error executing script:', err);
});
