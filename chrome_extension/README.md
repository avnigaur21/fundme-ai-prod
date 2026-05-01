# FundMe Smart Apply Extension

## Load locally

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click `Load unpacked`.
4. Select this `chrome_extension` folder.

## Expected flow

1. In FundMe, open a draft and click `Stage Browser Assist`.
2. The external application portal opens in a new tab.
3. Log in on the external portal.
4. Open the extension popup.
5. Click `Capture Form`.
6. Click `Generate Answers`.
7. Click `Fill Portal`.

## Notes

- The extension reads the live page DOM only after the user is already on the external site.
- File uploads still need to be completed manually because browsers do not allow silent file injection into third-party forms.
- The popup supports manual `User ID` and `Opportunity ID` entry if no staged session is found.
