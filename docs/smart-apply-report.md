# FundMe Smart Apply Report

## What was built

- A schema-driven application draft system that no longer depends on hardcoded `o10` / `o11` templates.
- A new AI schema generation route for opportunities:
  - `POST /api/ai/generate-application-schema`
- A new draft bootstrap route that creates or refreshes drafts from either:
  - AI-inferred opportunity schemas
  - Chrome extension captures of live external forms
  - `POST /api/drafts/bootstrap`
- A draft lookup route by opportunity:
  - `GET /api/drafts/by-opportunity`
- Extension staging routes so FundMe can hand context to the Chrome extension:
  - `POST /api/extension/session`
  - `GET /api/extension/session`
- A stricter AI draft generation flow that now works from structured `form_schema` objects instead of loose field-label maps:
  - `POST /api/ai/generate-draft`
- Rebuilt draft UI pages:
  - `drafts.html`
  - `draft-generator.html`
  - `draft-preview.html`
- A Chrome extension in `chrome_extension/` that:
  - Captures the live application form after user login
  - Saves the schema back into FundMe
  - Requests AI-generated answers from FundMe
  - Fills the external portal fields back into the page

## Production intent

- The backend now treats the draft schema as the source of truth.
- The browser extension is intentionally thin: it reads and fills the page, while FundMe owns schema storage, answer generation, and progress state.
- Extension capture metadata and source URLs are persisted so later application-status tracking has a clean place to attach.

## Known limits

- Silent file upload is not implemented because browsers block automatic file injection into third-party file inputs.
- The platform still uses plaintext passwords and local JSON storage, which is not production-safe for real users.
- There is no authenticated extension handshake yet; staged sessions are keyed by external URL hostname and should be upgraded before public launch.
- Application submission tracking is not yet automated; the current work lays the storage and extension foundation for that next phase.

## Recommended next release steps

1. Move auth from plaintext JSON to a real database plus hashed passwords and sessions.
2. Replace `db.json` with Postgres or another transactional store before multi-user rollout.
3. Add authenticated extension tokens so the popup does not rely on manual IDs or hostname-only staged sessions.
4. Add application-status capture flows in the extension for confirmation pages, dashboards, and email-triggered updates.
