# 🍽️ MessBot — WhatsApp Mess Meal Trading Bot

A WhatsApp bot for college students to buy and sell mess meals with smart AI-powered price negotiation.

## Features

- **Smart Negotiation** — Mirror & Match engine (holds firm, mirrors buyer movement, auto-accepts)
- **Mess Name Parsing** — handles `kadamba veg`, `kd nv`, `palash`, `yukta`, etc.
- **Meal Auto-Detect** — no meal specified? Bot picks based on time of day
- **Auto-Expiry** — listings deleted when meal time passes (BF→10AM, Lunch→3PM, etc.)
- **Race Protection** — atomic DB updates prevent double-sells
- **Order History** — shows mess name, meal, price, and contact for 24 hours
- **Cross-Platform** — Windows, Linux, macOS
- **Graceful Shutdown** — clean disconnect on Ctrl+C

---

## Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | 18.x or 20.x LTS |
| MySQL | 5.7+ or 8.x |
| Google Chrome / Chromium | Any recent version |
| WhatsApp | A phone number for the bot |

> ⚠️ **Node.js 24.x is not recommended** — Puppeteer may have compatibility issues.

---

## Setup

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd messbot
npm install
```

### 2. Install Chrome/Chromium

**Ubuntu/Debian:**
```bash
# Option A: Google Chrome
wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
sudo dpkg -i google-chrome-stable_current_amd64.deb
sudo apt-get -f install

# Option B: Chromium
sudo apt install chromium-browser

# Option C: Puppeteer's bundled Chrome
npx puppeteer browsers install chrome
```

**Linux headless dependencies:**
```bash
sudo apt update && sudo apt install -y \
  ca-certificates fonts-liberation libappindicator3-1 \
  libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
  libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 \
  libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
  libxrandr2 xdg-utils libxss1 libxtst6 lsb-release \
  wget curl
```

**Windows:**
- Install Chrome from https://www.google.com/chrome/
- Or: `npx puppeteer browsers install chrome`

### 3. Setup MySQL

```sql
mysql -u root -p
CREATE DATABASE messbot;
EXIT;
```

### 4. Configure (Optional)

Environment variables override defaults in code:

```bash
export DB_HOST=localhost
export DB_USER=root
export DB_PASS=yourpassword
export DB_NAME=messbot
```

### 5. Run

```bash
node index.js
```

Scan the QR code with WhatsApp → Linked Devices → Link a Device.
Session is saved locally after first scan.

### 6. Run in Background (Production)

**PM2 (recommended):**
```bash
npm install -g pm2
pm2 start bot.js --name messbot
pm2 save
pm2 startup
```

**systemd:**
```ini
# /etc/systemd/system/messbot.service
[Unit]
Description=MessBot
After=network.target mysql.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/messbot
ExecStart=/usr/bin/node index.js
Restart=on-failure
RestartSec=10
Environment=DB_PASS=yourpassword

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable messbot
sudo systemctl start messbot
```

---

## Commands

| Command | Description |
|---------|-------------|
| `hi` / `hello` / `hey` | Welcome message |
| `help` | All commands |
| `register <name> <mobile> <upi>` | Register + send QR image |
| `sell <mess> <meal> <ask> <min>` | List a meal for sale |
| `buy <mess> <meal>` | Find & negotiate a meal |
| `listings` | Browse available meals |
| `paid` | Confirm payment after deal |
| `orders` | Order history (24h) |
| `cancel` | Cancel negotiation or reservation |
| `delist` | Remove all your listings |

### Accepted Mess Names

| Mess | Accepted Inputs |
|------|----------------|
| Palash | `palash`, `plash` |
| Yuktahar | `yuktahar`, `yukta`, `yukt` |
| Kadamba Veg | `kadamba veg`, `kadamba v`, `kadamba vg`, `kd veg`, `kd v`, `kdv` |
| Kadamba NonVeg | `kadamba nv`, `kadamba nonveg`, `kadamba non-veg`, `kd nv`, `kdnv` |

> Typing just `kadamba` or `kd` → bot asks you to specify Veg or NV.

### Accepted Meal Names

| Meal | Accepted Inputs | Expires At |
|------|----------------|------------|
| Breakfast | `bf`, `bfast`, `breakfast`, `nashta`, `morning` | 10:00 AM |
| Lunch | `lunch`, `lnch`, `lun`, `afternoon` | 3:00 PM |
| Snacks | `snacks`, `snack`, `snk`, `tiffin` | 6:00 PM |
| Dinner | `dinner`, `din`, `dnr`, `night`, `raat` | 10:00 PM |

> No meal specified → auto-detected from current time.

---

## Negotiation Flow

```
Buyer: "buy Palash Lunch"
Bot:   "Found Palash — Lunch at ₹60. What's your offer?"

Buyer: "30"
Bot:   "That's way too low 😅 Please send a reasonable offer."
       [30 < 50% of 60 → lowball, no counter]

Buyer: "40"
Bot:   "₹60 is already a fair price. Can you come closer?"
       [40/60 = 67% < 70% → hold firm, round 1]

Buyer: "45"
Bot:   "Alright, ₹55 — that's the best I can do."
       [jump=5 → drop ₹5 → 60→55]

Buyer: "50"
Bot:   "Done at ₹50! 🤝 Reply paid after payment."
       [50 within ₹5 of 55 → auto-accept]
```

---

## Background Jobs

| Job | Interval | Action |
|-----|----------|--------|
| Reservation cleanup | 1 min | Releases unpaid reservations after 5 min, notifies buyer |
| Meal expiry | 5 min | Deletes listings past meal deadline, notifies negotiating buyers |
| Order cleanup | 1 hour | Deletes orders older than 24 hours |
| Processing recovery | 1 min | Reverts stuck `processing` status from crash scenarios |

---

## Troubleshooting

### Chrome / Puppeteer

| Problem | Cause | Solution |
|---------|-------|----------|
| `Failed to launch the browser process` | Chrome not found | `npx puppeteer browsers install chrome` |
| `Could not find Chrome (ver. X.X)` | Bundled Chrome missing | `npx puppeteer browsers install chrome` |
| `No usable sandbox` | Missing sandbox perms (Linux) | Already handled: `--no-sandbox` flag |
| `EACCES: permission denied` | Chrome not executable | `chmod +x /usr/bin/google-chrome` |
| `libnss3.so: cannot open` | Missing deps | Install headless deps (see Setup step 2) |
| White screen / crash | Node 24.x issue | Downgrade to Node.js 20 LTS |

### Database

| Problem | Cause | Solution |
|---------|-------|----------|
| `ER_ACCESS_DENIED_ERROR` | Wrong credentials | Check `DB_USER` / `DB_PASS` |
| `ER_BAD_DB_ERROR` | DB doesn't exist | `CREATE DATABASE messbot;` |
| `ECONNREFUSED` | MySQL not running | `sudo systemctl start mysql` |
| `ER_DUP_ENTRY` on orders | ID collision | Bot auto-retries (up to 3 times) |
| Old columns missing | DB from older version | Bot auto-migrates with `ALTER TABLE` |

### WhatsApp

| Problem | Cause | Solution |
|---------|-------|----------|
| QR not showing | Terminal can't render | Use a full terminal (not VS Code's) |
| `auth_failure` | Corrupt session | Delete `.wwebjs_auth/` folder, re-scan |
| Bot stops responding | Disconnected | Auto-reconnects after 5s |
| Bot replies in groups | Group filter missing | Fixed: only DMs are processed |
| Messages not received | WhatsApp rate limit | Wait 5-10 min, restart bot |

### General

| Problem | Cause | Solution |
|---------|-------|----------|
| Bot crashes on startup | Node.js 24.x | Use Node.js 18 or 20 LTS |
| Memory leak over time | QR images in DB | Normal for <1000 users |
| Reservation lost after restart | In-memory state cleared | 5-min DB cleanup handles it; buyer gets notified |
| Double-sell race condition | Concurrent buyers | Fixed: atomic `UPDATE WHERE status='available'` |
| Stuck `processing` status | Crash during `paid` | Auto-recovered by cleanup job |

---

## Architecture

```
WhatsApp Message
       │
       ▼
  Private Chat? ──No──▶ (ignored)
       │ Yes
       ▼
  Pending Registration? ──Yes──▶ Save QR → Done
       │ No
       ▼
  Active Negotiation? ──Yes──▶ Negotiation Engine
       │ No                      (Mirror & Match)
       ▼
  Command Router
  ├── greetings ──▶ welcome
  ├── help      ──▶ command list
  ├���─ register  ──▶ save info → ask QR
  ├── sell      ──▶ validate → normalize → create listing
  ├── buy       ──▶ find listing → start negotiation
  ├── listings  ──▶ show available
  ├── paid      ──▶ lock → transaction → order → notify
  ├── orders    ──▶ show history (UNION query)
  ├── cancel    ──▶ cancel negotiation/reservation + notify
  ├── delist    ──▶ remove listings + notify buyers
  └── unknown   ──▶ help prompt

  Background:
  ├── Every 1 min:  Release stale reservations + notify buyer
  ├── Every 5 min:  Expire listings past meal time + notify
  ├── Every 1 hr:   Delete 24h+ old orders
  └── Every 1 min:  Recover stuck 'processing' status
```

---

## Limits

| Setting | Value | Location |
|---------|-------|----------|
| Max listings per seller | 5 | `MAX_LISTINGS_PER_SELLER` |
| Reservation timeout | 5 min | Cleanup interval |
| Negotiation silence → reminder | 30 sec | `startSilenceTimer` |
| Negotiation silence → cancel | 75 sec total | `startSilenceTimer` |
| Max negotiation rounds | 5 | `negotiate()` |
| Order history retention | 24 hours | Cleanup interval |
| Price rounding | Nearest ₹5 | `roundTo5()` |

---

## License

MIT