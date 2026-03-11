// Load .env if exists
try { require('dotenv').config(); } catch {}

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const mysql = require('mysql2/promise');
const os = require('os');
const fs = require('fs');

// ================= DATABASE CONFIG =================
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || 'sagarjha',
    database: process.env.DB_NAME || 'messbot'
};

// ================= CONNECTION POOL =================
const pool = mysql.createPool({
    ...dbConfig,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ================= CROSS-PLATFORM CHROME =================
function findChromePath() {
    const platform = os.platform();
    const candidates = {
        win32: [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`
        ],
        linux: [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium'
        ],
        darwin: [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        ]
    };

    for (const p of (candidates[platform] || [])) {
        if (p && fs.existsSync(p)) return p;
    }
    return null;
}

// ================= IST TIME HELPERS =================
function getIST() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc + istOffset);
}

function getISTHour() {
    return getIST().getHours();
}

function getISTDay() {
    return getIST().getDay(); // 0=Sunday, 1=Monday, ...
}

function formatISTDate(timestamp) {
    const d = new Date(timestamp);
    const istOffset = 5.5 * 60 * 60 * 1000;
    const utc = d.getTime() + (d.getTimezoneOffset() * 60000);
    const ist = new Date(utc + istOffset);
    const day = ist.getDate().toString().padStart(2, '0');
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const month = months[ist.getMonth()];
    let hours = ist.getHours();
    const mins = ist.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${day} ${month}, ${hours}:${mins} ${ampm}`;
}

// ================= MEAL TIME CONFIG =================
const MEAL_DEADLINES = {
    'Breakfast': 10,
    'Lunch': 15,
    'Snacks': 18,
    'Dinner': 22
};

const MAX_LISTINGS_PER_SELLER = 5;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function getMealByTime() {
    const hour = getISTHour();
    if (hour >= 22 || hour < 10) return 'Breakfast';
    if (hour >= 10 && hour < 15) return 'Lunch';
    if (hour >= 15 && hour < 18) return 'Snacks';
    return 'Dinner';
}

/**
 * Get the DAY the meal will actually be served on.
 * If it's Monday 10PM and the meal is Breakfast → that's Tuesday's breakfast.
 * If it's Monday 2PM and the meal is Dinner → that's Monday's dinner (same day).
 * If it's Monday 10PM and the meal is Dinner → dinner time passed, this is for Tuesday.
 */
function getMealServingDay(meal) {
    const hour = getISTHour();
    const today = getISTDay();

    if (meal === 'Breakfast') {
        if (hour >= 22) return (today + 1) % 7;
        if (hour < 10) return today;
        return (today + 1) % 7;
    }

    const deadline = MEAL_DEADLINES[meal];
    if (hour >= deadline) {
        return (today + 1) % 7;
    }
    return today;
}

/**
 * Does Kadamba require Veg/NonVeg selection for this meal on its serving day?
 * 
 * Rules:
 * - Breakfast: EVERY day → Veg/NV required
 * - Lunch: Sunday(0), Wednesday(3) → Veg/NV required
 * - Dinner: Monday(1), Thursday(4), Friday(5) → Veg/NV required
 * - Snacks: Never → no Veg/NV needed
 * - All other combos: single menu, no selection needed
 */
function kadambaRequiresVegNV(meal, servingDay) {
    if (meal === 'Breakfast') return true;
    if (meal === 'Lunch' && [0, 3].includes(servingDay)) return true;
    if (meal === 'Dinner' && [1, 4, 5].includes(servingDay)) return true;
    return false;
}

function isMealExpiredNow(meal) {
    const deadline = MEAL_DEADLINES[meal];
    if (deadline === undefined) return false;
    const hour = getISTHour();
    if (meal === 'Breakfast') return hour >= 10 && hour < 22;
    return hour >= deadline;
}

function getExpiredMealsNow() {
    const hour = getISTHour();
    const expired = [];
    for (const [meal, deadline] of Object.entries(MEAL_DEADLINES)) {
        if (meal === 'Breakfast') {
            if (hour >= deadline && hour < 22) expired.push(meal);
        } else {
            if (hour >= deadline) expired.push(meal);
        }
    }
    return expired;
}

// ================= TABLE SETUP =================
async function ensureTables() {
    const conn = await pool.getConnection();
    try {
        await conn.query(`CREATE TABLE IF NOT EXISTS users (
            id VARCHAR(64) PRIMARY KEY,
            name VARCHAR(64),
            mobile VARCHAR(20),
            upi VARCHAR(128),
            qr LONGTEXT,
            qr_mimetype VARCHAR(64)
        )`);

        await conn.query(`CREATE TABLE IF NOT EXISTS listings (
            id VARCHAR(64) PRIMARY KEY,
            seller VARCHAR(64),
            mess VARCHAR(32),
            meal VARCHAR(64),
            startPrice FLOAT,
            minPrice FLOAT,
            status VARCHAR(16) DEFAULT 'available',
            reservedBy VARCHAR(64),
            reservedAt BIGINT,
            finalPrice FLOAT,
            createdAt BIGINT,
            INDEX idx_status_mess_meal (status, mess, meal),
            INDEX idx_seller (seller),
            INDEX idx_meal_status (meal, status)
        )`);

        await conn.query(`CREATE TABLE IF NOT EXISTS orders (
            id VARCHAR(10) PRIMARY KEY,
            listingId VARCHAR(64),
            buyer VARCHAR(64),
            seller VARCHAR(64),
            buyerMobile VARCHAR(20),
            sellerMobile VARCHAR(20),
            buyerWa VARCHAR(64),
            sellerWa VARCHAR(64),
            mess VARCHAR(32),
            meal VARCHAR(64),
            price FLOAT,
            createdAt BIGINT,
            INDEX idx_buyer (buyer),
            INDEX idx_seller_ord (seller),
            INDEX idx_created (createdAt)
        )`);

        // Safe migrations for older DBs
        const safeAdd = async (table, col, type) => {
            try { await conn.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`); } catch {}
        };
        await safeAdd('orders', 'buyerWa', 'VARCHAR(64)');
        await safeAdd('orders', 'sellerWa', 'VARCHAR(64)');
        await safeAdd('orders', 'mess', 'VARCHAR(32)');
        await safeAdd('orders', 'meal', 'VARCHAR(64)');
        await safeAdd('listings', 'createdAt', 'BIGINT');

    } finally {
        conn.release();
    }
}

ensureTables();

// ================= IN-MEMORY STATE =================
const pendingRegistrations = {};
const activeNegotiations = {};
const activeReservations = {};  // sender → { listingId, reservedAt }
const negotiationTimers = {};

// ================= HELPERS =================

function generateOrderId() {
    const ts = Date.now().toString(36);
    const rand = Math.floor(Math.random() * 1296).toString(36).padStart(2, '0');
    return (ts + rand).slice(-8).toUpperCase();
}

async function insertOrderWithRetry(params, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const id = generateOrderId();
            await pool.query(
                `INSERT INTO orders (id, listingId, buyer, seller, buyerMobile, sellerMobile, buyerWa, sellerWa, mess, meal, price, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [id, ...params]
            );
            return id;
        } catch (err) {
            if (err.code === 'ER_DUP_ENTRY' && i < retries - 1) continue;
            throw err;
        }
    }
}

function roundTo5(n) {
    return Math.round(n / 5) * 5;
}

function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function isValidMobile(str) {
    return /^[6-9]\d{9}$/.test(str);
}

function isPrivateChat(chatId) {
    return chatId.endsWith('@c.us') || chatId.endsWith('@lid');
}

async function getRealNumber(waId) {
    try {
        if (waId.endsWith('@c.us')) return waId.replace('@c.us', '');
        const contact = await client.getContactById(waId);
        return contact.number || waId.replace(/@\S+/, '');
    } catch {
        return waId.replace(/@\S+/, '');
    }
}

// Helper: notify a user (non-critical — never throw)
async function safeNotify(chatId, text) {
    try { await client.sendMessage(chatId, text); } catch (err) {
        console.error(`Failed to notify ${chatId}:`, err.message);
    }
}

// ================= MESS & MEAL NORMALIZER =================

const MESS_ALIASES = {
    'palash': 'Palash',
    'plash': 'Palash',

    'yuktahar': 'Yuktahar',
    'yukta': 'Yuktahar',
    'yukt': 'Yuktahar',

    'kadamba veg': 'Kadamba Veg',
    'kadamba v': 'Kadamba Veg',
    'kadamba vg': 'Kadamba Veg',
    'kadambav': 'Kadamba Veg',
    'kadamba vegetarian': 'Kadamba Veg',
    'kd veg': 'Kadamba Veg',
    'kd v': 'Kadamba Veg',
    'kdv': 'Kadamba Veg',

    'kadamba non-veg': 'Kadamba NonVeg',
    'kadamba nonveg': 'Kadamba NonVeg',
    'kadamba non veg': 'Kadamba NonVeg',
    'kadamba nv': 'Kadamba NonVeg',
    'kadambanv': 'Kadamba NonVeg',
    'kd nv': 'Kadamba NonVeg',
    'kd nonveg': 'Kadamba NonVeg',
    'kd non-veg': 'Kadamba NonVeg',
    'kd non veg': 'Kadamba NonVeg',
    'kdnv': 'Kadamba NonVeg',

    'kadamba': null,
    'kd': null
};

const MEAL_ALIASES = {
    'breakfast': 'Breakfast',
    'bf': 'Breakfast',
    'bfast': 'Breakfast',
    'b fast': 'Breakfast',
    'brekfast': 'Breakfast',
    'morning': 'Breakfast',
    'nasta': 'Breakfast',
    'nashta': 'Breakfast',

    'lunch': 'Lunch',
    'lnch': 'Lunch',
    'lun': 'Lunch',
    'afternoon': 'Lunch',

    'snacks': 'Snacks',
    'snack': 'Snacks',
    'snk': 'Snacks',
    'evening snacks': 'Snacks',
    'tiffin': 'Snacks',

    'dinner': 'Dinner',
    'din': 'Dinner',
    'dnr': 'Dinner',
    'night': 'Dinner',
    'raat': 'Dinner'
};

function normalizeMeal(raw) {
    if (!raw || raw.trim() === '') return null;
    const input = raw.toLowerCase().trim();
    if (MEAL_ALIASES[input]) return MEAL_ALIASES[input];
    for (const [alias, meal] of Object.entries(MEAL_ALIASES)) {
        if (input.includes(alias)) return meal;
    }
    return null;
}

function parseMessAndMeal(input) {
    const raw = input.toLowerCase().trim();
    const messKeys = Object.keys(MESS_ALIASES).sort((a, b) => b.length - a.length);

    let matchedMessKey = null;
    let remaining = raw;

    for (const key of messKeys) {
        if (raw === key || raw.startsWith(key + ' ')) {
            matchedMessKey = key;
            remaining = raw.slice(key.length).trim();
            break;
        }
    }

    if (!matchedMessKey) {
        return {
            error: `Couldn't recognize the mess name.\n\nAvailable messes:\n• Palash\n• Yuktahar\n• Kadamba Veg / Kadamba NV`
        };
    }

    const messVal = MESS_ALIASES[matchedMessKey];

    // Parse meal first (needed for day-based Kadamba logic)
    let meal = normalizeMeal(remaining);
    let mealWasGuessed = false;
    if (!meal) { meal = getMealByTime(); mealWasGuessed = true; }

    // Handle Kadamba ambiguity (null = user typed "kadamba" or "kd" without veg/nv)
    if (messVal === null) {
        const servingDay = getMealServingDay(meal);
        const needsVegNV = kadambaRequiresVegNV(meal, servingDay);

        if (needsVegNV) {
            return { ambiguous: 'kadamba', remaining, meal, mealWasGuessed, servingDay };
        } else {
            return { mess: 'Kadamba', meal, mealWasGuessed };
        }
    }

    return { mess: messVal, meal, mealWasGuessed };
}

// ================= MESSAGE POOLS =================
const MSG = {
    welcome: [
        `Hey! 👋 Welcome to *MessBot*\n\nBuy or sell mess meals easily.\nType *help* to see all commands.`,
        `Hi there! 👋 This is *MessBot*\n\nYour one-stop place for mess meal deals.\nType *help* to get started.`,
        `Welcome to *MessBot*! 🍽️\n\nSave money on meals or sell the ones you won't eat.\nType *help* for commands.`
    ],

    regAskQr: [
        `Got it ✅ Now please send your mess QR image to complete registration.`,
        `Details saved! Now send your mess QR code image.`,
        `Almost done! Just send your mess QR.`
    ],
    regNeedImage: [
        `That doesn't look like an image. Please send your payment QR code as a photo.`,
        `I need a QR image to finish registration. Please send the photo.`
    ],
    regDone: [
        `Registration complete! ✅ You're all set.\nType *help* to see what you can do.`,
        `You're registered! 🎉 Type *help* to explore commands.`,
        `All done! Welcome aboard ✅\nUse *help* to see available commands.`
    ],
    regFirst: [
        `You need to register first.\n\nFormat:\n*register <name> <mobile> <upi>*\n\nExample: register Sagar 9876543210 sagar@upi`,
        `Please register before using the bot.\n\n*register <name> <mobile> <upi>*`
    ],
    regBadMobile: [
        `That doesn't look like a valid mobile number.\nPlease use a 10-digit Indian number starting with 6-9.`
    ],

    sellCreated: (mess, meal, price) => pick([
        `Listed ✅\n*${mess} — ${meal}* at ₹${price}\nYou'll be notified when it sells.`,
        `Done! *${mess} ${meal}* is up at ₹${price} 🍽️`,
        `Listing created ✅ *${mess} ${meal}* — ₹${price}`
    ]),
    sellMealGuess: (meal) => `\n_(No meal specified — set to *${meal}* based on current time. Delist and re-list if wrong.)_`,
    sellMealExpired: (meal) => `*${meal}* time has already passed for today.\n\nCurrent meal: *${getMealByTime()}*`,
    sellLimitReached: (max) => `You already have ${max} active listings.\nPlease *delist* some before creating new ones.`,

    noListings: [
        `No meals available right now. Check back in a bit! 🕐`,
        `Nothing listed at the moment. Try again later.`
    ],

    noListing: [
        `No matching meal found. Try *listings* to see what's available.`,
        `Couldn't find that meal. Type *listings* to browse.`
    ],
    buyStart: (mess, meal, price) => pick([
        `Found *${mess} — ${meal}* at ₹${price}. What's your offer?`,
        `*${mess} ${meal}* available at ₹${price} 🍽️ Send your offer.`,
        `Got one! *${mess} — ${meal}* at ₹${price}. How much will you pay?`
    ]),
    buyTimeGuess: (meal) => `\n_(No meal specified — picked *${meal}* based on current time)_`,
    buyHasReservation: `You already have a pending reservation.\nSend *paid* to complete it, or *cancel* to drop it first.`,
    buyHasNegotiation: `You're already in a negotiation.\nSend an offer, *ok*, or *cancel* first.`,

    kadambaAsk: (remaining, meal, servingDay) => {
        const day = DAY_NAMES[servingDay] || '';
        const mealPart = remaining ? ` ${remaining}` : '';
        return `Kadamba has both *Veg* and *Non-Veg* for *${meal}* on *${day}*.\n\nPlease specify:\n• *Kadamba Veg${mealPart}*\n• *Kadamba NV${mealPart}*`;
    },

    // ---- Negotiation messages (all include reply instructions) ----
    lowball: (counter) => pick([
        `That's way too low 😅\nI can do *₹${counter}*. Reply *ok* to accept or send a better offer.`,
        `Come on, not serious 😅\nBest I can offer: *₹${counter}*. Reply *ok* or send higher.`,
        `Too low!\n*₹${counter}* is fair — reply *ok* to accept or counter.`
    ]),
    belowMin: (counter) => pick([
        `Can't go that low.\nHow about *₹${counter}*? Reply *ok* to accept or increase your offer.`,
        `Not possible at that price.\n*₹${counter}* works — reply *ok* or offer more.`
    ]),
    counterOffer: (counter) => pick([
        `How about *₹${counter}*? 🤝\nReply *ok* to accept or send your counter.`,
        `I can do *₹${counter}*.\nReply *ok* to confirm or send a new offer.`,
        `Let's meet at *₹${counter}*.\nReply *ok* to accept or counter.`
    ]),
    firmOffer: (counter) => pick([
        `*₹${counter}* is the best I can do. Final.\nReply *ok* to accept or *cancel* to walk away.`,
        `Can't go below *₹${counter}*.\nReply *ok* to buy or *cancel* to pass.`,
        `Final price: *₹${counter}*.\nReply *ok* or *cancel*.`
    ]),
    repeatedOffer: (counter) => pick([
        `I see you really want that price. Let me meet you halfway — *₹${counter}*.\nReply *ok* to accept or *cancel*.`,
        `Alright, I hear you. Best I can stretch to: *₹${counter}*.\nReply *ok* or *cancel*.`,
        `You've been firm, I respect that. *₹${counter}* — final.\nReply *ok* or *cancel*.`
    ]),
    instantAccept: (price) => pick([
        `That's a fair offer! ✅ Deal at *₹${price}*!\nReply *paid* after making payment.`,
        `Done! *₹${price}* works 🤝\nReply *paid* after payment.`,
        `Accepted! *₹${price}* 🎉\nReply *paid* once you've paid.`
    ]),
    pressure: `\n\n⏳ Others are checking this meal too.`,

    dealDone: (price) => pick([
        `Deal locked at ₹${price} ✅\nReply *paid* after making payment.`,
        `₹${price} it is! 🎉\nReply *paid* after payment.`
    ]),
    reserved: (price) => pick([
        `Reserved at ₹${price} ✅\nReply *paid* after making payment. _(You have 5 min)_`,
        `Locked in at ₹${price}! Send *paid* when done. _(5 min to pay)_`
    ]),
    listingGone: [
        `Sorry, that meal is no longer available.`,
        `This listing just got taken. Try *listings* for others.`
    ],
    negCancelled: [
        `Negotiation cancelled. No worries! 👍\nType *listings* to browse other meals.`,
        `Cancelled ✅ Check *listings* if you want something else.`
    ],
    noReservation: [
        `You don't have an active reservation.\nUse *buy* to find a meal first.`,
        `No reservation found. Browse meals with *listings*.`
    ],
    alreadySold: [
        `This order was already completed.`,
        `Already done! Check *orders* for details.`
    ],
    paymentDone: (orderId) => pick([
        `Payment confirmed ✅\nOrder ID: *${orderId}*\nSeller's QR is above. Type *orders* for history.`,
        `Done! ✅ Order *${orderId}* placed.\nSeller QR sent above. Check *orders* anytime.`
    ]),
    sellerNotify: (buyerName, buyerMobile, mess, meal, price, orderId) => (
`🎉 *Your meal has been sold!*

🍽️ ${mess} — ${meal}
👤 Buyer: ${buyerName}
📞 Mobile: ${buyerMobile}
💰 Amount: ₹${price}
🆔 Order: ${orderId}`
    ),
    noOrders: [
        `No orders yet. Your history will show up here after a deal.`,
        `Nothing here yet! Buy or sell a meal to see orders.`
    ],
    silenceReminder: [
        `Still there? Reply with your offer, *ok*, or *cancel*.`,
        `Hey, waiting for your reply — offer, *ok*, or *cancel*.`
    ],
    silenceCancel: [
        `Negotiation cancelled — no reply received.`,
        `Auto-cancelled due to no response.`
    ],
    unknown: [
        `Didn't get that. Type *help* to see available commands.`,
        `Not sure what you mean. Try *help* for the command list.`
    ],
    invalidInNeg: [
        `Please send a price, *ok* to accept, or *cancel* to stop.`,
        `Send a number as your offer, *ok*, or *cancel*.`
    ],
    delistNone: [
        `You don't have any active listings to remove.`,
        `No active listings found under your name.`
    ],
    delistDone: (count) => pick([
        `Removed ${count} listing(s) ✅`,
        `Done! ${count} listing(s) delisted.`
    ]),
    priceRounded: (start, min) => `\n_(Prices rounded to nearest ₹5: asking ₹${start}, minimum ₹${min})_`,
    cancelReservation: `Reservation cancelled ✅ The meal is back on the market.`,
    cancelNothing: `You don't have an active negotiation or reservation to cancel.`,
    reservationExpiredBuyer: `⏰ Your reservation expired because payment wasn't received in time.\nThe meal is back on the market. You can *buy* again.`,
    mealExpiredBuyer: (meal) => `⏰ *${meal}* time has passed. Your negotiation was automatically cancelled.`
};

// ================= TIMER MANAGEMENT =================
function clearNegotiationTimers(sender) {
    const t = negotiationTimers[sender];
    if (t) {
        if (t.reminder) clearTimeout(t.reminder);
        if (t.cancel) clearTimeout(t.cancel);
        delete negotiationTimers[sender];
    }
}

function startSilenceTimer(sender, listingId) {
    clearNegotiationTimers(sender);
    const timers = {};

    timers.reminder = setTimeout(async () => {
        const state = activeNegotiations[sender];
        if (!state || state.listingId !== listingId) return;

        await safeNotify(sender, pick(MSG.silenceReminder));

        timers.cancel = setTimeout(async () => {
            const s = activeNegotiations[sender];
            if (!s || s.listingId !== listingId) return;

            await pool.query(
                `UPDATE listings SET status='available', reservedBy=NULL, reservedAt=NULL WHERE id=?`,
                [listingId]
            );
            delete activeNegotiations[sender];
            delete negotiationTimers[sender];

            await safeNotify(sender, pick(MSG.silenceCancel));
        }, 45000);

        negotiationTimers[sender] = timers;
    }, 30000);

    negotiationTimers[sender] = timers;
}

// ================= AUTO CLEANUP =================

// Release stale reservations (5 min) + notify buyer
setInterval(async () => {
    try {
        const cutoff = Date.now() - 5 * 60 * 1000;

        const [stale] = await pool.query(
            `SELECT id, reservedBy FROM listings
             WHERE status='reserved' AND reservedAt < ?`,
            [cutoff]
        );

        if (stale.length > 0) {
            await pool.query(
                `UPDATE listings SET status='available', reservedBy=NULL, reservedAt=NULL, finalPrice=NULL
                 WHERE status='reserved' AND reservedAt < ?`,
                [cutoff]
            );

            for (const row of stale) {
                if (row.reservedBy) {
                    delete activeReservations[row.reservedBy];
                    await safeNotify(row.reservedBy, MSG.reservationExpiredBuyer);
                }
            }

            console.log(`🧹 Released ${stale.length} stale reservation(s)`);
        }

        // Clean up stuck 'processing' status (crash recovery)
        await pool.query(
            `UPDATE listings SET status='reserved'
             WHERE status='processing' AND reservedAt < ?`,
            [cutoff]
        );

    } catch (err) { console.error('Reservation cleanup error:', err.message); }
}, 60000);

// Delete old orders (24h)
setInterval(async () => {
    try {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const [result] = await pool.query(`DELETE FROM orders WHERE createdAt < ?`, [cutoff]);
        if (result.affectedRows > 0) {
            console.log(`🧹 Deleted ${result.affectedRows} old order(s)`);
        }
    } catch (err) { console.error('Order cleanup error:', err.message); }
}, 3600000);

// Auto-expire listings after meal time + notify affected buyers
setInterval(async () => {
    try {
        const expiredMeals = getExpiredMealsNow();
        if (expiredMeals.length === 0) return;

        const [expiring] = await pool.query(
            `SELECT id, reservedBy FROM listings
             WHERE status IN ('available', 'reserved') AND meal IN (?)`,
            [expiredMeals]
        );

        if (expiring.length === 0) return;

        const expiringIds = expiring.map(r => r.id);

        for (const [sender, state] of Object.entries(activeNegotiations)) {
            if (expiringIds.includes(state.listingId)) {
                clearNegotiationTimers(sender);
                delete activeNegotiations[sender];
                const meal = expiredMeals[0];
                await safeNotify(sender, MSG.mealExpiredBuyer(meal));
            }
        }

        for (const row of expiring) {
            if (row.reservedBy && activeReservations[row.reservedBy]) {
                delete activeReservations[row.reservedBy];
                const meal = expiredMeals[0];
                await safeNotify(row.reservedBy, MSG.mealExpiredBuyer(meal));
            }
        }

        const [result] = await pool.query(
            `DELETE FROM listings WHERE status IN ('available', 'reserved') AND meal IN (?)`,
            [expiredMeals]
        );

        if (result.affectedRows > 0) {
            console.log(`🧹 Expired ${result.affectedRows} listing(s) for: ${expiredMeals.join(', ')}`);
        }

    } catch (err) { console.error('Meal expiry error:', err.message); }
}, 5 * 60 * 1000);

// ================= WHATSAPP CLIENT =================
const detectedChrome = findChromePath();

if (!detectedChrome) {
    console.error('❌ Chrome not found! Install: sudo apt install google-chrome-stable');
    process.exit(1);
}

console.log(`🌐 Chrome: ${detectedChrome}`);

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: detectedChrome,
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-gpu',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-extensions'
        ]
    }
});

client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.on('ready', () => console.log('✅ MessBot is live!'));
client.on('auth_failure', msg => console.error('❌ Auth failed:', msg));
client.on('disconnected', reason => {
    console.log('⚠️ Disconnected:', reason);
    process.exit(1);
});

// ================= NEGOTIATION ENGINE v2 =================
/**
 * Smart negotiation:
 * 1. ALWAYS propose a concrete counter price
 * 2. ALWAYS include "reply ok to accept" in every response
 * 3. offer >= 75% of asking → instant accept
 * 4. offer >= midpoint(min,asking) → accept or tiny counter
 * 5. Repeated same offer 3x → bot meets halfway, says "final"
 * 6. Every counter = smart midpoint between positions
 * 7. After round 5 → firm final offer
 */
function negotiate(state, offer, listing) {
    const { startPrice, minPrice } = listing;
    const { currentCounter, lastBuyerOffer, round } = state;
    const range = startPrice - minPrice;
    const midpoint = roundTo5((startPrice + minPrice) / 2);

    // Reject zero/negative
    if (offer <= 0) {
        const counter = roundTo5(startPrice - range * 0.15);
        return { action: 'lowball', counter: Math.max(counter, minPrice) };
    }

    // INSTANT ACCEPT: offer >= 75% of asking
    if (offer >= startPrice * 0.75) {
        return { action: 'instantAccept', price: roundTo5(offer) };
    }

    // INSTANT ACCEPT: offer >= current counter or within 5
    if (offer >= currentCounter - 5) {
        return { action: 'instantAccept', price: roundTo5(offer) };
    }

    // VERY LOW: below minPrice
    if (offer < minPrice) {
        if (offer < startPrice * 0.4) {
            // Absurdly low — counter at ~70% of asking
            const counter = roundTo5(startPrice * 0.7);
            return { action: 'lowball', counter: Math.max(counter, minPrice) };
        }
        // Below min but not absurd — counter at midpoint
        const counter = roundTo5((currentCounter + offer) / 2);
        return { action: 'belowMin', counter: Math.max(counter, minPrice) };
    }

    // REPEATED SAME OFFER 3+ times → meet halfway
    if (lastBuyerOffer !== null && offer === lastBuyerOffer) {
        const newSameCount = (state.sameOfferCount || 0) + 1;
        state.sameOfferCount = newSameCount;

        if (newSameCount >= 3) {
            let compromise = roundTo5((currentCounter + offer) / 2);
            compromise = Math.max(compromise, minPrice);
            // If compromise is close to offer, just accept
            if (compromise <= offer + 5) {
                return { action: 'instantAccept', price: roundTo5(offer) };
            }
            return { action: 'repeated', counter: compromise };
        }
    } else {
        state.sameOfferCount = 0;
    }

    // GOOD OFFER: at or above midpoint → accept or tiny counter
    if (offer >= midpoint) {
        let counter = roundTo5(offer + (currentCounter - offer) * 0.3);
        counter = Math.max(counter, minPrice);
        // If counter is barely above offer, just accept
        if (counter <= offer + 5) {
            return { action: 'instantAccept', price: roundTo5(offer) };
        }
        return { action: 'counter', counter, addPressure: round >= 3 };
    }

    // DECENT OFFER: between min and midpoint → smart counter
    const buyerGap = offer - minPrice;
    const totalGap = startPrice - minPrice;
    const buyerProgress = totalGap > 0 ? buyerGap / totalGap : 0;

    let counter;
    if (buyerProgress < 0.2) {
        // Buyer barely above min — counter at ~65% of range
        counter = roundTo5(minPrice + totalGap * 0.65);
    } else if (buyerProgress < 0.4) {
        // Counter at ~55% of range
        counter = roundTo5(minPrice + totalGap * 0.55);
    } else {
        // Counter at midpoint between positions
        counter = roundTo5((currentCounter + offer) / 2);
    }

    counter = Math.max(counter, minPrice);
    // Don't counter ABOVE current counter (always go down)
    counter = Math.min(counter, currentCounter);

    // Round 5+ → firm final
    if (round >= 5) {
        let finalPrice = roundTo5((currentCounter + offer) / 2);
        finalPrice = Math.max(finalPrice, minPrice);
        return { action: 'firm', counter: finalPrice };
    }

    return { action: 'counter', counter, addPressure: round >= 3 };
}

// ================= MESSAGE HANDLER =================
client.on('message', async (message) => {
    try {
        const sender = message.from;
        if (!isPrivateChat(sender)) return;

        const text = (message.body || '').trim();
        if (!text && !message.hasMedia) return;

        const lower = text.toLowerCase();

        // --- Pending registration (QR upload) ---
        if (pendingRegistrations[sender]) {
            if (!message.hasMedia) {
                return message.reply(pick(MSG.regNeedImage));
            }

            const media = await message.downloadMedia();
            if (!media) return message.reply(pick(MSG.regNeedImage));

            const { name, mobile, upi } = pendingRegistrations[sender];

            await pool.query(
                `INSERT INTO users (id, name, mobile, upi, qr, qr_mimetype)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE
                 name=VALUES(name), mobile=VALUES(mobile), upi=VALUES(upi),
                 qr=VALUES(qr), qr_mimetype=VALUES(qr_mimetype)`,
                [sender, name, mobile, upi, media.data, media.mimetype]
            );

            delete pendingRegistrations[sender];
            return message.reply(pick(MSG.regDone));
        }

        // --- Active negotiation ---
        if (activeNegotiations[sender]) {
            clearNegotiationTimers(sender);
            const state = activeNegotiations[sender];

            const [rows] = await pool.query('SELECT * FROM listings WHERE id=?', [state.listingId]);
            const listing = rows[0];

            if (!listing || listing.status !== 'available') {
                delete activeNegotiations[sender];
                return message.reply(pick(MSG.listingGone));
            }

            if (lower === 'cancel') {
                delete activeNegotiations[sender];
                return message.reply(pick(MSG.negCancelled));
            }

            if (lower === 'ok') {
                const price = roundTo5(state.currentCounter);

                const [result] = await pool.query(
                    `UPDATE listings SET status='reserved', reservedBy=?, reservedAt=?, finalPrice=?
                     WHERE id=? AND status='available'`,
                    [sender, Date.now(), price, listing.id]
                );

                if (result.affectedRows === 0) {
                    delete activeNegotiations[sender];
                    return message.reply(pick(MSG.listingGone));
                }

                activeReservations[sender] = { listingId: listing.id, reservedAt: Date.now() };
                delete activeNegotiations[sender];
                return message.reply(MSG.reserved(price));
            }

            const offer = parseFloat(text);

            if (!isNaN(offer)) {
                const roundedOffer = roundTo5(offer);
                const result = negotiate(state, roundedOffer, listing);

                const doAccept = async (price) => {
                    const [dbResult] = await pool.query(
                        `UPDATE listings SET status='reserved', reservedBy=?, reservedAt=?, finalPrice=?
                         WHERE id=? AND status='available'`,
                        [sender, Date.now(), price, listing.id]
                    );
                    if (dbResult.affectedRows === 0) {
                        delete activeNegotiations[sender];
                        return message.reply(pick(MSG.listingGone));
                    }
                    activeReservations[sender] = { listingId: listing.id, reservedAt: Date.now() };
                    delete activeNegotiations[sender];
                    return message.reply(MSG.instantAccept(price));
                };

                switch (result.action) {
                    case 'instantAccept':
                        return doAccept(result.price);

                    case 'lowball': {
                        state.currentCounter = result.counter;
                        state.lastBuyerOffer = roundedOffer;
                        state.round++;
                        startSilenceTimer(sender, listing.id);
                        return message.reply(MSG.lowball(result.counter));
                    }
                    case 'belowMin': {
                        state.currentCounter = result.counter;
                        state.lastBuyerOffer = roundedOffer;
                        state.round++;
                        startSilenceTimer(sender, listing.id);
                        return message.reply(MSG.belowMin(result.counter));
                    }
                    case 'repeated': {
                        state.currentCounter = result.counter;
                        state.round++;
                        startSilenceTimer(sender, listing.id);
                        return message.reply(MSG.repeatedOffer(result.counter));
                    }
                    case 'firm': {
                        state.currentCounter = result.counter;
                        state.lastBuyerOffer = roundedOffer;
                        state.round++;
                        startSilenceTimer(sender, listing.id);
                        return message.reply(MSG.firmOffer(result.counter));
                    }
                    case 'counter': {
                        let msg = MSG.counterOffer(result.counter);
                        if (result.addPressure) msg += MSG.pressure;
                        state.currentCounter = result.counter;
                        state.lastBuyerOffer = roundedOffer;
                        state.round++;
                        startSilenceTimer(sender, listing.id);
                        return message.reply(msg);
                    }
                }
            }

            startSilenceTimer(sender, listing.id);
            return message.reply(pick(MSG.invalidInNeg));
        }

        // --- Greetings ---
        const greetings = ['hi', 'hii', 'hiii', 'hello', 'hlo', 'hlooo', 'hey', 'yo'];
        if (greetings.includes(lower)) {
            return message.reply(pick(MSG.welcome));
        }

        // --- Help ---
        if (lower === 'help') {
            return message.reply(
`📋 *MessBot — Commands*

👤 *Register*
register <name> <mobile> <upi>
_Then send your Mess QR image._
Example: register abc 9876543210 xyz@upi

🍽️ *Sell a Meal*
sell <mess> <meal> <askingPrice> <minPrice>
Example: sell Palash Lunch 60 40
Example: sell Kadamba NV Dinner 70 50

🛒 *Buy a Meal*
buy <mess> <meal>
_If no meal given, auto-detects by time of day._
Example: buy Palash Lunch
Example: buy Kadamba Veg BF

📋 *Browse Meals*
listings

✅ *Confirm Payment*
paid

📦 *Order History (last 24h)*
orders

❌ *Cancel*
cancel _(cancels negotiation or reservation)_

🗑️ *Remove Your Listings*
delist

🏢 *Messes:* Palash, Yuktahar, Kadamba Veg, Kadamba NV
🍽️ *Meals:* Breakfast (BF), Lunch, Snacks, Dinner
⏰ *Auto-expiry:* BF→10AM, Lunch→3PM, Snacks→6PM, Dinner→10PM
🕐 All times in IST`
            );
        }

        // --- Register ---
        if (lower.startsWith('register ')) {
            const parts = text.split(/\s+/);
            if (parts.length < 3) {
                return message.reply(`Format:\n*register <name> <mobile> <upi(optional)>*\n\nExample: register Sagar 9876543210 sagar@upi`);
            }

            if (!isValidMobile(parts[2])) {
                return message.reply(pick(MSG.regBadMobile));
            }

            pendingRegistrations[sender] = {
                name: parts[1],
                mobile: parts[2],
                upi: parts[3] || null
            };

            return message.reply(pick(MSG.regAskQr));
        }

        // --- Check registration ---
        const [userRows] = await pool.query('SELECT * FROM users WHERE id=?', [sender]);
        if (!userRows.length) {
            return message.reply(pick(MSG.regFirst));
        }

        // --- Sell ---
        if (lower.startsWith('sell ')) {
            const parts = text.split(/\s+/);

            if (parts.length < 5) {
                return message.reply(
`Format:\n*sell <mess> <meal> <askingPrice> <minPrice>*\n\nExamples:\nsell Palash Lunch 60 40\nsell Kadamba Veg Dinner 70 50\nsell Kadamba NV BF 50 30`
                );
            }

            const rawStart = parseFloat(parts[parts.length - 2]);
            const rawMin = parseFloat(parts[parts.length - 1]);
            const startPrice = roundTo5(rawStart);
            const minPrice = roundTo5(rawMin);

            if (isNaN(startPrice) || isNaN(minPrice) || minPrice <= 0) {
                return message.reply(`Invalid prices. Both must be positive numbers.`);
            }
            if (minPrice > startPrice) {
                return message.reply(`After rounding to nearest ₹5, min (₹${minPrice}) > asking (₹${startPrice}).\nPlease adjust.`);
            }

            const messAndMeal = parts.slice(1, parts.length - 2).join(' ');
            const parsed = parseMessAndMeal(messAndMeal);

            if (parsed.error) return message.reply(parsed.error);
            if (parsed.ambiguous) return message.reply(MSG.kadambaAsk(parsed.remaining || '', parsed.meal, parsed.servingDay));

            const { mess, meal, mealWasGuessed } = parsed;

            // Block listing if meal time already passed
            if (isMealExpiredNow(meal)) {
                return message.reply(MSG.sellMealExpired(meal));
            }

            // Limit listings per seller
            const [[{ cnt }]] = await pool.query(
                `SELECT COUNT(*) AS cnt FROM listings WHERE seller=? AND status='available'`,
                [sender]
            );
            if (cnt >= MAX_LISTINGS_PER_SELLER) {
                return message.reply(MSG.sellLimitReached(MAX_LISTINGS_PER_SELLER));
            }

            const id = `${Date.now()}_${sender.slice(-6)}`;

            await pool.query(
                `INSERT INTO listings (id, seller, mess, meal, startPrice, minPrice, status, createdAt)
                 VALUES (?, ?, ?, ?, ?, ?, 'available', ?)`,
                [id, sender, mess, meal, startPrice, minPrice, Date.now()]
            );

            let reply = MSG.sellCreated(mess, meal, startPrice);
            if (mealWasGuessed) reply += MSG.sellMealGuess(meal);
            if (rawStart !== startPrice || rawMin !== minPrice) reply += MSG.priceRounded(startPrice, minPrice);

            return message.reply(reply);
        }

        // --- Listings ---
        if (lower === 'listings') {
            const [rows] = await pool.query(
                `SELECT mess, meal, startPrice FROM listings
                 WHERE status='available'
                 ORDER BY mess, meal, startPrice ASC`
            );

            if (!rows.length) return message.reply(pick(MSG.noListings));

            let msg = `🍽️ *Available Meals:*\n`;
            rows.forEach((l, i) => {
                msg += `\n${i + 1}. *${l.mess}* — ${l.meal} — ₹${l.startPrice}`;
            });
            msg += `\n\nUse *buy <mess> <meal>* to grab one.`;

            return message.reply(msg);
        }

        // --- Delist ---
        if (lower === 'delist') {
            const [myListings] = await pool.query(
                `SELECT id FROM listings WHERE seller=? AND status='available'`,
                [sender]
            );
            const myIds = myListings.map(r => r.id);

            for (const [buyerSender, state] of Object.entries(activeNegotiations)) {
                if (myIds.includes(state.listingId)) {
                    clearNegotiationTimers(buyerSender);
                    delete activeNegotiations[buyerSender];
                    await safeNotify(buyerSender, `The seller removed this listing. Negotiation cancelled.\nTry *listings* for other meals.`);
                }
            }

            const [result] = await pool.query(
                `DELETE FROM listings WHERE seller=? AND status='available'`,
                [sender]
            );

            if (result.affectedRows === 0) return message.reply(pick(MSG.delistNone));
            return message.reply(MSG.delistDone(result.affectedRows));
        }

        // --- Buy ---
        if (lower.startsWith('buy ')) {
            if (activeReservations[sender]) {
                return message.reply(MSG.buyHasReservation);
            }
            if (activeNegotiations[sender]) {
                return message.reply(MSG.buyHasNegotiation);
            }

            const rawInput = text.slice(4).trim();
            if (!rawInput) {
                return message.reply(`Format: *buy <mess> <meal>*\nExample: buy Palash Lunch`);
            }

            const parsed = parseMessAndMeal(rawInput);
            if (parsed.error) return message.reply(parsed.error);
            if (parsed.ambiguous) return message.reply(MSG.kadambaAsk(parsed.remaining || '', parsed.meal, parsed.servingDay));

            const { mess, meal, mealWasGuessed } = parsed;

            const [rows] = await pool.query(
                `SELECT * FROM listings
                 WHERE status='available' AND mess=? AND meal=?
                 ORDER BY startPrice ASC LIMIT 1`,
                [mess, meal]
            );

            if (!rows.length) {
                let reply = pick(MSG.noListing);
                if (mealWasGuessed) {
                    reply += `\n\n_(Auto-detected *${meal}* based on current time. Try specifying the meal.)_`;
                }
                return message.reply(reply);
            }

            const listing = rows[0];

            activeNegotiations[sender] = {
                listingId: listing.id,
                currentCounter: listing.startPrice,
                lastBuyerOffer: null,
                round: 0,
                sameOfferCount: 0
            };

            let reply = MSG.buyStart(mess, meal, listing.startPrice);
            if (mealWasGuessed) reply += MSG.buyTimeGuess(meal);

            return message.reply(reply);
        }

        // --- Paid ---
        if (lower === 'paid') {
            if (!activeReservations[sender]) {
                return message.reply(pick(MSG.noReservation));
            }

            const { listingId } = activeReservations[sender];

            // Atomic lock: reserved → processing (prevents double-paid)
            const [checkResult] = await pool.query(
                `UPDATE listings SET status='processing' WHERE id=? AND status='reserved' AND reservedBy=?`,
                [listingId, sender]
            );

            if (checkResult.affectedRows === 0) {
                delete activeReservations[sender];
                return message.reply(pick(MSG.alreadySold));
            }

            const [listingRows] = await pool.query('SELECT * FROM listings WHERE id=?', [listingId]);
            const listing = listingRows[0];

            const [[seller], [buyer]] = await Promise.all([
                pool.query('SELECT name, mobile, qr, qr_mimetype FROM users WHERE id=?', [listing.seller]).then(r => r[0]),
                pool.query('SELECT name, mobile FROM users WHERE id=?', [sender]).then(r => r[0])
            ]);

            if (!seller || !buyer) {
                await pool.query(`UPDATE listings SET status='reserved' WHERE id=?`, [listingId]);
                return message.reply(`User data missing. Please contact support.`);
            }

            const [buyerWa, sellerWa] = await Promise.all([
                getRealNumber(sender),
                getRealNumber(listing.seller)
            ]);

            let orderId;
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();

                orderId = await insertOrderWithRetry([
                    listing.id, sender, listing.seller,
                    buyer.mobile, seller.mobile,
                    buyerWa, sellerWa,
                    listing.mess, listing.meal,
                    listing.finalPrice, Date.now()
                ]);

                await conn.query(`UPDATE listings SET status='sold' WHERE id=?`, [listing.id]);
                await conn.commit();
            } catch (txErr) {
                await conn.rollback();
                await pool.query(`UPDATE listings SET status='reserved' WHERE id=?`, [listingId]);
                throw txErr;
            } finally {
                conn.release();
            }

            delete activeReservations[sender];

            // Send seller QR to buyer
            try {
                if (seller.qr && seller.qr_mimetype) {
                    const media = new MessageMedia(seller.qr_mimetype, seller.qr, 'payment_qr.png');
                    await client.sendMessage(sender, media);
                }
            } catch (qrErr) {
                console.error('QR send failed:', qrErr.message);
                await safeNotify(sender, `⚠️ Couldn't send QR. Contact seller at ${seller.mobile}`);
            }

            // Notify seller
            await safeNotify(
                listing.seller,
                MSG.sellerNotify(buyer.name, buyer.mobile, listing.mess, listing.meal, listing.finalPrice, orderId)
            );

            return message.reply(MSG.paymentDone(orderId));
        }

        // --- Orders (IST time) ---
        if (lower === 'orders') {
            const [orders] = await pool.query(
                `(SELECT * FROM orders WHERE buyer=? ORDER BY createdAt DESC LIMIT 20)
                 UNION ALL
                 (SELECT * FROM orders WHERE seller=? ORDER BY createdAt DESC LIMIT 20)
                 ORDER BY createdAt DESC LIMIT 20`,
                [sender, sender]
            );

            if (!orders.length) return message.reply(pick(MSG.noOrders));

            let msg = `📦 *Your Orders (last 24h):*\n`;

            for (const o of orders) {
                const date = formatISTDate(o.createdAt);

                const mealInfo = (o.mess && o.meal) ? `${o.mess} — ${o.meal}` : 'Meal';

                if (o.buyer === sender) {
                    msg += `\n🛒 *Bought* — ${mealInfo}\n💰 ₹${o.price} | Seller: ${o.sellerMobile}\n🆔 ${o.id} | ${date}\n`;
                } else {
                    msg += `\n💰 *Sold* — ${mealInfo}\n💰 ₹${o.price} | Buyer: ${o.buyerMobile}\n🆔 ${o.id} | ${date}\n`;
                }
            }

            return message.reply(msg);
        }

        // --- Cancel ---
        if (lower === 'cancel') {
            if (activeReservations[sender]) {
                const { listingId } = activeReservations[sender];

                const [lr] = await pool.query('SELECT seller, mess, meal, finalPrice FROM listings WHERE id=?', [listingId]);

                await pool.query(
                    `UPDATE listings SET status='available', reservedBy=NULL, reservedAt=NULL, finalPrice=NULL
                     WHERE id=? AND status='reserved'`,
                    [listingId]
                );

                delete activeReservations[sender];

                if (lr.length && lr[0].seller) {
                    await safeNotify(lr[0].seller,
                        `ℹ️ A buyer cancelled their reservation for *${lr[0].mess} — ${lr[0].meal}* at ₹${lr[0].finalPrice}.\nYour listing is back on the market.`
                    );
                }

                return message.reply(MSG.cancelReservation);
            }
            return message.reply(MSG.cancelNothing);
        }

        // --- Unknown ---
        return message.reply(pick(MSG.unknown));

    } catch (err) {
        console.error('Bot error:', err);
        try { await message.reply(`Something went wrong. Please try again.`); } catch {}
    }
});

// ================= GRACEFUL SHUTDOWN =================
async function shutdown(signal) {
    console.log(`\n${signal} received. Shutting down...`);
    try {
        await client.destroy();
        await pool.end();
        console.log('✅ Cleanup complete.');
    } catch (err) {
        console.error('Shutdown error:', err.message);
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.initialize();