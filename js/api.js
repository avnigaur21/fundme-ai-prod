/**
 * FundMe API Helper
 * Shared fetch utility used by all pages.
 * Usage: import or include BEFORE page-specific scripts.
 */

const API_BASE = `${window.location.origin}/api`;

/** Get the current logged-in user_id from localStorage */
function getCurrentUserId() {
  return localStorage.getItem('fundme_user_id') || 'u1'; // 'u1' = demo fallback
}

/** Get the current user object from localStorage */
function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('fundme_user') || '{}');
  } catch {
    return {};
  }
}

/** Save login result to localStorage */
function setSession(user) {
  localStorage.setItem('fundme_user_id', user.user_id);
  localStorage.setItem('fundme_user', JSON.stringify(user));
}

/** Clear session (logout) */
function clearSession() {
  localStorage.removeItem('fundme_user_id');
  localStorage.removeItem('fundme_user');
}

/**
 * Core API fetch wrapper.
 * @param {string} endpoint - e.g. '/opportunities' or '/applications/a1'
 * @param {object} options  - standard fetch options (method, body, etc.)
 * @returns {Promise<any>}
 */
async function apiFetch(endpoint, options = {}) {
  const url = API_BASE + endpoint;
  const defaults = {
    headers: { 'Content-Type': 'application/json' },
  };
  const config = { ...defaults, ...options };
  if (config.body && typeof config.body === 'object') {
    config.body = JSON.stringify(config.body);
  }
  const res = await fetch(url, config);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'API error');
  }
  return res.json();
}

// ─── Convenience helpers ───────────────────────────────────────────────────────

const api = {
  // Auth
  signup: (data) => apiFetch('/signup', { method: 'POST', body: data }),
  login:  (data) => apiFetch('/login',  { method: 'POST', body: data }),

  // Opportunities - Automatically filter out closed ones
  getOpportunities: async (type) => {
    const opps = await apiFetch(`/opportunities${type ? `?type=${type}` : ''}`);
    const today = new Date();
    today.setHours(0,0,0,0);
    
    return opps.filter(o => {
      if (!o.deadline || o.deadline.toLowerCase() === 'rolling' || o.deadline.toLowerCase() === 'not specified') return true;
      const dDate = new Date(o.deadline);
      return dDate >= today;
    });
  },
  getOpportunity:   (id)   => apiFetch(`/opportunities/${id}`),

  // Saved
  getSaved:    ()   => apiFetch(`/saved?user_id=${getCurrentUserId()}`),
  saveOpp:     (opportunity_id) => apiFetch('/saved', { method: 'POST', body: { user_id: getCurrentUserId(), opportunity_id } }),
  unsaveOpp:   (saved_id)       => apiFetch(`/saved/${saved_id}`, { method: 'DELETE' }),
  unsaveOppByExplorer: (opportunity_id) => apiFetch(`/saved?user_id=${getCurrentUserId()}&opportunity_id=${opportunity_id}`, { method: 'DELETE' }),

  // Applications
  getApplications: ()   => apiFetch(`/applications?user_id=${getCurrentUserId()}`),
  getApplication:  (id) => apiFetch(`/applications/${id}`),
  createApplication: (opportunity_id, deadline) =>
    apiFetch('/applications', { method: 'POST', body: { user_id: getCurrentUserId(), opportunity_id, deadline } }),
  updateApplication: (id, data) =>
    apiFetch(`/applications/${id}`, { method: 'PUT', body: data }),

  // Drafts
  getDrafts: ()   => apiFetch(`/drafts?user_id=${getCurrentUserId()}`),
  getDraft:  (id) => apiFetch(`/drafts/${id}`),
  getDraftByOpportunity: (opportunity_id) => apiFetch(`/drafts/by-opportunity?user_id=${getCurrentUserId()}&opportunity_id=${opportunity_id}`),
  bootstrapDraft: ({ opportunity_id, source_url = '', form_schema = null, schema_source = 'manual', capture_meta = {} }) =>
    apiFetch('/drafts/bootstrap', {
      method: 'POST',
      body: { user_id: getCurrentUserId(), opportunity_id, source_url, form_schema, schema_source, capture_meta }
    }),
  updateDraft: (id, data) =>
    apiFetch(`/drafts/${id}`, { method: 'PUT', body: data }),

  // Founder Profile
  getProfile:    ()     => apiFetch(`/founder/profile?user_id=${getCurrentUserId()}`),
  createProfile: (data) => apiFetch('/founder/profile', { method: 'POST', body: { user_id: getCurrentUserId(), ...data } }),
  updateProfile: async (data) => {
    const res = await apiFetch('/founder/profile', { method: 'PUT',  body: { user_id: getCurrentUserId(), ...data } });
    // Invalidate match score cache when profile updates
    localStorage.removeItem(`fundme_matches_${getCurrentUserId()}`);
    return res;
  },

  // Match Scoring with Batching and Caching
  getBatchMatchScores: async (opportunities) => {
    const userId = getCurrentUserId();
    const cacheKey = `fundme_matches_${userId}`;
    let cache = {};
    try {
      cache = JSON.parse(localStorage.getItem(cacheKey) || '{}');
    } catch (e) { cache = {}; }

    // 1. Identify which ones need calculation (Fresh IDs or missing from cache)
    const toCalculate = opportunities.filter(o => !cache[o.opportunity_id]);
    
    if (toCalculate.length > 0) {
      try {
        const profile = await api.getProfile();
        const res = await apiFetch('/ai/match-opportunities', {
          method: 'POST',
          body: { profile, opportunities: toCalculate }
        });
        
        // 2. Update cache with new results
        if (res.result && Array.isArray(res.result)) {
          res.result.forEach(item => {
            cache[item.opportunity_id] = {
              score: item.score,
              timestamp: Date.now()
            };
          });
          localStorage.setItem(cacheKey, JSON.stringify(cache));
        }
      } catch (err) {
        console.error('Batch matching failed', err);
      }
    }

    // 3. Return combined results (cached + fresh)
    return opportunities.map(o => ({
      opportunity_id: o.opportunity_id,
      score: cache[o.opportunity_id] ? cache[o.opportunity_id].score : null
    }));
  },

  // User / Settings
  getUser:    ()     => apiFetch(`/user?user_id=${getCurrentUserId()}`),
  updateUser: (data) => apiFetch('/user', { method: 'PUT', body: { user_id: getCurrentUserId(), ...data } }),

  // Upload
  uploadFile: (file, doc_type) => {
    const form = new FormData();
    form.append('file', file);
    form.append('user_id', getCurrentUserId());
    form.append('doc_type', doc_type);
    return fetch(`${API_BASE}/upload`, { method: 'POST', body: form }).then(r => r.json());
  },

  // GET TOP MATCHES logic for Dashboard
  getTopMatches: (opportunities, limit = 5) => {
    const userId = getCurrentUserId();
    const cacheKey = `fundme_matches_${userId}`;
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(cacheKey) || '{}'); } catch (e) {}

    // Attach scores to opportunities
    const withScores = opportunities.map(o => ({
      ...o,
      _score: cache[o.opportunity_id] ? cache[o.opportunity_id].score : -1 // -1 for unscored
    }));

    // Sort by score descending
    withScores.sort((a, b) => b._score - a._score);
    
    // Return top N
    return withScores.slice(0, limit);
  },

  // AI Drafting
  generateApplicationSchema: (opportunity_id, source_url = '') =>
    apiFetch('/ai/generate-application-schema', {
      method: 'POST',
      body: { opportunity_id, source_url }
    }),
  generateDraftAnswers: ({ profile, form_schema, opportunity }) =>
    apiFetch('/ai/generate-draft', {
      method: 'POST',
      body: { profile, form_schema, opportunity }
    }),

  // Extension support
  stageExtensionSession: (opportunity_id, external_url) =>
    apiFetch('/extension/session', {
      method: 'POST',
      body: { user_id: getCurrentUserId(), opportunity_id, external_url }
    })
};
