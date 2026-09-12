import { Telegraf, Markup, Context } from "telegraf";
import { message } from "telegraf/filters";
import "dotenv/config";
import { loadDatabase as loadSQLiteDatabase, saveDatabase as saveSQLiteDatabase } from "./database";
import crypto from "node:crypto";

const WEBAPP_URL = String(process.env.WEBAPP_URL || "").trim();
const TOKEN = String(process.env.BOT_TOKEN || "");
if (!TOKEN) throw new Error("BOT_TOKEN داخل فایل .env قرار نگرفته است.");

const OWNER_ID = Number(process.env.BOT_OWNER_ID || 0);
const EXTRA_ADMIN_IDS = new Set(
    String(process.env.BOT_ADMIN_IDS || "")
        .split(",")
        .map(v => Number(v.trim()))
        .filter(Number.isSafeInteger)
        .filter(v => v > 0)
);

const bot = new Telegraf(TOKEN);

const DB_VERSION = 11;
const STARTING_COINS = 100;
const MIN_GAME_BET = 20;
const COINS_PER_1000 = 20_000;
const GAME_TTL_MS = 5 * 60 * 1000;
const MAX_TRANSACTION_LOG = 500;
const MAX_BALANCE = Number.MAX_SAFE_INTEGER;

function safePositiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const REFERRAL_REWARD = safePositiveInt(process.env.REFERRAL_REWARD, 150);
const REFERRAL_GROUP_ID = String(process.env.REFERRAL_GROUP_ID || "").trim();
const REFERRAL_CHANNEL_ID = String(process.env.REFERRAL_CHANNEL_ID || "").trim();

const NUMBER_GUESS_MIN = 1;
const NUMBER_GUESS_MAX = 7;
const NUMBER_GUESS_WIN_MULTIPLIER = 3;

const MAX_LEVEL = 400;
const XP_BAR_WIDTH = 12;
const XP_BASE = 100;
const XP_GROWTH = 1.65;

function levelName(level: number) {
    if (level <= 10) return "تازه‌کار";
    if (level <= 20) return "تازه‌وارد";
    if (level <= 35) return "آماتور";
    if (level <= 55) return "جسور";
    if (level <= 80) return "مبارز";
    if (level <= 110) return "ماهر";
    if (level <= 145) return "حرفه‌ای";
    if (level <= 185) return "نخبه";
    if (level <= 230) return "قهرمان";
    if (level <= 280) return "افسانه‌ای";
    if (level <= 330) return "فراطبیعی";
    if (level <= 375) return "فرازمینی";
    if (level < MAX_LEVEL) return "اسطوره";
    return "خدا";
}

function xpNeededForLevel(level: number) {
    if (level >= MAX_LEVEL) return 0;
    return Math.max(1, Math.floor(XP_BASE + XP_GROWTH * Math.pow(level, 1.72)));
}

function xpForBet(bet: number) {
    return Math.max(10, Math.floor(12 + Math.sqrt(Math.max(1, bet)) * 3));
}

function xpBar(current: number, needed: number) {
    if (needed <= 0) return "█".repeat(XP_BAR_WIDTH);
    const ratio = Math.max(0, Math.min(1, current / needed));
    const filled = Math.round(ratio * XP_BAR_WIDTH);
    return "█".repeat(filled) + "░".repeat(XP_BAR_WIDTH - filled);
}

function levelFromXp(totalXp: number) {
    let level = 1;
    let remaining = Math.max(0, Math.floor(totalXp));
    while (level < MAX_LEVEL) {
        const need = xpNeededForLevel(level);
        if (remaining < need) break;
        remaining -= need;
        level++;
    }
    return { level, current: remaining, needed: level >= MAX_LEVEL ? 0 : xpNeededForLevel(level) };
}

function levelSnapshot(user: User) {
    return levelFromXp(user.stats.xp || 0);
}

const STICKER_IDS = {
    welcome: process.env.STICKER_WELCOME || "",
    game: process.env.STICKER_GAME || "",
    win: process.env.STICKER_WIN || "",
    lose: process.env.STICKER_LOSE || "",
    draw: process.env.STICKER_DRAW || "",
    wheel: process.env.STICKER_WHEEL || "",
    guessWin: process.env.STICKER_GUESS_WIN || "",
    guessLose: process.env.STICKER_GUESS_LOSE || "",
    dice: process.env.STICKER_DICE || "",
    diceWin: process.env.STICKER_DICE_WIN || "",
    dart: process.env.STICKER_DART || "",
    dartWin: process.env.STICKER_DART_WIN || "",
    casino: process.env.STICKER_CASINO || "",
    casinoWin: process.env.STICKER_CASINO_WIN || "",
    casinoLose: process.env.STICKER_CASINO_LOSE || ""
} as const;

const DAILY_WHEEL_REWARDS = [20, 40, 60, 80, 100, 120, 140, 160, 180, 200] as const;
const DAILY_WHEEL_WEIGHTS = [24, 19, 15, 12, 9, 7, 5, 4, 3, 2] as const;
const DAILY_MISSIONS = [
    { games: 50, reward: 100 },
    { games: 100, reward: 150 },
    { games: 150, reward: 200 },
    { games: 200, reward: 250 }
] as const;

let mutationTail: Promise<void> = Promise.resolve();

async function withMutationLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = mutationTail;
    mutationTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
        return await fn();
    } finally {
        release();
    }
}

const ACTIVE_GAME_STATUSES = new Set<GameStatus>(["waiting", "playing"]);

type Stats = {
    wins: number;
    losses: number;
    draws: number;
    games: number;
    winStreak: number;
    bestStreak: number;
    xp: number;
    coinflipWins: number;
    rpsWins: number;
    tttWins: number;
    diceWins: number;
    dartWins: number;
    guessWins: number;
    casinoWins: number;
};

type User = {
    id: number;
    name: string;
    username?: string;
    coins: number;
    xp?: number;
    activeGameId?: string;
    stats: Stats;
    createdAt: number;
    updatedAt: number;
    lastWheelDay?: string;
    claimedMissions?: number[];
    referredBy?: number;
};

type GameStatus = "waiting" | "playing" | "finished";
type GameType = "coinflip" | "rps" | "tictactoe" | "dice" | "dart" | "casino" | "number_guess";
type RPSChoice = "rock" | "paper" | "scissors";

type BaseGame = {
    id: string;
    type: GameType;
    chatId: number;
    messageId?: number;
    creatorId: number;
    creatorName: string;
    opponentId?: number;
    opponentName?: string;
    wager: number;
    status: GameStatus;
    creatorStakeHeld: boolean;
    opponentStakeHeld: boolean;
    createdAt: number;
    settled: boolean;
};

type CoinflipGame = BaseGame & { type: "coinflip" };
type RPSGame = BaseGame & {
    type: "rps";
    creatorChoice?: RPSChoice;
    opponentChoice?: RPSChoice;
};
type TicTacToeGame = BaseGame & {
    type: "tictactoe";
    board: string[];
    turn: number;
};
type DicePredictionMode = "even" | "odd" | "exact";

type DiceGame = BaseGame & {
    type: "dice";
    creatorRoll?: number;
    opponentRoll?: number;
    creatorMode?: DicePredictionMode;
    opponentMode?: DicePredictionMode;
    creatorExact?: number;
    opponentExact?: number;
};
type DartGame = BaseGame & {
    type: "dart";
    creatorRoll?: number;
    opponentRoll?: number;
};
type CasinoGame = BaseGame & {
    type: "casino";
    creatorRoll?: number;
    opponentRoll?: number;
};

type Game = CoinflipGame | RPSGame | TicTacToeGame | DiceGame | DartGame | CasinoGame;

type Transaction = {
    id: string;
    fromUserId?: number;
    toUserId?: number;
    amount: number;
    type: "transfer" | "admin_add" | "admin_deduct" | "admin_xp" | "owner_charge" | "game_win" | "game_refund" | "daily_wheel" | "mission_reward" | "number_guess" | "dice_game" | "dart_game" | "casino_game" | "referral_reward";
    note?: string;
    createdAt: number;
};

type ReferralRecord = {
    inviterId: number;
    inviteeId: number;
    inviteeName: string;
    createdAt: number;
    groupJoined: boolean;
    channelJoined: boolean;
    rewarded: boolean;
    rewardedAt?: number;
};

type Database = {
    version: number;
    users: Record<string, User>;
    games: Record<string, Game>;
    admins: number[];
    totals: {
        games: number;
        coinsPaid: number;
    };
    transactions: Transaction[];
    referrals: Record<string, ReferralRecord>;
};

function emptyStats(): Stats {
    return {
        wins: 0,
        losses: 0,
        draws: 0,
        games: 0,
        winStreak: 0,
        bestStreak: 0,
        xp: 0,
        coinflipWins: 0,
        rpsWins: 0,
        tttWins: 0,
        diceWins: 0,
        dartWins: 0,
        guessWins: 0,
        casinoWins: 0
    };
}

function emptyDatabase(): Database {
    return {
        version: DB_VERSION,
        users: {},
        games: {},
        admins: [],
        totals: { games: 0, coinsPaid: 0 },
        transactions: [],
        referrals: {}
    };
}

function numberOr(value: unknown, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function safeInt(value: unknown, fallback = 0) {
    const n = Math.floor(numberOr(value, fallback));
    return Number.isSafeInteger(n) ? n : fallback;
}

function sanitizeStats(value: any): Stats {
    const oldStats = value ?? {};
    return {
        wins: Math.max(0, safeInt(oldStats.wins)),
        losses: Math.max(0, safeInt(oldStats.losses)),
        draws: Math.max(0, safeInt(oldStats.draws)),
        games: Math.max(0, safeInt(oldStats.games)),
        winStreak: Math.max(0, safeInt(oldStats.winStreak)),
        bestStreak: Math.max(0, safeInt(oldStats.bestStreak)),
        xp: Math.max(0, safeInt(oldStats.xp)),
        coinflipWins: Math.max(0, safeInt(oldStats.coinflipWins)),
        rpsWins: Math.max(0, safeInt(oldStats.rpsWins)),
        tttWins: Math.max(0, safeInt(oldStats.tttWins)),
        diceWins: Math.max(0, safeInt(oldStats.diceWins)),
        dartWins: Math.max(0, safeInt(oldStats.dartWins)),
        guessWins: Math.max(0, safeInt(oldStats.guessWins)),
        casinoWins: Math.max(0, safeInt(oldStats.casinoWins))
    };
}

function migrateDatabase(raw: any): Database {
    const db = emptyDatabase();
    const rawUsers = raw?.users ?? {};

    for (const value of Object.values(rawUsers) as any[]) {
        if (!value || !Number.isSafeInteger(Number(value.id))) continue;

        const id = Number(value.id);
        const safe: User = {
            id,
            name: String(value.name || value.username || "کاربر"),
            username: value.username ? String(value.username) : undefined,
            coins: Math.max(0, safeInt(value.coins)),
            xp: Math.max(0, safeInt(value.xp)),
            activeGameId: typeof value.activeGameId === "string" ? value.activeGameId : undefined,
            stats: sanitizeStats(value.stats),
            createdAt: numberOr(value.createdAt, Date.now()),
            updatedAt: numberOr(value.updatedAt, Date.now()),
            lastWheelDay: typeof value.lastWheelDay === "string" ? value.lastWheelDay : undefined,
            claimedMissions: Array.isArray(value.claimedMissions)
                ? value.claimedMissions.map((v: any) => safeInt(v)).filter((v: number) => v > 0)
                : [],
            referredBy: Number.isSafeInteger(Number(value.referredBy)) ? Number(value.referredBy) : undefined
        };

        const existing = db.users[String(id)];
        if (!existing) {
            db.users[String(id)] = safe;
            continue;
        }

        existing.coins = Math.max(existing.coins, safe.coins);
        existing.name = safe.name || existing.name;
        existing.username = safe.username || existing.username;
        existing.createdAt = Math.min(existing.createdAt, safe.createdAt);
        existing.updatedAt = Math.max(existing.updatedAt, safe.updatedAt);
        existing.xp = Math.max(0, safeInt(existing.xp ?? safe.xp));
        existing.stats.wins = Math.max(existing.stats.wins, safe.stats.wins);
        existing.stats.losses = Math.max(existing.stats.losses, safe.stats.losses);
        existing.stats.draws = Math.max(existing.stats.draws, safe.stats.draws);
        existing.stats.games = Math.max(existing.stats.games, safe.stats.games);
        existing.stats.winStreak = Math.max(existing.stats.winStreak, safe.stats.winStreak);
        existing.stats.bestStreak = Math.max(existing.stats.bestStreak, safe.stats.bestStreak);
        existing.stats.xp = Math.max(existing.stats.xp, safe.stats.xp);
        existing.stats.coinflipWins = Math.max(existing.stats.coinflipWins, safe.stats.coinflipWins);
        existing.stats.rpsWins = Math.max(existing.stats.rpsWins, safe.stats.rpsWins);
        existing.stats.tttWins = Math.max(existing.stats.tttWins, safe.stats.tttWins);
        existing.stats.diceWins = Math.max(existing.stats.diceWins, safe.stats.diceWins);
        existing.stats.dartWins = Math.max(existing.stats.dartWins, safe.stats.dartWins);
        existing.stats.guessWins = Math.max(existing.stats.guessWins, safe.stats.guessWins);
        existing.stats.casinoWins = Math.max(existing.stats.casinoWins, safe.stats.casinoWins);
        existing.lastWheelDay = existing.lastWheelDay || safe.lastWheelDay;
        existing.claimedMissions = Array.from(new Set([...(existing.claimedMissions || []), ...(safe.claimedMissions || [])]));
    }

    for (const id of Array.isArray(raw?.admins) ? raw.admins : []) {
        const n = Number(id);
        if (Number.isSafeInteger(n) && n > 0 && !db.admins.includes(n)) db.admins.push(n);
    }
    for (const id of EXTRA_ADMIN_IDS) {
        if (!db.admins.includes(id)) db.admins.push(id);
    }
    if (OWNER_ID > 0 && !db.admins.includes(OWNER_ID)) db.admins.push(OWNER_ID);

    db.totals.games = Math.max(0, safeInt(raw?.totals?.games));
    db.totals.coinsPaid = Math.max(0, safeInt(raw?.totals?.coinsPaid));

    if (raw?.version === DB_VERSION) {
        const txs = Array.isArray(raw?.transactions) ? raw.transactions : [];
        db.transactions = txs.slice(-MAX_TRANSACTION_LOG).filter((tx: any) =>
            tx && typeof tx.id === "string" && Number.isSafeInteger(Number(tx.amount)) && Number(tx.amount) > 0
        ) as Transaction[];
    }

    for (const [rid, rawReferral] of Object.entries(raw?.referrals ?? {}) as [string, any][]) {
        if (!rawReferral) continue;
        const inviterId = safeInt(rawReferral.inviterId);
        const inviteeId = safeInt(rawReferral.inviteeId);
        if (inviterId <= 0 || inviteeId <= 0 || inviterId === inviteeId) continue;
        db.referrals[rid] = {
            inviterId,
            inviteeId,
            inviteeName: String(rawReferral.inviteeName || "کاربر"),
            createdAt: numberOr(rawReferral.createdAt, Date.now()),
            groupJoined: Boolean(rawReferral.groupJoined),
            channelJoined: Boolean(rawReferral.channelJoined),
            rewarded: Boolean(rawReferral.rewarded),
            rewardedAt: Number.isSafeInteger(Number(rawReferral.rewardedAt)) ? Number(rawReferral.rewardedAt) : undefined,
        };
    }

    const rawGames = raw?.games ?? {};
    for (const [id, rawGame] of Object.entries(rawGames) as [string, any][]) {
        if (!rawGame) continue;

        if ((raw?.version === 7 || raw?.version === 8 || raw?.version === 9 || raw?.version === 10) && typeof rawGame.type === "string" && ACTIVE_GAME_STATUSES.has(rawGame.status)) {
            const creatorId = Number(rawGame.creatorId);
            const opponentId = rawGame.opponentId == null ? undefined : Number(rawGame.opponentId);
            const wager = Math.max(0, safeInt(rawGame.wager));
            if (!Number.isSafeInteger(creatorId) || wager <= 0 || !db.users[String(creatorId)]) continue;

            const base = {
                id: String(rawGame.id || id),
                chatId: safeInt(rawGame.chatId),
                messageId: Number.isSafeInteger(Number(rawGame.messageId)) ? Number(rawGame.messageId) : undefined,
                creatorId,
                creatorName: String(rawGame.creatorName || db.users[String(creatorId)]?.name || "کاربر"),
                opponentId: Number.isSafeInteger(opponentId as number) ? opponentId : undefined,
                opponentName: rawGame.opponentName ? String(rawGame.opponentName) : undefined,
                wager,
                status: rawGame.status as GameStatus,
                creatorStakeHeld: Boolean(rawGame.creatorStakeHeld),
                opponentStakeHeld: Boolean(rawGame.opponentStakeHeld),
                createdAt: numberOr(rawGame.createdAt, Date.now()),
                settled: Boolean(rawGame.settled)
            };

            if (rawGame.type === "coinflip") {
                db.games[base.id] = { ...base, type: "coinflip" };
            } else if (rawGame.type === "dice") {
                db.games[base.id] = {
                    ...base,
                    type: "dice",
                    creatorRoll: Number.isInteger(Number(rawGame.creatorRoll)) ? Number(rawGame.creatorRoll) : undefined,
                    opponentRoll: Number.isInteger(Number(rawGame.opponentRoll)) ? Number(rawGame.opponentRoll) : undefined,
                    creatorMode: rawGame.creatorMode === "even" || rawGame.creatorMode === "odd" || rawGame.creatorMode === "exact" ? rawGame.creatorMode : undefined,
                    opponentMode: rawGame.opponentMode === "even" || rawGame.opponentMode === "odd" || rawGame.opponentMode === "exact" ? rawGame.opponentMode : undefined,
                    creatorExact: Number.isInteger(Number(rawGame.creatorExact)) && Number(rawGame.creatorExact) >= 1 && Number(rawGame.creatorExact) <= 6 ? Number(rawGame.creatorExact) : undefined,
                    opponentExact: Number.isInteger(Number(rawGame.opponentExact)) && Number(rawGame.opponentExact) >= 1 && Number(rawGame.opponentExact) <= 6 ? Number(rawGame.opponentExact) : undefined
                };
            } else if (rawGame.type === "dart") {
                db.games[base.id] = {
                    ...base,
                    type: "dart",
                    creatorRoll: Number.isInteger(Number(rawGame.creatorRoll)) ? Number(rawGame.creatorRoll) : undefined,
                    opponentRoll: Number.isInteger(Number(rawGame.opponentRoll)) ? Number(rawGame.opponentRoll) : undefined
                };
            } else if (rawGame.type === "casino") {
                db.games[base.id] = {
                    ...base,
                    type: "casino",
                    creatorRoll: Number.isInteger(Number(rawGame.creatorRoll)) ? Number(rawGame.creatorRoll) : undefined,
                    opponentRoll: Number.isInteger(Number(rawGame.opponentRoll)) ? Number(rawGame.opponentRoll) : undefined
                };
            } else if (rawGame.type === "rps") {
                db.games[base.id] = {
                    ...base,
                    type: "rps",
                    creatorChoice: rawGame.creatorChoice,
                    opponentChoice: rawGame.opponentChoice
                };
            } else if (rawGame.type === "tictactoe" && Array.isArray(rawGame.board)) {
                const board = rawGame.board.map((v: any) => v === "❌" || v === "⭕" ? v : " ").slice(0, 9);
                while (board.length < 9) board.push(" ");
                db.games[base.id] = {
                    ...base,
                    type: "tictactoe",
                    board,
                    turn: Number(rawGame.turn) || creatorId
                };
            }
            continue;
        }

        if (rawGame.stakesTaken) {
            const wager = Math.max(0, safeInt(rawGame.wager));
            const a = db.users[String(rawGame.creatorId)];
            const b = db.users[String(rawGame.opponentId)];
            if (a && wager > 0) a.coins += wager;
            if (b && wager > 0) b.coins += wager;
        }
    }

    return db;
}

function loadDatabase(): Database {
    return loadSQLiteDatabase<Database>();
}

function saveDatabase(database: Database) {
    saveSQLiteDatabase(database);
}

const db = loadDatabase();

for (const id of EXTRA_ADMIN_IDS) {
    if (!db.admins.includes(id)) db.admins.push(id);
}
if (OWNER_ID > 0 && !db.admins.includes(OWNER_ID)) db.admins.push(OWNER_ID);
saveDatabase(db);

function formatNumber(value: number) {
    return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, useGrouping: true }).format(Math.floor(value));
}

function copyNumber(value: number) {
    return `<code>${formatNumber(value)}</code>`;
}

function coinsToToman(coins: number) {
    return Math.floor((coins / 1000) * COINS_PER_1000);
}

function currentDayKey() {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(new Date());
    const get = (type: string) => parts.find(p => p.type === type)?.value || "00";
    return `${get("year")}-${get("month")}-${get("day")}`;
}

function weightedWheelReward() {
    const total = DAILY_WHEEL_WEIGHTS.reduce((sum, weight) => sum + weight, 0);
    let roll = crypto.randomInt(1, total + 1);
    for (let i = 0; i < DAILY_WHEEL_WEIGHTS.length; i++) {
        roll -= DAILY_WHEEL_WEIGHTS[i];
        if (roll <= 0) return DAILY_WHEEL_REWARDS[i];
    }
    return DAILY_WHEEL_REWARDS[DAILY_WHEEL_REWARDS.length - 1];
}

function missionText(user: User) {
    const claimed = new Set(user.claimedMissions || []);
    const lines = ["🎯 <b>ماموریت‌های امروز</b>", `🎮 تا الان: <b>${copyNumber(user.stats.games)}</b> بازی`, ""];
    DAILY_MISSIONS.forEach((mission) => {
        const done = user.stats.games >= mission.games;
        const rewarded = claimed.has(mission.games);
        const status = rewarded ? "✅ گرفتی" : done ? "🎁 آماده‌ست" : `⏳ ${copyNumber(mission.games - user.stats.games)} تا مونده`;
        lines.push(`${done ? "🔥" : "▫️"} ${copyNumber(mission.games)} بازی → <b>${copyNumber(mission.reward)} MBN</b>  ${status}`);
    });
    lines.push("", "😎 بازی کن، جایزه‌ها خودشون می‌رسن!");
    return lines.join("\n");
}

async function notifyCompletedMissions(user: User) {
    user.claimedMissions = user.claimedMissions || [];
    for (const mission of DAILY_MISSIONS) {
        if (user.stats.games < mission.games || user.claimedMissions.includes(mission.games)) continue;
        if (!canAddCoins(user, mission.reward)) continue;
        user.claimedMissions.push(mission.games);
        user.coins += mission.reward;
        user.updatedAt = Date.now();
        recordTransaction({ toUserId: user.id, amount: mission.reward, type: "mission_reward", note: `mission:${mission.games}` });
        try {
            await bot.telegram.sendMessage(
                user.id,
                `🎉 <b>ماموریت تکمیل شد!</b>\n\n` +
                `🎮 تعداد بازی: <b>${copyNumber(mission.games)}</b>\n` +
                `🪙 پاداش: <b>${copyNumber(mission.reward)} MBN</b>\n` +
                `💰 معادل: <b>${copyNumber(coinsToToman(mission.reward))} تومان</b>\n\n` +
                `✅ پاداش به حساب شما واریز شد.\n` +
                `ID: <code>${user.id}</code>`,
                { parse_mode: "HTML" }
            );
        } catch {
        }
    }
}

function recordTransaction(input: Omit<Transaction, "id" | "createdAt">) {
    db.transactions.push({
        ...input,
        id: randomId(),
        createdAt: Date.now()
    });
    if (db.transactions.length > MAX_TRANSACTION_LOG) {
        db.transactions.splice(0, db.transactions.length - MAX_TRANSACTION_LOG);
    }
}

function isPrivateChat(ctx: any) {
    const chat = ctx && ctx.chat;
    return Boolean(chat && chat.type === "private");
}

async function safeAnswerCbQuery(ctx: any, text?: string, options?: any) {
    if (!ctx?.callbackQuery) return;
    try {
        await ctx.answerCbQuery(text, options);
    } catch (error: any) {
        const message = String(error?.description || error?.message || "");
        if (!message.includes("query is too old") && !message.includes("query ID is invalid")) {
            console.error("answer callback query error:", error);
        }
    }
}

function escapeHTML(value: string) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function displayName(user: { first_name?: string; last_name?: string; username?: string }) {
    const full = `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim();
    return full || user.username || "کاربر";
}

function mention(user: { id: number; first_name?: string; last_name?: string; username?: string }) {
    return `<a href="tg://user?id=${user.id}">${escapeHTML(displayName(user))}</a>`;
}

function userKey(id: number) {
    return String(id);
}

function getStoredUser(id: number) {
    return db.users[userKey(id)];
}

function getUser(from: { id: number; first_name?: string; last_name?: string; username?: string }) {
    const key = userKey(from.id);
    const now = Date.now();
    const name = displayName(from);
    let user = db.users[key];

    if (!user) {
        user = {
            id: from.id,
            name,
            username: from.username,
            coins: STARTING_COINS,
            xp: 0,
            stats: emptyStats(),
            createdAt: now,
            updatedAt: now,
            claimedMissions: []
        };
        db.users[key] = user;
        saveDatabase(db);
        return { user, created: true };
    }

    user.name = name;
    user.username = from.username;
    user.updatedAt = now;
    saveDatabase(db);
    return { user, created: false };
}

function isOwner(id?: number) {
    return Boolean(id && OWNER_ID > 0 && id === OWNER_ID);
}

function isAdmin(id?: number) {
    return Boolean(id && (isOwner(id) || db.admins.includes(id)));
}

function randomId() {
    return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function random50(a: number, b: number) {
    return crypto.randomInt(0, 2) === 0 ? a : b;
}

function styledCallback(text: string, data: string, style: "primary" | "success" | "danger" = "primary") {
    return { ...Markup.button.callback(text, data), style } as any;
}

function styledUrl(text: string, url: string, style: "primary" | "success" | "danger") {
    return { ...Markup.button.url(text, url), style } as any;
}

function warmName(name: string) {
    return escapeHTML(name || "رفیق");
}

function streakMood(streak: number) {
    if (streak >= 5) return `🔥 <b>${copyNumber(streak)} برد پشت‌سرهم!</b>`;
    if (streak >= 3) return `⚡ <b>${copyNumber(streak)}تایی شد!</b>`;
    if (streak === 2) return `✨ دومی هم رفت`;
    return `😎 خوب شروع کردی`;
}

function nextRoundHint() {
    return "🎮 راند بعدی؟";
}

async function sendStickerSafe(ctx: Context, key: keyof typeof STICKER_IDS) {
    const sticker = STICKER_IDS[key];
    if (!sticker || !ctx.chat) return false;

    try {
        await ctx.telegram.sendSticker(ctx.chat.id, sticker);
        return true;
    } catch (error) {
        console.error(`sticker:${String(key)} failed:`, error);
        return false;
    }
}

async function replyWarm(
    ctx: Context,
    text: string,
    sticker?: keyof typeof STICKER_IDS,
    extra?: any
) {
    if (sticker) await sendStickerSafe(ctx, sticker);
    return ctx.reply(text, extra);
}

function numberGuessKeyboard(userId: number, bet: number) {
    const buttons = Array.from(
        { length: NUMBER_GUESS_MAX - NUMBER_GUESS_MIN + 1 },
        (_, offset) => {
            const number = NUMBER_GUESS_MIN + offset;
            return styledCallback(
                `🔢 ${number}`,
                `ng:pick:${userId}:${bet}:${number}`,
                number % 2 === 0 ? "primary" : "success"
            );
        }
    );

    return Markup.inlineKeyboard([
        buttons.slice(0, 4),
        buttons.slice(4),
        [styledCallback("↩️ بی‌خیال", `ng:cancel:${userId}`, "danger")]
    ]);
}

function numberGuessPrompt(bet: number) {
    return [
        "🎯 <b>حدس عدد</b>",
        `🪙 شرط: <b>${copyNumber(bet)} MBN</b>`,
        "👇 یکی از ۱ تا ۷ رو انتخاب کن"
    ].join("\n");
}

function normalizeDigits(text: string) {
    const fa = "۰۱۲۳۴۵۶۷۸۹";
    const ar = "٠١٢٣٤٥٦٧٨٩";
    return text
        .replace(/[۰-۹]/g, d => String(fa.indexOf(d)))
        .replace(/[٠-٩]/g, d => String(ar.indexOf(d)))
        .replace(/[٬,،]/g, "")
        .trim();
}

function parseGameBet(value: string) {
    const normalized = normalizeDigits(value);
    if (!/^\d+$/.test(normalized)) return null;
    const bet = Number(normalized);
    if (!Number.isSafeInteger(bet) || bet < MIN_GAME_BET) return null;
    return bet;
}

function parseAmount(value: string) {
    const normalized = normalizeDigits(value);
    if (!/^\d+$/.test(normalized)) return null;
    const amount = Number(normalized);
    if (!Number.isSafeInteger(amount) || amount < 1) return null;
    return amount;
}

function canAddCoins(user: User, amount: number) {
    return Number.isSafeInteger(amount) && amount > 0 && user.coins <= MAX_BALANCE - amount;
}

function addCoinsSafe(user: User, amount: number) {
    if (!canAddCoins(user, amount)) return false;
    user.coins += amount;
    return true;
}

function clearActiveGame(userId: number, expectedGameId?: string) {
    const user = getStoredUser(userId);
    if (!user) return;
    if (!expectedGameId || user.activeGameId === expectedGameId) delete user.activeGameId;
    user.updatedAt = Date.now();
}

function reserveCreatorStake(game: BaseGame) {
    if (game.status !== "waiting" || game.settled || game.creatorStakeHeld) return false;
    const creator = getStoredUser(game.creatorId);
    if (!creator || creator.coins < game.wager) return false;

    creator.coins -= game.wager;
    creator.updatedAt = Date.now();
    game.creatorStakeHeld = true;
    return true;
}

function reserveOpponentStake(game: BaseGame, opponentId: number, opponentName: string) {
    if (game.status !== "waiting" || game.settled || game.opponentId || game.opponentStakeHeld || opponentId === game.creatorId) return false;
    const opponent = getStoredUser(opponentId);
    if (!opponent || opponent.coins < game.wager) return false;

    opponent.coins -= game.wager;
    opponent.updatedAt = Date.now();
    game.opponentId = opponentId;
    game.opponentName = opponentName;
    game.opponentStakeHeld = true;
    return true;
}

function refundGame(game: Game) {
    if (game.settled) return false;

    const creator = getStoredUser(game.creatorId);
    const creatorHeld = game.creatorStakeHeld;
    if (creatorHeld && creator) {
        if (!addCoinsSafe(creator, game.wager)) throw new Error("موجودی سازنده از محدوده امن عددی خارج شد.");
    }
    clearActiveGame(game.creatorId, game.id);

    let opponent: User | undefined;
    const opponentHeld = game.opponentStakeHeld;
    if (game.opponentId) {
        opponent = getStoredUser(game.opponentId);
        if (opponentHeld && opponent) {
            if (!addCoinsSafe(opponent, game.wager)) throw new Error("موجودی بازیکن دوم از محدوده امن عددی خارج شد.");
        }
        clearActiveGame(game.opponentId, game.id);
    }

    game.creatorStakeHeld = false;
    game.opponentStakeHeld = false;
    game.settled = true;
    game.status = "finished";
    if (creatorHeld && creator && game.wager > 0) recordTransaction({ toUserId: creator.id, amount: game.wager, type: "game_refund", note: `game:${game.id}:cancel` });
    if (opponentHeld && opponent && game.wager > 0) recordTransaction({ toUserId: opponent.id, amount: game.wager, type: "game_refund", note: `game:${game.id}:cancel` });
    saveDatabase(db);
    return true;
}

function settleWinner(game: Game, winnerId: number) {
    if (game.settled || game.status !== "playing" || !game.opponentId) return null;
    if (winnerId !== game.creatorId && winnerId !== game.opponentId) return null;
    if (!game.creatorStakeHeld || !game.opponentStakeHeld) return null;

    const loserId = winnerId === game.creatorId ? game.opponentId : game.creatorId;
    const winner = getStoredUser(winnerId);
    const loser = getStoredUser(loserId);
    if (!winner || !loser) return null;

    if (!addCoinsSafe(winner, game.wager * 2)) {
        return null;
    }
    db.totals.games += 1;
    db.totals.coinsPaid += game.wager * 2;

    game.creatorStakeHeld = false;
    game.opponentStakeHeld = false;
    game.settled = true;
    game.status = "finished";

    addWin(winnerId);
    addLoss(loserId);
    const winnerXp = applyGameXp(winner, game.wager, game.type, true);
    const loserXp = applyGameXp(loser, game.wager, game.type, false);
    void notifyCompletedMissions(winner);
    void notifyCompletedMissions(loser);
    recordTransaction({ fromUserId: loserId, toUserId: winnerId, amount: game.wager * 2, type: "game_win", note: `game:${game.id}` });
    clearActiveGame(game.creatorId, game.id);
    clearActiveGame(game.opponentId, game.id);
    saveDatabase(db);

    return { winner, loser, winnerXp, loserXp };
}

function settleDraw(game: Game) {
    if (game.settled || game.status !== "playing" || !game.opponentId) return null;

    const creator = getStoredUser(game.creatorId);
    const opponent = getStoredUser(game.opponentId);
    if (!creator || !opponent || !game.creatorStakeHeld || !game.opponentStakeHeld) return null;

    if (game.creatorStakeHeld && !addCoinsSafe(creator, game.wager)) return null;
    if (game.opponentStakeHeld && !addCoinsSafe(opponent, game.wager)) return null;

    game.creatorStakeHeld = false;
    game.opponentStakeHeld = false;
    game.settled = true;
    game.status = "finished";

    addDraw(game.creatorId);
    addDraw(game.opponentId);
    const creatorXp = applyGameXp(creator, game.wager, game.type, false, true);
    const opponentXp = applyGameXp(opponent, game.wager, game.type, false, true);
    void notifyCompletedMissions(creator);
    void notifyCompletedMissions(opponent);
    recordTransaction({ amount: game.wager, type: "game_refund", note: `game:${game.id}:draw:${game.creatorId}` });
    recordTransaction({ amount: game.wager, type: "game_refund", note: `game:${game.id}:draw:${game.opponentId}` });
    clearActiveGame(game.creatorId, game.id);
    clearActiveGame(game.opponentId, game.id);
    saveDatabase(db);

    return { creator, opponent, creatorXp, opponentXp };
}

function addWin(id: number) {
    const user = getStoredUser(id);
    if (!user) return;
    user.stats.games++;
    user.stats.wins++;
    user.stats.winStreak++;
    user.stats.bestStreak = Math.max(user.stats.bestStreak, user.stats.winStreak);
    user.updatedAt = Date.now();
}

function addLoss(id: number) {
    const user = getStoredUser(id);
    if (!user) return;
    user.stats.games++;
    user.stats.losses++;
    user.stats.winStreak = 0;
    user.updatedAt = Date.now();
}

function addDraw(id: number) {
    const user = getStoredUser(id);
    if (!user) return;
    user.stats.games++;
    user.stats.draws++;
    user.stats.winStreak = 0;
    user.updatedAt = Date.now();
}

function addXp(user: User, delta: number, gameType: GameType, won: boolean) {
    const before = levelSnapshot(user);
    user.stats.xp = Math.max(0, Math.floor((user.stats.xp || 0) + delta));
    if (won) {
        if (gameType === "coinflip") user.stats.coinflipWins++;
        if (gameType === "rps") user.stats.rpsWins++;
        if (gameType === "tictactoe") user.stats.tttWins++;
        if (gameType === "dice") user.stats.diceWins++;
        if (gameType === "dart") user.stats.dartWins++;
        if (gameType === "number_guess") user.stats.guessWins++;
        if (gameType === "casino" as any) user.stats.casinoWins++;
    }
    user.updatedAt = Date.now();
    const after = levelSnapshot(user);
    return { before, after, delta };
}

function applyGameXp(user: User, bet: number, gameType: GameType, won: boolean, isDraw = false) {
    const winXp = xpForBet(bet);
    let delta: number;
    if (won) {
        delta = winXp;
    } else if (isDraw) {
        delta = Math.max(1, Math.floor(winXp / 2));
    } else {
        const penalty = Math.max(1, Math.floor(winXp / 2));
        const current = Math.max(0, user.stats.xp || 0);
        delta = -Math.min(penalty, current);
    }
    return addXp(user, delta, gameType, won);
}

function xpResultLine(user: User, award: { before: { level: number }; after: { level: number }; delta: number }) {
    const levelUp = award.after.level > award.before.level;
    const levelDown = award.after.level < award.before.level;
    const levelText = levelUp
        ? `🎉 <b>لول آپ شد: ${award.after.level}</b>`
        : levelDown
            ? `😬 <b>یه لول افتادی: ${award.after.level}</b>`
            : `⭐ <b>لول ${award.after.level}</b>`;
    const deltaText = award.delta > 0
        ? `+${formatNumber(award.delta)}`
        : award.delta < 0
            ? `-${formatNumber(Math.abs(award.delta))}`
            : `0`;
    const totalXp = Math.max(0, user.stats.xp || 0);
    return `${levelText}  •  XP: <b>${deltaText}</b>  •  مجموع XP: <b>${formatNumber(totalXp)}</b>`;
}

function xpRulesText() {
    return `⭐ <b>XP چطور کار می‌کنه؟</b>

🏆 ببری: XP کامل
💀 ببازی: نصف XP که قرار بود بگیری، می‌پره
🤝 مساوی: یه XP کوچیک

🎯 XP جمع کن، لولت بره بالا!`;
}

function xpText(user: User) {
    const s = levelSnapshot(user);
    if (s.level >= MAX_LEVEL) return `⭐ <b>لول ${MAX_LEVEL} • خدا</b>
████████████  <b>MAX</b>
✨ XP: <b>${formatNumber(user.stats.xp || 0)}</b>`;
    const pct = Math.floor((s.current / s.needed) * 100);
    const remaining = Math.max(0, s.needed - s.current);
    return `⭐ <b>لول ${s.level} • ${levelName(s.level)}</b>
${xpBar(s.current, s.needed)}  <b>${pct}٪</b>
✨ XP: <b>${formatNumber(s.current)} / ${formatNumber(s.needed)}</b>
📈 تا لول بعد: <b>${formatNumber(remaining)} XP</b>`;
}

function reconcileActiveGames() {
    const activeByUser = new Map<number, string>();

    for (const [id, game] of Object.entries(db.games)) {
        if (!ACTIVE_GAME_STATUSES.has(game.status)) continue;
        activeByUser.set(game.creatorId, id);
        if (game.opponentId) activeByUser.set(game.opponentId, id);
    }

    for (const user of Object.values(db.users)) {
        const expected = activeByUser.get(user.id);
        if (user.activeGameId !== expected) {
            if (expected) user.activeGameId = expected;
            else delete user.activeGameId;
            user.updatedAt = Date.now();
        }
    }
    saveDatabase(db);
}

function expireGames() {
    const now = Date.now();
    let changed = false;

    for (const [id, game] of Object.entries(db.games)) {
        if (now - game.createdAt <= GAME_TTL_MS) continue;
        refundGame(game);
        delete db.games[id];
        changed = true;
    }

    if (changed) saveDatabase(db);
}

reconcileActiveGames();
expireGames();
const cleanupTimer = setInterval(expireGames, 30_000);
(cleanupTimer as any).unref?.();

function activeGameFor(id: number) {
    const user = getStoredUser(id);
    if (!user?.activeGameId) return undefined;
    const game = db.games[user.activeGameId];
    if (!game || !ACTIVE_GAME_STATUSES.has(game.status)) {
        delete user.activeGameId;
        saveDatabase(db);
        return undefined;
    }
    return game;
}

function shortUser(user: User) {
    return `<a href="tg://user?id=${user.id}">${escapeHTML(user.name)}</a>`;
}

function identityText(user: User) {
    const username = user.username ? `@${user.username}` : "—";
    return [
        `👤 <b>${warmName(user.name)}</b>`,
        `⭐ ${copyNumber(levelSnapshot(user).level)} • ${escapeHTML(levelName(levelSnapshot(user).level))}`,
        `🪙 ${copyNumber(user.coins)} MBN  •  💰 ${copyNumber(coinsToToman(user.coins))} تومان`,
        `🆔 ${escapeHTML(username)}  •  <code>${user.id}</code>`
    ].join("\n");
}

function balanceText(user: User) {
    return `🪙 <b>موجودی ${warmName(user.name)}</b>
💰 <b>${copyNumber(user.coins)} MBN</b>
💵 ${copyNumber(coinsToToman(user.coins))} تومان`;
}

function profileText(user: User) {
    const played = user.stats.games;
    const rate = played ? Math.round((user.stats.wins / played) * 100) : 0;
    return [
        `👤 <b>${warmName(user.name)}</b>`,
        xpText(user),
        `🪙 ${copyNumber(user.coins)} MBN  •  📈 ${copyNumber(rate)}٪ برد`,
        `🎮 ${copyNumber(played)}  •  🏆 ${copyNumber(user.stats.wins)}  •  💀 ${copyNumber(user.stats.losses)}`,
        `🔥 استریک: <b>${copyNumber(user.stats.winStreak)}</b>  •  رکورد: <b>${copyNumber(user.stats.bestStreak)}</b>`
    ].join("\n");
}

function topText() {
    const users = Object.values(db.users);
    if (!users.length) return "🏆 هنوز کسی توی جدول قهرمان‌ها جا نگرفته.";
    const topXp = [...users].sort((a, b) => (b.stats.xp - a.stats.xp) || (b.stats.wins - a.stats.wins)).slice(0, 10);
    return [
        "🏆 <b>لیدربورد مبینا</b>",
        "",
        "⭐ <b>لول و XP</b>",
        ...topXp.map((u, i) => {
            const s = levelSnapshot(u);
            return `${i < 3 ? ["🥇", "🥈", "🥉"][i] : `#${i + 1}`} ${shortUser(u)}  •  ⭐ ${s.level} ${levelName(s.level)}  •  XP ${formatNumber(u.stats.xp)}`;
        }),
        "",
        `✊ RPS: ${leaderLine(users, "rpsWins")}`,
        `❌⭕ دوز: ${leaderLine(users, "tttWins")}`,
        `🎲 تاس: ${leaderLine(users, "diceWins")}`,
        `🎯 دارت: ${leaderLine(users, "dartWins")}`,
        `🎰 کازینو: ${leaderLine(users, "casinoWins")}`,
        `🎯 حدس عدد: ${leaderLine(users, "guessWins")}`
    ].join("\n");
}

function leaderLine(users: User[], key: keyof Stats) {
    const sorted = [...users].sort((a, b) => Number(b.stats[key] || 0) - Number(a.stats[key] || 0));
    const top = sorted[0];
    if (!top || Number(top.stats[key] || 0) <= 0) return "هنوز بردی برای این بخش ثبت نشده؛ اولین نفر تو باش! 🔥";
    return `${shortUser(top)} • ${formatNumber(Number(top.stats[key] || 0))} برد`;
}

function adminKeyboard(userId: number) {
    const rows: any[][] = [
        [
            styledCallback("🏠 داشبورد", "admin:home", "primary"),
            styledCallback("📊 آمار", "admin:stats", "primary")
        ],
        [
            styledCallback("👥 کاربران", "admin:users", "primary"),
            styledCallback("🔎 جستجو", "admin:find", "primary")
        ],
        [
            styledCallback("🎮 بازی‌های فعال", "admin:games", "primary"),
            styledCallback("🎰 کازینو", "admin:casino", "success")
        ],
        [
            styledCallback("💰 اقتصاد", "admin:economy", "success"),
            styledCallback("⭐ XP / لول", "admin:levels", "primary")
        ],
        [styledCallback("📜 تراکنش‌ها", "admin:transactions", "primary")]
    ];

    if (isOwner(userId)) {
        rows.push([
            styledCallback("🛡 ادمین‌ها", "admin:admins", "danger"),
            styledCallback("⚙️ کنسول مالک", "admin:owner", "danger")
        ]);
        rows.push([
            styledCallback("➕ 100", "admin:charge100", "success"),
            styledCallback("➕ 1000", "admin:charge1000", "success")
        ]);
    }

    return Markup.inlineKeyboard(rows);
}

async function sendPrivate(ctx: Context, text: string, keyboard?: any) {
    if (!ctx.from) return;

    if (!isPrivateChat(ctx)) {
        try {
            await ctx.telegram.sendMessage(ctx.from.id, text, {
                parse_mode: "HTML",
                reply_markup: (keyboard ?? privateKeyboardFor(ctx.from.id)).reply_markup
            });
            await ctx.reply("📩 پنل رو فرستادم توی پیویت 😎");
        } catch {
            const username = ctx.botInfo.username;
            const url = `https://t.me/${username}?start=panel`;
            await ctx.reply("💌 یه سر بیا پیوی بات و Start رو بزن تا پنل رو برات باز کنم 😉", {
                ...Markup.inlineKeyboard([[styledUrl("✉️ باز کردن پیوی", url, "primary")]])
            });
        }
        return;
    }

    await ctx.reply(text, {
        parse_mode: "HTML",
        ...keyboard
    });
}

function privateKeyboardFor(userId: number) {
    const rows: any[][] = [
        [
            styledCallback("🪙 جیب من", "pv:balance", "success"),
            styledCallback("👤 پروفایل من", "pv:profile", "primary")
        ],
        [
            styledCallback("🎡 گردونه", "pv:wheel", "success"),
            styledCallback("🎯 مأموریت‌هام", "pv:missions", "primary")
        ],
        [
            styledCallback("👥 زیرمجموعه", "pv:referral", "success"),
            styledCallback("🏆 خفن‌ها", "pv:top", "primary")
        ]
    ];
    if (isAdmin(userId)) rows.push([styledCallback("🛡 پنل مدیریت حرفه‌ای", "admin:home", "danger")]);
    return Markup.inlineKeyboard(rows);
}

function casinoBetKeyboard(userId: number, coins: number) {
    const presets = [20, 50, 100, 500, 1000, 5000].filter(v => v <= coins && v >= MIN_GAME_BET);
    const rows: any[][] = [];
    for (let i = 0; i < presets.length; i += 2) {
        rows.push(presets.slice(i, i + 2).map(v => styledCallback(
            `🎰 ${formatNumber(v)}`,
            `casino:bet:${userId}:${v}`,
            i % 2 === 0 ? "success" : "primary"
        )));
    }
    rows.push([styledCallback("✍️ مبلغ دلخواه", `casino:custom:${userId}`, "primary")]);
    return Markup.inlineKeyboard(rows);
}

function gameButtons(game: BaseGame) {
    return Markup.inlineKeyboard([[
        styledCallback("🔥 بزن بریم!", `game:join:${game.id}`, "success"),
        styledCallback("🛑 لغو بازی", `game:cancel:${game.id}`, "danger")
    ]]);
}

function waitingGameText(game: BaseGame) {
    const title = game.type === "coinflip"
        ? "🎲 بازی شانس"
        : game.type === "rps"
            ? "✊ سنگ، کاغذ، قیچی"
            : game.type === "dice"
                ? "🎲 نبرد تاس"
                : game.type === "dart"
                    ? "🎯 نبرد دارت"
                    : game.type === "casino"
                        ? "🎰 نبرد کازینو"
                        : "❌⭕ دوز";

    return [
        `<b>${title}</b>`,
        "",
        `👤 ${warmName(game.creatorName)} منتظر یه حریف خفنـه!`,
        `⭐ لول سازنده: <b>${levelSnapshot(getStoredUser(game.creatorId) || ({ stats: { xp: 0 } } as any)).level}</b>`,
        `🪙 شرط: <b>${copyNumber(game.wager)} MBN</b>`,
        `🏆 برنده این راند: <b>${copyNumber(game.wager * 2)} MBN</b>`,
        "",
        "👇 هرکی آماده‌ست، وارد نبرد شو!"
    ].join("\n");
}

function playingRpsKeyboard(gameId: string) {
    return Markup.inlineKeyboard([
        [
            styledCallback("🪨 سنگ", `rps:choose:${gameId}:rock`, "primary"),
            styledCallback("📄 کاغذ", `rps:choose:${gameId}:paper`, "success"),
            styledCallback("✂️ قیچی", `rps:choose:${gameId}:scissors`, "danger")
        ]
    ]);
}

function rpsName(choice?: RPSChoice) {
    if (choice === "rock") return "🪨 سنگ";
    if (choice === "paper") return "📄 کاغذ";
    if (choice === "scissors") return "✂️ قیچی";
    return "⏳";
}

function rpsWinner(a: RPSChoice, b: RPSChoice): "creator" | "opponent" | "draw" {
    if (a === b) return "draw";
    if (
        (a === "rock" && b === "scissors") ||
        (a === "paper" && b === "rock") ||
        (a === "scissors" && b === "paper")
    ) return "creator";
    return "opponent";
}

async function safeEditMessageById(chatId: number, messageId: number | undefined, text: string, extra?: any) {
    if (!messageId) return;
    try {
        await bot.telegram.editMessageText(chatId, messageId, undefined, text, extra);
    } catch (error: any) {
        const message = String(error?.description || error?.message || "");
        if (!message.includes("message is not modified") && !message.includes("message to edit not found")) {
            console.error("edit by id error:", error);
        }
    }
}

async function safeEdit(ctx: Context, text: string, extra?: any) {
    try {
        await ctx.editMessageText(text, extra);
    } catch (error: any) {
        if (!String(error?.description || error?.message).includes("message is not modified")) {
            console.error("edit error:", error);
        }
    }
}

async function createGame(ctx: Context, type: GameType, wager: number) {
    const from = ctx.from;
    const chat = ctx.chat;

    if (!from || !chat || chat.type === "private") return;

    return withMutationLock(async () => {
    const { user } = getUser(ctx.from!);

    if (user.coins < wager) {
        await replyWarm(
            ctx,
            `😅 <b>موجودی کافی نیست!</b>\n\n` +
            `🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>\n` +
            `🎯 شرط انتخابی: <b>${copyNumber(wager)} MBN</b>\n\n` +
            `💡 یه مبلغ کمتر انتخاب کن و دوباره شانس خودت رو امتحان کن 😉`,
            "lose",
            { parse_mode: "HTML" }
        );
        return;
    }

    const common = {
        id: randomId(),
        type,
        chatId: chat.id,
        creatorId: user.id,
        creatorName: user.name,
        wager,
        status: "waiting" as GameStatus,
        creatorStakeHeld: false,
        opponentStakeHeld: false,
        createdAt: Date.now(),
        settled: false
    };

    const game: Game = type === "coinflip"
        ? { ...common, type: "coinflip" }
        : type === "rps"
            ? { ...common, type: "rps" }
            : type === "dice"
                ? { ...common, type: "dice" }
                : type === "dart"
                    ? { ...common, type: "dart" }
                    : type === "casino"
                        ? { ...common, type: "casino" }
                        : {
                        ...common,
                        type: "tictactoe",
                        board: Array(9).fill(" "),
                        turn: user.id
                    };

    if (!reserveCreatorStake(game)) {
        await replyWarm(ctx, "😅 شرطت قفل نشد؛ دوباره بزن 👀", "game");
        return;
    }

    db.games[game.id] = game;
    user.updatedAt = Date.now();
    saveDatabase(db);

    try {
        const sent = await ctx.reply(waitingGameText(game), {
            parse_mode: "HTML",
            ...gameButtons(game)
        });
        game.messageId = sent.message_id;
        saveDatabase(db);
    } catch (error) {
        console.error("create game message error:", error);
        refundGame(game);
        delete db.games[game.id];
        saveDatabase(db);
        await replyWarm(
            ctx,
            "😕 <b>یه مشکلی موقع ساخت بازی پیش اومد.</b>\n\n" +
            "🪙 خیالت راحت؛ مبلغ شرط کامل برگشت داده شد. دوباره امتحان کن 💛",
            "game",
            { parse_mode: "HTML" }
        );
    }
    });
}

async function updateRps(ctx: Context, game: RPSGame) {
    const ready = Number(Boolean(game.creatorChoice)) + Number(Boolean(game.opponentChoice));
    const vibe = ready === 0 ? "😈 هر دوتون انتخاب کنین؛ ببینیم کی قراره برنده بشه!"
        : ready === 1 ? "👀 یکی انتخابش رو ثبت کرده... حالا نوبت نفر بعدیه!"
        : "⚡ انتخاب هر دوتون ثبت شد؛ وقتشه ببینیم کی برده!";
    await safeEdit(ctx,
        `✊ <b>نبرد سنگ، کاغذ، قیچی</b>\n\n` +
        `👤 ${warmName(game.creatorName)} ➜ ${game.creatorChoice ? "✅ انتخاب شد" : "⏳ هنوز انتخاب نکرده..."}\n` +
        `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ${game.opponentChoice ? "✅ انتخاب شد" : "⏳ هنوز انتخاب نکرده..."}\n\n` +
        `🪙 شرط: <b>${copyNumber(game.wager)} MBN</b>\n` +
        `👇 انتخابت رو بزن؛ بقیه‌ش با شانس و مهارته!`,
        { parse_mode: "HTML", ...playingRpsKeyboard(game.id) }
    );
}

function tttBoard(board: string[]) {
    return [0, 3, 6].map(row =>
        `${[0,1,2].map(offset => {
            const value = board[row + offset];
            return value === " " ? "▫️" : value;
        }).join("  ")}`
    ).join("\n");
}

function tttKeyboard(game: TicTacToeGame) {
    const rows: any[][] = [];
    for (let row = 0; row < 3; row++) {
        const line: any[] = [];
        for (let col = 0; col < 3; col++) {
            const index = row * 3 + col;
            const value = game.board[index];
            if (value === "❌") line.push(styledCallback("❌", `ttt:move:${game.id}:${index}`, "danger"));
            else if (value === "⭕") line.push(styledCallback("⭕", `ttt:move:${game.id}:${index}`, "success"));
            else line.push(styledCallback("　", `ttt:move:${game.id}:${index}`, "primary"));
        }
        rows.push(line);
    }
    return Markup.inlineKeyboard(rows);
}

async function updateTtt(ctx: Context, game: TicTacToeGame) {
    if (!game.opponentName) return;
    const turnName = game.turn === game.creatorId ? game.creatorName : game.opponentName;
    await safeEdit(ctx,
        `❌⭕ <b>دوز</b>  •  🔥 راند داغه!\n\n` +
        `❌ ${warmName(game.creatorName)}\n⭕ ${warmName(game.opponentName)}\n\n` +
        `${tttBoard(game.board)}\n\n` +
        `🪙 <b>${copyNumber(game.wager)} MBN</b>  •  🏆 <b>${copyNumber(game.wager * 2)} MBN</b>\n` +
        `🎯 نوبت <b>${warmName(turnName)}</b> ـه 👇`,
        { parse_mode: "HTML", ...tttKeyboard(game) }
    );
}

function checkWinner(board: string[]) {
    const lines = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ];

    for (const [a, b, c] of lines) {
        if (board[a] !== " " && board[a] === board[b] && board[a] === board[c]) return board[a];
    }
    return null;
}

async function finishCoinflip(ctx: Context, game: CoinflipGame) {
    await withMutationLock(async () => {
        const winnerId = random50(game.creatorId, game.opponentId!);
        const settled = settleWinner(game, winnerId);
        if (!settled) return;
        await sendStickerSafe(ctx, "win");
        const streak = settled.winner.stats.winStreak;
        await safeEdit(ctx,
            `🏁 <b>بازی شانس تموم شد!</b>\n\n` +
            `👑 برنده: <b>${warmName(settled.winner.name)}</b>\n` +
            `😵 بازنده: <b>${warmName(settled.loser.name)}</b>\n\n` +
            `🏆 جایزه: <b>${copyNumber(game.wager * 2)} MBN</b>\n` +
            `🪙 موجودی برنده: <b>${copyNumber(settled.winner.coins)}</b>\n` +
            `🪙 موجودی بازنده: <b>${copyNumber(settled.loser.coins)}</b>\n\n` +
            `${xpResultLine(settled.winner, settled.winnerXp)}\n` +
            `${xpResultLine(settled.loser, settled.loserXp)}` ,
            { parse_mode: "HTML" }
        );
        delete db.games[game.id];
        saveDatabase(db);
    });
}

bot.start(async ctx => {
    if (!ctx.from) return;
    const { user, created } = getUser(ctx.from);
    const rawStart = String((ctx as any).startPayload || "").trim();
    const refMatch = rawStart.match(/^ref_(\d+)$/i);
    if (created && refMatch) {
        const inviterId = Number(refMatch[1]);
        if (Number.isSafeInteger(inviterId) && inviterId > 0 && inviterId !== user.id && getStoredUser(inviterId)) {
            user.referredBy = inviterId;
            db.referrals[String(user.id)] = {
                inviterId,
                inviteeId: user.id,
                inviteeName: user.name,
                createdAt: Date.now(),
                groupJoined: false,
                channelJoined: false,
                rewarded: false,
            };
            saveDatabase(db);
            await checkReferralMembership("", user.id);
        }
    }

    if (!isPrivateChat(ctx)) {
        if (created) {
            await ctx.reply(`🎉 ${mention(ctx.from)} خوش اومدی!\n🪙 <b>+${copyNumber(STARTING_COINS)}</b> 💛`, { parse_mode: "HTML" });
        }
        return;
    }

    const hello = created
        ? `🎉 <b>خوش اومدی ${warmName(user.name)}!</b> 💛\n\n` +
          `من اینجام که چت رو با رقابت، شانس، هیجان و جایزه گرم‌تر کنیم 😎🔥\n\n` +
          `🪙 هدیهٔ شروع: <b>+${copyNumber(STARTING_COINS)} MBN</b>\n` +
          `💰 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>\n\n` +
          `😎 بیا بازی کنیم؛ XP، سکه و کلی رقابت داریم!`
        : `👋 <b>خوش برگشتی ${warmName(user.name)}!</b> 🫶\n\n` +
          `💰 موجودی فعلیت <b>${copyNumber(user.coins)} MBN</b> ـه؛ بزن بریم یه راند دیگه! 😎\n` +
          `🎯 یه راند دیگه بزنیم؟ 😎`;

    await sendStickerSafe(ctx, created ? "welcome" : "game");

    const mainKeyboard = Markup.inlineKeyboard([
        [Markup.button.webApp("🚀 باز کردن مینی‌اپ مبینا", WEBAPP_URL)],
        ...(privateKeyboardFor(user.id).reply_markup as any).inline_keyboard
    ]);

    await ctx.reply(hello, {
        parse_mode: "HTML",
        ...mainKeyboard
    });
});
function referralKey(inviteeId: number) { return String(inviteeId); }

function getReferralList(inviterId: number) {
    return Object.values(db.referrals ?? {}).filter(r => r.inviterId === inviterId);
}

function referralLink(botUsername: string, userId: number) {
    return `https://t.me/${botUsername}?start=ref_${userId}`;
}

function referralText(userId: number, botUsername: string) {
    const list = getReferralList(userId);
    const successful = list.filter(r => r.rewarded).length;
    const pending = list.length - successful;
    const lines = [
        "👥 <b>مرکز زیرمجموعه‌گیری مبینا</b>",
        "",
        `🎁 پاداش هر دعوت موفق: <b>${formatNumber(REFERRAL_REWARD)} سکه</b> برای شما و دوستت`,
        `✅ دعوت‌های موفق: <b>${successful}</b> نفر`,
        `⏳ دعوت‌های در انتظار: <b>${pending}</b> نفر`,
        "",
        `🔗 <b>لینک اختصاصی تو:</b>
<code>${escapeHTML(referralLink(botUsername, userId))}</code>`,
        "",
        "📌 پاداش وقتی ثبت می‌شه که فرد دعوت‌شده واقعاً وارد گپ و کانال تنظیم‌شده شود.",
        "",
        ...(list.length ? ["👤 <b>دعوت‌ها:</b>", ...list.slice(-10).reverse().map(r => `${r.rewarded ? "✅" : "⏳"} ${escapeHTML(r.inviteeName)} • ${r.groupJoined ? "گپ✅" : "گپ⏳"} • ${r.channelJoined ? "کانال✅" : "کانال⏳"}`)] : ["هنوز کسی با لینک تو وارد نشده؛ اولین رفیقت رو دعوت کن! 🚀"]),
    ];
    return lines.join("\n");
}

function referralKeyboard(userId: number) {
    return Markup.inlineKeyboard([
        [styledCallback("🔄 بروزرسانی", "pv:referral", "primary")],
        [styledCallback("↩️ برگشت", "pv:home", "primary")],
    ]);
}

async function rewardReferralIfComplete(inviteeId: number) {
    const referral = db.referrals[referralKey(inviteeId)];
    if (!referral || referral.rewarded || !referral.groupJoined || !referral.channelJoined) return false;
    const inviter = getStoredUser(referral.inviterId);
    const invitee = getStoredUser(inviteeId);
    if (!inviter || !invitee) return false;
    if (!canAddCoins(inviter, REFERRAL_REWARD) || !canAddCoins(invitee, REFERRAL_REWARD)) return false;
    inviter.coins += REFERRAL_REWARD;
    invitee.coins += REFERRAL_REWARD;
    referral.rewarded = true;
    referral.rewardedAt = Date.now();
    recordTransaction({ toUserId: inviter.id, amount: REFERRAL_REWARD, type: "referral_reward", note: `referral:${inviteeId}` });
    recordTransaction({ toUserId: invitee.id, amount: REFERRAL_REWARD, type: "referral_reward", note: `referral:${inviter.id}` });
    saveDatabase(db);
    try {
        await bot.telegram.sendMessage(inviter.id, `🎉 <b>زیرمجموعه موفق!</b>\n\n👤 ${escapeHTML(referral.inviteeName)} با لینک تو اومد و شرایط دعوت رو کامل کرد.\n🎁 پاداش تو: <b>+${formatNumber(REFERRAL_REWARD)} سکه</b>`, { parse_mode: "HTML" });
    } catch {}
    try {
        await bot.telegram.sendMessage(invitee.id, `🎉 <b>دعوت با موفقیت ثبت شد!</b>\n\n👤 دعوت‌کننده: <b>${escapeHTML(inviter.name)}</b>\n🎁 پاداش تو: <b>+${formatNumber(REFERRAL_REWARD)} سکه</b>`, { parse_mode: "HTML" });
    } catch {}
    return true;
}

async function checkReferralMembership(chatId: string, userId: number) {
    if (!REFERRAL_GROUP_ID && !REFERRAL_CHANNEL_ID) return;
    for (const [kind, targetChat] of [["group", REFERRAL_GROUP_ID], ["channel", REFERRAL_CHANNEL_ID]] as const) {
        if (!targetChat) continue;
        try {
            const member = await bot.telegram.getChatMember(targetChat, userId);
            const status = String(member.status);
            const ok = status === "member" || status === "administrator" || status === "creator" || (status === "restricted" && (member as any).is_member !== false);
            const referral = db.referrals[String(userId)];
            if (!referral) continue;
            if (kind === "group") referral.groupJoined = ok;
            else referral.channelJoined = ok;
            saveDatabase(db);
            await rewardReferralIfComplete(userId);
        } catch (error) {
            console.error(`referral ${kind} membership check failed:`, error);
        }
    }
}

const HELP_TEXT = `
🎉 <b>سلام رفیق! خوش اومدی به دنیای بازی‌های مبینا</b> 💛

🎮 <b>بازی‌های دونفره در گپ</b>
🎲 <code>بازی 100</code>  |  <code>شانس 100</code>
✊ <code>گیم 100</code>  |  <code>rps 100</code>
❌⭕ <code>دوز 100</code>
🎲 <code>تاس 100</code>
🎯 <code>دارت 100</code>
🎰 <code>کازینو 100</code>  |  <code>اسلات 100</code>

🎯 <b>حدس عدد</b>
<code>حدس عدد 100</code>
عدد ۱ تا ۷ رو انتخاب کن و شانست رو امتحان کن 🔥

⭐ <b>XP و لول</b>
<code>لول</code> یا <code>XP</code>

💰 <b>اطلاعات حساب</b>
<code>موجودی</code>  •  <code>پروفایل</code>  •  <code>برترین</code>

🎡 <b>گردونه روزانه</b>
<code>گردونه</code>

🎯 <b>ماموریت‌ها</b>
<code>ماموریت</code>

💸 <b>انتقال MBN</b>
روی پیام کاربر Reply کن و مبلغ موردنظر رو ارسال کن.

━━━━━━━━━━━━━━
🏆 <b>بازی کن • XP بگیر • لول شو • برنده شو</b>
❤️ <b>موفق باشی رفیق!</b>
`;

bot.hears(/^راهنما$/i, async (ctx) => {
    if (ctx.chat?.type !== "private") return;

    try {
        await ctx.reply(HELP_TEXT, {
            parse_mode: "HTML",
        });
    } catch (error) {
        console.error("help message error:", error);
    }
});

bot.on(message("new_chat_members"), async ctx => {
    if (isPrivateChat(ctx)) return;

    for (const member of ctx.message.new_chat_members) {
        if (member.is_bot) continue;

        try {
            const { user, created } = getUser(member);

            await sendStickerSafe(ctx, "welcome");

            if (created) {
                await ctx.reply(
                    `🎉 ${mention(member)} <b>به جمع‌مون خوش اومدی!</b> 🫶\n\n` +
                    `🪙 هدیهٔ شروع: <b>+${copyNumber(STARTING_COINS)} MBN</b>\n` +
                    `💰 موجودی: <b>${copyNumber(user.coins)} MBN</b>\n\n` +
                    `😎 حالا دیگه رسماً آماده‌ای برای بازی و رقابت!`,
                    { parse_mode: "HTML" }
                );
            } else {
                await ctx.reply(
                    `🎉 ${mention(member)} <b>خوش اومدی!</b> 🫶\n\n` +
                    `💰 موجودیت: <b>${copyNumber(user.coins)} MBN</b>\n` +
                    `😎 بزن بریم بازی!`,
                    { parse_mode: "HTML" }
                );
            }
        } catch (error) {
            console.error("welcome handler error:", error);
        }
    }
});

bot.command("referral", async ctx => {
    if (!ctx.from || !isPrivateChat(ctx)) return;
    await ctx.reply(referralText(ctx.from.id, ctx.botInfo.username), { parse_mode: "HTML", ...referralKeyboard(ctx.from.id) });
});

bot.command("balance", async ctx => {
    if (!ctx.from) return;
    await sendPrivate(ctx, balanceText(getUser(ctx.from).user), privateKeyboardFor(ctx.from.id));
});

bot.command("profile", async ctx => {
    if (!ctx.from) return;
    await sendPrivate(ctx, profileText(getUser(ctx.from).user), privateKeyboardFor(ctx.from.id));
});

bot.command("top", async ctx => {
    if (!ctx.from) return;
    await sendPrivate(ctx, topText(), privateKeyboardFor(ctx.from.id));
});

bot.command("admin", async ctx => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await replyWarm(ctx, "⛔ اوپس! این بخش مخصوص ادمین‌هاست 😄🛡", undefined, { parse_mode: "HTML" });
        return;
    }

    if (!isPrivateChat(ctx)) {
        try {
            await ctx.telegram.sendMessage(ctx.from.id, "🛡 <b>پنل مدیریت</b>", {
                parse_mode: "HTML",
                reply_markup: adminKeyboard(ctx.from.id).reply_markup
            });
            await ctx.reply("📩 پنل فرستاده شد 😎");
        } catch {
            await ctx.reply("📩 یه سر بیا پیوی بات و Start رو بزن 😉");
        }
        return;
    }

    await ctx.reply("🛡 <b>پنل مدیریت</b>", {
        parse_mode: "HTML",
        ...adminKeyboard(ctx.from.id)
    });
});

bot.action(/^pv:(home|balance|profile|top|missions|wheel|casino|referral)$/, async ctx => {
    if (!ctx.from) return;
    await safeAnswerCbQuery(ctx);
    const { user } = getUser(ctx.from);
    const key = ctx.match[1];
    if (key === "home") {
        await ctx.editMessageText(`🏠 <b>منوی اصلی مبینا</b>

💰 موجودی: <b>${copyNumber(user.coins)} MBN</b>`, { parse_mode: "HTML", ...privateKeyboardFor(user.id) });
        return;
    }
    if (key === "balance") await ctx.editMessageText(balanceText(user), { parse_mode: "HTML", ...privateKeyboardFor(user.id) });
    if (key === "profile") await ctx.editMessageText(profileText(user), { parse_mode: "HTML", ...privateKeyboardFor(user.id) });
    if (key === "top") await ctx.editMessageText(topText(), { parse_mode: "HTML", ...privateKeyboardFor(user.id) });
    if (key === "missions") await ctx.editMessageText(missionText(user), { parse_mode: "HTML", ...privateKeyboardFor(user.id) });
    if (key === "wheel") {
        await handleDailyWheel(ctx);
        return;
    }
    if (key === "referral") {
        await ctx.editMessageText(referralText(ctx.from.id, ctx.botInfo.username), { parse_mode: "HTML", ...referralKeyboard(ctx.from.id) });
        return;
    }
    if (key === "casino") {
        await ctx.editMessageText(
            `🎰 <b>کازینو حرفه‌ای</b>\n\n` +
            `🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>\n` +
            `🎯 حداقل شرط: <b>${copyNumber(MIN_GAME_BET)} MBN</b>\n\n` +
            `👇 مبلغ شرطت رو انتخاب کن:`,
            { parse_mode: "HTML", ...casinoBetKeyboard(user.id, user.coins) }
        );
        return;
    }
});

bot.action(/^admin:(home|stats|games|users|find|ops|casino|economy|transactions|admins|owner|levels|charge100|charge1000|cancel):?(.*)$/, async ctx => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await safeAnswerCbQuery(ctx, "⛔ دسترسی این بخش رو نداری.", { show_alert: true });
        return;
    }
    await withMutationLock(async () => {

    const action = ctx.match[1];
    const actionId = ctx.match[2];

    if (action === "cancel") {
        const game = actionId ? db.games[actionId] : undefined;
        if (!game || !ACTIVE_GAME_STATUSES.has(game.status)) {
            await safeAnswerCbQuery(ctx, "❌ این بازی دیگه پیدا نمی‌شه؛ احتمالاً تموم شده یا لغو شده.", { show_alert: true });
            return;
        }
        const refunded = refundGame(game);
        if (refunded) {
            await safeEditMessageById(game.chatId, game.messageId, "✖️ <b>بازی توسط مدیریت 🛑 لغو شد..</b>\n\n🪙 تمام شرط‌های درگیر به حساب بازیکن‌ها برگشت.", { parse_mode: "HTML" });
            delete db.games[game.id];
            saveDatabase(db);
        }
        await safeAnswerCbQuery(ctx, refunded ? "بازی 🛑 لغو شد. ✅" : "این بازی قبلاً تسویه شده.", { show_alert: !refunded });
        await ctx.editMessageText("✖️ <b>بازی 🛑 لغو شد..</b>\n\n🪙 مبلغ شرط‌ها کامل برگشت خورد.", { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
        return;
    }

    if (action === "home") {
        const users = Object.values(db.users);
        const activeGames = Object.values(db.games).filter(g => ACTIVE_GAME_STATUSES.has(g.status)).length;
        const totalCoins = users.reduce((sum, u) => sum + u.coins, 0);
        const totalXp = users.reduce((sum, u) => sum + (u.stats.xp || 0), 0);
        const text = [
            "🛡 <b>مرکز مدیریت حرفه‌ای مبینا</b>",
            "",
            `👥 کاربران: <b>${copyNumber(users.length)}</b>`,
            `🎮 بازی فعال: <b>${copyNumber(activeGames)}</b>`,
            `🏁 بازی تمام‌شده: <b>${copyNumber(db.totals.games)}</b>`,
            `🪙 نقدینگی کاربران: <b>${copyNumber(totalCoins)} MBN</b>`,
            `⭐ مجموع XP: <b>${copyNumber(totalXp)}</b>`,
            `💸 پرداخت بازی‌ها: <b>${copyNumber(db.totals.coinsPaid)} MBN</b>`,
            `📜 تراکنش‌ها: <b>${copyNumber(db.transactions.length)}</b>`,
            "",
            "⚡ از دکمه‌های زیر برای کنترل کامل سیستم استفاده کن."
        ].join("\n");
        await ctx.editMessageText(text, { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
        return;
    }

    if (action === "stats") {
        const totalUsers = Object.keys(db.users).length;
        const activeGames = Object.values(db.games).filter(g => ACTIVE_GAME_STATUSES.has(g.status)).length;
        const totalCoins = Object.values(db.users).reduce((sum, u) => sum + u.coins, 0);
        const text = [
            "📊 <b>آمار</b>",
            "",
            `👥 کاربران: <b>${copyNumber(totalUsers)}</b>`,
            `🎮 بازی‌های فعال: <b>${copyNumber(activeGames)}</b>`,
            `🎯 کل بازی‌های تمام‌شده: <b>${copyNumber(db.totals.games)}</b>`,
            `🪙 کل موجودی: <b>${copyNumber(totalCoins)} MBN</b>`,
            `💸 کل پرداخت بازی‌ها: <b>${copyNumber(db.totals.coinsPaid)} MBN</b>`,
            `📜 تراکنش‌های ثبت‌شده: <b>${copyNumber(db.transactions.length)}</b>`,
            "",
            `🎰 کازینو: <b>${copyNumber(Object.values(db.users).reduce((s, u) => s + u.stats.casinoWins, 0))}</b> برد`,
            `🎲 تاس: <b>${copyNumber(Object.values(db.users).reduce((s, u) => s + u.stats.diceWins, 0))}</b> برد`,
            `🎯 دارت: <b>${copyNumber(Object.values(db.users).reduce((s, u) => s + u.stats.dartWins, 0))}</b> برد`,
            `✊ RPS: <b>${copyNumber(Object.values(db.users).reduce((s, u) => s + u.stats.rpsWins, 0))}</b> برد`,
            `❌⭕ دوز: <b>${copyNumber(Object.values(db.users).reduce((s, u) => s + u.stats.tttWins, 0))}</b> برد`
        ].join("\n");
        await ctx.editMessageText(text, { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
        return;
    }

    if (action === "games") {
        const games = Object.values(db.games).filter(g => ACTIVE_GAME_STATUSES.has(g.status)).slice(0, 20);
        const text = games.length
            ? ["🎮 <b>بازی‌های فعال</b>", "", ...games.map(g => `${gameTypeTitle(g.type)}  •  ${escapeHTML(g.creatorName)}${g.opponentName ? ` 🆚 ${escapeHTML(g.opponentName)}` : ""}  •  🪙 ${copyNumber(g.wager)}`)].join("\n")
            : "🎮 بازی فعالی نیست.";
        const rows: any[][] = [];
        for (const game of games.slice(0, 10)) rows.push([styledCallback(`✖️ لغو ${gameTypeTitle(game.type)} ${formatNumber(game.wager)}`, `admin:cancel:${game.id}`, "danger")]);
        rows.push([styledCallback("↩️ برگشت", "admin:home", "primary")]);
        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: Markup.inlineKeyboard(rows).reply_markup });
        return;
    }

    if (action === "casino") {
        const casinoTx = db.transactions.filter(tx => tx.type === "casino_game");
        const wins = casinoTx.filter(tx => (tx.note || "").startsWith("casino:")).length;
        const losses = casinoTx.filter(tx => (tx.note || "").startsWith("casino-loss:")).length;
        const paid = casinoTx.filter(tx => (tx.toUserId != null)).reduce((sum, tx) => sum + tx.amount, 0);
        const top = Object.values(db.users).sort((a, b) => b.stats.casinoWins - a.stats.casinoWins).slice(0, 5);
        const text = [
            "🎰 <b>کنترل‌سنتر کازینو</b>",
            "",
            `🎮 راند ثبت‌شده: <b>${copyNumber(casinoTx.length)}</b>`,
            `🏆 بردهای ثبت‌شده: <b>${copyNumber(wins)}</b>`,
            `💥 باخت‌های ثبت‌شده: <b>${copyNumber(losses)}</b>`,
            `💰 پرداخت ثبت‌شده: <b>${copyNumber(paid)} MBN</b>`,
            `📈 نرخ برد کاربران: <b>${casinoTx.length ? Math.round((wins / casinoTx.length) * 100) : 0}%</b>`,
            "",
            "🏆 <b>برترین‌های کازینو</b>",
            ...(top.length ? top.map((u, i) => `${i + 1}. ${shortUser(u)} • ${copyNumber(u.stats.casinoWins)} برد`) : ["هنوز رکوردی نیست"])
        ].join("\n");
        await ctx.editMessageText(text, { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
        return;
    }

    if (action === "economy") {
        const users = Object.values(db.users);
        const totalCoins = users.reduce((sum, u) => sum + u.coins, 0);
        const avgCoins = users.length ? Math.floor(totalCoins / users.length) : 0;
        const richest = [...users].sort((a, b) => b.coins - a.coins).slice(0, 5);
        const text = [
            "💰 <b>داشبورد اقتصادی</b>",
            "",
            `👥 کاربران: <b>${copyNumber(users.length)}</b>`,
            `🪙 کل موجودی: <b>${copyNumber(totalCoins)} MBN</b>`,
            `📊 میانگین موجودی: <b>${copyNumber(avgCoins)} MBN</b>`,
            `💸 پرداخت کل بازی‌ها: <b>${copyNumber(db.totals.coinsPaid)} MBN</b>`,
            `📜 تعداد تراکنش‌ها: <b>${copyNumber(db.transactions.length)}</b>`,
            "",
            "👑 <b>پولدارترین کاربران</b>",
            ...(richest.length ? richest.map((u, i) => `${i + 1}. ${shortUser(u)} • ${copyNumber(u.coins)} MBN`) : ["هنوز کاربری اینجا ثبت نشده."])
        ].join("\n");
        await ctx.editMessageText(text, { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
        return;
    }

    if (action === "users") {
        const allUsers = Object.values(db.users);
        const users = allUsers.sort((a, b) => (b.coins - a.coins) || (b.stats.xp - a.stats.xp)).slice(0, 20);
        const text = users.length
            ? ["👥 <b>کاربران</b>", `مجموع: <b>${copyNumber(allUsers.length)}</b>`, "", ...users.map(u => { const s = levelSnapshot(u); return `• ${shortUser(u)}  |  <code>${u.id}</code>  |  🪙 ${copyNumber(u.coins)}  |  ⭐ ${s.level}  |  XP ${formatNumber(u.stats.xp)}`; })].join("\n")
            : "👥 هنوز هیچ کاربری ثبت نشده.";
        await ctx.editMessageText(text, { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
        return;
    }

    if (action === "find") {
        await ctx.editMessageText(
            "🔎 <b>جستجوی کاربر</b>\n\n<code>کاربر 123456789</code>\nیا\n<code>کاربر @username</code>",
            { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) }
        );
        return;
    }

    if (action === "transactions") {
        const txs = db.transactions.slice(-20).reverse();
        const text = txs.length
            ? ["📜 <b>آخرین تراکنش‌ها</b>", "", ...txs.map(tx => {
                const from = tx.fromUserId ? `<code>${tx.fromUserId}</code>` : "سیستم";
                const to = tx.toUserId ? `<code>${tx.toUserId}</code>` : "—";
                return `• ${escapeHTML(tx.type)} | ${copyNumber(tx.amount)} MBN | ${from} ➜ ${to}`;
            })].join("\n")
            : "📜 تراکنشی ثبت نشده.";
        await ctx.editMessageText(text, { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
        return;
    }

    if (action === "levels") {
        await ctx.editMessageText(
            "⭐ <b>مرکز XP و لول</b>\n\n" +
            "تنظیم مستقیم: <code>لول 50 123456789</code>\n" +
            "تنظیم XP: <code>XP 5000 123456789</code>\n" +
            "افزایش XP: <code>افزایش XP 500 123456789</code>\n" +
            "کسر XP: <code>کسر XP 200 123456789</code>\n\n" +
            "✅ تغییرات بلافاصله ذخیره می‌شوند.",
            { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) }
        );
        return;
    }

    if (action === "charge100" || action === "charge1000") {
        if (!isOwner(ctx.from.id)) {
            await safeAnswerCbQuery(ctx, "فقط مالک.", { show_alert: true });
            return;
        }
        const amount = action === "charge100" ? 100 : 1000;
        const owner = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;
        const before = owner.coins;
        if (!addCoinsSafe(owner, amount)) {
            await replyWarm(ctx, "😵‍💫 موجودی به سقف امن رسیده؛ فعلاً این یکی رو نمی‌شه انجام داد.", "game");
            return true;
        }
        owner.updatedAt = Date.now();
        recordTransaction({ toUserId: owner.id, amount, type: "owner_charge", note: "quick-charge" });
        saveDatabase(db);
        await ctx.editMessageText(
            `💰 <b>حساب مالک شارژ شد</b>\n\nقبل: <b>${copyNumber(before)}</b> MBN\nافزایش: <b>${copyNumber(amount)}</b> MBN\nبعد: <b>${copyNumber(owner.coins)}</b> MBN`,
            { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) }
        );
        return;
    }

    if (action === "owner") {
        if (!isOwner(ctx.from.id)) {
            await safeAnswerCbQuery(ctx, "👑 این بخش فقط برای سازندهٔ باته.", { show_alert: true });
            return;
        }
        const totalUsers = Object.keys(db.users).length;
        const activeGames = Object.values(db.games).filter(g => ACTIVE_GAME_STATUSES.has(g.status)).length;
        const admins = db.admins.length;
        await ctx.editMessageText(
            `⚙️ <b>کنسول مالک</b>\n\n` +
            `👥 کاربران: <b>${copyNumber(totalUsers)}</b>\n` +
            `🎮 بازی فعال: <b>${copyNumber(activeGames)}</b>\n` +
            `🛡 ادمین: <b>${copyNumber(admins)}</b>\n\n` +
            `افزودن ادمین: <code>ادمین + 123456789</code>\n` +
            `حذف ادمین: <code>ادمین - 123456789</code>\n` +
            `شارژ دلخواه: <code>شارژ 10000</code>`,
            { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) }
        );
        return;
    }

    if (action === "ops") {
        const text = [
            "💰 <b>عملیات مدیریتی</b>",
            "",
            "کسر موجودی از کاربر:",
            "<code>کسر 100</code> را روی پیام همان کاربر Reply کن.",
            "🔐 🔐 فقط مالک و ادمین‌های مجاز اجازه استفاده از این دستور رو دارن.",
            "💼 مبلغ کسرشده مستقیماً به حساب مالک منتقل می‌شود.",
            "",
            "انتقال بین کاربران:",
            "<code>انتقال 100</code> را روی پیام گیرنده Reply کن.",
            "👥 این دستور برای همه کاربران فعال است.",
            "",
            "شارژ حساب مالک:",
            "<code>شارژ 10000</code>"
        ].join("\n");
        await ctx.editMessageText(text, { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
        return;
    }

    if (action === "admins") {
        if (!isOwner(ctx.from.id)) {
            await safeAnswerCbQuery(ctx, "👑 این بخش فقط برای سازندهٔ باته.", { show_alert: true });
            return;
        }
        const lines = db.admins.map(id => {
            const user = getStoredUser(id);
            return `• ${user ? escapeHTML(user.name) : "کاربر"}  •  <code>${id}</code>${isOwner(id) ? "  👑" : ""}`;
        });
        const text = [
            "🛡 <b>ادمین‌ها</b>",
            "",
            lines.length ? lines.join("\n") : "هنوز هیچ ادمینی ثبت نشده.",
            "",
            "افزودن: <code>ادمین + 123456789</code>",
            "حذف: <code>ادمین - 123456789</code>"
        ].join("\n");
        await ctx.editMessageText(text, { parse_mode: "HTML", ...adminKeyboard(ctx.from.id) });
    }
    });
});

function gameTypeTitle(type: GameType) {
    if (type === "coinflip") return "🎲 شانس";
    if (type === "rps") return "✊ سنگ‌کاغذقیچی";
    if (type === "dice") return "🎲 تاس";
    if (type === "dart") return "🎯 دارت";
    if (type === "casino") return "🎰 کازینو";
    return "❌⭕ دوز";
}

function diceGroupPredictionKeyboard(game: DiceGame) {
    const bothReady = Boolean(game.creatorMode) && Boolean(game.opponentMode);
    const rows: any[][] = [];

    if (bothReady) {
        rows.push([styledCallback("🎲 انداختن تاس", `game:dice-roll:${game.id}`, "success")]);
    } else {
        rows.push([
            styledCallback("🔵 زوج", `gd:mode:${game.id}:even`, "primary"),
            styledCallback("🔴 فرد", `gd:mode:${game.id}:odd`, "success")
        ]);
        rows.push([styledCallback("🎯 عدد دقیق", `gd:mode:${game.id}:exact`, "danger")]);
    }
    rows.push([styledCallback("❌ لغو", `game:cancel:${game.id}`, "danger")]);
    return Markup.inlineKeyboard(rows);
}

function diceGroupExactKeyboard(game: DiceGame) {
    const nums = [1, 2, 3, 4, 5, 6].map(n =>
        styledCallback(String(n), `gd:pick:${game.id}:${n}`, n % 2 ? "success" : "primary")
    );
    return Markup.inlineKeyboard([
        nums.slice(0, 3),
        nums.slice(3),
        [styledCallback("↩️ پیش‌بینی دیگر", `gd:back:${game.id}`, "primary")]
    ]);
}

function diceModeText(mode?: DicePredictionMode, exact?: number) {
    if (!mode) return "⏳ انتخاب نشده";
    if (mode === "even") return "🔵 زوج";
    if (mode === "odd") return "🔴 فرد";
    return `🎯 دقیقاً ${exact ?? "?"}`;
}

function diceDartButtons(game: BaseGame) {
    const label = game.type === "dice" ? "🎲 انداختن تاس" : "🎯 پرتاب دارت";
    const action = game.type === "dice" ? "game:dice-roll" : "game:dart-roll";
    return Markup.inlineKeyboard([
        [styledCallback(label, `${action}:${game.id}`)],
        [styledCallback("❌ لغو", `game:cancel:${game.id}`, "danger")]
    ]);
}

function casinoGroupButtons(game: CasinoGame) {
    return Markup.inlineKeyboard([
        [styledCallback("🎰 اسپین من", `game:casino-roll:${game.id}`, "success")],
        [styledCallback("❌ لغو", `game:cancel:${game.id}`, "danger")]
    ]);
}

async function rollGroupDice(ctx: any, game: DiceGame) {
    if (!ctx.from || !game.opponentId || game.status !== "playing" || game.settled) return;

    if (ctx.from.id !== game.creatorId && ctx.from.id !== game.opponentId) {
        await safeAnswerCbQuery(ctx, "⛔ این بازی مال تو نیست؛ از دکمه‌های بازی خودت استفاده کن 😄", { show_alert: true });
        return;
    }

    const isCreator = ctx.from.id === game.creatorId;
    const currentMode = isCreator ? game.creatorMode : game.opponentMode;
    const currentExact = isCreator ? game.creatorExact : game.opponentExact;
    if (!currentMode) {
        await safeAnswerCbQuery(ctx, "اول پیش‌بینی‌ات را انتخاب کن.", { show_alert: true });
        await safeEdit(ctx,
            `🎲 <b>نبرد تاس</b>\n\n` +
            `👤 ${warmName(game.creatorName)} ➜ ${diceModeText(game.creatorMode, game.creatorExact)}\n` +
            `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ${diceModeText(game.opponentMode, game.opponentExact)}\n\n` +
            `🪙 شرط هر نفر: <b>${copyNumber(game.wager)} MBN</b>\n` +
            `🏆 زوج/فرد: <b>${copyNumber(game.wager * 2)} MBN</b>\n` +
            `🎯 عدد دقیق: <b>${copyNumber(game.wager * 4)} MBN</b>\n\n` +
            `👇 پیش‌بینی خودت را انتخاب کن`,
            { parse_mode: "HTML", ...diceGroupPredictionKeyboard(game) }
        );
        return;
    }

    const currentRoll = isCreator ? game.creatorRoll : game.opponentRoll;
    if (currentRoll != null) {
        await safeAnswerCbQuery(ctx, "تاس خودت قبلاً انداخته شده 😄", { show_alert: true });
        return;
    }

    try {
        const msg = await ctx.telegram.sendDice(game.chatId, { emoji: "🎲" });
        const value = Number(msg?.dice?.value);
        if (!Number.isInteger(value) || value < 1 || value > 6) {
            await safeAnswerCbQuery(ctx, "نتیجه تاس نامعتبر بود.", { show_alert: true });
            return;
        }

        if (isCreator) game.creatorRoll = value;
        else game.opponentRoll = value;

        saveDatabase(db);
        await safeAnswerCbQuery(ctx, "تاس ✅ ثبت شد؛ بزن بریم!");

        if (game.creatorRoll == null || game.opponentRoll == null) {
            await safeEdit(ctx,
                `🎲 <b>نبرد تاس</b>\n\n` +
                `👤 ${warmName(game.creatorName)} ➜ ${diceModeText(game.creatorMode, game.creatorExact)}  |  ${game.creatorRoll == null ? "⏳ منتظر تاس" : `✅ ${game.creatorRoll}`}\n` +
                `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ${diceModeText(game.opponentMode, game.opponentExact)}  |  ${game.opponentRoll == null ? "⏳ منتظر تاس" : `✅ ${game.opponentRoll}`}\n\n` +
                `🪙 شرط هر نفر: <b>${copyNumber(game.wager)} MBN</b>\n` +
                `🏆 زوج/فرد: <b>${copyNumber(game.wager * 2)} MBN</b>  •  🎯 دقیق: <b>${copyNumber(game.wager * 4)} MBN</b>\n\n` +
                `👇 هر دو نفر پیش‌بینی و تاس خودشان را ثبت کنند`,
                { parse_mode: "HTML", ...diceGroupPredictionKeyboard(game) }
            );
            return;
        }

        const a = Number(game.creatorRoll);
        const b = Number(game.opponentRoll);
        const predicts = (mode?: DicePredictionMode, exact?: number, value?: number) => {
            if (!mode || value == null) return false;
            return mode === "even" ? value % 2 === 0
                : mode === "odd" ? value % 2 === 1
                : value === exact;
        };

        const creatorCorrect = predicts(game.creatorMode, game.creatorExact, a);
        const opponentCorrect = predicts(game.opponentMode, game.opponentExact, b);

        let winnerId: number | null = null;
        if (creatorCorrect && !opponentCorrect) winnerId = game.creatorId;
        else if (opponentCorrect && !creatorCorrect) winnerId = game.opponentId!;
        else if (creatorCorrect && opponentCorrect) {
            if (a > b) winnerId = game.creatorId;
            else if (b > a) winnerId = game.opponentId!;
        } else {
            if (a > b) winnerId = game.creatorId;
            else if (b > a) winnerId = game.opponentId!;
        }

        if (winnerId == null) {
            const settled = settleDraw(game);
            if (!settled) return;
            await sendStickerSafe(ctx, "dice");
            await safeEdit(ctx,
                `🤝 <b>نبرد تاس مساوی شد!</b>\n\n` +
                `👤 ${warmName(game.creatorName)} → ${diceModeText(game.creatorMode, game.creatorExact)} → <b>${a}</b> ${creatorCorrect ? "✅" : "❌"}\n` +
                `👤 ${warmName(game.opponentName || "بازیکن دوم")} → ${diceModeText(game.opponentMode, game.opponentExact)} → <b>${b}</b> ${opponentCorrect ? "✅" : "❌"}\n\n` +
                `🪙 شرط هر دو نفر کامل برگشت.\n\n` +
                `${xpResultLine(settled.creator, settled.creatorXp)}\n` +
                `${xpResultLine(settled.opponent, settled.opponentXp)}`,
                { parse_mode: "HTML" }
            );
        } else {
            const winner = getStoredUser(winnerId);
            const loserId = winnerId === game.creatorId ? game.opponentId! : game.creatorId;
            const loser = getStoredUser(loserId);
            if (!winner || !loser) return;

            const winnerMode = winnerId === game.creatorId ? game.creatorMode : game.opponentMode;
            const winnerExact = winnerId === game.creatorId ? game.creatorExact : game.opponentExact;
            const winnerRoll = winnerId === game.creatorId ? a : b;
            const loserRoll = winnerId === game.creatorId ? b : a;
            const multiplier = winnerMode === "exact" ? 4 : 2;

            const payout = game.wager * multiplier;
            const heldPayout = game.wager * 2;

            if (winner.coins > MAX_BALANCE - payout) return;
            winner.coins += payout;
            if (heldPayout < payout) db.totals.coinsPaid += payout - heldPayout;

            game.creatorStakeHeld = false;
            game.opponentStakeHeld = false;
            game.settled = true;
            game.status = "finished";
            addWin(winnerId);
            addLoss(loserId);
            const winnerXp = applyGameXp(winner, game.wager, "dice", true);
            const loserXp = applyGameXp(loser, game.wager, "dice", false);
            recordTransaction({ fromUserId: loserId, toUserId: winnerId, amount: heldPayout, type: "dice_game", note: `group:${winnerMode}:${winnerExact ?? "-"}:${winnerRoll}` });
            saveDatabase(db);

            await sendStickerSafe(ctx, "diceWin");
            await safeEdit(ctx,
                `🎲 <b>نبرد تاس تموم شد!</b>\n\n` +
                `👑 برنده: <b>${warmName(winner.name)}</b> → ${diceModeText(winnerMode, winnerExact)} → <b>${winnerRoll}</b> ✅\n` +
                `😵 بازنده: <b>${warmName(loser.name)}</b> → <b>${loserRoll}</b>\n\n` +
                `🏆 جایزه: <b>${copyNumber(payout)} MBN</b>\n` +
                `🪙 موجودی برنده: <b>${copyNumber(winner.coins)}</b>\n\n` +
                `${xpResultLine(winner, winnerXp)}\n` +
                `${xpResultLine(loser, loserXp)}` ,
                { parse_mode: "HTML" }
            );
        }

        delete db.games[game.id];
        saveDatabase(db);
    } catch (error) {
        console.error("group dice error:", error);
        await safeAnswerCbQuery(ctx, "یه مشکلی پیش اومد؛ دوباره بزن.", { show_alert: true });
    }
}

async function rollGroupDart(ctx: any, game: DartGame) {
    const emoji = "🎯";
    if (!ctx.from || !game.opponentId || game.status !== "playing" || game.settled) return;
    const isCreator = ctx.from.id === game.creatorId;
    const current = isCreator ? game.creatorRoll : game.opponentRoll;
    if (current != null) {
        await safeAnswerCbQuery(ctx, "این راند رو زدی 😄", { show_alert: true });
        return;
    }
    try {
        const msg = await ctx.telegram.sendDice(game.chatId, { emoji });
        const value = Number(msg?.dice?.value);
        if (!Number.isInteger(value)) throw new Error("Telegram dart value missing");
        if (isCreator) game.creatorRoll = value; else game.opponentRoll = value;
        saveDatabase(db);
        await safeAnswerCbQuery(ctx, "✅ ثبت شد؛ بزن بریم!");
        if (game.creatorRoll == null || game.opponentRoll == null) {
            await safeEdit(ctx,
                `🎯 <b>نبرد دارت</b>\n\n` +
                `👤 ${warmName(game.creatorName)} ➜ ${game.creatorRoll == null ? "⏳ منتظر" : `✅ ${game.creatorRoll}`}\n` +
                `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ${game.opponentRoll == null ? "⏳ منتظر" : `✅ ${game.opponentRoll}`}\n\n` +
                `🪙 شرط: <b>${copyNumber(game.wager)} MBN</b>`,
                { parse_mode: "HTML", ...diceDartButtons(game) }
            );
            return;
        }
        const a=Number(game.creatorRoll), b=Number(game.opponentRoll);
        let winnerId:number|null=null;
        if (a===b) winnerId=null;
        else if (a>b) winnerId=game.creatorId;
        else winnerId=game.opponentId!;
        if (winnerId==null) {
            const settled=settleDraw(game); if(!settled) return;
            await safeAnswerCbQuery(ctx,"مساوی شد");
            await safeEdit(ctx,`🤝 <b>دارت مساوی شد!</b>\n\n👤 ${warmName(game.creatorName)}: <b>${a}</b>\n👤 ${warmName(game.opponentName||"بازیکن دوم")}: <b>${b}</b>\n\n🪙 شرط هر دو نفر برگشت.\n\n${xpResultLine(settled.creator, settled.creatorXp)}\n${xpResultLine(settled.opponent, settled.opponentXp)}`,{parse_mode:"HTML"});
        } else {
            const settled=settleWinner(game,winnerId); if(!settled) return;
            const special=settled.winner.id===game.creatorId ? a===6 : b===6;
            await sendStickerSafe(ctx,special?"dartWin":"dart");
            await safeEdit(ctx,
                `🎯 <b>دارت تموم شد!</b>\n\n`+
                `👑 برنده: <b>${warmName(settled.winner.name)}</b> • <b>${settled.winner.id===game.creatorId?a:b}</b>${special?"\n🎯 ضربه به مرکز!":""}\n`+
                `😵 بازنده: <b>${warmName(settled.loser.name)}</b> • <b>${settled.loser.id===game.creatorId?a:b}</b>\n\n`+
                `🏆 جایزه: <b>${copyNumber(game.wager*2)} MBN</b>\n\n`+
                `${xpResultLine(settled.winner, settled.winnerXp)}\n`+
                `${xpResultLine(settled.loser, settled.loserXp)}`,
                {parse_mode:"HTML"});
        }
        delete db.games[game.id];
        saveDatabase(db);
    } catch(error) {
        console.error("group dart error:", error);
        await safeAnswerCbQuery(ctx,"یه مشکلی پیش اومد؛ دوباره بزن.",{show_alert:true});
    }
}

async function rollGroupCasino(ctx: any, game: CasinoGame) {
    if (!ctx.from || !game.opponentId || game.status !== "playing" || game.settled) return;
    if (ctx.from.id !== game.creatorId && ctx.from.id !== game.opponentId) {
        await safeAnswerCbQuery(ctx, "⛔ این بازی مال تو نیست؛ از دکمه‌های بازی خودت استفاده کن 😄", { show_alert: true });
        return;
    }

    const isCreator = ctx.from.id === game.creatorId;
    const current = isCreator ? game.creatorRoll : game.opponentRoll;
    if (current != null) {
        await safeAnswerCbQuery(ctx, "اسپینت قبلاً ثبت شده 😄", { show_alert: true });
        return;
    }

    try {
        const msg = await ctx.telegram.sendDice(game.chatId, { emoji: "🎰" });
        const value = Number(msg?.dice?.value);
        if (!Number.isInteger(value) || value < 1 || value > 64) {
            await safeAnswerCbQuery(ctx, "نتیجه کازینو نامعتبر بود.", { show_alert: true });
            return;
        }

        if (isCreator) game.creatorRoll = value;
        else game.opponentRoll = value;

        saveDatabase(db);
        await safeAnswerCbQuery(ctx, "اسپین ✅ ثبت شد؛ بزن بریم!");

        const creatorReady = game.creatorRoll != null;
        const opponentReady = game.opponentRoll != null;
        if (!creatorReady || !opponentReady) {
            await safeEdit(ctx,
                `🎰 <b>نبرد کازینو</b>\n\n` +
                `👤 ${warmName(game.creatorName)} ➜ ${creatorReady ? "✅ آماده" : "⏳ در انتظار اسپین"}\n` +
                `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ${opponentReady ? "✅ آماده" : "⏳ در انتظار اسپین"}\n\n` +
                `🪙 شرط هر نفر: <b>${copyNumber(game.wager)} MBN</b>\n` +
                `🏆 برنده این راند: <b>${copyNumber(game.wager * 2)} MBN</b>\n\n` +
                `👇 هر دو نفر اسپین کنن تا نتیجه مشخص بشه`,
                { parse_mode: "HTML", ...casinoGroupButtons(game) }
            );
            return;
        }

        const a = Number(game.creatorRoll);
        const b = Number(game.opponentRoll);
        const aOutcome = casinoPayout(a);
        const bOutcome = casinoPayout(b);

        if (aOutcome.multiplier === bOutcome.multiplier) {
            const settled = settleDraw(game);
            if (!settled) return;
            await sendStickerSafe(ctx, "draw");
            await safeEdit(ctx,
                `🤝 <b>نبرد کازینو مساوی شد</b>\n\n` +
                `👤 ${warmName(game.creatorName)}\n${casinoCombo(a)}\n🎯 ${escapeHTML(aOutcome.label)}\n\n` +
                `👤 ${warmName(game.opponentName || "بازیکن دوم")}\n${casinoCombo(b)}\n🎯 ${escapeHTML(bOutcome.label)}\n\n` +
                `🪙 شرط هر دو نفر کامل برگشت شد.\n\n` +
                `${xpResultLine(settled.creator, settled.creatorXp)}\n` +
                `${xpResultLine(settled.opponent, settled.opponentXp)}`,
                { parse_mode: "HTML" }
            );
        } else {
            const winnerId = aOutcome.multiplier > bOutcome.multiplier ? game.creatorId : game.opponentId;
            const settled = settleWinner(game, winnerId!);
            if (!settled) return;
            const winnerRoll = settled.winner.id === game.creatorId ? a : b;
            const loserRoll = settled.loser.id === game.creatorId ? a : b;
            const winnerOutcome = settled.winner.id === game.creatorId ? aOutcome : bOutcome;
            const loserOutcome = settled.loser.id === game.creatorId ? aOutcome : bOutcome;
            await sendStickerSafe(ctx, "casinoWin");
            await safeEdit(ctx,
                `🎰 <b>نبرد کازینو تموم شد!</b>\n\n` +
                `👑 برنده: <b>${warmName(settled.winner.name)}</b>\n` +
                `${casinoCombo(winnerRoll)}\n🎯 ${escapeHTML(winnerOutcome.label)}\n\n` +
                `😵 بازنده: <b>${warmName(settled.loser.name)}</b>\n` +
                `${casinoCombo(loserRoll)}\n🎯 ${escapeHTML(loserOutcome.label)}\n\n` +
                `🏆 جایزه: <b>${copyNumber(game.wager * 2)} MBN</b>\n` +
                `🪙 موجودی برنده: <b>${copyNumber(settled.winner.coins)}</b>`,
                { parse_mode: "HTML" }
            );
        }

        delete db.games[game.id];
        saveDatabase(db);
    } catch (error) {
        console.error("group casino roll error:", error);
        await safeAnswerCbQuery(ctx, "کازینو اجرا نشد؛ دوباره بزن.", { show_alert: true });
    }
}

bot.action(/^game:casino-roll:(.+)$/, async ctx => {
    if (!ctx.from || !ctx.chat) return;
    const game = db.games[ctx.match[1]] as CasinoGame | undefined;
    if (!game || game.type !== "casino" || game.chatId !== ctx.chat.id || game.status !== "playing" || !game.opponentId) {
        await safeAnswerCbQuery(ctx, "⚠️ این بازی دیگه فعال نیست؛ احتمالاً راند تموم شده.", { show_alert: true });
        return;
    }
    await withMutationLock(() => rollGroupCasino(ctx, game));
});

bot.action(/^gd:mode:(.+):(even|odd|exact)$/, async ctx => {
    if (!ctx.from || !ctx.chat) return;
    const game = db.games[ctx.match[1]] as DiceGame | undefined;
    if (!game || game.type !== "dice" || game.status !== "playing" || game.chatId !== ctx.chat.id) {
        await safeAnswerCbQuery(ctx, "⚠️ این بازی دیگه فعال نیست؛ احتمالاً راند تموم شده.", { show_alert: true });
        return;
    }
    if (ctx.from.id !== game.creatorId && ctx.from.id !== game.opponentId) {
        await safeAnswerCbQuery(ctx, "⛔ این بازی مال تو نیست؛ از دکمه‌های بازی خودت استفاده کن 😄", { show_alert: true });
        return;
    }
    const isCreator = ctx.from.id === game.creatorId;
    const mode = ctx.match[2] as DicePredictionMode;

    if (mode === "exact") {
        await safeAnswerCbQuery(ctx, "عدد دقیق رو انتخاب کن");
        await safeEdit(ctx,
            `🎲 <b>پیش‌بینی دقیق</b>\n\n🪙 شرط: <b>${copyNumber(game.wager)} MBN</b>\n👇 عدد ۱ تا ۶ را انتخاب کن`,
            { parse_mode: "HTML", ...diceGroupExactKeyboard(game) }
        );
        return;
    }

    if (isCreator) game.creatorMode = mode; else game.opponentMode = mode;
    saveDatabase(db);
    await safeAnswerCbQuery(ctx, "پیش‌بینی ✅ ثبت شد؛ بزن بریم!");
    await safeEdit(ctx,
        `🎲 <b>نبرد تاس</b>\n\n` +
        `👤 ${warmName(game.creatorName)} ➜ ${diceModeText(game.creatorMode, game.creatorExact)}\n` +
        `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ${diceModeText(game.opponentMode, game.opponentExact)}\n\n` +
        `🪙 شرط هر نفر: <b>${copyNumber(game.wager)} MBN</b>\n` +
        `🏆 زوج/فرد: <b>${copyNumber(game.wager * 2)} MBN</b> • 🎯 دقیق: <b>${copyNumber(game.wager * 4)} MBN</b>\n\n` +
        `👇 ${(!game.creatorMode || !game.opponentMode) ? "هر کس پیش‌بینی خودش را انتخاب کند." : "هر دو آماده‌اید؛ تاس را بزنید!"}`,
        { parse_mode: "HTML", ...diceGroupPredictionKeyboard(game) }
    );
});

bot.action(/^gd:pick:(.+):([1-6])$/, async ctx => {
    if (!ctx.from || !ctx.chat) return;
    const game = db.games[ctx.match[1]] as DiceGame | undefined;
    if (!game || game.type !== "dice" || game.status !== "playing" || game.chatId !== ctx.chat.id) {
        await safeAnswerCbQuery(ctx, "⚠️ این بازی دیگه فعال نیست؛ احتمالاً راند تموم شده.", { show_alert: true });
        return;
    }
    if (ctx.from.id !== game.creatorId && ctx.from.id !== game.opponentId) {
        await safeAnswerCbQuery(ctx, "⛔ این بازی مال تو نیست؛ از دکمه‌های بازی خودت استفاده کن 😄", { show_alert: true });
        return;
    }
    const exact = Number(ctx.match[2]);
    if (ctx.from.id === game.creatorId) {
        game.creatorMode = "exact";
        game.creatorExact = exact;
    } else {
        game.opponentMode = "exact";
        game.opponentExact = exact;
    }
    saveDatabase(db);
    await safeAnswerCbQuery(ctx, `عدد دقیق ${exact} ✅ ثبت شد؛ بزن بریم!`);
    await safeEdit(ctx,
        `🎲 <b>نبرد تاس</b>\n\n` +
        `👤 ${warmName(game.creatorName)} ➜ ${diceModeText(game.creatorMode, game.creatorExact)}\n` +
        `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ${diceModeText(game.opponentMode, game.opponentExact)}\n\n` +
        `🪙 شرط هر نفر: <b>${copyNumber(game.wager)} MBN</b>\n` +
        `🏆 زوج/فرد: <b>${copyNumber(game.wager * 2)} MBN</b> • 🎯 دقیق: <b>${copyNumber(game.wager * 4)} MBN</b>\n\n` +
        `👇 هر دو پیش‌بینی را انتخاب کنید و بعد تاس خودتان را بیندازید.`,
        { parse_mode: "HTML", ...diceGroupPredictionKeyboard(game) }
    );
});

bot.action(/^gd:back:(.+)$/, async ctx => {
    if (!ctx.from || !ctx.chat) return;
    const game = db.games[ctx.match[1]] as DiceGame | undefined;
    if (!game || game.type !== "dice" || game.status !== "playing" || game.chatId !== ctx.chat.id) return;
    await safeAnswerCbQuery(ctx);
    await safeEdit(ctx,
        `🎲 <b>پیش‌بینی تاس</b>\n\n🪙 شرط: <b>${copyNumber(game.wager)} MBN</b>\n👇 نوع پیش‌بینی را انتخاب کن`,
        { parse_mode: "HTML", ...diceGroupPredictionKeyboard(game) }
    );
});

bot.action(/^game:dice-roll:(.+)$/, async ctx => {
    const game = db.games[ctx.match[1]] as DiceGame | undefined;
    if (!game || game.type !== "dice" || !ctx.chat || game.chatId !== ctx.chat.id) {
        await safeAnswerCbQuery(ctx, "⚠️ این بازی دیگه فعال نیست؛ احتمالاً راند تموم شده.", { show_alert: true });
        return;
    }
    if (ctx.from.id !== game.creatorId && ctx.from.id !== game.opponentId) {
        await safeAnswerCbQuery(ctx, "⛔ این بازی مال تو نیست؛ از دکمه‌های بازی خودت استفاده کن 😄", { show_alert: true });
        return;
    }
    const diceGame = game as DiceGame;
    const myMode = ctx.from.id === diceGame.creatorId ? diceGame.creatorMode : diceGame.opponentMode;
    if (!myMode) {
        await safeAnswerCbQuery(ctx, "اول زوج، فرد یا عدد دقیق را انتخاب کن.", { show_alert: true });
        return;
    }
    await withMutationLock(() => rollGroupDice(ctx, diceGame));
});

bot.action(/^game:dart-roll:(.+)$/, async ctx => {
    const game = db.games[ctx.match[1]] as DartGame | undefined;
    if (!game || game.type !== "dart" || !ctx.chat || game.chatId !== ctx.chat.id) {
        await safeAnswerCbQuery(ctx, "⚠️ این بازی دیگه فعال نیست؛ احتمالاً راند تموم شده.", { show_alert: true });
        return;
    }
    if (ctx.from.id !== game.creatorId && ctx.from.id !== game.opponentId) {
        await safeAnswerCbQuery(ctx, "⛔ این بازی مال تو نیست؛ از دکمه‌های بازی خودت استفاده کن 😄", { show_alert: true });
        return;
    }
    await withMutationLock(() => rollGroupDart(ctx, game));
});

bot.action(/^game:join:(.+)$/, async ctx => {
    if (!ctx.from || !ctx.chat) return;
    await withMutationLock(async () => {
    const game = db.games[ctx.match[1]];

    if (!game || !ctx.chat || game.chatId !== ctx.chat.id) {
        await safeAnswerCbQuery(ctx, "⚠️ این بازی مربوط به این گروهه نیست.", { show_alert: true });
        return;
    }
    if (!game || game.status !== "waiting" || game.settled) {
        await safeAnswerCbQuery(ctx, "⚠️ این راند دیگه فعال نیست یا نتیجه‌ش قبلاً ثبت شده.", { show_alert: true });
        return;
    }

    if (ctx.from.id === game.creatorId) {
        await safeAnswerCbQuery(ctx, "😄 این بازی مال خودته؛ یه حریف دیگه لازمه!", { show_alert: true });
        return;
    }

    const { user: opponent } = getUser(ctx.from);
    if (opponent.coins < game.wager) {
        await safeAnswerCbQuery(ctx, `😅 موجودی ${copyNumber(opponent.coins)} MBN ـه؛ برای این بازی ${copyNumber(game.wager)} MBN لازمه.`, { show_alert: true });
        return;
    }

    if (!reserveOpponentStake(game, opponent.id, opponent.name)) {
        await safeAnswerCbQuery(ctx, "⚠️ بازی یه لحظه قبل پر شد یا وضعیتش عوض شد؛ دوباره نگاه کن 👀", { show_alert: true });
        return;
    }

    game.status = "playing";
    game.createdAt = Date.now();
    saveDatabase(db);
    await safeAnswerCbQuery(ctx, "🔥 بزن بریم! بازی شروع شد");

    if (game.type === "coinflip") {
        await safeEdit(ctx, "🎲 <b>در حال قرعه...</b>", { parse_mode: "HTML" });
        setTimeout(() => finishCoinflip(ctx, game), 650);
        return;
    }

    if (game.type === "rps") {
        await updateRps(ctx, game);
        return;
    }

    if (game.type === "dice") {
        await safeEdit(
            ctx,
            `🎲 <b>نبرد تاس</b>\n\n` +
            `👤 ${warmName(game.creatorName)} ➜ ${diceModeText(game.creatorMode, game.creatorExact)}\n` +
            `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ${diceModeText(game.opponentMode, game.opponentExact)}\n\n` +
            `🪙 شرط هر نفر: <b>${copyNumber(game.wager)} MBN</b>\n` +
            `🏆 زوج/فرد: <b>${copyNumber(game.wager * 2)} MBN</b>\n` +
            `🎯 عدد دقیق: <b>${copyNumber(game.wager * 4)} MBN</b>\n\n` +
            `👇 اول پیش‌بینی خودت را انتخاب کن`,
            { parse_mode: "HTML", ...diceGroupPredictionKeyboard(game as DiceGame) }
        );
        return;
    }

    if (game.type === "dart") {
        await safeEdit(
            ctx,
            `🎯 <b>نبرد دارت</b>\n\n` +
            `👤 ${warmName(game.creatorName)} ➜ ⏳\n` +
            `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ⏳\n\n` +
            `🪙 شرط: <b>${copyNumber(game.wager)} MBN</b>\n` +
            `👇 هر دو نفر پرتاب کنند`,
            { parse_mode: "HTML", ...diceDartButtons(game) }
        );
        return;
    }

    if (game.type === "casino") {
        await safeEdit(
            ctx,
            `🎰 <b>نبرد کازینو</b>\n\n` +
            `👤 ${warmName(game.creatorName)} ➜ ⏳\n` +
            `👤 ${warmName(game.opponentName || "بازیکن دوم")} ➜ ⏳\n\n` +
            `🪙 شرط هر نفر: <b>${copyNumber(game.wager)} MBN</b>\n` +
            `🏆 برنده این راند: <b>${copyNumber(game.wager * 2)} MBN</b>\n\n` +
            `👇 هر دو نفر اسپین خودشون رو بزنن`,
            { parse_mode: "HTML", ...casinoGroupButtons(game as CasinoGame) }
        );
        return;
    }

    await updateTtt(ctx, game);
    });
});

bot.action(/^game:cancel:(.+)$/, async ctx => {
    if (!ctx.from) return;
    await withMutationLock(async () => {
    const game = db.games[ctx.match[1]];

    if (!game) {
        await safeAnswerCbQuery(ctx, "❌ این بازی دیگه پیدا نمی‌شه؛ احتمالاً تموم شده یا لغو شده.", { show_alert: true });
        return;
    }
    if (ctx.from.id !== game.creatorId) {
        await safeAnswerCbQuery(ctx, "🫶 فقط سازندهٔ بازی می‌تونه این دعوت رو لغو کنه.", { show_alert: true });
        return;
    }
    if (game.status !== "waiting") {
        await safeAnswerCbQuery(ctx, "⛔ بازی شروع شده؛ دیگه وسط راند نمی‌شه لغوش کرد.", { show_alert: true });
        return;
    }

    refundGame(game);
    delete db.games[game.id];
    saveDatabase(db);
    await safeEdit(ctx, "🛑 <b>بازی با موفقیت لغو شد!</b>\n\n🪙 مبلغ شرط کامل به سازنده برگردونده شد. خیالت راحت 💛", { parse_mode: "HTML" });
    });
});

bot.action(/^rps:choose:(.+):(rock|paper|scissors)$/, async ctx => {
    if (!ctx.from) return;
    await withMutationLock(async () => {
    const game = db.games[ctx.match[1]] as RPSGame | undefined;
    if (!game || !ctx.chat || game.chatId !== ctx.chat.id || game.type !== "rps" || game.status !== "playing") {
        await safeAnswerCbQuery(ctx, "⚠️ این راند دیگه فعال نیست یا نتیجه‌ش قبلاً ثبت شده.", { show_alert: true });
        return;
    }
    if (ctx.from.id !== game.creatorId && ctx.from.id !== game.opponentId) {
        await safeAnswerCbQuery(ctx, "⛔ این بازی مال تو نیست؛ از دکمه‌های بازی خودت استفاده کن 😄", { show_alert: true });
        return;
    }

    const choice = ctx.match[2] as RPSChoice;
    if (ctx.from.id === game.creatorId) {
        if (game.creatorChoice) {
            await safeAnswerCbQuery(ctx, "✅ انتخابت ثبت شد!", { show_alert: true });
            return;
        }
        game.creatorChoice = choice;
    } else {
        if (game.opponentChoice) {
            await safeAnswerCbQuery(ctx, "✅ انتخابت ثبت شد!", { show_alert: true });
            return;
        }
        game.opponentChoice = choice;
    }

    await safeAnswerCbQuery(ctx, "✅ ثبت شد؛ بزن بریم!");

    if (!game.creatorChoice || !game.opponentChoice) {
        saveDatabase(db);
        await updateRps(ctx, game);
        return;
    }

    const result = rpsWinner(game.creatorChoice, game.opponentChoice);
    if (result === "draw") {
        const settled = settleDraw(game);
        if (!settled) return;
        await safeEdit(ctx,
            `🤝 <b>این راند مساوی شد!</b>\n\n` +
            `👤 ${warmName(game.creatorName)}: ${rpsName(game.creatorChoice)}\n` +
            `👤 ${warmName(game.opponentName!)}: ${rpsName(game.opponentChoice)}\n\n` +
            `🪙 شرط هر دو نفر کامل برگشت.\n\n` +
            `${xpResultLine(settled.creator, settled.creatorXp)}\n` +
            `${xpResultLine(settled.opponent, settled.opponentXp)}`,
            { parse_mode: "HTML" }
        );
        delete db.games[game.id];
        saveDatabase(db);
        return;
    }

    const winnerId = result === "creator" ? game.creatorId : game.opponentId!;
    const settled = settleWinner(game, winnerId);
    if (!settled) return;

    await sendStickerSafe(ctx, "win");
    const winnerChoice = settled.winner.id === game.creatorId ? game.creatorChoice : game.opponentChoice;
    const loserChoice = settled.loser.id === game.creatorId ? game.creatorChoice : game.opponentChoice;
    await safeEdit(ctx,
        `🏁 <b>نبرد تموم شد!</b> 🔥\n\n` +
        `👑 برنده: <b>${warmName(settled.winner.name)}</b> (${rpsName(winnerChoice)})\n` +
        `😵 بازنده: <b>${warmName(settled.loser.name)}</b> (${rpsName(loserChoice)})\n\n` +
        `🏆 جایزه: <b>${copyNumber(game.wager * 2)} MBN</b>\n` +
        `🪙 موجودی برنده: <b>${copyNumber(settled.winner.coins)}</b>\n\n` +
        `${xpResultLine(settled.winner, settled.winnerXp)}\n` +
        `${xpResultLine(settled.loser, settled.loserXp)}` ,
        { parse_mode: "HTML" }
    );

    delete db.games[game.id];
    saveDatabase(db);
    });
});

bot.action(/^ttt:move:(.+):(\d)$/, async ctx => {
    if (!ctx.from) return;
    await withMutationLock(async () => {
    const game = db.games[ctx.match[1]] as TicTacToeGame | undefined;
    const index = Number(ctx.match[2]);

    if (!game || !ctx.chat || game.chatId !== ctx.chat.id || game.type !== "tictactoe" || game.status !== "playing") {
        await safeAnswerCbQuery(ctx, "⚠️ این راند دیگه فعال نیست یا نتیجه‌ش قبلاً ثبت شده.", { show_alert: true });
        return;
    }
    if (ctx.from.id !== game.creatorId && ctx.from.id !== game.opponentId) {
        await safeAnswerCbQuery(ctx, "⛔ این بازی مال تو نیست؛ از دکمه‌های بازی خودت استفاده کن 😄", { show_alert: true });
        return;
    }
    if (ctx.from.id !== game.turn) {
        await safeAnswerCbQuery(ctx, "نوبت تو نیست.", { show_alert: true });
        return;
    }
    if (game.board[index] !== " ") {
        await safeAnswerCbQuery(ctx, "این خونه پره.", { show_alert: true });
        return;
    }

    game.board[index] = ctx.from.id === game.creatorId ? "❌" : "⭕";
    const winnerSymbol = checkWinner(game.board);

    if (winnerSymbol) {
        const winnerId = ctx.from.id;
        const settled = settleWinner(game, winnerId);
        if (!settled) return;

        await safeAnswerCbQuery(ctx, "🏆 بردی!");
        await sendStickerSafe(ctx, "win");
        await safeEdit(ctx,
            `🏁 <b>نبرد دوز تموم شد!</b>\n\n` +
            `${tttBoard(game.board)}\n\n` +
            `👑 برنده: <b>${warmName(settled.winner.name)}</b>\n` +
            `💰 موجودی برنده: <b>${copyNumber(settled.winner.coins)}</b>\n` +
            `😵 بازنده: <b>${warmName(settled.loser.name)}</b>\n` +
            `💰 موجودی بازنده: <b>${copyNumber(settled.loser.coins)}</b>\n\n` +
            `${xpResultLine(settled.winner, settled.winnerXp)}\n` +
            `${xpResultLine(settled.loser, settled.loserXp)}`,
            { parse_mode: "HTML" }
        );
        delete db.games[game.id];
        saveDatabase(db);
        return;
    }

    if (game.board.every(cell => cell !== " ")) {
        const settled = settleDraw(game);
        if (!settled) return;
        await safeAnswerCbQuery(ctx, "🤝 مساوی");
        await safeEdit(ctx,
            `🤝 <b>دوز مساوی شد</b>\n\n` +
            `${tttBoard(game.board)}\n\n` +
            `🪙 شرط هر دو نفر برگشت.\n\n` +
            `${xpResultLine(settled.creator, settled.creatorXp)}\n` +
            `${xpResultLine(settled.opponent, settled.opponentXp)}`,
            { parse_mode: "HTML" }
        );
        delete db.games[game.id];
        saveDatabase(db);
        return;
    }

    game.turn = game.turn === game.creatorId ? game.opponentId! : game.creatorId;
    saveDatabase(db);
    await safeAnswerCbQuery(ctx, "✅ ثبت شد؛ بزن بریم!");
    await updateTtt(ctx, game);
    });
});

async function findTargetId(ctx: any, args: string[]) {
    if (ctx.message?.reply_to_message?.from?.id) {
        const id = Number(ctx.message.reply_to_message.from.id);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }

    const rawId = args[2];
    if (rawId && /^\d+$/.test(rawId)) {
        const id = Number(rawId);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    }
    return null;
}

function findUserByUsername(username: string) {
    const normalized = username.replace(/^@/, '').toLowerCase();
    return Object.values(db.users).find(u => (u.username || '').toLowerCase() === normalized);
}

async function handleDailyWheel(ctx: any) {
    if (!ctx.from) return;

    return withMutationLock(async () => {
        const { user } = getUser(ctx.from!);
        const today = currentDayKey();
        if (user.lastWheelDay === today) {
            await ctx.reply(
                `⏳ <b>گردونه امروز استفاده شده</b>\n\n` +
                `امروز جایزه‌ات رو گرفتی 😄\n` +
                `🎁 فردا دوباره یه شانس تازه داری!`,
                { parse_mode: "HTML" }
            );
            return;
        }

        const reward = weightedWheelReward();
        if (!canAddCoins(user, reward)) {
            await replyWarm(ctx, "😅 موجودی به سقف مجاز رسیده؛ این جایزه قابل واریز نیست.", "game");
            return;
        }

        user.coins += reward;
        user.lastWheelDay = today;
        user.updatedAt = Date.now();
        recordTransaction({ toUserId: user.id, amount: reward, type: "daily_wheel", note: `day:${today}` });
        saveDatabase(db);

        await ctx.reply(
            `🎡 <b>گردونه رو چرخوندی!</b> 🎉\n` +
            `🪙 جایزه: <b>+${copyNumber(reward)} MBN</b>\n` +
            `💰 موجودی: <b>${copyNumber(user.coins)} MBN</b>\n` +
            `📆 فردا دوباره شانس داری 😉`,
            { parse_mode: "HTML" }
        );
    });
}

async function handleTransfer(ctx: any, parts: string[]) {
    if (!ctx.from) return false;
    if (!/^انتقال$/i.test(parts[0])) return false;

    return withMutationLock(async () => {
        const amount = parseAmount(parts[1] || "");
        const replyFrom = ctx.message?.reply_to_message?.from;
        if (!amount || !replyFrom?.id) {
            await replyWarm(ctx, "🤝 <b>برای انتقال، فقط روی پیام گیرنده Reply کن.</b>\n\nمثال: <code>انتقال 100</code> 💸\n✨ سریع، ساده و بدون دردسر!", "game", { parse_mode: "HTML" });
            return true;
        }

        const sender = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;
        const targetId = Number(replyFrom.id);

        if (!Number.isSafeInteger(targetId) || targetId <= 0 || replyFrom.is_bot) {
            await ctx.reply("😅 این گیرنده معتبر نیست؛ پیام یا کاربر رو یه بار چک کن.", { parse_mode: "HTML" });
            return true;
        }
        if (targetId === sender.id) {
            await ctx.reply("😄 پول رو برای خودت نمی‌شه انتقال داد؛ یه رفیق انتخاب کن!");
            return true;
        }
        const target = getStoredUser(targetId);
        if (!target) {
            await ctx.reply("😅 این رفیق هنوز حسابش رو فعال نکرده؛ اول یه بار <code>/start</code> رو بزنه.");
            return true;
        }
        if (sender.coins < amount) {
            await replyWarm(ctx, `😅 <b>برای این انتقال 💸 موجودی کافی نیست؛ برای این شرط سکه کم داری.</b>\n\n🪙 موجودی فعلی: <b>${copyNumber(sender.coins)} MBN</b>\n💸 مبلغ: <b>${copyNumber(amount)} MBN</b>`, "lose", { parse_mode: "HTML" });
            return true;
        }
        if (!canAddCoins(target, amount)) {
            await ctx.reply("😅 موجودی گیرنده به سقف رسیده؛ انتقال انجام نشد.");
            return true;
        }

                sender.coins -= amount;
        target.coins += amount;
        sender.updatedAt = Date.now();
        target.updatedAt = Date.now();
        recordTransaction({ fromUserId: sender.id, toUserId: target.id, amount, type: "transfer", note: `chat:${ctx.chat?.id ?? "unknown"}` });
        saveDatabase(db);

        await ctx.reply(
            `💸 <b>انتقال انجام شد!</b> ✅\n` +
            `👤 ${warmName(sender.name)} ➜ ${warmName(target.name)}\n` +
            `🪙 <b>${copyNumber(amount)} MBN</b>\n` +
            `💰 موجودی تو: <b>${copyNumber(sender.coins)} MBN</b> ✨`,
            { parse_mode: "HTML" }
        );
        return true;
    });
}

async function handleUserLookup(ctx: any, parts: string[]) {
    if (!ctx.from || !isAdmin(ctx.from.id)) return false;
    if (!/^کاربر$/i.test(parts[0])) return false;

    const query = parts[1];
    if (!query) {
        await ctx.reply("🔎 این‌طوری بزن: <code>کاربر 123456789</code> 😉", { parse_mode: "HTML" });
        return true;
    }

    const user = /^\d+$/.test(query) ? getStoredUser(Number(query)) : findUserByUsername(query);
    if (!user) {
        await ctx.reply("😅 پیداش نکردم؛ آیدی یا یوزرنیم رو یه بار چک کن.");
        return true;
    }

    await ctx.reply(identityText(user), { parse_mode: "HTML" });
    return true;
}

async function handleDeductAdmin(ctx: any, parts: string[]) {
    if (!ctx.from || !isAdmin(ctx.from.id)) return false;
    if (!/^کسر$/i.test(parts[0])) return false;

    return withMutationLock(async () => {
        const amount = parseAmount(parts[1] || "");
        const replyFrom = ctx.message?.reply_to_message?.from;

        if (!amount || !replyFrom?.id) {
            await ctx.reply("🛠 روی پیام کاربر Reply کن: <code>کسر 100</code> 😉", { parse_mode: "HTML" });
            return true;
        }

        const targetId = Number(replyFrom.id);
        const target = getStoredUser(targetId);
        const actor = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;

        if (!Number.isSafeInteger(targetId) || targetId <= 0 || replyFrom.is_bot) {
            await ctx.reply("😅 این انتخاب معتبر نیست؛ یه بار دیگه امتحان کن.");
            return true;
        }
        if (!target) {
            await ctx.reply("😅 این رفیق هنوز بات رو Start نکرده.");
            return true;
        }
        if (!actor) {
            await ctx.reply("😅 حساب اجراکننده پیدا نشد؛ عملیات متوقف شد.");
            return true;
        }
        if (target.id === actor.id) {
            await ctx.reply("😄 از حساب خودت کسر نمی‌کنیم؛ روی پیام یه کاربر دیگه Reply کن.");
            return true;
        }
        if (target.id === OWNER_ID && !isOwner(ctx.from.id)) {
            await ctx.reply("👑 این حساب مخصوص مالک باته و قابل حذف نیست 😄");
            return true;
        }
        if (target.coins < amount) {
            await ctx.reply(`😅 موجودی این کاربر برای این مبلغ کافی نیست.\n🪙 ${copyNumber(target.coins)} MBN  •  🎯 ${copyNumber(amount)} MBN`, { parse_mode: "HTML" });
            return true;
        }
        if (!canAddCoins(actor, amount)) {
            await ctx.reply("😅 موجودی حساب دریافت‌کننده جا نداره؛ عملیات انجام نشد.");
            return true;
        }

        target.coins -= amount;
        actor.coins += amount;
        target.updatedAt = Date.now();
        actor.updatedAt = Date.now();
        recordTransaction({ fromUserId: target.id, toUserId: actor.id, amount, type: "admin_deduct", note: `admin:${ctx.from.id}` });
        saveDatabase(db);

        await ctx.reply(
            `✅ <b>کسر موجودی با موفقیت انجام شد!</b>\n\n` +
            `👤 کاربر: <b>${escapeHTML(target.name)}</b>\n` +
            `ID کاربر: <code>${target.id}</code>\n` +
            `🪙 مبلغ کسرشده: <b>${copyNumber(amount)} MBN</b>\n\n` +
            `💼 حساب دریافت‌کننده: <b>${escapeHTML(actor.name)}</b>\n` +
            `ID دریافت‌کننده: <code>${actor.id}</code>\n\n` +
            `📉 موجودی جدید کاربر: <b>${copyNumber(target.coins)} MBN</b>\n` +
            `📈 موجودی جدید اجراکننده: <b>${copyNumber(actor.coins)} MBN</b>`,
            { parse_mode: "HTML" }
        );
        return true;
    });
}

async function handleAdminManagement(ctx: any, text: string) {
    if (!ctx.from || !isOwner(ctx.from.id)) return false;
    return withMutationLock(async () => {

    const charge = text.match(/^شارژ\s+(.+)$/i);
    if (charge) {
        const amount = parseAmount(charge[1]);
        if (!amount) {
            await ctx.reply(`😅 مبلغ شارژ باید یک عدد مثبت باشه.`);
            return true;
        }
        const owner = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;
        const before = owner.coins;
        if (!addCoinsSafe(owner, amount)) {
            await safeAnswerCbQuery(ctx, "😅 سقف موجودی این حساب پر شده؛ فعلاً امکان افزایش بیشتر نیست.", { show_alert: true });
            return;
        }
        owner.updatedAt = Date.now();
        recordTransaction({ toUserId: owner.id, amount, type: "owner_charge", note: "manual-charge" });
        saveDatabase(db);
        await ctx.reply(
            `💰 <b>شارژ با موفقیت انجام شد!</b> +<b>${copyNumber(amount)} MBN</b> ✨\n🪙 موجودی: <b>${copyNumber(owner.coins)} MBN</b>`,
            { parse_mode: "HTML" }
        );
        return true;
    }

    const levelSet = text.match(/^لول\s+(\d+)\s+(\d+)$/i);
    const xpSet = text.match(/^(?:xp|ایکس\s*پی)\s+(\d+)\s+(\d+)$/i);

    if (levelSet) {
        const level = Math.max(1, Math.min(MAX_LEVEL, Number(levelSet[1])));
        const id = Number(levelSet[2]);
        const target = getStoredUser(id);
        if (!target) { await ctx.reply("😅 این کاربر هنوز حسابی توی بات نداره."); return true; }
        let xp = 0;
        for (let l = 1; l < level; l++) xp += xpNeededForLevel(l);
        target.stats.xp = xp;
        target.updatedAt = Date.now();
        saveDatabase(db);
        await ctx.reply(`⭐ لول <b>${level}</b> برای ${shortUser(target)} تنظیم شد.`, { parse_mode: "HTML" });
        return true;
    }

    if (xpSet) {
        const xp = Math.max(0, safeInt(xpSet[1]));
        const id = Number(xpSet[2]);
        const target = getStoredUser(id);
        if (!target) { await ctx.reply("😅 این کاربر هنوز حسابی توی بات نداره."); return true; }
        target.stats.xp = xp;
        target.updatedAt = Date.now();
        recordTransaction({ toUserId: target.id, amount: xp, type: "admin_xp", note: `admin:${ctx.from.id}:set-xp` });
        saveDatabase(db);
        const s = levelSnapshot(target);
        await ctx.reply(`⭐ ${shortUser(target)} ➜ لول <b>${s.level}</b> • XP <b>${formatNumber(xp)}</b>`, { parse_mode: "HTML" });
        return true;
    }

    const add = text.match(/^ادمین\s*\+\s*(\d+)$/i);
    const remove = text.match(/^ادمین\s*-\s*(\d+)$/i);

    const addXp = text.match(/^(?:افزایش\s+xp|افزودن\s+xp|xp\s*\+)\s+(\d+)\s+(\d+)$/i);
    const deductXp = text.match(/^(?:کسر\s+xp|کم\s+کردن\s+xp|xp\s*-)\s+(\d+)\s+(\d+)$/i);
    const addCoins = text.match(/^(?:شارژ\s+کاربر|افزایش\s+موجودی)\s+(\d+)\s+(\d+)$/i);

    if (addXp || deductXp) {
        const amount = safeInt((addXp || deductXp)![1]);
        const id = Number((addXp || deductXp)![2]);
        const target = getStoredUser(id);
        if (!target || amount <= 0) { await ctx.reply("😅 شناسه کاربر یا مبلغ واردشده معتبر نیست."); return true; }
        const before = target.stats.xp || 0;
        target.stats.xp = addXp ? before + amount : Math.max(0, before - amount);
        target.updatedAt = Date.now();
        recordTransaction({ toUserId: target.id, amount, type: "admin_xp", note: `admin:${ctx.from.id}:${addXp ? "add" : "deduct"}-xp` });
        saveDatabase(db);
        const s = levelSnapshot(target);
        await ctx.reply(
            `${addXp ? "⭐ XP افزایش یافت" : "📉 XP کاهش یافت"}\n\n` +
            `👤 ${shortUser(target)}\n` +
            `📊 قبل: <b>${formatNumber(before)}</b> XP\n` +
            `🎯 تغییر: <b>${addXp ? "+" : "-"}${formatNumber(amount)}</b> XP\n` +
            `⭐ اکنون: <b>${formatNumber(target.stats.xp)}</b> XP • لول <b>${s.level}</b>`,
            { parse_mode: "HTML" }
        );
        return true;
    }

    if (addCoins) {
        const amount = safeInt(addCoins[1]);
        const id = Number(addCoins[2]);
        const target = getStoredUser(id);
        if (!target || amount <= 0 || !canAddCoins(target, amount)) { await ctx.reply("😅 کاربر یا مقدار نامعتبره، یا موجودی به سقف امن می‌رسه."); return true; }
        const before = target.coins;
        target.coins += amount;
        target.updatedAt = Date.now();
        recordTransaction({ toUserId: target.id, amount, type: "admin_add", note: `admin:${ctx.from.id}:user-credit` });
        saveDatabase(db);
        await ctx.reply(`💰 <b>کاربر شارژ شد</b>\n\n👤 ${shortUser(target)}\nقبل: <b>${copyNumber(before)}</b> MBN\nافزایش: <b>+${copyNumber(amount)}</b> MBN\nبعد: <b>${copyNumber(target.coins)}</b> MBN`, { parse_mode: "HTML" });
        return true;
    }

    if (add) {
        const id = Number(add[1]);
        if (!db.admins.includes(id)) db.admins.push(id);
        saveDatabase(db);
        await ctx.reply(`🛡 <b>${copyNumber(id)}</b> شد ادمین 😎`, { parse_mode: "HTML" });
        return true;
    }

    if (remove) {
        const id = Number(remove[1]);
        if (isOwner(id)) {
            await ctx.reply("👑 نه نه، صاحب‌خونه رو نمی‌شه حذف کرد 😄");
            return true;
        }
        db.admins = db.admins.filter(x => x !== id);
        saveDatabase(db);
        await ctx.reply(`🛡 <b>${copyNumber(id)}</b> از ادمینی رفت 😉`, { parse_mode: "HTML" });
        return true;
    }

    return false;
    });
}

function singleDiceModeKeyboard(userId: number, bet: number) {
    return Markup.inlineKeyboard([
        [
            styledCallback("زوج", `sd:mode:${userId}:${bet}:even`, "primary"),
            styledCallback("فرد", `sd:mode:${userId}:${bet}:odd`, "success")
        ],
        [styledCallback("🎯 عدد دقیق", `sd:mode:${userId}:${bet}:exact`, "danger")],
        [styledCallback("❌ لغو", `sd:cancel:${userId}`, "danger")]
    ]);
}

function singleDiceExactKeyboard(userId: number, bet: number) {
    const nums = [1, 2, 3, 4, 5, 6].map(n =>
        styledCallback(String(n), `sd:pick:${userId}:${bet}:${n}`, n % 2 ? "success" : "primary")
    );
    return Markup.inlineKeyboard([
        nums.slice(0, 3),
        nums.slice(3),
        [styledCallback("↩️ برگشت", `sd:back:${userId}:${bet}`, "primary")]
    ]);
}

async function handleSingleDicePrompt(ctx: any, betRaw: string) {
    if (!ctx.from || !isPrivateChat(ctx)) return false;
    return withMutationLock(async () => {
        const bet = parseGameBet(betRaw);
        const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;

        if (!bet) {
            await replyWarm(ctx, "😅 <b>مبلغ شرط درست نیست!</b>\nیه عدد معتبر و حداقل مبلغ لازم رو وارد کن 😉", "dice", { parse_mode: "HTML" });
            return true;
        }
        if (user.coins < bet) {
            await replyWarm(ctx, `🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`, "lose", { parse_mode: "HTML" });
            return true;
        }

        await ctx.reply(
            `🎲 <b>بازی تاس</b>\n\n` +
            `🪙 شرط: <b>${copyNumber(bet)} MBN</b>\n` +
            `👇 پیش‌بینی خودت رو انتخاب کن!`,
            { parse_mode: "HTML", ...singleDiceModeKeyboard(user.id, bet) }
        );
        return true;
    });
}

async function resolveSingleDice(ctx: any, mode: "even" | "odd" | "exact", bet: number, exact?: number) {
    const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;
    if (!user || user.coins < bet) {
        await safeAnswerCbQuery(ctx, "💸 موجودی کافی نیست؛ برای این شرط سکه کم داری.", { show_alert: true });
        return;
    }

    let msg: any;
    try {
        msg = await ctx.telegram.sendDice(user.id, { emoji: "🎲" });
    } catch (error) {
        console.error("single dice send error:", error);
        await safeAnswerCbQuery(ctx, "⚠️ تاس اجرا نشد؛ خیالت راحت، شرطت از حسابت کم نشد.", { show_alert: true });
        return;
    }

    const value = Number(msg?.dice?.value);
    if (!Number.isInteger(value) || value < 1 || value > 6) {
        await safeAnswerCbQuery(ctx, "⚠️ نتیجه تاس معتبر نبود؛ شرطت از حسابت کم نشد.", { show_alert: true });
        return;
    }

    user.coins -= bet;
    user.stats.games++;
    db.totals.games++;

    const won = mode === "exact"
        ? value === exact
        : mode === "even"
            ? value % 2 === 0
            : value % 2 === 1;

    const multiplier = mode === "exact" ? 4 : 2;
    let xpAward: ReturnType<typeof applyGameXp>;

    if (won) {
        const prize = bet * multiplier;
        if (!canAddCoins(user, prize)) {
            user.coins += bet;
            user.stats.games--;
            db.totals.games--;
            await safeAnswerCbQuery(ctx, "↩️ شرط کامل برگشت خورد.", { show_alert: true });
            return;
        }

        user.coins += prize;
        db.totals.coinsPaid += prize;
        user.stats.wins++;
        user.stats.winStreak++;
        user.stats.bestStreak = Math.max(user.stats.bestStreak, user.stats.winStreak);
        xpAward = applyGameXp(user, bet, "dice", true);
        recordTransaction({ toUserId: user.id, amount: prize, type: "dice_game", note: `single:${mode}:${value}` });
    } else {
        user.stats.losses++;
        user.stats.winStreak = 0;
        xpAward = applyGameXp(user, bet, "dice", false);
        recordTransaction({ fromUserId: user.id, amount: bet, type: "dice_game", note: `single-miss:${mode}:${value}` });
    }

    user.updatedAt = Date.now();
    saveDatabase(db);

    await sendStickerSafe(ctx, won ? "diceWin" : "dice");
    await safeAnswerCbQuery(ctx, won ? "🏆 بردی! ✅" : "😅 این راند به نفع شانس تو نبود!");

    const picked = mode === "exact"
        ? `عدد دقیق ${exact}`
        : mode === "even"
            ? "زوج"
            : "فرد";

    const result = won
        ? `🎲 <b>بردی</b>\n\n` +
          `عدد تاس: <b>${value}</b>\n` +
          `انتخاب: <b>${picked}</b>\n\n` +
          `🏆 جایزه: <b>${copyNumber(bet * multiplier)} MBN</b>\n` +
          `🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`
        : `🎲 <b>😅 این راند به نفع شانس تو نبود!</b>\n\n` +
          `عدد تاس: <b>${value}</b>\n` +
          `انتخاب: <b>${picked}</b>\n\n` +
          `🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`;

    await ctx.reply(
        result + `\n\n${xpResultLine(user, xpAward)}\n\n✅ راند بعدی: دوباره «تاس ${bet}» را بفرست.`,
        { parse_mode: "HTML" }
    );
}

bot.action(/^sd:mode:(\d+):(\d+):(even|odd|exact)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) {
        await safeAnswerCbQuery(ctx, "⛔ این دکمه برای بازیکن دیگه‌ست 😉", { show_alert: true });
        return;
    }

    const userId = Number(ctx.match[1]);
    const bet = Number(ctx.match[2]);
    const mode = ctx.match[3] as "even" | "odd" | "exact";

    if (mode === "exact") {
        await safeAnswerCbQuery(ctx, "عدد دقیق رو انتخاب کن");
        await ctx.editMessageText(
            `🎲 <b>بازی تاس</b>\n\n🪙 شرط: <b>${copyNumber(bet)} MBN</b>\n👇 کدوم عدد؟`,
            { parse_mode: "HTML", ...singleDiceExactKeyboard(userId, bet) }
        );
        return;
    }

    await resolveSingleDice(ctx, mode, bet);
});

bot.action(/^sd:pick:(\d+):(\d+):([1-6])$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) {
        await safeAnswerCbQuery(ctx, "⛔ این دکمه برای بازیکن دیگه‌ست 😉", { show_alert: true });
        return;
    }
    await resolveSingleDice(ctx, "exact", Number(ctx.match[2]), Number(ctx.match[3]));
});

bot.action(/^sd:back:(\d+):(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) return;
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(
        `🎲 <b>بازی تاس</b>\n\n🪙 شرط: <b>${copyNumber(Number(ctx.match[2]))} MBN</b>\n👇 انتخاب کن`,
        { parse_mode: "HTML", ...singleDiceModeKeyboard(Number(ctx.match[1]), Number(ctx.match[2])) }
    );
});

bot.action(/^sd:cancel:(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) return;
    await safeAnswerCbQuery(ctx, "🛑 لغو شد.");
    await ctx.editMessageText("🎲 🛑 راند 🛑 لغو شد.؛ هر وقت خواستی دوباره شروع کن.", { parse_mode: "HTML" });
});

function singleDartKeyboard(userId: number, bet: number) {
    return Markup.inlineKeyboard([
        [styledCallback("🎯 پرتاب", `sda:throw:${userId}:${bet}`, "danger")],
        [styledCallback("❌ لغو", `sda:cancel:${userId}`, "danger")]
    ]);
}

async function handleSingleDartPrompt(ctx: any, betRaw: string) {
    if (!ctx.from || !isPrivateChat(ctx)) return false;
    return withMutationLock(async () => {
        const bet = parseGameBet(betRaw);
        const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;

        if (!bet) {
            await replyWarm(ctx, "😅 <b>مبلغ شرط درست نیست!</b>\nیه عدد معتبر و حداقل مبلغ لازم رو وارد کن 😉", "dart", { parse_mode: "HTML" });
            return true;
        }
        if (user.coins < bet) {
            await replyWarm(ctx, `🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`, "lose", { parse_mode: "HTML" });
            return true;
        }

        await ctx.reply(
            `🎯 <b>بازی دارت</b>\n\n` +
            `🪙 شرط: <b>${copyNumber(bet)} MBN</b>\n` +
            `🎯 به مرکز بزنه، جایزه مال توئه!`,
            { parse_mode: "HTML", ...singleDartKeyboard(user.id, bet) }
        );
        return true;
    });
}

bot.action(/^sda:throw:(\d+):(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) {
        await safeAnswerCbQuery(ctx, "⛔ این دکمه برای بازیکن دیگه‌ست 😉", { show_alert: true });
        return;
    }

    await withMutationLock(async () => {
        const bet = Number(ctx.match[2]);
        const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;

        if (!user || user.coins < bet) {
            await safeAnswerCbQuery(ctx, "💸 موجودی کافی نیست؛ برای این شرط سکه کم داری.", { show_alert: true });
            return;
        }

        let msg: any;
        try {
            msg = await ctx.telegram.sendDice(user.id, { emoji: "🎯" });
        } catch (error) {
            console.error("single dart send error:", error);
            await safeAnswerCbQuery(ctx, "⚠️ پرتاب انجام نشد؛ چیزی از موجودی کم نشد.", { show_alert: true });
            return;
        }

        const value = Number(msg?.dice?.value);
        if (!Number.isInteger(value)) {
            await safeAnswerCbQuery(ctx, "⚠️ نتیجه پرتاب معتبر نبود؛ شرطت محفوظ موند.", { show_alert: true });
            return;
        }

        user.coins -= bet;
        user.stats.games++;
        db.totals.games++;

        const win = value === 6;
        let xpAward: ReturnType<typeof applyGameXp>;

        if (win) {
            const prize = bet * 3;
            if (!canAddCoins(user, prize)) {
                user.coins += bet;
                user.stats.games--;
                db.totals.games--;
                await safeAnswerCbQuery(ctx, "↩️ شرط کامل برگشت خورد.", { show_alert: true });
                return;
            }
            user.coins += prize;
            db.totals.coinsPaid += prize;
            user.stats.wins++;
            user.stats.winStreak++;
            user.stats.bestStreak = Math.max(user.stats.bestStreak, user.stats.winStreak);
            xpAward = applyGameXp(user, bet, "dart", true);
            recordTransaction({ toUserId: user.id, amount: prize, type: "dart_game", note: `single:center:${value}` });
        } else {
            user.stats.losses++;
            user.stats.winStreak = 0;
            xpAward = applyGameXp(user, bet, "dart", false);
            recordTransaction({ fromUserId: user.id, amount: bet, type: "dart_game", note: `single:miss:${value}` });
        }

        user.updatedAt = Date.now();
        saveDatabase(db);

        await sendStickerSafe(ctx, win ? "dartWin" : "dart");
        await safeAnswerCbQuery(ctx, win ? "🎯 وسط خوندی! آفرین!" : "😅 این بار مرکز رو نزدی!");

        const result = win
            ? `🎯 <b>وسط خورد</b>\n\n🏆 جایزه: <b>${copyNumber(bet * 3)} MBN</b>\n🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`
            : `🎯 <b>😅 این بار مرکز رو نزدی!</b>\n\n🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`;

        await ctx.reply(
            result + `\n\n${xpResultLine(user, xpAward)}\n\n✅ راند بعدی: دوباره «دارت ${bet}» را بفرست.`,
            { parse_mode: "HTML" }
        );
    });
});

bot.action(/^sda:cancel:(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) return;
    await safeAnswerCbQuery(ctx, "🛑 لغو شد.");
    await ctx.editMessageText("🎯 🛑 راند 🛑 لغو شد.؛ هر وقت خواستی دوباره شروع کن.", { parse_mode: "HTML" });
});

async function handleNumberGuessPrompt(ctx: any, betRaw: string) {
    if (!ctx.from) return true;

    return withMutationLock(async () => {
        const bet = parseGameBet(betRaw);
        const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;

        if (!bet) {
            await replyWarm(ctx, `😅 <b>مبلغ شرط درست نیست!</b>\nمثال: <code>حدس عدد 100</code> 🎯`, "game", { parse_mode: "HTML" });
            return true;
        }

        if (user.coins < bet) {
            await replyWarm(ctx, `🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>\n🎯 شرط: <b>${copyNumber(bet)} MBN</b>`, "lose", { parse_mode: "HTML" });
            return true;
        }

        await ctx.reply(numberGuessPrompt(bet), {
            parse_mode: "HTML",
            ...numberGuessKeyboard(user.id, bet)
        });
        return true;
    });
}

async function handleNumberGuess(ctx: any, betRaw: string, guessRaw: string) {
    if (!ctx.from) return;

    return withMutationLock(async () => {
        const bet = parseGameBet(betRaw);
        const normalizedGuess = normalizeDigits(guessRaw);
        const guess = /^\d+$/.test(normalizedGuess) ? Number(normalizedGuess) : NaN;
        const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;
        const isCallback = Boolean(ctx?.callbackQuery);

        if (!bet || !Number.isSafeInteger(guess) || guess < NUMBER_GUESS_MIN || guess > NUMBER_GUESS_MAX) {
            if (isCallback) await safeAnswerCbQuery(ctx, "🎯 عدد باید بین ۱ تا ۷ باشه.", { show_alert: true });
            else await replyWarm(ctx, `🎯 عدد انتخابی باید بین <b>۱ تا ۷</b> باشه.`, "game", { parse_mode: "HTML" });
            return;
        }

        if (user.coins < bet) {
            if (isCallback) await safeAnswerCbQuery(ctx, "برای این شرط 💸 موجودی کافی نیست؛ برای این شرط سکه کم داری.", { show_alert: true });
            else await replyWarm(ctx, `🪙 موجودی کافی نیست: <b>${copyNumber(user.coins)} MBN</b>`, "lose", { parse_mode: "HTML" });
            return;
        }

        const secret = crypto.randomInt(NUMBER_GUESS_MIN, NUMBER_GUESS_MAX + 1);
        user.coins -= bet;
        user.stats.games++;
        db.totals.games++;

        let resultText: string;
        let resultSticker: keyof typeof STICKER_IDS | undefined;
        let xpAward: ReturnType<typeof applyGameXp> = {
            before: levelSnapshot(user),
            after: levelSnapshot(user),
            delta: 0
        };

        if (guess === secret) {
            const prize = bet * NUMBER_GUESS_WIN_MULTIPLIER;
            if (!canAddCoins(user, prize)) {
                user.coins += bet;
                user.stats.games--;
                db.totals.games--;
                resultText = `😅 این 🛑 راند 🛑 لغو شد.؛ هر وقت خواستی دوباره شروع کن.\n🪙 شرطت برگشت خورد.`;
                resultSticker = "game";
            } else {
                user.coins += prize;
                db.totals.coinsPaid += prize;
                user.stats.wins++;
                user.stats.winStreak++;
                user.stats.bestStreak = Math.max(user.stats.bestStreak, user.stats.winStreak);
                xpAward = applyGameXp(user, bet, "number_guess", true);
                recordTransaction({ toUserId: user.id, amount: prize, type: "number_guess", note: `guess:${secret}` });
                await notifyCompletedMissions(user);
                resultText = `🎯 <b>آفرین! دقیق زدی! 🎯🔥</b>\n🤫 عدد: <b>${secret}</b>\n🏆 جایزه: <b>${copyNumber(prize)} MBN</b>\n🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`;
                resultSticker = "guessWin";
            }
        } else {
            user.stats.losses++;
            user.stats.winStreak = 0;
            xpAward = applyGameXp(user, bet, "number_guess", false);
            recordTransaction({ fromUserId: user.id, amount: bet, type: "number_guess", note: `miss:${secret}` });
            await notifyCompletedMissions(user);
            resultText = `😅 <b>این بار نه! 😄</b>\n🤫 عدد: <b>${secret}</b>  •  ❌ حدس: <b>${guess}</b>\n🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`;
            resultSticker = "guessLose";
        }

        saveDatabase(db);
        if (isCallback) await safeAnswerCbQuery(ctx, guess === secret ? "🎉 درست بود!" : "😅 این بار نه! 😄");
        if (resultSticker) await sendStickerSafe(ctx, resultSticker);

        const xpLine = xpResultLine(user, xpAward);
        resultText += `\n\n${xpLine}`;
        const next = numberGuessKeyboard(user.id, bet);
        if (isCallback) {
            await ctx.editMessageText(
                resultText + "\n\n👇 دوباره انتخاب کن",
                { parse_mode: "HTML", ...next }
            );
        } else {
            await ctx.reply(resultText, { parse_mode: "HTML", ...next });
        }
    });
}

bot.action(/^ng:pick:(\d+):(\d+):(\d)$/, async ctx => {
    if (!ctx.from) return;

    const ownerId = Number(ctx.match[1]);
    const bet = Number(ctx.match[2]);
    const guess = Number(ctx.match[3]);

    if (ctx.from.id !== ownerId) {
        await safeAnswerCbQuery(ctx, "😄 ⛔ این دکمه فقط برای بازیکن همون راند ساخته شده.", { show_alert: true });
        return;
    }

    await handleNumberGuess(ctx, String(bet), String(guess));
});

bot.action(/^ng:cancel:(\d+)$/, async ctx => {
    if (!ctx.from) return;
    const ownerId = Number(ctx.match[1]);

    if (ctx.from.id !== ownerId) {
        await safeAnswerCbQuery(ctx, "⛔ ⛔ این دکمه برای بازیکن دیگه‌ست 😉", { show_alert: true });
        return;
    }

    await safeAnswerCbQuery(ctx, "باشه رفیق 😄 هر وقت خواستی دوباره می‌ریم سراغش!");
    try {
        await ctx.editMessageText(
            "✅ <b>🛑 راند 🛑 لغو شد.؛ هر وقت خواستی دوباره شروع کن.</b>\nهر وقت خواستی دوباره شروع کن.",
            { parse_mode: "HTML" }
        );
    } catch {}
});

const CASINO_SLOT_TABLE = [
    "bar|bar|bar", "grape|bar|bar", "lemon|bar|bar", "seven|bar|bar",
    "bar|grape|bar", "grape|grape|bar", "lemon|grape|bar", "seven|grape|bar",
    "bar|lemon|bar", "grape|lemon|bar", "lemon|lemon|bar", "seven|lemon|bar",
    "bar|seven|bar", "grape|seven|bar", "lemon|seven|bar", "seven|seven|bar",
    "bar|bar|grape", "grape|bar|grape", "lemon|bar|grape", "seven|bar|grape",
    "bar|grape|grape", "grape|grape|grape", "lemon|grape|grape", "seven|grape|grape",
    "bar|lemon|grape", "grape|lemon|grape", "lemon|lemon|grape", "seven|lemon|grape",
    "bar|seven|grape", "grape|seven|grape", "lemon|seven|grape", "seven|seven|grape",
    "bar|bar|lemon", "grape|bar|lemon", "lemon|bar|lemon", "seven|bar|lemon",
    "bar|grape|lemon", "grape|grape|lemon", "lemon|grape|lemon", "seven|grape|lemon",
    "bar|lemon|lemon", "grape|lemon|lemon", "lemon|lemon|lemon", "seven|lemon|lemon",
    "bar|seven|lemon", "grape|seven|lemon", "lemon|seven|lemon", "seven|seven|lemon",
    "bar|bar|seven", "grape|bar|seven", "lemon|bar|seven", "seven|bar|seven",
    "bar|grape|seven", "grape|grape|seven", "lemon|grape|seven", "seven|grape|seven",
    "bar|lemon|seven", "grape|lemon|seven", "lemon|lemon|seven", "seven|lemon|seven",
    "bar|seven|seven", "grape|seven|seven", "lemon|seven|seven", "seven|seven|seven"
] as const;

const CASINO_ICON: Record<string, string> = {
    bar: "🟫",
    grape: "🍇",
    lemon: "🍋",
    seven: "7️⃣"
};

function casinoCombo(value: number) {
    const row = CASINO_SLOT_TABLE[Math.max(1, Math.min(64, value)) - 1].split("|");
    return row.map(symbol => CASINO_ICON[symbol]).join("  ");
}

function casinoPayout(value: number) {
    const combo = CASINO_SLOT_TABLE[value - 1].split("|");
    if (combo.every(symbol => symbol === "grape")) return { multiplier: 20, label: "سه تا انگور — جک‌پات!" };
    if (combo.every(symbol => symbol === "seven")) return { multiplier: 12, label: "سه تا هفت" };
    if (combo.every(symbol => symbol === "bar")) return { multiplier: 8, label: "سه تا بار" };
    if (combo.every(symbol => symbol === "lemon")) return { multiplier: 6, label: "سه تا لیمو" };
    if (combo[0] === combo[1] || combo[1] === combo[2] || combo[0] === combo[2]) return { multiplier: 2, label: "جفت" };
    return { multiplier: 0, label: "باخت" };
}

function casinoKeyboard(userId: number, bet: number) {
    return Markup.inlineKeyboard([
        [styledCallback("🎰 دوباره", `casino:spin:${userId}:${bet}`, "success")],
        [styledCallback("❌ لغو", `casino:cancel:${userId}`, "danger")]
    ]);
}

async function playCasino(ctx: any, bet: number) {
    if (!ctx?.from) return;
    return withMutationLock(async () => {
    const safeBet = parseGameBet(String(bet));
    if (!safeBet) {
        await safeAnswerCbQuery(ctx, "مبلغ شرط نامعتبر است.", { show_alert: true });
        return;
    }
    const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;
    if (user.coins < safeBet) {
        await safeAnswerCbQuery(ctx, "💸 موجودی کافی نیست؛ برای این شرط سکه کم داری.", { show_alert: true });
        return;
    }

    let msg: any;
    try {
        msg = await ctx.telegram.sendDice(user.id, { emoji: "🎰" });
    } catch (error) {
        console.error("casino send error:", error);
        await safeAnswerCbQuery(ctx, "⚠️ کازینو اجرا نشد؛ دوباره تلاش کن.", { show_alert: true });
        return;
    }

    const value = Number(msg?.dice?.value);
    if (!Number.isInteger(value) || value < 1 || value > 64) {
        await safeAnswerCbQuery(ctx, "⚠️ نتیجه کازینو معتبر نبود؛ راند دوباره قابل اجراست.", { show_alert: true });
        return;
    }

    const outcome = casinoPayout(value);
    const earnedXp = xpForBet(safeBet);
    const xpDelta = outcome.multiplier > 0 ? earnedXp : Math.max(5, Math.floor(earnedXp / 2));
    let xpAward: ReturnType<typeof addXp>;

    user.coins -= safeBet;
    user.stats.games++;
    db.totals.games++;

    if (outcome.multiplier > 0) {
        const prize = safeBet * outcome.multiplier;
        if (!canAddCoins(user, prize)) {
            user.coins += safeBet;
            user.stats.games--;
            db.totals.games--;
            await safeAnswerCbQuery(ctx, "↩️ شرط کامل برگشت خورد.", { show_alert: true });
            return;
        }

        user.coins += prize;
        db.totals.coinsPaid += prize;
        user.stats.wins++;
        user.stats.winStreak++;
        user.stats.bestStreak = Math.max(user.stats.bestStreak, user.stats.winStreak);
        xpAward = addXp(user, xpDelta, "casino", true);
        recordTransaction({ toUserId: user.id, amount: prize, type: "casino_game", note: `casino:${value}` });
    } else {
        user.stats.losses++;
        user.stats.winStreak = 0;
        xpAward = addXp(user, xpDelta, "casino", false);
        recordTransaction({ fromUserId: user.id, amount: safeBet, type: "casino_game", note: `casino-loss:${value}` });
    }

    user.updatedAt = Date.now();
    saveDatabase(db);
    await sendStickerSafe(ctx, outcome.multiplier > 0 ? "casinoWin" : "casinoLose");

    const result = outcome.multiplier > 0
        ? `🎰 <b>${outcome.label}</b>\n\n${casinoCombo(value)}\n\n🏆 جایزه: <b>${copyNumber(safeBet * outcome.multiplier)} MBN</b>\n🪙 موجودی: <b>${copyNumber(user.coins)}</b>\n\n${xpResultLine(user, xpAward)}`
        : `🎰 <b>این یکی نه</b>\n\n${casinoCombo(value)}\n\n🪙 -${copyNumber(safeBet)} MBN\n🪙 موجودی: <b>${copyNumber(user.coins)}</b>\n\n${xpResultLine(user, xpAward)}`;

    await safeAnswerCbQuery(ctx, outcome.multiplier > 0 ? "🏆 بردی! ✅" : "😅 این راند به نفع شانس تو نبود!");
    await ctx.reply(result + `\n\n✅ راند بعدی: «کازینو ${safeBet}» را بفرست.`, { parse_mode: "HTML" });
    });
}

async function handleCasinoPrompt(ctx: any, betRaw: string) {
    if (!ctx.from || !isPrivateChat(ctx)) return false;

    const bet = parseGameBet(betRaw);
    const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;

    if (!bet) {
        await replyWarm(ctx, "😅 <b>مبلغ شرط درست نیست!</b>\nیه عدد معتبر و حداقل مبلغ لازم رو وارد کن 😉", "casino", { parse_mode: "HTML" });
        return true;
    }

    if (user.coins < bet) {
        await replyWarm(ctx, `🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>`, "casinoLose", { parse_mode: "HTML" });
        return true;
    }

    await ctx.reply(
        `🎰 <b>کازینو</b>\n\n🍇 سه تا انگور بیشترین جایزه رو می‌ده!\n🎰 آماده‌ای شانست رو امتحان کنی؟\n🪙 شرط: <b>${copyNumber(bet)} MBN</b>`,
        {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
                [styledCallback("🎰 بچرخون!", `casino:start:${user.id}:${bet}`, "success")],
                [styledCallback("❌ لغو", `casino:cancel:${user.id}`, "danger")]
            ])
        }
    );
    return true;
}

bot.action(/^casino:bet:(\d+):(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) {
        await safeAnswerCbQuery(ctx, "⛔ این دکمه برای بازیکن دیگه‌ست 😉", { show_alert: true });
        return;
    }
    const user = getStoredUser(ctx.from.id) ?? getUser(ctx.from).user;
    const bet = parseGameBet(ctx.match[2]);
    if (!bet || user.coins < bet) {
        await safeAnswerCbQuery(ctx, "مبلغ شرط معتبر نیست یا 💸 موجودی کافی نیست؛ برای این شرط سکه کم داری.", { show_alert: true });
        return;
    }
    await safeAnswerCbQuery(ctx, "✅ شرط انتخاب شد؛ آماده‌ای؟");
    await ctx.editMessageText(
        `🎰 <b>کازینو</b>\n\n🪙 شرط: <b>${copyNumber(bet)} MBN</b>\n\n👇 برای شروع بزن:`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([
            [styledCallback("🎰 بچرخون!", `casino:start:${user.id}:${bet}`, "success")],
            [styledCallback("↩️ انتخاب مبلغ دیگه", "pv:casino", "primary")]
        ]) }
    );
});

bot.action(/^casino:custom:(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) return;
    await safeAnswerCbQuery(ctx);
    await ctx.editMessageText(
        `🎰 <b>شرط دلخواه کازینو</b>\n\n` +
        `مثال: <code>کازینو 100</code>\n` +
        `🪙 حداقل: <b>${copyNumber(MIN_GAME_BET)} MBN</b>`,
        { parse_mode: "HTML", ...Markup.inlineKeyboard([[styledCallback("↩️ برگشت", "pv:casino", "primary")]]) }
    );
});

bot.action(/^casino:start:(\d+):(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) return;
    await playCasino(ctx, Number(ctx.match[2]));
});

bot.action(/^casino:spin:(\d+):(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) return;
    await playCasino(ctx, Number(ctx.match[2]));
});

bot.action(/^casino:cancel:(\d+)$/, async ctx => {
    if (!ctx.from || ctx.from.id !== Number(ctx.match[1])) return;
    await safeAnswerCbQuery(ctx, "🛑 لغو شد.");
    try {
        await ctx.editMessageText("🎰 راند کازینو 🛑 لغو شد..", { parse_mode: "HTML" });
    } catch {}
});

bot.command("casino", async ctx => {
    if (!ctx.from || !isPrivateChat(ctx)) return;
    const raw = (ctx.message.text || "").replace(/^\/casino(?:@\w+)?/i, "").trim();
    if (raw) {
        await handleCasinoPrompt(ctx, raw);
        return;
    }
    const { user } = getUser(ctx.from);
    await ctx.reply(
        `🎰 <b>کازینو حرفه‌ای</b>\n\n🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>\n👇 مبلغ شرطت رو انتخاب کن:`,
        { parse_mode: "HTML", ...casinoBetKeyboard(user.id, user.coins) }
    );
});

bot.on("chat_member", async ctx => {
    try {
        const update: any = (ctx as any).update?.chat_member;
        const userId = Number(update?.new_chat_member?.user?.id);
        if (!Number.isSafeInteger(userId) || userId <= 0) return;
        const chatId = String(update?.chat?.id ?? "");
        if (chatId !== REFERRAL_GROUP_ID && chatId !== REFERRAL_CHANNEL_ID) return;
        const status = String(update?.new_chat_member?.status || "");
        const joined = status === "member" || status === "administrator" || status === "creator" || (status === "restricted" && update?.new_chat_member?.is_member !== false);
        const referral = db.referrals[String(userId)];
        if (!referral) return;
        if (chatId === REFERRAL_GROUP_ID) referral.groupJoined = joined;
        if (chatId === REFERRAL_CHANNEL_ID) referral.channelJoined = joined;
        saveDatabase(db);
        if (joined) await rewardReferralIfComplete(userId);
    } catch (error) {
        console.error("referral chat_member handler error:", error);
    }
});

bot.on(message("text"), async ctx => {
    if (!ctx.from) return;
    const text = ctx.message.text.trim();
    if (!text) return;

    const clean = text.replace(/\s+/g, " ");

    if (/^مبینا\s*(?:آ|ا)?یدی(?:\s+کاربر|\s+من)?\s*$/i.test(clean) || /^مبینا\s+(?:id|اطلاعات|مشخصات)\s*$/i.test(clean)) {
        const repliedId = Number(ctx.message.reply_to_message?.from?.id);
        const target = Number.isSafeInteger(repliedId) && repliedId > 0
            ? getStoredUser(repliedId)
            : getUser(ctx.from).user;
        if (!target) {
            await ctx.reply("😅 این رفیق هنوز بات رو Start نکرده.");
            return;
        }
        await ctx.reply(identityText(target), { parse_mode: "HTML" });
        return;
    }

    if (/^مبینا\s+موجودی(?:\s+رو)?(?:\s+نشون\s*بده|\s+بده)?\s*$/i.test(clean)) {
        const repliedId = Number(ctx.message.reply_to_message?.from?.id);
        const target = Number.isSafeInteger(repliedId) && repliedId > 0
            ? getStoredUser(repliedId)
            : getUser(ctx.from).user;
        if (!target) {
            await ctx.reply("😅 این رفیق هنوز بات رو Start نکرده.");
            return;
        }
        await sendPrivate(ctx, balanceText(target), privateKeyboardFor(ctx.from.id));
        return;
    }

    if (/^مبینا\s+پروفایل(?:\s+رو)?(?:\s+نشون\s*بده|\s+بده)?\s*$/i.test(clean)) {
        const repliedId = Number(ctx.message.reply_to_message?.from?.id);
        const target = Number.isSafeInteger(repliedId) && repliedId > 0
            ? getStoredUser(repliedId)
            : getUser(ctx.from).user;
        if (!target) {
            await ctx.reply("😅 این رفیق هنوز بات رو Start نکرده.");
            return;
        }
        await sendPrivate(ctx, profileText(target), privateKeyboardFor(ctx.from.id));
        return;
    }

    if (isPrivateChat(ctx)) {
        if (/^(?:موجودی|balance)$/i.test(clean)) {
            const { user } = getUser(ctx.from);
            await ctx.reply(balanceText(user), { parse_mode: "HTML", ...privateKeyboardFor(user.id) });
            return;
        }
        if (/^(?:پروفایل|profile)$/i.test(clean)) {
            const { user } = getUser(ctx.from);
            await ctx.reply(profileText(user), { parse_mode: "HTML", ...privateKeyboardFor(user.id) });
            return;
        }
        if (/^(?:لول|xp|ایکس\s*پی)$/i.test(clean)) {
            const { user } = getUser(ctx.from);
            await ctx.reply(xpText(user) + `\n\n${xpRulesText()}`, { parse_mode: "HTML", ...privateKeyboardFor(user.id) });
            return;
        }
        if (/^(?:برترین|برترین‌ها|تاپ|top)$/i.test(clean)) {
            await ctx.reply(topText(), { parse_mode: "HTML", ...privateKeyboardFor(ctx.from.id) });
            return;
        }
        if (/^(?:ماموریت|ماموریت‌ها|ماموریت روزانه)$/i.test(clean)) {
            const { user } = getUser(ctx.from);
            await ctx.reply(missionText(user), { parse_mode: "HTML", ...privateKeyboardFor(ctx.from.id) });
            return;
        }
        if (/^(?:زیرمجموعه|دعوت|رفرال|referral)$/i.test(clean)) {
            await ctx.reply(referralText(ctx.from.id, ctx.botInfo.username), { parse_mode: "HTML", ...referralKeyboard(ctx.from.id) });
            return;
        }

        if (/^(?:گردونه|گردونه روزانه)$/i.test(clean)) {
            await handleDailyWheel(ctx);
            return;
        }

        const casino = clean.match(/^(?:کازینو|اسلات|slot)(?:\s+(.+))?$/i);
        if (casino) {
            if (casino[1]) {
                await handleCasinoPrompt(ctx, casino[1]);
            } else {
                const { user } = getUser(ctx.from);
                await ctx.reply(
                    `🎰 <b>کازینو حرفه‌ای</b>\n\n🪙 موجودی فعلی: <b>${copyNumber(user.coins)} MBN</b>\n👇 مبلغ شرطت رو انتخاب کن:`,
                    { parse_mode: "HTML", ...casinoBetKeyboard(user.id, user.coins) }
                );
            }
            return;
        }

        const dice = clean.match(/^تاس\s+(.+)$/i);
        if (dice && await handleSingleDicePrompt(ctx, dice[1])) return;

        const dart = clean.match(/^دارت\s+(.+)$/i);
        if (dart && await handleSingleDartPrompt(ctx, dart[1])) return;

        {
            const parts = clean.split(" ");
            if (await handleTransfer(ctx, parts)) return;
        }

        if (isAdmin(ctx.from.id)) {
            const parts = clean.split(" ");
            if (await handleUserLookup(ctx, parts)) return;
            if (/^کسر$/i.test(parts[0]) && await handleDeductAdmin(ctx, parts)) return;
            if (await handleAdminManagement(ctx, clean)) return;
        }
        return;
    }

    if (/^موجودی$/i.test(clean)) {
        const { user } = getUser(ctx.from);
        await ctx.reply(balanceText(user), { parse_mode: "HTML" });
        return;
    }
    if (/^(?:لول|xp|ایکس\s*پی)$/i.test(clean)) {
        const { user } = getUser(ctx.from);
        await ctx.reply(xpText(user), { parse_mode: "HTML" });
        return;
    }
    if (/^(?:ماموریت|ماموریت‌ها|ماموریت روزانه)$/i.test(clean)) {
        const { user } = getUser(ctx.from);
        await ctx.reply(missionText(user), { parse_mode: "HTML" });
        return;
    }
    if (/^(?:گردونه|گردونه روزانه)$/i.test(clean)) {
        await handleDailyWheel(ctx);
        return;
    }

    {
        const parts = clean.split(" ");
        if (await handleTransfer(ctx, parts)) return;
    }

    if (isAdmin(ctx.from.id)) {
        const parts = clean.split(" ");
        if (await handleUserLookup(ctx, parts)) return;

        if (/^کسر(?:\s+مبینا)?$/i.test(parts[0]) && await handleDeductAdmin(ctx, parts)) return;
        if (await handleAdminManagement(ctx, clean)) return;
    }

    if (isPrivateChat(ctx)) {
        const dice = clean.match(/^تاس\s+(.+)$/i);
        if (dice && await handleSingleDicePrompt(ctx, dice[1])) return;

        const dart = clean.match(/^دارت\s+(.+)$/i);
        if (dart && await handleSingleDartPrompt(ctx, dart[1])) return;
    }

    const guessPrompt = clean.match(/^حدس عدد\s+([^\s]+)$/i);
    if (guessPrompt) {
        await handleNumberGuessPrompt(ctx, guessPrompt[1]);
        return;
    }

    const guess = clean.match(/^حدس عدد\s+([^\s]+)\s+([^\s]+)$/i);
    if (guess) {
        await handleNumberGuess(ctx, guess[1], guess[2]);
        return;
    }

        const groupDice = clean.match(/^تاس\s+(.+)$/i);
    if (groupDice && !isPrivateChat(ctx)) {
        const wager = parseGameBet(groupDice[1]);
        if (!wager) {
            await replyWarm(ctx, `😅 <b>مبلغ شرط قابل قبول نیست.</b>\nمثلاً: <code>تاس 100</code> 😉`, "dice", { parse_mode: "HTML" });
            return;
        }
        await createGame(ctx, "dice", wager);
        return;
    }

    const groupDart = clean.match(/^دارت\s+(.+)$/i);
    if (groupDart && !isPrivateChat(ctx)) {
        const wager = parseGameBet(groupDart[1]);
        if (!wager) {
            await replyWarm(ctx, `😅 <b>مبلغ شرط قابل قبول نیست.</b>\nمثلاً: <code>تاس 100</code> 😉`, "dart", { parse_mode: "HTML" });
            return;
        }
        await createGame(ctx, "dart", wager);
        return;
    }

    const groupCasino = clean.match(/^(?:کازینو|اسلات|slot)\s+(.+)$/i);
    if (groupCasino && !isPrivateChat(ctx)) {
        const wager = parseGameBet(groupCasino[1]);
        if (!wager) {
            await replyWarm(ctx, `😅 <b>مبلغ شرط قابل قبول نیست.</b>\nمثلاً: <code>تاس 100</code> 😉`, "casino", { parse_mode: "HTML" });
            return;
        }
        await createGame(ctx, "casino", wager);
        return;
    }

    const coinflip = clean.match(/^(?:بازی|شانس)\s+(.+)$/i);
    if (coinflip) {
        const wager = parseGameBet(coinflip[1]);
        if (!wager) {
            await replyWarm(
                ctx,
                `😅 <b>مبلغ شرط یه مشکلی داره!</b>\n\n` +
                `مثال: <code>بازی 100</code>\n` +
                `💡 حداقل شرط: <b>${copyNumber(MIN_GAME_BET)} MBN</b>\n` +
                `🚀 هر مبلغ بالاتری هم اوکیه؛ فقط موجودی باید برسه! 😄`,
                "game",
                { parse_mode: "HTML" }
            );
            return;
        }
        await createGame(ctx, "coinflip", wager);
        return;
    }

    const rps = clean.match(/^(?:گیم|rps)\s+(.+)$/i);
    if (rps) {
        const wager = parseGameBet(rps[1]);
        if (!wager) {
            await replyWarm(
                ctx,
                `😅 <b>مبلغ شرط یه مشکلی داره!</b>\n\n` +
                `مثال: <code>گیم 100</code>\n` +
                `💡 حداقل شرط: <b>${copyNumber(MIN_GAME_BET)} MBN</b>\n` +
                `🚀 هر مبلغ بالاتری هم اوکیه؛ فقط موجودی باید برسه! 😄`,
                "game",
                { parse_mode: "HTML" }
            );
            return;
        }
        await createGame(ctx, "rps", wager);
        return;
    }

    const ttt = clean.match(/^(?:دوز|doz|ttt)\s+(.+)$/i);
    if (ttt) {
        const wager = parseGameBet(ttt[1]);
        if (!wager) {
            await replyWarm(
                ctx,
                `😅 <b>مبلغ شرط یه مشکلی داره!</b>\n\n` +
                `مثال: <code>دوز 100</code>\n` +
                `💡 حداقل شرط: <b>${copyNumber(MIN_GAME_BET)} MBN</b>\n` +
                `🚀 هر مبلغ بالاتری هم اوکیه؛ فقط موجودی باید برسه! 😄`,
                "game",
                { parse_mode: "HTML" }
            );
            return;
        }
        await createGame(ctx, "tictactoe", wager);
    }
});

bot.catch((error, ctx) => {
    console.error("خطای ربات:", error, "update:", ctx.update.update_id);
});

bot.launch();
console.log("Mobina Game Bot started.");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

import express from "express";
import path from "node:path";

function validateInitData(initData: string): any | null {
    if (!initData) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");

    const dataCheckString = Array.from(params.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
    const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (computedHash !== hash) return null;

    const userJson = params.get("user");
    if (!userJson) return null;
    try { return JSON.parse(userJson); } catch { return null; }
}

function authMiddleware(req: any, res: any, next: any) {
    const initData = String(req.headers["x-init-data"] || "");
    const user = validateInitData(initData);
    if (!user) return res.status(401).json({ error: "unauthorized" });
    req.tgUser = user;
    next();
}

function publicProfile(user: User) {
    const s = levelSnapshot(user);
    return {
        id: user.id,
        name: user.name,
        username: user.username || null,
        coins: user.coins,
        coinsToman: coinsToToman(user.coins),
        level: s.level,
        levelName: levelName(s.level),
        xp: user.stats.xp,
        xpCurrent: s.current,
        xpNeeded: s.needed,
        xpPct: s.needed > 0 ? Math.round((s.current / s.needed) * 100) : 100,
        stats: {
            games: user.stats.games,
            wins: user.stats.wins,
            losses: user.stats.losses,
            draws: user.stats.draws,
            winStreak: user.stats.winStreak,
            bestStreak: user.stats.bestStreak,
            coinflipWins: user.stats.coinflipWins,
            rpsWins: user.stats.rpsWins,
            tttWins: user.stats.tttWins,
            diceWins: user.stats.diceWins,
            dartWins: user.stats.dartWins,
            casinoWins: user.stats.casinoWins,
            guessWins: user.stats.guessWins
        }
    };
}

function leaderboardList(type: string) {
    const users = Object.values(db.users);
    let sorted: User[];
    let valueFn: (u: User) => number;

    if (type === "coins") {
        sorted = [...users].sort((a, b) => b.coins - a.coins);
        valueFn = u => u.coins;
    } else if (type === "xp") {
        sorted = [...users].sort((a, b) => (b.stats.xp || 0) - (a.stats.xp || 0));
        valueFn = u => u.stats.xp || 0;
    } else {
        const keyMap: Record<string, keyof Stats> = {
            coinflip: "coinflipWins",
            rps: "rpsWins",
            ttt: "tttWins",
            dice: "diceWins",
            dart: "dartWins",
            casino: "casinoWins",
            guess: "guessWins"
        };
        const key = keyMap[type];
        if (!key) return null;
        sorted = [...users].sort((a, b) => Number(b.stats[key]) - Number(a.stats[key]));
        valueFn = u => Number(u.stats[key]);
    }

    return sorted
        .filter(u => valueFn(u) > 0)
        .slice(0, 50)
        .map((u, i) => {
            const s = levelSnapshot(u);
            return {
                rank: i + 1,
                id: u.id,
                name: u.name,
                username: u.username || null,
                value: valueFn(u),
                level: s.level,
                levelName: levelName(s.level)
            };
        });
}

const webApp = express();
webApp.use(express.json({ limit: "32kb" }));
webApp.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-Init-Data");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
});

webApp.use(express.static(path.join(__dirname, "..", "webapp")));

webApp.get("/api/me", authMiddleware, (req: any, res) => {
    const { user } = getUser(req.tgUser);
    res.json(publicProfile(user));
});

webApp.get("/api/leaderboard/:type", (req, res) => {
    const list = leaderboardList(req.params.type);
    if (!list) return res.status(400).json({ error: "bad_type" });
    res.json({ type: req.params.type, list });
});

webApp.post("/api/purchase", authMiddleware, (req: any, res) => {
    const coins = Number(req.body?.coins);
    if (!Number.isSafeInteger(coins) || coins < 100) {
        return res.status(400).json({ error: "bad_amount" });
    }
    res.json({
        ok: false,
        coins,
        toman: coinsToToman(coins),
        message: "🚧 درگاه پرداخت هنوز ساخته نشده\nبه‌زودی فعال می‌شه 💛"
    });
});

const MINI_APP_PORT = Number(process.env.MINI_APP_PORT || 3000);
webApp.listen(MINI_APP_PORT, () => {
    console.log(`🌐 Mini App server listening on port ${MINI_APP_PORT}`);
});