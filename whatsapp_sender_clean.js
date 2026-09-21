/**
 * whatsapp_sender_clean.js
 * -------------------------------------------------------------------------
 * Node.js + Baileys backend for the LSK WhatsApp bot.
 *
 * This is the service qrcode.html and whatsapp_sender_curl.php talk to.
 * It exposes exactly the routes those two files already expect, so
 * NOTHING on the PHP or HTML side needs to change:
 *
 *   GET  /qr-status
 *        -> { qrCode: "<raw baileys qr string>" }        while waiting
 *        -> { connected: true,  number: "9198xxxxxxx" }  once linked
 *        -> { connected: false }                          just started
 *
 *   GET  /refresh-qr
 *        Forces the current socket to close and reconnect, which makes
 *        Baileys issue a brand-new QR string.
 *
 *   POST /api/php-broadcast/send
 *        Header: x-api-key: <PHP_BRIDGE_API_KEY>
 *        Body:   { "recipients": [ { "name", "phone", "message" }, ... ] }
 *        -> { success: true, sent, failed, results: [ {name,status,error?} ] }
 *        This is the exact contract whatsapp_sender_curl.php already sends
 *        to and parses from $baileysApiUrl.
 *
 * Setup:
 *   npm install
 *   PHP_BRIDGE_API_KEY=lsk2026secretkey987 node whatsapp_sender_clean.js
 *
 * The WhatsApp session is saved to ./auth_info (via useMultiFileAuthState),
 * so once you scan the QR once, restarting this process will NOT ask you
 * to scan again — it reconnects automatically using the saved session.
 * -------------------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const pino = require('pino');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

// ---- Config ---------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = process.env.AUTH_FOLDER || './auth_info';
// Must match $baileysApiKey in whatsapp_sender_curl.php.
const PHP_BRIDGE_API_KEY = process.env.PHP_BRIDGE_API_KEY || 'lsk2026secretkey987';

// ---- In-memory connection state, read by GET /qr-status -------------------
const state = {
    qrCode: null,       // raw string from Baileys' 'qr' event, or null
    connected: false,
    number: null,       // e.g. "919876543210"
};

// ---- In-memory broadcast progress, read by GET /broadcast-progress --------
// Lets the PHP/frontend show a live "X% sent" loader while a single
// /api/php-broadcast/send request is still running (it can take a couple of
// minutes for a large batch because of the human-like delay between sends).
const broadcastProgress = {
    inProgress: false,
    total: 0,
    sent: 0,
    failed: 0,
};

let sock = null;
let starting = false; // guards against overlapping start() calls from /refresh-qr

async function startBaileys() {
    if (starting) return;
    starting = true;

    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: authState,
        // Keep Baileys' own console output quiet; our routes report status.
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            state.qrCode = qr;
            state.connected = false;
            state.number = null;
            console.log('[Baileys] New QR code issued — scan it from /qr-status.');
        }

        if (connection === 'open') {
            state.qrCode = null;
            state.connected = true;
            // sock.user.id looks like "919876543210:12@s.whatsapp.net"
            const rawId = sock.user && sock.user.id ? sock.user.id : '';
            state.number = rawId.split(':')[0].split('@')[0] || null;
            console.log('[Baileys] Connected as', state.number);
        }

        if (connection === 'close') {
            state.connected = false;
            const statusCode = lastDisconnect &&
                lastDisconnect.error &&
                lastDisconnect.error.output &&
                lastDisconnect.error.output.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;

            console.log('[Baileys] Connection closed. loggedOut =', loggedOut);

            if (loggedOut) {
                // Session invalid (e.g. unlinked from phone) — clear it so
                // the next start produces a fresh QR instead of looping.
                state.qrCode = null;
                state.number = null;
                try {
                    require('fs').rmSync(AUTH_FOLDER, { recursive: true, force: true });
                } catch (e) { /* ignore */ }
            }

            starting = false;
            // Always try to reconnect (fresh QR if logged out, resumed
            // session otherwise) after a short delay.
            setTimeout(startBaileys, 3000);
            return;
        }
    });

    starting = false;
}

// Force a brand-new QR: close the current socket (if any) and restart.
// Baileys will issue a new 'qr' event once the fresh connection begins.
async function forceRefreshQR() {
    state.qrCode = null;
    state.connected = false;
    try {
        if (sock) sock.end(undefined);
    } catch (e) { /* ignore */ }
    starting = false;
    await startBaileys();
}

// ---- Sending messages -------------------------------------------------
function toJid(phoneRaw) {
    // Strip everything except digits, then address the WhatsApp JID.
    // Expects phoneRaw to already include the country code (e.g. 91XXXXXXXXXX),
    // matching how prepare_messages.php / messages_to_send.json store it.
    const digits = String(phoneRaw).replace(/\D/g, '');
    return digits + '@s.whatsapp.net';
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- HTTP server ------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/qr-status', (req, res) => {
    if (state.connected) {
        return res.json({ connected: true, number: state.number });
    }
    if (state.qrCode) {
        return res.json({ qrCode: state.qrCode });
    }
    return res.json({ connected: false });
});

app.get('/refresh-qr', async (req, res) => {
    forceRefreshQR().catch((e) => console.error('[refresh-qr] error:', e));
    res.json({ success: true, message: 'Refreshing QR — poll /qr-status.' });
});

app.post('/api/php-broadcast/send', async (req, res) => {
    const apiKey = req.header('x-api-key');
    if (apiKey !== PHP_BRIDGE_API_KEY) {
        return res.status(401).json({ success: false, message: 'Invalid API key' });
    }

    if (!state.connected || !sock) {
        return res.status(503).json({
            success: false,
            message: 'WhatsApp session is not connected. Scan the QR code first.',
        });
    }

    const recipients = Array.isArray(req.body.recipients) ? req.body.recipients : [];
    if (recipients.length === 0) {
        return res.json({ success: true, sent: 0, failed: 0, results: [] });
    }

    const results = [];
    let sent = 0;
    let failed = 0;

    // Reset progress for this batch so a poller can show a live "X% sent"
    // loader while this request is still running.
    broadcastProgress.inProgress = true;
    broadcastProgress.total = recipients.length;
    broadcastProgress.sent = 0;
    broadcastProgress.failed = 0;

    for (const r of recipients) {
        const name = r.name || 'Patient';
        const phone = r.phone || '';
        const message = r.message || '';

        if (!phone || !message) {
            failed++;
            results.push({ name, status: 'FAILED', error: 'missing phone or message' });
            broadcastProgress.failed = failed;
            continue;
        }

        try {
            await sock.sendMessage(toJid(phone), { text: message });
            sent++;
            results.push({ name, status: 'SENT' });
        } catch (err) {
            failed++;
            results.push({ name, status: 'FAILED', error: err.message || 'unknown error' });
        }

        broadcastProgress.sent = sent;
        broadcastProgress.failed = failed;

        // Randomized human-like gap between sends (2-5s), same behaviour
        // whatsapp_sender_curl.php's comments already describe.
        await sleep(2000 + Math.random() * 3000);
    }

    broadcastProgress.inProgress = false;

    res.json({ success: true, sent, failed, results });
});

// Lightweight endpoint the PHP/frontend can poll while a broadcast is
// running, to show a live progress loader instead of a silent 1-2 minute wait.
app.get('/broadcast-progress', (req, res) => {
    res.json(broadcastProgress);
});

app.get('/', (req, res) => {
    res.json({ ok: true, connected: state.connected, hasQr: !!state.qrCode });
});

app.listen(PORT, () => {
    console.log(`[Baileys] HTTP server listening on port ${PORT}`);
    startBaileys().catch((e) => console.error('[Baileys] startup error:', e));
});