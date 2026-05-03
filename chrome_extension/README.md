# FundMe Smart Apply Extension

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this `chrome_extension` folder.

## Expected flow

1. In FundMe, open an opportunity and click `Apply Externally`.
2. The external application portal opens in a new tab.
3. Log in on the external portal.
4. When the application form appears, the extension automatically captures the visible fields, generates answers from the founder profile and opportunity data, and fills the form in place.
5. Review every answer, upload required files manually, and submit yourself.

The popup still supports the manual flow: diagnose the page, capture the form, generate answers, fill the portal, or run AI Smart Fill when a site uses unusual labels.

## Notes

- The extension reads the live page DOM only after the user is already on the external site.
- File uploads and final submission still need to be completed manually because browsers do not allow silent file injection into third-party forms and the extension intentionally does not submit applications for the user.
- The popup supports manual `User ID` and `Opportunity ID` entry if no staged session is found.
