# Facebook Bulk Unfriend (Chrome Extension)

Chrome **Side Panel** extension to bulk-unfriend on [facebook.com/friends/list](https://www.facebook.com/friends/list) using your **current Facebook session** (cookies + `fb_dtsg`) via internal AJAX/API — not UI menu clicks.

## Features

- **Session status box** — shows if `c_user` + `fb_dtsg` are OK
- **Select All** / **Unselect All** / **Exclude**
- Delay **3s / 5s / 8s** between API calls
- Start / Stop + live log

## Install

1. `chrome://extensions` → Developer mode → **Load unpacked**
2. Select this folder (or `dist/package`)
3. Open friends list → click extension icon → Side Panel
4. Confirm **Session OK** → Rescan → select → Start

## Notes

- Token never leaves `facebook.com` (same-origin requests only)
- Facebook may rate-limit or change internal endpoints
- Use on your own account at your own risk
