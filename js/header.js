/**
 * FundMe Header Management
 * Dynamically updates the header across all pages with user and startup data.
 */

async function updateUserHeader() {
    const user = getCurrentUser();
    if (!user || !user.user_id) return;

    // Update User Name / Company Name
    const nameEl = document.getElementById('header_user_name');
    const avatarEl = document.getElementById('header_user_avatar');
    const metaEl = document.getElementById('header_user_meta');
    const sidebarLogo = document.querySelector('.sidebar-logo');

    // Fetch Profile for Startup Info
    try {
        const profile = await api.getProfile();
        
        if (nameEl) {
            nameEl.innerText = profile.startup_name || user.name;
        }
        
        if (metaEl) {
            const sector = profile.sector || 'Early Stage';
            const stage = profile.stage || 'Stealth';
            metaEl.innerText = `${stage} • ${sector}`;
        }

        if (avatarEl) {
            avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.startup_name || user.name)}&background=0ea5e9&color=fff&size=32`;
            avatarEl.alt = profile.startup_name || user.name;
        }

        // Optional: Update Large Profile Sidebar (if it exists on current page)
        const lgName = document.querySelector('.profile-name-large');
        const lgAvatar = document.querySelector('.avatar-large');
        if (lgName) lgName.innerText = profile.startup_name || user.name;
        if (lgAvatar) {
            lgAvatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.startup_name || user.name)}&background=111827&color=fff&size=120`;
        }

    } catch (err) {
        console.warn('Could not fetch profile for header:', err);
        // Fallback to User Info
        if (nameEl) nameEl.innerText = user.name;
        if (avatarEl) {
            avatarEl.src = user.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=0ea5e9&color=fff&size=32`;
        }
    }
}

// Run on page load
document.addEventListener('DOMContentLoaded', updateUserHeader);
