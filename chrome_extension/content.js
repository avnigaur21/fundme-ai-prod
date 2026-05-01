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

function getVisibleFields(root = document) {
    const selector = 'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]';
    return Array.from(root.querySelectorAll(selector)).filter(field => {
        const style = window.getComputedStyle(field);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (field.closest('[aria-hidden="true"], [hidden], template')) return false;
        return true;
    });
}

function getFieldLabel(field) {
    if (!field) return '';

    const ariaLabel = field.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim();

    const ariaLabelledBy = field.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
        const text = ariaLabelledBy
            .split(/\s+/)
            .map(id => document.getElementById(id)?.textContent?.trim() || '')
            .filter(Boolean)
            .join(' ');
        if (text) return text;
    }

    if (field.id) {
        const explicit = document.querySelector(`label[for="${CSS.escape(field.id)}"]`);
        if (explicit?.textContent) return explicit.textContent.trim();
    }

    const wrappingLabel = field.closest('label');
    if (wrappingLabel?.textContent) return wrappingLabel.textContent.trim();

    const row = field.closest('[data-testid], .form-group, .field, .input-group, div, li, section, fieldset');
    if (row) {
        const nearby = row.querySelector('label, legend, strong, .label, .field-label');
        if (nearby?.textContent) return nearby.textContent.trim();
    }

    return field.placeholder || field.name || field.id || field.type || 'Application field';
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
    const candidates = explicitForms.length ? explicitForms : [document.body];
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
    return field.name || field.id || label || `field_${Math.random().toString(36).slice(2, 8)}`;
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

    const candidates = getVisibleFields();
    const wanted = String(field.label || '').trim().toLowerCase();
    return candidates.find(node => getFieldLabel(node).trim().toLowerCase() === wanted) || null;
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
        // Find the node by portalId (which could be name or id or label)
        const node = allVisible.find(n => n.name === portalId || n.id === portalId || getFieldLabel(n) === portalId);
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

// ─── MESSAGE LISTENERS ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
        if (message.type === 'extractFormSchema') {
            sendResponse(extractFormSchema());
            return true;
        }

        if (message.type === 'fillFormFields') {
            sendResponse(fillFormFields(message.schema, message.values));
            return true;
        }

        if (message.type === 'fillWithMapping') {
            sendResponse(fillWithMapping(message.mapping, message.values));
            return true;
        }
    } catch (err) {
        sendResponse({ error: err.message });
        return true;
    }

    return false;
});
