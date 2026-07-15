const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

// Enable stealth plugin to prevent detection
puppeteer.use(StealthPlugin());

// =========================================================
// 1. EXPONENTIAL BACKOFF (Google API 500 Error Fix)
// =========================================================
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function saveWithRetry(sheet, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            await sheet.saveUpdatedCells();
            return; // Success, break the retry loop
        } catch (error) {
            if (i === retries - 1) {
                console.error("❌ Max retries reached. Google API remains unavailable.");
                throw error;
            }
            const waitTime = (2 ** i) * 1000;
            console.log(`⚠️ Google API 500/Timeout. Retrying in ${2 ** i} seconds...`);
            await delay(waitTime);
        }
    }
}

// =========================================================
// 2. CORE SCRAPER ENGINE
// =========================================================
async function runScraper() {
    console.log("🚀 Starting Ector CAD Property Scraper...");

    // Authenticate with Google Sheets using the JSON secret
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const serviceAccountAuth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    // Auto-expand columns to accommodate data up to Column AF (Index 31 -> total 32 columns)
    if (sheet.columnCount < 32) {
        console.log(`📏 Expanding sheet columns from ${sheet.columnCount} to 32...`);
        await sheet.resize({ rowCount: sheet.rowCount, columnCount: 32 });
    }

    // Load cell tracking window into memory
    await sheet.loadCells();

    // Launch Headless Browser
    const browser = await puppeteer.launch({
        headless: "new",
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    let scrapeCount = 0;
    let rowsRemaining = false;
    
    // Batch Configuration: Pushing to Google in small blocks avoids 500 timeouts
    const FLUSH_BATCH_SIZE = 10; 
    let stagedCellsToSave = [];

    // 3. Loop through rows (rowIndex = 1 skips the header)
    for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {

        // Assuming URLs are in Column A (Index 0)
        const url = sheet.getCell(rowIndex, 0).value;
        
        // Status tracking in Column N (Index 13)
        const status = sheet.getCell(rowIndex, 13).value || "";

        if (!url) continue; // Skip empty rows
        if (status.includes("✅")) continue; // Skip already successfully processed items

        // --- FRESH RUN LIMITER ---
        if (scrapeCount >= 30) {
            console.log("🛑 Reached 30 rows. Shutting down to rotate environment...");
            rowsRemaining = true;
            break;
        }

        const actualRowNumber = rowIndex + 1;
        console.log(`🕵️ Scraping Row ${actualRowNumber}: ${url}`);

        const page = await browser.newPage();

        try {
            // --- SPEED BOOST: BLOCK HEAVY ASSETS ---
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                // Block images, styles, and fonts to dramatically speed up page load
                if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            // Random delay navigation pacing (humanize the behavior slightly)
            await delay(Math.floor(Math.random() * 500) + 500);
            
            // Navigate to the CAD URL
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

            const pageTitle = await page.title();
            if (pageTitle.includes("Pardon Our Interruption") || pageTitle.includes("Robot Check")) {
                console.log(`❌ BLOCKED: IP has been flagged on Row ${actualRowNumber}`);
                sheet.getCell(rowIndex, 13).value = "❌ BLOCKED (IP Burned)";
                await saveWithRetry(sheet);
                await page.close();
                continue;
            }

            // 4. Extract property details from the DOM
            const extractedData = await page.evaluate(() => {
                // Helper for Definition Lists (<dl><dt>Label</dt><dd>Value</dd></dl>)
                const getDlValue = (labelText) => {
                    const dt = Array.from(document.querySelectorAll('dt')).find(el => el.innerText.includes(labelText));
                    return dt ? dt.nextElementSibling.innerText.trim() : "";
                };

                // Helper for List Items (<li><div class="fw-bold">Label</div><p>Value</p></li>)
                const getLiValue = (labelText) => {
                    const div = Array.from(document.querySelectorAll('.list-group-item .fw-bold'))
                                     .find(el => el.innerText.includes(labelText));
                    return div ? div.nextElementSibling.innerText.trim() : "";
                };

                return {
                    currentYearLevy: getDlValue('Current Year Levy:'),
                    currentYearDue: getDlValue('Current Year Due:'),
                    priorYearDue: getDlValue('Prior Year Due:'),
                    totalAmountDue: getDlValue('Total Amount Due:'),
                    mailingAddress: getLiValue('Mailing Address:'),
                    propertySiteAddress: getLiValue('Property Site Address:'),
                    legalDescription: getLiValue('Legal Description:')
                };
            });

            // 5. Stage variables to local memory cache (Mapping to Columns Z through AF)
            const baseIndex = 25; // Index 25 corresponds to Column Z

            sheet.getCell(rowIndex, baseIndex + 0).value = extractedData.currentYearLevy;       // Z
            sheet.getCell(rowIndex, baseIndex + 1).value = extractedData.currentYearDue;        // AA
            sheet.getCell(rowIndex, baseIndex + 2).value = extractedData.priorYearDue;          // AB
            sheet.getCell(rowIndex, baseIndex + 3).value = extractedData.totalAmountDue;        // AC
            sheet.getCell(rowIndex, baseIndex + 4).value = extractedData.mailingAddress;        // AD
            sheet.getCell(rowIndex, baseIndex + 5).value = extractedData.propertySiteAddress;   // AE
            sheet.getCell(rowIndex, baseIndex + 6).value = extractedData.legalDescription;      // AF
            
            // Mark Status in Column N (Index 13)
            sheet.getCell(rowIndex, 13).value = "✅ SUCCESS";                                 

            stagedCellsToSave.push(rowIndex);
            console.log(`✔️ Staged Row ${actualRowNumber} | Total Due: ${extractedData.totalAmountDue || 'N/A'} | Levy: ${extractedData.currentYearLevy || 'N/A'}`);
            scrapeCount++;

        } catch (e) {
            console.error(`🛑 Error on Row ${actualRowNumber}: ${e.message}`);
            sheet.getCell(rowIndex, 13).value = "🛑 Error: " + e.message;
            stagedCellsToSave.push(rowIndex);
        } finally {
            await page.close();
        }

        // =========================================================
        // 6. PERIODIC BATCH WRITING
        // =========================================================
        if (stagedCellsToSave.length >= FLUSH_BATCH_SIZE) {
            console.log(`📦 Flashing batch of ${stagedCellsToSave.length} records to Google Sheets...`);
            await saveWithRetry(sheet);
            stagedCellsToSave = []; // Reset storage frame
        }
    }

    // Process leftover elements at loop termination
    if (stagedCellsToSave.length > 0) {
        console.log(`📦 Flashing final ${stagedCellsToSave.length} trailing records to Google Sheets...`);
        await saveWithRetry(sheet);
    }

    await browser.close();

    // 7. GITHUB ACTIONS CASCADE BRIDGE
    if (process.env.GITHUB_OUTPUT) {
        if (rowsRemaining) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=true\n");
            console.log("🔄 Remaining links found. Relaying trigger token to runner pipeline...");
        } else {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, "has_more=false\n");
            console.log("🎉 Entire sheet processing execution completed!");
        }
    }
}

runScraper();
