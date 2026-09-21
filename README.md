# LSK WhatsApp Bot Backend (Baileys)

This is a standalone Node.js + Baileys backend that connects to WhatsApp
and exposes the routes the LSK PHP site (`qrcode.html` and
`whatsapp_sender_curl.php`) needs.

## Routes exposed
- `GET  /qr-status` — used by qrcode.html to display the QR code / connection status
- `GET  /refresh-qr` — forces a new QR code
- `POST /api/php-broadcast/send` — used by whatsapp_sender_curl.php to send messages

## Local setup
```
npm install
PHP_BRIDGE_API_KEY=lsk2026secretkey987 node whatsapp_sender_clean.js
```

## Deploy to Render
1. Push this folder to a GitHub repo.
2. On Render.com: New + → Web Service → connect this repo.
3. Environment: Docker (uses the included Dockerfile).
4. Add an Environment Variable:
   - `PHP_BRIDGE_API_KEY` = `lsk2026secretkey987`
5. Deploy. Render will give you a URL like `https://your-service.onrender.com`.

## After deploying
Update these two files in the main LSK PHP project with your new Render URL:
- `qrcode.html` → `const BAILEYS_BASE_URL = 'https://your-service.onrender.com';`
- `whatsapp_sender_curl.php` → `$baileysApiUrl = 'https://your-service.onrender.com/api/php-broadcast/send';`

## Note
⚠️ Render's free tier has an ephemeral filesystem — the `auth_info` folder
(where your scanned WhatsApp session is saved) gets wiped on every
redeploy/restart. That means you'll need to re-scan the QR code after each
redeploy, unless you add a persistent disk in Render's paid tier.
