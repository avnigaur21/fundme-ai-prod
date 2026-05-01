/* FundMe Core Logic */

document.addEventListener('DOMContentLoaded', () => {
    console.log('FundMe Platform Initialized');

    // Global Dark Mode Initialization
    const isLandingPage = window.location.pathname.endsWith('index.html') || window.location.pathname === '/' || window.location.pathname === '';
    if (localStorage.getItem('fundme-dark-mode') === 'true' && !isLandingPage) {
        document.body.classList.add('dark-mode');
    }

    // Collapsible Sidebar - Locked vs Auto Logic
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const dashboardLayout = document.querySelector('.dashboard-layout');

    if (sidebarToggle && dashboardLayout) {
        // Restore persisted preference
        const isLocked = localStorage.getItem('fundme-sidebar-locked') === 'true';
        const isExpanded = localStorage.getItem('fundme-sidebar-expanded') === 'true';

        if (isLocked) {
            dashboardLayout.classList.add('sidebar-locked');
            if (isExpanded) {
                dashboardLayout.classList.add('sidebar-expanded');
            } else {
                dashboardLayout.classList.remove('sidebar-expanded');
            }
        }

        const updateToggleAttributes = (expanded) => {
            sidebarToggle.setAttribute('title', expanded ? 'Collapse sidebar' : 'Expand sidebar');
            sidebarToggle.setAttribute('aria-label', expanded ? 'Collapse sidebar' : 'Expand sidebar');
        };

        // Initial attribute sync
        updateToggleAttributes(dashboardLayout.classList.contains('sidebar-expanded'));

        const handleSidebarToggle = (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Manual toggle sets the locked state to true
            dashboardLayout.classList.add('sidebar-locked');
            dashboardLayout.classList.toggle('sidebar-expanded');

            const nowExpanded = dashboardLayout.classList.contains('sidebar-expanded');
            localStorage.setItem('fundme-sidebar-locked', 'true');
            localStorage.setItem('fundme-sidebar-expanded', nowExpanded);
            
            updateToggleAttributes(nowExpanded);
        };

        sidebarToggle.addEventListener('click', handleSidebarToggle);

        // Make the entire header (Logo area) clickable too
        const sidebarHeader = document.querySelector('.sidebar-header');
        if (sidebarHeader) {
            sidebarHeader.addEventListener('click', handleSidebarToggle);
        }
    }

    // Sidebar Toggle (Mobile - hamburger)
    const menuToggle = document.getElementById('menu-toggle');
    const sidebar = document.getElementById('sidebar');

    if (menuToggle && sidebar) {
        menuToggle.addEventListener('click', (e) => {
            e.stopPropagation();
            sidebar.classList.toggle('open');
        });

        document.addEventListener('click', (e) => {
            if (window.innerWidth <= 768 &&
                sidebar.classList.contains('open') &&
                !sidebar.contains(e.target) &&
                e.target !== menuToggle) {
                sidebar.classList.remove('open');
            }
        });
    }

    // Filter Sidebar Toggle (Explorer)
    const filterToggle = document.getElementById('filter-toggle');
    const filterSidebar = document.getElementById('filter-sidebar');

    if (filterToggle && filterSidebar) {
        filterToggle.addEventListener('click', () => {
            filterSidebar.classList.toggle('open');
        });
    }

    // Sync save buttons across pages
    initSaveButtons();
});

/**
 * Toggle Save/Unsave status of an opportunity
 * @param {string} opportunityId
 * @param {HTMLElement} btn - The button element that was clicked
 */
async function toggleSave(opportunityId, btn) {
    if (!opportunityId) return;
    const isSaved = btn.getAttribute('data-saved') === 'true';
    const originalText = btn.innerText;

    btn.disabled = true;
    btn.innerText = isSaved ? 'Removing...' : 'Saving...';

    try {
        if (isSaved) {
            // Fetch saved items to find the saved_id for this opportunity
            const savedItems = await api.getSaved();
            const item = savedItems.find(s => s.opportunity_id === opportunityId);

            if (item && item.saved_id) {
                await api.unsaveOpp(item.saved_id);
            } else {
                // Fallback to the new explorer-based unsave if saved_id not found
                await api.unsaveOppByExplorer(opportunityId);
            }

            btn.innerText = 'Save';
            btn.classList.add('btn-outline');
            btn.classList.remove('btn-primary');
            btn.setAttribute('data-saved', 'false');
            
            // Special handling for saved.html: remove card if unsaved
            if (window.location.pathname.includes('saved.html')) {
                const card = btn.closest('.opp-card');
                if (card) card.remove();
            }
        } else {
            await api.saveOpp(opportunityId);
            btn.innerText = 'Saved';
            btn.classList.add('btn-primary');
            btn.classList.remove('btn-outline');
            btn.setAttribute('data-saved', 'true');
            
            // UX: Transition from 'Saved' (Success) to 'Unsave' (Actionable) after 2 seconds
            setTimeout(() => {
                if (btn.getAttribute('data-saved') === 'true') {
                    btn.innerText = 'Unsave';
                }
            }, 1000);
        }
    } catch (err) {
        console.error('Save Toggle Error:', err);
        alert('Failed to update saved status. Please try again.');
        btn.innerText = originalText;
    } finally {
        btn.disabled = false;
    }
}

/**
 * Sync all save buttons on the page with the current user's saved opportunities
 */
async function initSaveButtons() {
    const saveButtons = document.querySelectorAll('[data-save-btn]');
    if (saveButtons.length === 0 && !window.location.pathname.includes('saved.html')) return;

    try {
        const savedItems = await api.getSaved();
        const savedIds = new Set(savedItems.map(s => s.opportunity_id));

        saveButtons.forEach(btn => {
            const oppId = btn.getAttribute('data-opportunity-id');
            if (savedIds.has(oppId)) {
                btn.innerText = 'Unsave'; // Show immediate actionable text for already saved items
                btn.classList.add('btn-primary');
                btn.classList.remove('btn-outline');
                btn.setAttribute('data-saved', 'true');
            } else {
                btn.innerText = 'Save';
                btn.classList.add('btn-outline');
                btn.classList.remove('btn-primary');
                btn.setAttribute('data-saved', 'false');
            }
            
            btn.onclick = (e) => {
                e.preventDefault();
                toggleSave(oppId, btn);
            };
        });
        
        // If we are on saved.html, we might want to refresh the entire list dynamically
        // but for now let's just ensure the existing "Remove" buttons work.
        if (window.location.pathname.includes('saved.html')) {
            document.querySelectorAll('.opp-card').forEach(card => {
                const oppId = card.getAttribute('data-opportunity');
                const removeBtn = card.querySelector('.btn-outline');
                if (removeBtn && removeBtn.innerText === 'Remove') {
                    removeBtn.setAttribute('data-saved', 'true');
                    removeBtn.onclick = (e) => {
                        e.preventDefault();
                        toggleSave(oppId, removeBtn);
                    };
                }
            });
        }
    } catch (err) {
        console.error('Init Save Buttons Error:', err);
    }
}


/**
 * Format a deadline string (ISO date or special keywords) into a user-friendly format.
 * @param {string} deadline - e.g. "2026-10-15", "Rolling", "Closed"
 * @returns {string} - e.g. "15 Oct", "Rolling", "Closed"
 */
function formatDeadline(deadline) {
    if (!deadline) return '---';
    const specialKeywords = ['rolling', 'closed', 'as per challenge timeline', 'timeline based', 'rolling basis'];
    if (specialKeywords.includes(deadline.toLowerCase())) {
        return deadline;
    }

    try {
        const date = new Date(deadline);
        if (isNaN(date.getTime())) return deadline; // Return original if invalid
        
        const day = date.getDate();
        const month = date.toLocaleString('default', { month: 'short' });
        return `${day} ${month}`;
    } catch (e) {
        return deadline;
    }
}

/**
 * Cleans up raw scraped text to make it more readable (adds missing spaces, etc.)
 * @param {string} text 
 * @returns {string} cleaned text
 */
function formatScrapedText(text) {
    if (!text) return '';
    
    return text
        .replace(/([a-z])([A-Z0-9])/g, '$1 $2') // Add space between lowercase and uppercase/number
        .replace(/([0-9])([a-zA-Z])/g, '$1 $2') // Add space between number and letter
        .replace(/([\.!\?])([^\s])/g, '$1 $2') // Add space after period/etc if missing
        .replace(/\s+/g, ' ')                  // Collapse multiple spaces
        .trim();
}
