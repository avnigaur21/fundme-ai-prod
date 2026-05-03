function cssPathFor(element) {
    if (!(element instanceof Element)) return '';
    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
        let selector = current.nodeName.toLowerCase();
        if (current.id) {
            selector += `#${CSS.escape(current.id)}`;
            parts.unshift(selector);
            break;
        }

        if (current.name) selector += `[name="${CSS.escape(current.name)}"]`;
        parts.unshift(selector);
        current = current.parentElement;
    }

    return parts.join(' > ');
}

function queryAllPiercing(selector, root = document) {
    const results = Array.from(root.querySelectorAll(selector));
    const elementsWithShadow = Array.from(root.querySelectorAll('*')).filter(el => el.shadowRoot);
    elementsWithShadow.forEach(el => {
        results.push(...queryAllPiercing(selector, el.shadowRoot));
    });
    return results;
}

function getVisibleFields(root = document) {
    const selector = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]';
    return queryAllPiercing(selector, root).filter(field => {
        const style = window.getComputedStyle(field);

        // Relaxed visibility check: Some enterprise forms use tiny or slightly transparent fields
        // We only filter out truly 'none' or 'hidden' unless they have a usable name/id
        const isInvisible = style.display === 'none' || style.visibility === 'hidden';
        const name = field.getAttribute('name') || field.id || '';

        if (isInvisible && name.length < 3) return false;

        const rect = field.getBoundingClientRect();
        const isTiny = rect.width <= 1 && rect.height <= 1;
        const type = (field.type || '').toLowerCase();
        const isSpecial = ['radio', 'checkbox', 'select-one', 'select-multiple'].includes(type) || field.tagName === 'SELECT';

        // Only filter out tiny fields if they lack identifying attributes
        if (isTiny && !isSpecial && name.length < 3 && !field.placeholder) return false;

        if (field.closest('template')) return false;
        return true;
    });
}

function cleanLabel(text) {
    if (!text) return '';
    let cleaned = text
        .replace(/\b(Required|Optional|Validate|Check|Help)\b/gi, '')
        .replace(/[*:]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    // Enterprise Pattern Cleaning:
    // If we have "Full Name First name", strip "Full Name" to leave "First name"
    const genericPrefixes = /^(Full Name|Name|Contact|Company|Startup|Organization|Address|User)\s+/i;
    if (genericPrefixes.test(cleaned)) {
        const sub = cleaned.replace(genericPrefixes, '').trim();
        const specificDescriptors = /^(First|Last|Middle|Given|Family|Email|Phone|Mobile|Website|Street|City|State|Zip|Postal|Country|Title|Position)/i;
        if (sub.length > 1 && specificDescriptors.test(sub)) {
            return sub;
        }
    }

    return cleaned;
}

function getFieldLabel(field) {
    if (!field) return '';

    // 1. Explicit ARIA Label
    const ariaLabel = field.getAttribute('aria-label');
    if (ariaLabel) return cleanLabel(ariaLabel);

    // 2. ARIA LabelledBy (Piercing)
    const ariaLabelledBy = field.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
        const ids = ariaLabelledBy.split(/\s+/);
        const parts = ids
            .map(id => {
                // Try global then shadow-piercing if needed
                const el = document.getElementById(id) || queryAllPiercing(`[id="${CSS.escape(id)}"]`)[0];
                return el?.textContent?.trim() || '';
            })
            .filter(Boolean);

        if (parts.length > 1) {
            const first = parts[0].toLowerCase();
            const last = parts[parts.length - 1].toLowerCase();
            const generic = ['full name', 'name', 'address', 'date', 'location', 'contact', 'details'];
            if (generic.some(c => first.includes(c))) {
                if (last.includes('first') || last.includes('last') || last.includes('middle') || last.includes('street')) {
                    return cleanLabel(parts[parts.length - 1]);
                }
            }
        }
        const text = parts.join(' ');
        if (text) return cleanLabel(text);
    }

    // 3. Explicit Label for ID
    if (field.id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (explicit?.textContent) return cleanLabel(explicit.textContent);
    }

    // 4. Wrapping Label
    const wrappingLabel = field.closest('label');
    if (wrappingLabel?.textContent) return cleanLabel(wrappingLabel.textContent);

    // 5. Parent/Container Text Search (Deeper)
    let container = field.parentElement;
    for (let i = 0; i < 3 && container; i++) {
        // Look for specific label-like elements in this container
        const labelEl = container.querySelector('label, legend, .label, .field-label, [class*="label"], [class*="title"]');
        if (labelEl && labelEl !== field && labelEl.textContent.trim().length > 1) {
            return cleanLabel(labelEl.textContent);
        }

        // If it's a Zoho-style sublabel container
        const subLabel = container.querySelector('em, small, .sublabel, [class*="sub-label"]');
        if (subLabel && subLabel.textContent.trim().length > 1) {
            return cleanLabel(subLabel.textContent);
        }
        container = container.parentElement;
    }

    // 6. Nearest Preceding Text Node (Last Resort)
    const row = field.closest('[data-testid], .form-group, .field, .input-group, tr, div');
    if (row) {
        const text = row.innerText || row.textContent;
        const clean = text.split('\n')[0].trim(); // Take first line
        if (clean && clean.length > 1 && clean.length < 100) return cleanLabel(clean);
    }

    // 7. Attribute Fallbacks
    const placeholder = field.getAttribute('placeholder');
    if (placeholder && placeholder.length > 1) return cleanLabel(placeholder);

    const name = field.getAttribute('name');
    if (name && name.length > 1) return cleanLabel(name.replace(/[_-]/g, ' '));

    const id = field.id;
    if (id && id.length > 1 && !/\d{5,}/.test(id)) return cleanLabel(id.replace(/[_-]/g, ' '));

    return 'Application Field';
}

function getSectionTitle(field) {
    const fieldset = field.closest('fieldset');
    const legend = fieldset?.querySelector('legend');
    if (legend?.textContent?.trim()) return legend.textContent.trim();

    const section = field.closest('section, [role="group"], form, .modal, main, article, div');
    const heading = section?.querySelector('h1, h2, h3, h4');
    return heading?.textContent?.trim() || 'Application Details';
}

function normalizeOptionValues(select) {
    return Array.from(select.options || [])
        .map(option => option.textContent.trim())
        .filter(Boolean);
}

function getFormRoots() {
    const explicitForms = Array.from(document.querySelectorAll('form, [role="form"]'));
    const candidates = [...explicitForms, document.querySelector('main') || document.body];
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const scored = candidates.map(root => {
        const fields = getVisibleFields(root);
        let score = fields.length;

        fields.forEach(field => {
            const type = (field.type || field.tagName).toLowerCase();
            if (field.required) score += 2;
            if (type === 'textarea' || type === 'select') score += 2;
            if (type === 'email' || type === 'tel' || type === 'url') score += 1;
        });

        if (activeElement && root.contains(activeElement)) score += 10;
        return { root, fields, score };
    }).filter(item => item.fields.length > 0);

    scored.sort((a, b) => b.score - a.score);
    return scored;
}

function chooseBestRoot() {
    const roots = getFormRoots();
    return roots[0] || { root: document.body, fields: getVisibleFields(document.body), score: 0 };
}

function getDescriptorId(field, label) {
    const base = (field.name || field.id || 'f').replace(/[^a-zA-Z0-9]/g, '_');
    const labelSlug = label ? label.toLowerCase().trim().replace(/[^a-z0-9]/g, '_').slice(0, 15) : '';
    const placeholder = (field.getAttribute('placeholder') || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '_').slice(0, 10);

    // Build a specific ID combining base, label, and placeholder
    let finalId = base;
    if (labelSlug && !finalId.toLowerCase().includes(labelSlug)) {
        finalId += `_${labelSlug}`;
    }
    if (placeholder && !finalId.toLowerCase().includes(placeholder)) {
        finalId += `_${placeholder}`;
    }

    // Ensure it's not just "name" or something generic
    if (finalId.length < 3) finalId = `field_${finalId}_${field.type || 'input'}`;

    return finalId;
}

function dedupeDescriptors(fields) {
    const seen = new Set();
    return fields.filter(field => {
        const key = `${field.id}::${field.label}::${field.section}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function extractFormSchema() {
    const bestRoot = chooseBestRoot();
    const sections = new Map();
    const radioGroups = new Map();
    let fieldCount = 0;

    bestRoot.fields.forEach(field => {
        const tag = field.tagName.toLowerCase();
        const type = (field.type || tag).toLowerCase();
        const sectionTitle = getSectionTitle(field);
        const label = getFieldLabel(field);
        const id = getDescriptorId(field, label);

        if (type === 'radio') {
            const groupKey = field.name || id;
            const entry = radioGroups.get(groupKey) || {
                id: groupKey,
                label,
                type: 'select',
                required: field.required,
                placeholder: '',
                help_text: '',
                options: [],
                section: sectionTitle,
                selectorHints: {
                    name: field.name || '',
                    id: field.id || '',
                    css: cssPathFor(field)
                }
            };

            const optionText = field.value || label || 'Option';
            entry.options.push(optionText);
            radioGroups.set(groupKey, entry);
            return;
        }

        const descriptor = {
            id,
            label,
            type: tag === 'textarea' ? 'textarea' : (tag === 'select' ? 'select' : (tag === 'div' ? 'textarea' : type)),
            required: field.required,
            placeholder: field.placeholder || '',
            name: field.name || '',
            help_text: '',
            options: tag === 'select' ? normalizeOptionValues(field) : [],
            section: sectionTitle,
            selectorHints: {
                name: field.name || '',
                id: field.id || '',
                css: cssPathFor(field)
            }
        };

        if (!sections.has(sectionTitle)) sections.set(sectionTitle, []);
        sections.get(sectionTitle).push(descriptor);
        fieldCount += 1;
    });

    radioGroups.forEach(entry => {
        if (!sections.has(entry.section)) sections.set(entry.section, []);
        entry.options = Array.from(new Set(entry.options.filter(Boolean)));
        sections.get(entry.section).push(entry);
        fieldCount += 1;
    });

    const normalizedSections = Array.from(sections.entries()).map(([title, fields]) => ({
        title,
        fields: dedupeDescriptors(fields)
    })).filter(section => section.fields.length > 0);

    return {
        schema: {
            title: `${document.title} Application`,
            subtitle: `Captured from ${location.hostname}`,
            sections: normalizedSections,
            required_documents: []
        },
        fieldCount,
        pageTitle: document.title,
        selectedRootTag: bestRoot.root.tagName?.toLowerCase() || 'body',
        selectedRootScore: bestRoot.score
    };
}

function matchFieldNode(field) {
    const candidates = getVisibleFields();
    
    // 1. Exact descriptor match (most reliable for disambiguating identical names)
    const exactNode = candidates.find(node => getDescriptorId(node, getFieldLabel(node)) === field.id);
    if (exactNode) return exactNode;

    const hints = field.selectorHints || {};
    if (hints.id) {
        const byId = document.getElementById(hints.id);
        if (byId) return byId;
    }

    if (hints.name) {
        const byName = document.querySelector(`[name="${CSS.escape(hints.name)}"]`);
        if (byName) return byName;
    }

    if (hints.css) {
        try {
            const byCss = document.querySelector(hints.css);
            if (byCss) return byCss;
        } catch (err) {
            void err;
        }
    }

    const wanted = cleanLabel(field.label || '').toLowerCase();
    return candidates.find(node => {
        const got = cleanLabel(getFieldLabel(node)).toLowerCase();
        return got === wanted || (got.length > 3 && wanted.includes(got)) || (wanted.length > 3 && got.includes(wanted));
    }) || null;
}

function setNativeValue(node, value) {
    const prototype = node.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor?.set) {
        descriptor.set.call(node, value);
    } else {
        node.value = value;
    }
}

function dispatchValueEvents(node) {
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.dispatchEvent(new Event('blur', { bubbles: true }));
}

function fillFormFields(schema, values) {
    let filledCount = 0;
    const unmatched = [];
    const fields = (schema?.sections || []).flatMap(section => section.fields || []);

    fields.forEach(field => {
        const node = matchFieldNode(field);
        const value = values?.[field.id];
        if (!node || value === undefined || value === null || value === '') {
            unmatched.push(field.label || field.id);
            return;
        }

        if (field.type === 'checkbox') {
            const shouldCheck = value === true || value === 'true';
            if (node.checked !== shouldCheck) node.click();
            dispatchValueEvents(node);
            filledCount += 1;
            return;
        }

        if (node.tagName.toLowerCase() === 'select') {
            const options = Array.from(node.options || []);
            const wanted = String(value).trim().toLowerCase();
            const match = options.find(option =>
                option.value.trim().toLowerCase() === wanted ||
                option.textContent.trim().toLowerCase() === wanted ||
                option.textContent.trim().toLowerCase().includes(wanted)
            );
            if (match) {
                node.value = match.value;
                dispatchValueEvents(node);
                filledCount += 1;
            } else {
                unmatched.push(field.label || field.id);
            }
            return;
        }

        if (node.type === 'radio') {
            const radios = document.querySelectorAll(`[name="${CSS.escape(node.name)}"]`);
            const wanted = String(value).trim().toLowerCase();
            const match = Array.from(radios).find(radio =>
                radio.value.trim().toLowerCase() === wanted ||
                getFieldLabel(radio).trim().toLowerCase() === wanted
            );
            if (match) {
                if (!match.checked) match.click();
                dispatchValueEvents(match);
                filledCount += 1;
            } else {
                unmatched.push(field.label || field.id);
            }
            return;
        }

        if (node.isContentEditable) {
            node.focus();
            node.textContent = String(value);
            dispatchValueEvents(node);
            filledCount += 1;
            return;
        }

        node.focus();
        setNativeValue(node, String(value));
        dispatchValueEvents(node);
        filledCount += 1;
    });

    return { filledCount, unmatched };
}

// ─── AUTO-CAPTURE LOGIC ───────────────────────────────────────────────────────

let stagedSession = null;
let knownFields = new Set();
let reactiveWatcherActive = false;

function startReactiveWatcher(payload) {
    if (reactiveWatcherActive) return;
    reactiveWatcherActive = true;

    const { userId, opportunityId, baseUrl } = payload;
    const API_BASE = `${baseUrl}/api`;

    // Initialize known fields with what's already visible
    getVisibleFields().forEach(field => {
        const id = getDescriptorId(field, getFieldLabel(field));
        knownFields.add(id);
    });

    console.log('👀 FundMe: Reactive watcher armed for conditional fields.');

    let debounceTimer;
    const observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(async () => {
            const allVisible = getVisibleFields();
            const newFields = allVisible.filter(field => {
                const id = getDescriptorId(field, getFieldLabel(field));
                return !knownFields.has(id);
            });

            if (newFields.length > 0) {
                console.log(`🚀 FundMe: Detected ${newFields.length} new conditional field(s).`);
                showCaptureToast(`Detected ${newFields.length} new field(s). Preparing answers...`, 'info');

                // Update known fields immediately to prevent double-triggering
                newFields.forEach(field => {
                    knownFields.add(getDescriptorId(field, getFieldLabel(field)));
                });

                try {
                    // 1. Extract schema for new fields only
                    const tempRoot = { root: document.body, fields: newFields, score: 0 };
                    const schemaResult = extractFormSchemaFromRoot(tempRoot);

                    // 2. Fetch context if missing (we need profile and opportunity)
                    const [profile, opportunity] = await Promise.all([
                        fetch(`${API_BASE}/founder/profile?user_id=${encodeURIComponent(userId)}`).then(r => r.json()),
                        fetch(`${API_BASE}/opportunities/${encodeURIComponent(opportunityId)}`).then(r => r.json())
                    ]);

                    // 3. Generate answers for new fields
                    const generated = await fetch(`${API_BASE}/ai/generate-draft`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            profile,
                            form_schema: schemaResult.schema,
                            opportunity
                        })
                    }).then(r => r.json());

                    if (generated.result) {
                        const fillResult = fillFormFields(schemaResult.schema, generated.result);
                        if (fillResult.filledCount > 0) {
                            showCaptureToast(`Auto-filled ${fillResult.filledCount} new conditional field(s).`, 'success');
                        }
                    }
                } catch (err) {
                    console.error('Failed to reactive fill new fields:', err);
                }
            }
        }, 800);
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden']
    });
}

function extractFormSchemaFromRoot(bestRoot) {
    const sections = new Map();
    const radioGroups = new Map();
    let fieldCount = 0;

    bestRoot.fields.forEach(field => {
        const tag = field.tagName.toLowerCase();
        const type = (field.type || tag).toLowerCase();
        const sectionTitle = getSectionTitle(field);
        const label = getFieldLabel(field);
        const id = getDescriptorId(field, label);

        if (type === 'radio') {
            const groupKey = field.name || id;
            const entry = radioGroups.get(groupKey) || {
                id: groupKey,
                label,
                type: 'select',
                required: field.required,
                placeholder: '',
                help_text: '',
                options: [],
                section: sectionTitle,
                selectorHints: {
                    name: field.name || '',
                    id: field.id || '',
                    css: cssPathFor(field)
                }
            };

            const optionText = field.value || label || 'Option';
            entry.options.push(optionText);
            radioGroups.set(groupKey, entry);
            return;
        }

        const descriptor = {
            id,
            label,
            type: tag === 'textarea' ? 'textarea' : (tag === 'select' ? 'select' : (tag === 'div' ? 'textarea' : type)),
            required: field.required,
            placeholder: field.placeholder || '',
            help_text: '',
            options: tag === 'select' ? normalizeOptionValues(field) : [],
            section: sectionTitle,
            selectorHints: {
                name: field.name || '',
                id: field.id || '',
                css: cssPathFor(field)
            }
        };

        if (!sections.has(sectionTitle)) sections.set(sectionTitle, []);
        sections.get(sectionTitle).push(descriptor);
        fieldCount += 1;
    });

    radioGroups.forEach(entry => {
        if (!sections.has(entry.section)) sections.set(entry.section, []);
        entry.options = Array.from(new Set(entry.options.filter(Boolean)));
        sections.get(entry.section).push(entry);
        fieldCount += 1;
    });

    const normalizedSections = Array.from(sections.entries()).map(([title, fields]) => ({
        title,
        fields: dedupeDescriptors(fields)
    })).filter(section => section.fields.length > 0);

    return {
        schema: {
            title: `${document.title} Application`,
            subtitle: `Captured from ${location.hostname}`,
            sections: normalizedSections,
            required_documents: []
        },
        fieldCount
    };
}

const SUCCESS_PATTERNS = [
    /thank\s*you/i,
    /submitted/i,
    /success/i,
    /application\s*received/i,
    /done/i,
    /confirm/i
];

async function checkStagedSession() {
    try {
        const url = window.location.href;
        const settings = await chrome.storage.local.get(['fundmeBaseUrl']);
        const baseUrl = (settings.fundmeBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
        const API_BASE = `${baseUrl}/api`;

        const res = await fetch(`${API_BASE}/extension/session?external_url=${encodeURIComponent(url)}`);
        if (res.ok) {
            stagedSession = await res.json();
            console.log('🎯 FundMe: Staged session found!', stagedSession);

            // Check for fields
            const fields = getVisibleFields();
            if (fields.length === 0) {
                // No fields? Look for navigation hints
                const applyBtn = Array.from(document.querySelectorAll('a, button')).find(el =>
                    /apply|register|start application|fill form/i.test(el.innerText || el.textContent || '')
                );
                if (applyBtn) {
                    applyBtn.style.outline = '4px solid #0ea5e9';
                    applyBtn.style.outlineOffset = '4px';
                    showCaptureToast('Form not found here. Try clicking the highlighted "Apply" button to reach the portal.', 'info');
                } else {
                    showCaptureToast(`Tracking session active for ${stagedSession.opportunity_id}. Head to the application portal to fill fields.`);
                }
                return;
            }

            // AUTOMATION: Try to fetch draft and auto-fill
            try {
                const draftRes = await fetch(`${API_BASE}/drafts/by-opportunity?user_id=${encodeURIComponent(stagedSession.user_id)}&opportunity_id=${encodeURIComponent(stagedSession.opportunity_id)}`);
                if (draftRes.ok) {
                    const draft = await draftRes.json();
                    if (draft && draft.form_fields && Object.keys(draft.form_fields).length > 0) {
                        console.log('🪄 FundMe: Auto-filling fields from draft...');
                        const result = fillFormFields(draft.form_schema, draft.form_fields);
                        if (result.filledCount > 0) {
                            showCaptureToast(`Auto-filled ${result.filledCount} fields for ${stagedSession.opportunity_id}`, 'success');
                        } else {
                            showCaptureToast(`Found the form! Use the FundMe popup to "Fill Portal" if auto-fill didn't catch everything.`);
                        }
                    }
                }
            } catch (draftErr) {
                showCaptureToast(`Ready to fill application for ${stagedSession.opportunity_id}`);
            }
        }
    } catch (err) {
        // Silent fail if no session or server down
    }
}

function showCaptureToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 12px 20px;
        background: ${type === 'success' ? '#10b981' : '#0ea5e9'};
        color: white;
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        z-index: 999999;
        font-family: system-ui, -apple-system, sans-serif;
        font-size: 14px;
        font-weight: 500;
        transition: all 0.3s ease;
        transform: translateY(100px);
        display: flex;
        align-items: center;
        gap: 10px;
    `;
    toast.innerHTML = `
        <span style="font-size: 18px;">${type === 'success' ? '✅' : '🚀'}</span>
        <span>${message}</span>
    `;
    document.body.appendChild(toast);

    // Animate in
    setTimeout(() => toast.style.transform = 'translateY(0)', 100);

    // Auto remove
    setTimeout(() => {
        toast.style.transform = 'translateY(100px)';
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

function detectSubmission() {
    // Listen for clicks on anything that looks like a submit button
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button, input[type="submit"], [role="button"]');
        if (!btn) return;

        const text = btn.innerText || btn.value || '';
        const isSubmit = /submit|apply|send|confirm|finish/i.test(text);

        if (isSubmit && stagedSession) {
            console.log('🚀 FundMe: Potential submission detected. Monitoring for success...');
            monitorForSuccess();
        }
    }, true);
}

function monitorForSuccess() {
    const observer = new MutationObserver((mutations, obs) => {
        const bodyText = document.body.innerText;
        const hasSuccess = SUCCESS_PATTERNS.some(pattern => pattern.test(bodyText));

        if (hasSuccess) {
            console.log('✅ FundMe: Submission success confirmed!');
            obs.disconnect();
            handleSuccess();
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    // Timeout after 30 seconds if no success found
    setTimeout(() => observer.disconnect(), 30000);
}

async function handleSuccess() {
    if (!stagedSession) return;

    try {
        const settings = await chrome.storage.local.get(['fundmeBaseUrl']);
        const baseUrl = (settings.fundmeBaseUrl || 'http://localhost:3000').replace(/\/$/, '');
        const API_BASE = `${baseUrl}/api`;

        const res = await fetch(`${API_BASE}/applications`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: stagedSession.user_id,
                opportunity_id: stagedSession.opportunity_id,
                status: 'Applied',
                timeline: [{ stage: 'Applied', date: new Date().toISOString().slice(0, 10), note: 'Auto-captured by FundMe Extension' }]
            })
        });

        if (res.ok) {
            showCaptureToast('Application auto-captured and moved to tracking!', 'success');
            stagedSession = null; // Clear to prevent double capture
        }
    } catch (err) {
        console.error('Failed to auto-capture application', err);
    }
}

function fillWithMapping(mapping, values) {
    let filledCount = 0;
    const allVisible = getVisibleFields();

    Object.entries(mapping).forEach(([portalId, draftId]) => {
        // Find the node by regenerating its unique descriptor ID
        const node = allVisible.find(n => getDescriptorId(n, getFieldLabel(n)) === portalId);
        const value = values?.[draftId];

        if (node && value !== undefined && value !== null && value !== '') {
            node.focus();
            setNativeValue(node, String(value));
            dispatchValueEvents(node);
            filledCount += 1;
        }
    });

    return { filledCount };
}

// ─── INITIALIZATION ───────────────────────────────────────────────────────────

checkStagedSession();
detectSubmission();

// ─── WEB APP HANDSHAKE ───────────────────────────────────────────────────────
document.documentElement.dataset.fundmeExtensionInstalled = 'true';

window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source === 'fundme-web' && event.data?.type === 'FUNDME_EXTENSION_PING') {
        window.postMessage({
            source: 'fundme-extension',
            type: 'FUNDME_EXTENSION_PONG',
            version: '1.0.0'
        }, '*');
    }

    if (event.data.type === 'FUNDME_STASH_SESSION') {
        const { user_id, opportunity_id, baseUrl } = event.data;
        chrome.storage.local.set({
            fundmeUserId: user_id,
            fundmeOpportunityId: opportunity_id,
            fundmeBaseUrl: baseUrl || 'http://localhost:3000'
        });
        console.log('✅ FundMe: Session context stashed in local storage');
    }
});

// ─── MESSAGE LISTENERS ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
        if (message.type === 'BROADCAST_EXTRACT_SCHEMA') {
            console.log('📬 FundMe: Received BROADCAST_EXTRACT_SCHEMA');
            const schema = extractFormSchema();
            console.log('📬 FundMe: Extracted schema, fieldCount:', schema.fieldCount);
            chrome.runtime.sendMessage({ type: 'SCHEMA_RESPONSE', schema });
            return false; // No direct response needed
        }

        if (message.type === 'BROADCAST_FILL_FIELDS') {
            const result = fillFormFields(message.schema, message.values);
            chrome.runtime.sendMessage({ type: 'FILL_RESPONSE', result });
            return false;
        }

        if (message.type === 'BROADCAST_FILL_MAPPING') {
            const result = fillWithMapping(message.mapping, message.values);
            chrome.runtime.sendMessage({ type: 'FILL_RESPONSE', result });
            return false;
        }

        if (message.type === 'BROADCAST_START_WATCHER') {
            startReactiveWatcher(message.payload);
            return false;
        }

        // Keep old handlers for backwards compatibility during reload
        if (message.type === 'extractFormSchema') {
            const schema = extractFormSchema();
            if (schema.fieldCount > 0) {
                sendResponse(schema);
            } else {
                setTimeout(() => sendResponse(schema), 800);
            }
            return true;
        }

        if (message.type === 'fillFormFields') {
            const result = fillFormFields(message.schema, message.values);
            if (result.filledCount > 0) {
                sendResponse(result);
            } else {
                setTimeout(() => sendResponse(result), 800);
            }
            return true;
        }

        if (message.type === 'fillWithMapping') {
            const result = fillWithMapping(message.mapping, message.values);
            if (result.filledCount > 0) {
                sendResponse(result);
            } else {
                setTimeout(() => sendResponse(result), 800);
            }
            return true;
        }
    } catch (err) {
        console.error('FundMe: Message listener error', err);
        if (message.type && !message.type.startsWith('BROADCAST_')) {
            try { sendResponse({ error: err.message }); } catch (e) { }
        }
        return false;
    }

    return false;
});
