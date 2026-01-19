/**
 * FFTCG Card Scraper v8
 * Fixed: $eval argument limitation (wrap in single object)
 * Added: Icon parsing for ability text ([F], [1], [Dull], etc.)
 * Added: Incremental image downloads
 */

const { chromium } = require('playwright');
const fs = require('fs').promises;
const path = require('path');

// =============================================================================
// CORRECT FILTER SELECTORS (based on actual HTML)
// =============================================================================

const FILTER_SELECTORS = {
    // MULTI-SELECT filters (have .options container)
    set: {
        container: '.filter.set.multi .options',  // <-- FIXED: need .options
        itemSelector: '.item[data-value]',
        // data-value: "Opus I", "Opus II", "Crystal Dominion", etc.
    },
    category: {
        container: '.filter.category.multi .options',  // <-- FIXED: need .options
        itemSelector: '.item[data-value]',
        // data-value: "I", "II", "VII", "DFF", "FFT", etc.
    },
    
    // SINGLE-SELECT filters (items are direct children)
    type: {
        container: '.filter.type.select',
        itemSelector: '.item[data-value]',
        values: {
            'Backup': 'backup', 'Crystal': 'crystal', 'Forward': 'forward',
            'Monster': 'monster', 'Summon': 'summon',
        }
    },
    element: {
        container: '.filter.element.select',
        itemSelector: '.item[data-value]',
        values: {
            'Fire': 'fire', 'Ice': 'ice', 'Wind': 'wind', 'Earth': 'earth',
            'Lightning': 'lightning', 'Water': 'water', 'Light': 'light',
            'Dark': 'darkness', 'Darkness': 'darkness',
        }
    },
    rarity: {
        container: '.filter.rarity.select',
        itemSelector: '.item[data-value]',
        values: {
            'Common': 'c', 'Rare': 'r', 'Hero': 'h', 'Legend': 'l',
            'Starter': 's', 'Boss': 'b', 'Promo': 'pr',
            'C': 'c', 'R': 'r', 'H': 'h', 'L': 'l', 'S': 's', 'B': 'b', 'PR': 'pr',
        }
    },
    cost: {
        container: '.filter.cost.select',
        itemSelector: '.item[data-value]',
        // data-value: "1" through "11"
    },
    flag: {
        container: '.filter.flag.select',
        itemSelector: '.item[data-value]',
        values: { 
            'Special': 'special', 'EX Burst': 'exburst', 'Generic': 'multi',
            'special': 'special', 'exburst': 'exburst', 'multi': 'multi',
        }
    },
};

// Card selector - cards are in .results div
const CARD_SELECTOR = '.results .item[data-code]';
const RESULTS_HEADER = '.results .header span';

const DEFAULT_CONFIG = {
    output: {
        directory: './output',
        downloadImages: true,
        saveJson: true,
        jsonFilename: 'cards.json',
        imageSubdir: 'images',
    },
    filters: {
        sets: null,
        elements: null,
        types: null,
        rarities: null,
        categories: null,
        costs: null,
        flags: null,
        keyword: null,
        code: null,
    },
    scraping: {
        includeCardDetails: true,
        delayBetweenCards: 150,
        delayBetweenPages: 500,
        headless: false,  // Set to false for debugging
        timeout: 60000,
    },
    images: {
        quality: 'full',
        concurrent: 5,
    }
};

class FFTCGScraper {
    constructor(config = {}) {
        this.config = this.mergeConfig(DEFAULT_CONFIG, config);
        this.browser = null;
        this.page = null;
        this.cards = [];
    }
    
    // =========================================================================
    // LOGGING
    // =========================================================================
    
    log(message, level = 'info') {
        const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
        const icons = { 'info': 'ℹ️ ', 'debug': '🔍', 'warn': '⚠️ ', 'error': '❌', 'success': '✅' };
        console.log(`[${timestamp}] ${icons[level] || ''} ${message}`);
    }
    
    // =========================================================================
    // UTILITIES
    // =========================================================================
    
    mergeConfig(defaults, overrides) {
        const result = { ...defaults };
        for (const key of Object.keys(overrides)) {
            if (overrides[key] !== undefined && typeof overrides[key] === 'object' && 
                !Array.isArray(overrides[key]) && overrides[key] !== null) {
                result[key] = this.mergeConfig(defaults[key] || {}, overrides[key]);
            } else if (overrides[key] !== undefined) {
                result[key] = overrides[key];
            }
        }
        return result;
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    rarityCodeToName(code) {
        const map = { 'C': 'Common', 'R': 'Rare', 'H': 'Hero', 'L': 'Legend', 
                      'S': 'Starter', 'B': 'Boss', 'P': 'Promo', 'PR': 'Promo' };
        return map[code?.toUpperCase()] || code;
    }
    
    // =========================================================================
    // BROWSER
    // =========================================================================
    
    async init() {
        this.log('FFTCG Scraper v8 Starting...', 'info');
        this.log(`Output: ${this.config.output.directory}`, 'info');
        this.log(`Filters: ${JSON.stringify(this.config.filters)}`, 'info');
        
        await fs.mkdir(this.config.output.directory, { recursive: true });
        if (this.config.output.downloadImages) {
            await fs.mkdir(path.join(this.config.output.directory, this.config.output.imageSubdir), { recursive: true });
        }
        
        this.browser = await chromium.launch({ headless: this.config.scraping.headless });
        this.page = await this.browser.newPage();
        this.page.setDefaultTimeout(this.config.scraping.timeout);
        
        this.log('Browser launched', 'success');
    }
    
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.log('Browser closed', 'info');
        }
    }
    
    // =========================================================================
    // NAVIGATION
    // =========================================================================
    
    async handleCookieBanner() {
        // Try to dismiss cookie consent banner
        const cookieSelectors = [
            '.osano-cm-accept-all',           // Accept all button
            '.osano-cm-button--type_accept',  // Accept button
            'button:has-text("Accept")',
            'button:has-text("Reject Non-Essential")',
            '.osano-cm-dialog__close',        // Close button
        ];
        
        for (const selector of cookieSelectors) {
            try {
                const btn = await this.page.$(selector);
                if (btn && await btn.isVisible()) {
                    this.log(`Clicking cookie banner: ${selector}`, 'debug');
                    await btn.click();
                    await this.sleep(500);
                    return true;
                }
            } catch (e) {}
        }
        return false;
    }
    
    async clickSearchButton() {
        // Click the Search button to load/refresh results
        const searchSelectors = [
            '.card-search button',
            '.search-btn',
            'button[role="search"]',
            '.card-search',
        ];
        
        for (const selector of searchSelectors) {
            try {
                const btn = await this.page.$(selector);
                if (btn && await btn.isVisible()) {
                    this.log(`Clicking Search button: ${selector}`, 'info');
                    await btn.click();
                    return true;
                }
            } catch (e) {}
        }
        
        this.log('Could not find Search button!', 'warn');
        return false;
    }
    
    async navigateToCardBrowser() {
        const url = 'https://fftcg.square-enix-games.com/en/card-browser';
        this.log(`Navigating to: ${url}`, 'info');
        
        await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        
        // Handle cookie consent banner first
        this.log('Checking for cookie banner...', 'debug');
        await this.sleep(1000);
        await this.handleCookieBanner();
        
        // IMPORTANT: Expand filters panel FIRST (it's collapsed by default!)
        await this.expandFiltersPanel();
        await this.sleep(500);
        
        // Now wait for filters to load (they should be visible now)
        this.log('Waiting for filter items...', 'debug');
        try {
            await this.page.waitForSelector('.filter.set.multi .options .item[data-value]', { timeout: 30000 });
            this.log('Filters loaded', 'success');
        } catch (e) {
            this.log('Timeout waiting for filter items, trying to expand filters again...', 'warn');
            await this.expandFiltersPanel();
            await this.sleep(1000);
        }
        
        // DON'T click Search yet - we want to apply filters first!
        // The page starts with "No Results" which is fine.
        
        this.log('Card browser loaded (filters ready, no search yet)', 'success');
    }
    
    // =========================================================================
    // FILTERS
    // =========================================================================
    
    async expandFiltersPanel() {
        // The filters panel is collapsed by default - need to click "Filters" toggle to expand
        this.log('Checking if filters panel needs to be expanded...', 'debug');
        
        try {
            // First, wait for the page to have the toggle button
            await this.page.waitForSelector('.card-filter .toggle, .toggle.noselect', { timeout: 10000 });
            
            // Check if filters are hidden
            const filtersPanel = await this.page.$('.filters');
            if (filtersPanel) {
                const style = await filtersPanel.getAttribute('style');
                const isHidden = style?.includes('display: none') || style?.includes('display:none');
                
                if (!isHidden) {
                    this.log('Filters panel already visible', 'debug');
                    return true;
                }
            }
            
            // Click the Filters toggle button
            this.log('Filters panel is hidden, clicking toggle to expand...', 'info');
            
            const toggleSelectors = [
                '.card-filter .toggle',
                '.toggle.noselect',
                '.item.card-filter',
            ];
            
            for (const selector of toggleSelectors) {
                try {
                    const toggleBtn = await this.page.$(selector);
                    if (toggleBtn && await toggleBtn.isVisible()) {
                        await toggleBtn.click();
                        await this.sleep(500);
                        
                        // Verify filters are now visible
                        const filtersAfter = await this.page.$('.filters');
                        if (filtersAfter) {
                            const styleAfter = await filtersAfter.getAttribute('style');
                            if (!styleAfter || !styleAfter.includes('display: none')) {
                                this.log('Filters panel expanded successfully', 'success');
                                return true;
                            }
                        }
                    }
                } catch (e) {}
            }
            
            this.log('Could not expand filters panel!', 'error');
            return false;
            
        } catch (e) {
            this.log(`Error expanding filters: ${e.message}`, 'warn');
            return false;
        }
    }
    
    async clickFilterItem(filterType, value) {
        const filterConfig = FILTER_SELECTORS[filterType];
        if (!filterConfig) {
            this.log(`Unknown filter type: ${filterType}`, 'warn');
            return false;
        }
        
        // Make sure filters panel is expanded
        await this.expandFiltersPanel();
        
        // Map user-friendly value to data-value if needed
        let dataValue = value;
        if (filterConfig.values && filterConfig.values[value]) {
            dataValue = filterConfig.values[value];
        }
        
        // Build the full selector
        const selector = `${filterConfig.container} .item[data-value="${dataValue}"]`;
        this.log(`Looking for: ${selector}`, 'debug');
        
        try {
            const element = await this.page.$(selector);
            
            if (!element) {
                this.log(`❌ Element NOT FOUND: ${selector}`, 'error');
                
                // List available options
                const available = await this.page.$$eval(
                    `${filterConfig.container} .item[data-value]`,
                    els => els.slice(0, 10).map(e => e.getAttribute('data-value'))
                ).catch(() => []);
                this.log(`Available ${filterType} values: ${available.join(', ')}...`, 'warn');
                
                return false;
            }
            
            // Scroll into view first
            await element.scrollIntoViewIfNeeded();
            await this.sleep(200);
            
            // Check if visible now
            const isVisible = await element.isVisible();
            if (!isVisible) {
                this.log(`Element found but not visible, trying to make it visible...`, 'warn');
                
                // Try scrolling the container
                await this.page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (el) {
                        el.scrollIntoView({ behavior: 'instant', block: 'center' });
                    }
                }, selector);
                await this.sleep(300);
            }
            
            // Click the element with a shorter timeout
            await element.click({ timeout: 5000 });
            this.log(`✅ Clicked ${filterType}: "${dataValue}"`, 'success');
            
            // Verify it got selected
            await this.sleep(200);
            const classes = await element.getAttribute('class');
            if (classes?.includes('selected')) {
                this.log(`Filter "${dataValue}" is now selected`, 'debug');
            }
            
            return true;
            
        } catch (e) {
            this.log(`❌ Error clicking ${filterType}="${value}": ${e.message}`, 'error');
            return false;
        }
    }
    
    async applyFilters() {
        const { filters } = this.config;
        let appliedCount = 0;
        let criticalFilterFailed = false;
        
        // Make sure filters panel is visible first
        await this.expandFiltersPanel();
        
        // Set filter (CRITICAL - if this fails, we should abort)
        if (filters.sets?.length > 0) {
            this.log(`Applying SET filter: ${filters.sets.join(', ')}`, 'info');
            for (const set of filters.sets) {
                if (await this.clickFilterItem('set', set)) {
                    appliedCount++;
                } else {
                    this.log(`CRITICAL: Failed to apply SET filter "${set}"!`, 'error');
                    criticalFilterFailed = true;
                }
                await this.sleep(300);
            }
        }
        
        // If critical filter failed, ask if we should continue
        if (criticalFilterFailed) {
            this.log('FATAL: Set filter failed! Aborting to prevent loading ALL cards.', 'error');
            throw new Error('Critical filter (Set) failed to apply. Check if filters panel expanded correctly.');
        }
        
        // Type filter
        if (filters.types?.length > 0) {
            this.log(`Applying TYPE filter: ${filters.types.join(', ')}`, 'info');
            for (const type of filters.types) {
                if (await this.clickFilterItem('type', type)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        // Element filter
        if (filters.elements?.length > 0) {
            this.log(`Applying ELEMENT filter: ${filters.elements.join(', ')}`, 'info');
            for (const el of filters.elements) {
                if (await this.clickFilterItem('element', el)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        // Rarity filter
        if (filters.rarities?.length > 0) {
            this.log(`Applying RARITY filter: ${filters.rarities.join(', ')}`, 'info');
            for (const rarity of filters.rarities) {
                if (await this.clickFilterItem('rarity', rarity)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        // Category filter
        if (filters.categories?.length > 0) {
            this.log(`Applying CATEGORY filter: ${filters.categories.join(', ')}`, 'info');
            for (const cat of filters.categories) {
                if (await this.clickFilterItem('category', cat)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        // Cost filter
        if (filters.costs?.length > 0) {
            this.log(`Applying COST filter: ${filters.costs.join(', ')}`, 'info');
            for (const cost of filters.costs) {
                if (await this.clickFilterItem('cost', String(cost))) appliedCount++;
                await this.sleep(200);
            }
        }
        
        // Flag filter
        if (filters.flags?.length > 0) {
            this.log(`Applying FLAG filter: ${filters.flags.join(', ')}`, 'info');
            for (const flag of filters.flags) {
                if (await this.clickFilterItem('flag', flag)) appliedCount++;
                await this.sleep(200);
            }
        }
        
        // Keyword search
        if (filters.keyword) {
            this.log(`Applying KEYWORD: ${filters.keyword}`, 'info');
            await this.page.fill('input[name="keyword"]', filters.keyword);
            appliedCount++;
        }
        
        // Code search
        if (filters.code) {
            this.log(`Applying CODE: ${filters.code}`, 'info');
            await this.page.fill('input[name="code"]', filters.code);
            appliedCount++;
        }
        
        if (appliedCount > 0) {
            this.log(`Applied ${appliedCount} filter(s), clicking Search...`, 'info');
            
            // MUST click Search button to apply filters!
            await this.clickSearchButton();
            
            // Wait for results to update
            await this.sleep(2000);
            
            // Check result count
            const resultText = await this.page.textContent(RESULTS_HEADER).catch(() => null);
            this.log(`Results: ${resultText}`, 'info');
        }
        
        return appliedCount;
    }
    
    // =========================================================================
    // CARD LOADING
    // =========================================================================
    
    async getExpectedCount() {
        try {
            const text = await this.page.textContent(RESULTS_HEADER);
            // Handle both "(148)" and "(50/219)" formats
            const match = text?.match(/\((?:\d+\/)?(\d+)\)/);
            return match ? parseInt(match[1]) : null;
        } catch (e) {
            return null;
        }
    }
    
    async loadAllCards() {
        this.log('Loading all cards...', 'info');
        
        const expectedTotal = await this.getExpectedCount();
        this.log(`Expected total: ${expectedTotal ?? 'unknown'}`, 'info');
        
        // Safety limit - don't load more than this without explicit expected count
        const MAX_CARDS_SAFETY = 500;
        
        let currentCount = await this.page.$$(CARD_SELECTOR).then(els => els.length);
        this.log(`Current count: ${currentCount}`, 'info');
        
        if (currentCount === 0) {
            this.log('No cards found! Check if filters returned results.', 'error');
            
            // Check for "No Results" message
            const noResults = await this.page.$('.results .empty:not([style*="display: none"])');
            if (noResults) {
                const text = await noResults.textContent();
                this.log(`No Results message: "${text}"`, 'warn');
            }
            
            return 0;
        }
        
        // If no expected total and already have lots of cards, warn user
        if (!expectedTotal && currentCount >= 50) {
            this.log(`WARNING: No expected count and already ${currentCount} cards. Filter may have failed!`, 'warn');
        }
        
        // Load more cards if needed
        let previousCount = 0;
        let noChangeCount = 0;
        
        while (noChangeCount < 5) {
            currentCount = await this.page.$$(CARD_SELECTOR).then(els => els.length);
            
            // Safety check - stop if we're loading way too many cards
            if (!expectedTotal && currentCount >= MAX_CARDS_SAFETY) {
                this.log(`SAFETY STOP: Loaded ${currentCount} cards without known total. Filter may have failed!`, 'warn');
                this.log(`If this is intentional, set a specific filter or increase safety limit.`, 'warn');
                break;
            }
            
            if (expectedTotal && currentCount >= expectedTotal) {
                this.log(`All ${currentCount} cards loaded`, 'success');
                break;
            }
            
            if (currentCount === previousCount) {
                noChangeCount++;
                
                // Try "Load more" button
                const loadMore = await this.page.$('.results .more:not([style*="display: none"])');
                if (loadMore && await loadMore.isVisible()) {
                    this.log('Clicking Load More...', 'debug');
                    await loadMore.click();
                    await this.sleep(this.config.scraping.delayBetweenPages);
                    noChangeCount = 0;
                    continue;
                }
                
                // Try scrolling
                await this.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await this.sleep(this.config.scraping.delayBetweenPages);
            } else {
                this.log(`Loaded ${currentCount}/${expectedTotal ?? '?'} cards`, 'info');
                noChangeCount = 0;
            }
            
            previousCount = currentCount;
        }
        
        const finalCount = await this.page.$$(CARD_SELECTOR).then(els => els.length);
        this.log(`Total cards loaded: ${finalCount}`, 'success');
        return finalCount;
    }
    
    // =========================================================================
    // CARD SCRAPING
    // =========================================================================
    
    async scrapeCardCodes() {
        const items = await this.page.$$(CARD_SELECTOR);
        const codes = [];
        
        for (const item of items) {
            const code = await item.getAttribute('data-code');
            if (code && !codes.includes(code)) {
                codes.push(code);
            }
        }
        
        this.log(`Found ${codes.length} unique card codes`, 'info');
        return codes;
    }
    
    async scrapeCardDetails(cardCode) {
        const card = {
            code: cardCode,
            name: null,
            type: null,
            job: null,
            element: null,
            cost: null,
            power: null,
            rarity: null,
            category: null,
            set: null,
            abilities: '',  // Changed from [] to '' since parseAbilityText returns string
            imageUrl: `https://fftcg.cdn.sewest.net/images/cards/full/${cardCode}_eg.jpg`,
        };
        
        try {
            // Click card to open overlay
            await this.page.click(`${CARD_SELECTOR}[data-code="${cardCode}"]`);
            
            // Wait for overlay
            await this.page.waitForSelector('.overlay', { state: 'visible', timeout: 5000 });
            await this.sleep(300);
            
            // Get name from overlay title
            try {
                card.name = await this.page.textContent('.overlay .bar .title');
                card.name = card.name?.trim();
            } catch (e) {}
            
            // Get abilities text with proper icon parsing
            // Try multiple selectors in case structure varies
            const textSelectors = [
                '.overlay .col.details .text',
                '.overlay .col.details p.text',
                '.overlay .details .text',
                '.overlay p.text',
            ];
            
            for (const selector of textSelectors) {
                try {
                    // Use $eval to evaluate directly on the element
                    // Playwright $eval only allows ONE arg after function, so wrap in object
                    const abilities = await this.page.$eval(selector, (el, icons) => {
                        const result = [];
                        
                        function processNode(node) {
                            if (node.nodeType === Node.TEXT_NODE) {
                                const text = node.textContent;
                                if (text) result.push(text);
                            } else if (node.nodeType === Node.ELEMENT_NODE) {
                                const elem = node;
                                
                                // Check if this is an icon span
                                if (elem.tagName === 'SPAN' && elem.classList.contains('icon')) {
                                    const classes = Array.from(elem.classList);
                                    
                                    // Check for number icon (has "num" class)
                                    if (classes.includes('num')) {
                                        const num = elem.textContent?.trim() || '?';
                                        result.push(`[${num}]`);
                                        return;
                                    }
                                    
                                    // Check for element/special icons
                                    for (const cls of classes) {
                                        if (icons.elements[cls]) {
                                            result.push(`[${icons.elements[cls]}]`);
                                            return;
                                        }
                                        if (icons.special[cls]) {
                                            result.push(`[${icons.special[cls]}]`);
                                            return;
                                        }
                                    }
                                    
                                    // Unknown icon - use class name as fallback
                                    const iconClass = classes.find(c => c !== 'icon');
                                    if (iconClass) {
                                        result.push(`[${iconClass}]`);
                                    }
                                } else if (elem.tagName === 'SPAN' && elem.classList.contains('italic')) {
                                    // Wrap italic text (like Priming) in asterisks
                                    result.push(`*${elem.textContent?.trim()}*`);
                                } else if (elem.tagName === 'BR') {
                                    result.push(' ');
                                } else {
                                    // Process children for other elements
                                    for (const child of elem.childNodes) {
                                        processNode(child);
                                    }
                                }
                            }
                        }
                        
                        processNode(el);
                        return result.join('').replace(/\s+/g, ' ').trim();
                    }, {
                        elements: {
                            'fire': 'F', 'ice': 'I', 'wind': 'W', 'earth': 'E',
                            'lightning': 'L', 'water': 'A', 'light': 'Lt', 
                            'dark': 'D', 'darkness': 'D'
                        },
                        special: {
                            'down': 'Dull', 'special': 'S', 'exburst': 'EX', 
                            'c': 'C', 'ability': '', 's': 'S'
                        }
                    });
                    
                    if (abilities) {
                        // Post-process: Clean up special ability formats
                        let processed = abilities
                            // Priming: Remove --, move closing asterisk after costs
                            .replace(/(\*Priming [^*]+)\*\s*(?:--\s*)?((?:\[[^\]]+\])+)/g, '$1 $2*')
                            // Limit Break: Remove -- between name and number
                            .replace(/\*Limit Break\s*--\s*(\d+)\*/g, '*Limit Break $1*')
                            .replace(/\s+/g, ' ')  // clean up any double spaces
                            .trim();
                        card.abilities = processed;
                        this.log(`Abilities for ${cardCode}: "${processed.substring(0, 60)}..."`, 'debug');
                        break;
                    }
                } catch (e) {
                    // Selector not found or eval failed - try next
                    this.log(`Selector ${selector} failed: ${e.message}`, 'debug');
                }
            }
            
            // If still no abilities, log the actual HTML structure for debugging
            if (!card.abilities) {
                try {
                    const detailsHtml = await this.page.$eval('.overlay', el => {
                        // Find any element with class containing 'text' or 'detail'
                        const debugInfo = [];
                        debugInfo.push('Classes found: ' + Array.from(el.querySelectorAll('*')).slice(0, 20).map(e => e.className).filter(c => c).join(', '));
                        const textEl = el.querySelector('.text') || el.querySelector('p.text') || el.querySelector('.col.details');
                        if (textEl) {
                            debugInfo.push('Text element HTML: ' + textEl.outerHTML.substring(0, 300));
                        }
                        return debugInfo.join(' | ');
                    });
                    this.log(`DEBUG ${cardCode} overlay structure: ${detailsHtml}`, 'warn');
                } catch (e) {
                    this.log(`Could not debug overlay: ${e.message}`, 'debug');
                }
            }
            
            // Parse attributes table
            const rows = await this.page.$$('.overlay .attributes tr');
            for (const row of rows) {
                try {
                    const cells = await row.$$('td');
                    if (cells.length >= 2) {
                        const labelText = await cells[0].textContent();
                        const label = labelText.toLowerCase().replace(':', '').trim();
                        
                        // Element is an icon, not text - check for icon class
                        if (label === 'element') {
                            const iconEl = await cells[1].$('.icon');
                            if (iconEl) {
                                const classes = await iconEl.getAttribute('class');
                                // Extract element from class like "icon fire" -> "Fire"
                                const elementMatch = classes?.match(/icon\s+(\w+)/);
                                if (elementMatch) {
                                    const el = elementMatch[1];
                                    card.element = el.charAt(0).toUpperCase() + el.slice(1);
                                }
                            }
                            continue;
                        }
                        
                        const value = (await cells[1].textContent()).trim();
                        
                        switch (label) {
                            case 'type': card.type = value; break;
                            case 'job': card.job = value || null; break;
                            case 'cost': card.cost = parseInt(value) || value; break;
                            case 'power': card.power = parseInt(value) || value || null; break;
                            case 'serial type': card.rarity = this.rarityCodeToName(value); break;
                            case 'category': card.category = value; break;
                            case 'set': card.set = value; break;
                            case 'code': break; // Already have this
                        }
                    }
                } catch (e) {}
            }
            
            // Close overlay
            await this.page.click('.overlay .close').catch(() => {});
            await this.sleep(100);
            
        } catch (e) {
            this.log(`Error scraping ${cardCode}: ${e.message}`, 'warn');
            // Try to close overlay
            await this.page.click('.overlay .close').catch(() => {});
            await this.page.keyboard.press('Escape').catch(() => {});
        }
        
        return card;
    }
    
    // =========================================================================
    // IMAGES
    // =========================================================================
    
    async downloadImage(card) {
        if (!card.imageUrl) {
            this.log(`No imageUrl for ${card.code}`, 'debug');
            return false;
        }
        
        const imageDir = path.join(this.config.output.directory, this.config.output.imageSubdir);
        const filepath = path.join(imageDir, `${card.code}.jpg`);
        
        this.log(`Downloading: ${card.imageUrl} -> ${filepath}`, 'debug');
        
        try {
            // Ensure directory exists
            await fs.mkdir(imageDir, { recursive: true });
            
            // Use native fetch instead of page.request (more reliable)
            const response = await fetch(card.imageUrl);
            this.log(`Fetch response for ${card.code}: ${response.status} ${response.statusText}`, 'debug');
            
            if (response.ok) {
                const buffer = Buffer.from(await response.arrayBuffer());
                await fs.writeFile(filepath, buffer);
                this.log(`Saved ${card.code}.jpg (${buffer.length} bytes)`, 'debug');
                return true;
            } else {
                this.log(`Image download failed for ${card.code}: HTTP ${response.status}`, 'warn');
            }
        } catch (e) {
            this.log(`Image download error for ${card.code}: ${e.message}`, 'warn');
        }
        
        return false;
    }
    
    async downloadImages(cards) {
        const concurrent = this.config.images.concurrent;
        let success = 0, fail = 0;
        
        const imageDir = path.join(this.config.output.directory, this.config.output.imageSubdir);
        this.log(`Downloading ${cards.length} images to ${imageDir}...`, 'info');
        
        // Test first image URL
        if (cards.length > 0) {
            this.log(`First image URL: ${cards[0].imageUrl}`, 'info');
        }
        
        for (let i = 0; i < cards.length; i += concurrent) {
            const batch = cards.slice(i, i + concurrent);
            const results = await Promise.all(batch.map(c => this.downloadImage(c)));
            success += results.filter(r => r).length;
            fail += results.filter(r => !r).length;
            
            const pct = Math.round((i + batch.length) / cards.length * 100);
            this.log(`Images: ${pct}% (${success} ok, ${fail} failed)`, 'info');
        }
        
        this.log(`Downloaded ${success}/${cards.length} images`, 'success');
    }
    
    // =========================================================================
    // OUTPUT
    // =========================================================================
    
    async saveJson(cards, partial = false) {
        // Ensure directory exists
        await fs.mkdir(this.config.output.directory, { recursive: true });
        
        const filename = partial 
            ? this.config.output.jsonFilename.replace('.json', '_partial.json')
            : this.config.output.jsonFilename;
        const filepath = path.join(this.config.output.directory, filename);
        
        const output = {
            scraped_at: new Date().toISOString(),
            filters: this.config.filters,
            total: cards.length,
            complete: !partial,
            cards,
        };
        await fs.writeFile(filepath, JSON.stringify(output, null, 2));
        
        if (!partial) {
            this.log(`Saved ${cards.length} cards to ${filepath}`, 'success');
            
            // Remove partial file if it exists
            const partialPath = path.join(this.config.output.directory, 
                this.config.output.jsonFilename.replace('.json', '_partial.json'));
            try {
                await fs.unlink(partialPath);
            } catch (e) {} // Ignore if doesn't exist
        }
    }
    
    async saveIncremental() {
        // Save current progress
        if (this.cards.length > 0) {
            await this.saveJson(this.cards, true);
        }
    }
    
    printSummary() {
        this.log('=== SUMMARY ===', 'info');
        this.log(`Total: ${this.cards.length} cards`, 'info');
        
        const group = (attr) => {
            const counts = {};
            for (const c of this.cards) {
                const val = c[attr] || 'Unknown';
                counts[val] = (counts[val] || 0) + 1;
            }
            return counts;
        };
        
        this.log(`Sets: ${JSON.stringify(group('set'))}`, 'info');
        this.log(`Rarities: ${JSON.stringify(group('rarity'))}`, 'info');
        this.log(`Types: ${JSON.stringify(group('type'))}`, 'info');
    }
    
    // =========================================================================
    // MAIN
    // =========================================================================
    
    async run() {
        const startTime = Date.now();
        
        try {
            await this.init();
            await this.navigateToCardBrowser();
            await this.applyFilters();
            
            const cardCount = await this.loadAllCards();
            
            if (cardCount === 0) {
                this.log('No cards to scrape!', 'error');
                return [];
            }
            
            const cardCodes = await this.scrapeCardCodes();
            
            // Save card codes immediately so we don't lose them
            const codesPath = path.join(this.config.output.directory, 'card_codes.json');
            await fs.mkdir(this.config.output.directory, { recursive: true });
            await fs.writeFile(codesPath, JSON.stringify({ 
                scraped_at: new Date().toISOString(),
                filters: this.config.filters,
                total: cardCodes.length,
                codes: cardCodes 
            }, null, 2));
            this.log(`Card codes saved to ${codesPath}`, 'success');
            
            this.log(`Scraping details for ${cardCodes.length} cards...`, 'info');
            
            if (this.config.scraping.includeCardDetails) {
                const SAVE_INTERVAL = 10; // Save every 10 cards
                let imagesDownloaded = 0;
                
                for (let i = 0; i < cardCodes.length; i++) {
                    const card = await this.scrapeCardDetails(cardCodes[i]);
                    this.cards.push(card);
                    
                    // Download image immediately if enabled
                    if (this.config.output.downloadImages) {
                        const imgResult = await this.downloadImage(card);
                        if (imgResult) imagesDownloaded++;
                    }
                    
                    // Progress logging
                    if ((i + 1) % 20 === 0 || i === cardCodes.length - 1) {
                        const imgStatus = this.config.output.downloadImages ? `, ${imagesDownloaded} images` : '';
                        this.log(`Progress: ${i + 1}/${cardCodes.length} cards${imgStatus}`, 'info');
                    }
                    
                    // Incremental save every N cards
                    if ((i + 1) % SAVE_INTERVAL === 0) {
                        await this.saveIncremental();
                        this.log(`Progress saved (${this.cards.length} cards)`, 'debug');
                    }
                    
                    await this.sleep(this.config.scraping.delayBetweenCards);
                }
                
                // Images already downloaded incrementally, skip batch download
                if (this.config.output.downloadImages) {
                    this.log(`Images downloaded incrementally: ${imagesDownloaded}/${this.cards.length}`, 'success');
                }
            } else {
                this.cards = cardCodes.map(code => ({
                    code,
                    imageUrl: `https://fftcg.cdn.sewest.net/images/cards/full/${code}_eg.jpg`,
                }));
            }
            
            this.printSummary();
            
            if (this.config.output.saveJson) await this.saveJson(this.cards);
            
            // Only batch download images if we didn't download incrementally
            // (incremental download happens when includeCardDetails is true)
            if (this.config.output.downloadImages && !this.config.scraping.includeCardDetails) {
                await this.downloadImages(this.cards);
            }
            
            this.log(`Complete in ${((Date.now() - startTime) / 1000).toFixed(1)}s`, 'success');
            return this.cards;
            
        } catch (error) {
            this.log(`FATAL: ${error.message}`, 'error');
            console.error(error.stack);
            
            // Try to save whatever we have
            if (this.cards.length > 0) {
                this.log(`Attempting to save ${this.cards.length} cards before exit...`, 'warn');
                try {
                    await this.saveJson(this.cards, true);
                    this.log(`Emergency save complete: ${this.cards.length} cards saved to partial file`, 'success');
                } catch (saveError) {
                    this.log(`Could not save: ${saveError.message}`, 'error');
                }
            }
            
            throw error;
        } finally {
            await this.close();
        }
    }
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
    let config = {};
    
    const configIdx = process.argv.indexOf('--config');
    if (configIdx !== -1 && process.argv[configIdx + 1]) {
        try {
            config = JSON.parse(await fs.readFile(process.argv[configIdx + 1], 'utf8'));
            console.log(`📄 Loaded config: ${process.argv[configIdx + 1]}`);
        } catch (e) {
            console.error(`❌ Config error: ${e.message}`);
            process.exit(1);
        }
    }
    
    // CLI overrides
    if (process.argv.includes('--no-images')) config.output = { ...config.output, downloadImages: false };
    if (process.argv.includes('--no-details')) config.scraping = { ...config.scraping, includeCardDetails: false };
    if (process.argv.includes('--visible')) config.scraping = { ...config.scraping, headless: false };
    
    const setIdx = process.argv.indexOf('--set');
    if (setIdx !== -1 && process.argv[setIdx + 1]) {
        config.filters = { ...config.filters, sets: [process.argv[setIdx + 1]] };
    }
    
    const rarityIdx = process.argv.indexOf('--rarity');
    if (rarityIdx !== -1 && process.argv[rarityIdx + 1]) {
        config.filters = { ...config.filters, rarities: [process.argv[rarityIdx + 1]] };
    }
    
    const catIdx = process.argv.indexOf('--category');
    if (catIdx !== -1 && process.argv[catIdx + 1]) {
        config.filters = { ...config.filters, categories: [process.argv[catIdx + 1]] };
    }
    
    const scraper = new FFTCGScraper(config);
    await scraper.run();
}

module.exports = { FFTCGScraper, DEFAULT_CONFIG, FILTER_SELECTORS };

if (require.main === module) {
    main().catch(err => {
        console.error(`❌ Fatal: ${err.message}`);
        process.exit(1);
    });
}