// Kirim sinyal heartbeat ke background worker saat popup dibuka
chrome.runtime.sendMessage({ type: 'HEARTBEAT' });

document.getElementById('runBtn').addEventListener('click', async () => {
  const prompt = document.getElementById('prompt').value;
  const ratio = document.getElementById('ratio').value;
  const mode = document.getElementById('genMode').value;
  const statusDiv = document.getElementById('status');

  statusDiv.textContent = '⏳ Menghubungi tab Google Vids...';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url.includes('docs.google.com/videos')) {
    statusDiv.textContent = '❌ Buka halaman Google Vids terlebih dahulu!';
    return;
  }

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: runGoogleVidsAutomation,
    args: [prompt, ratio, mode]
  }, (results) => {
    if (chrome.runtime.lastError) {
      statusDiv.textContent = '❌ Error: ' + chrome.runtime.lastError.message;
    } else {
      statusDiv.textContent = `✅ Perintah generate ${mode.toUpperCase()} dikirim ke halaman!`;
    }
  });
});

// Link Buka Google Vids Baru
document.getElementById('openVidsCreateLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'https://docs.google.com/videos/create?usp=vids_alc&authuser=0' });
});

// Link Buka Web Dashboard
document.getElementById('openDashboardLink').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'http://127.0.0.1:7890' });
});

function runGoogleVidsAutomation(promptText, ratioText, mode) {
  console.log('[Extension] Starting automation...', promptText, ratioText, mode);

  const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span'));
  
  if (mode === 'voice') {
    // Mode Voiceover AI
    const voiceBtn = buttons.find(b => b.textContent.trim().includes('Voiceover'));
    if (voiceBtn) voiceBtn.click();
  } else if (mode === 'image') {
    // Mode Foto/Gambar AI
    const fotoBtn = buttons.find(b => b.textContent.trim().includes('Foto') || b.textContent.trim().includes('Bahan'));
    if (fotoBtn) fotoBtn.click();
  } else {
    // Mode Default Video AI
    const videoAiBtn = buttons.find(b => b.textContent.includes('Video AI'));
    if (videoAiBtn) videoAiBtn.click();
  }

  setTimeout(() => {
    // 2. Klik Tab 'Buat'
    const buatTab = Array.from(document.querySelectorAll('button, div[role="tab"]')).find(b => b.textContent.trim() === 'Buat');
    if (buatTab) buatTab.click();

    setTimeout(() => {
      // 3. Atur Ratio (Khusus Video)
      if (mode === 'video') {
        const ratioBtn = Array.from(document.querySelectorAll('button')).find(b => 
          b.textContent.includes('Lanskap') || b.textContent.includes('Potret') || b.textContent.includes('Persegi')
        );
        if (ratioBtn) {
          ratioBtn.click();
          setTimeout(() => {
            let label = 'Lanskap';
            if (ratioText === '9:16') label = 'Potret';
            if (ratioText === '1:1') label = 'Persegi';

            const option = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], div')).find(o => o.textContent.trim() === label);
            if (option) option.click();
          }, 500);
        }
      }

      // 4. Isi Prompt & Submit
      setTimeout(() => {
        const textarea = document.querySelector('textarea, div[contenteditable="true"]');
        if (textarea) {
          textarea.focus();
          if (textarea.tagName === 'TEXTAREA') {
            textarea.value = promptText;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            textarea.innerText = promptText;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }

          // 5. Submit (Klik tombol Arrow Up / Buat / Ucapkan)
          setTimeout(() => {
            const submitBtn = Array.from(document.querySelectorAll('button')).find(b => 
              b.querySelector('path') || b.innerHTML.includes('arrow') || b.textContent.includes('Buat') || b.textContent.includes('Ucapkan')
            );
            if (submitBtn) submitBtn.click();
          }, 1000);
        }
      }, 1000);

    }, 1000);
  }, 1000);
}
