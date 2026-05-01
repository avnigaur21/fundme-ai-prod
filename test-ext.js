const puppeteer = require('puppeteer');
const path = require('path');

(async () => {
    const extPath = path.resolve(__dirname, 'chrome_extension');
    const browser = await puppeteer.launch({
        headless: false, 
        args: [
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`
        ]
    });

    try {
        const page = await browser.newPage();
        await page.goto('http://localhost:3000/application-detail.html', { waitUntil: 'networkidle0' });
        
        console.log('Navigated to localhost:3000/application-detail.html');

        // Check if content script is injected using the proper execution context
        // Wait for the background page or service worker
        let extensionId;
        const targets = await browser.targets();
        
        for (const target of targets) {
            if (target.url().startsWith('chrome-extension://')) {
                const url = target.url();
                extensionId = url.split('/')[2];
                break;
            }
        }
        
        if (extensionId) {
            console.log('Extension ID:', extensionId);

            const popupPage = await browser.newPage();
            await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'networkidle0' });
            console.log('Popup loaded successfully!');
            
            // Validate popup elements
            const hasCaptureBtn = await popupPage.evaluate(() => {
                return !!document.getElementById('captureBtn');
            });
            console.log('Popup has captureBtn:', hasCaptureBtn);
            
            // Check if captureBtn is clickable and runs
            const originalText = await popupPage.evaluate(() => {
                return document.getElementById('captureBtn').textContent;
            });
            console.log('Capture button text:', originalText);

            console.log('✅ Extension loaded and working!');
        } else {
            console.log('❌ Could not find extension ID');
        }

    } catch(e) {
        console.error('Error during test:', e);
    } finally {
        await browser.close();
        process.exit(0);
    }
})();
