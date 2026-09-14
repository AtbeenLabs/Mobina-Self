import path from "node:path";
import Database from "better-sqlite3";

const DB_FILE = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.join(process.cwd(), "data", "mabina.sqlite");

const sqlite = new Database(DB_FILE);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
sqlite.pragma("synchronous = NORMAL");
sqlite.pragma("temp_store = MEMORY");

sqlite.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    username TEXT,
    coins INTEGER NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    active_game_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_wheel_day TEXT,
    referred_by INTEGER
);

CREATE TABLE IF NOT EXISTS user_stats (
    user_id INTEGER PRIMARY KEY,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    games INTEGER NOT NULL DEFAULT 0,
    win_streak INTEGER NOT NULL DEFAULT 0,
    best_streak INTEGER NOT NULL DEFAULT 0,
    xp INTEGER NOT NULL DEFAULT 0,
    coinflip_wins INTEGER NOT NULL DEFAULT 0,
    rps_wins INTEGER NOT NULL DEFAULT 0,
    ttt_wins INTEGER NOT NULL DEFAULT 0,
    dice_wins INTEGER NOT NULL DEFAULT 0,
    dart_wins INTEGER NOT NULL DEFAULT 0,
    guess_wins INTEGER NOT NULL DEFAULT 0,
    casino_wins INTEGER NOT NULL DEFAULT 0,
    bowling_wins INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claimed_missions (
    user_id INTEGER NOT NULL,
    mission_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, mission_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admins (
    user_id INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS totals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    games INTEGER NOT NULL DEFAULT 0,
    coins_paid INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    from_user_id INTEGER,
    to_user_id INTEGER,
    amount INTEGER NOT NULL,
    type TEXT NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referrals (
    invitee_id INTEGER PRIMARY KEY,
    inviter_id INTEGER NOT NULL,
    invitee_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    group_joined INTEGER NOT NULL DEFAULT 0,
    channel_joined INTEGER NOT NULL DEFAULT 0,
    rewarded INTEGER NOT NULL DEFAULT 0,
    rewarded_at INTEGER
);

CREATE TABLE IF NOT EXISTS game_records (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_game_records_status ON game_records(status);
CREATE INDEX IF NOT EXISTS idx_referrals_inviter ON referrals(inviter_id);

INSERT OR IGNORE INTO totals (id, games, coins_paid) VALUES (1, 0, 0);
`);

/* ---------- Auto-migration برای دیتابیس‌های قدیمی ---------- */
function ensureColumn(table: string, column: string, definition: string) {
    try {
        const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        if (!cols.some(c => c.name === column)) {
            sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
            console.log(`🔧 migration: added column ${table}.${column}`);
        }
    } catch (error) {
        console.error(`column migration failed for ${table}.${column}:`, error);
    }
}

ensureColumn("users", "referred_by", "INTEGER");
ensureColumn("user_stats", "bowling_wins", "INTEGER NOT NULL DEFAULT 0");

console.log(`🗄️  SQLite ready: ${DB_FILE}`);

type AnyRecord = Record<string, any>;

function asNumber(value: unknown, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function asOptionalString(value: unknown) {
    return value == null ? undefined : String(value);
}

function asOptionalNumber(value: unknown) {
    if (value == null) return undefined;
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export function loadDatabase<T extends AnyRecord>(): T {
    const state: AnyRecord = {
        version: 11,
        users: {},
        games: {},
        admins: [],
        totals: { games: 0, coinsPaid: 0 },
        transactions: [],
        referrals: {}
    };

    /* ---------- کاربران ---------- */
    const userRows = sqlite.prepare(`
        SELECT id, name, username, coins, xp, active_game_id,
               created_at, updated_at, last_wheel_day, referred_by
        FROM users
        ORDER BY id
    `).all() as AnyRecord[];

    const statsRows = sqlite.prepare(`
        SELECT user_id, wins, losses, draws, games, win_streak, best_streak, xp,
               coinflip_wins, rps_wins, ttt_wins, dice_wins, dart_wins,
               guess_wins, casino_wins, bowling_wins
        FROM user_stats
    `).all() as AnyRecord[];

    const statsByUser = new Map<number, AnyRecord>();
    for (const row of statsRows) statsByUser.set(Number(row.user_id), row);

    const missionRows = sqlite.prepare(`
        SELECT user_id, mission_id FROM claimed_missions ORDER BY user_id, mission_id
    `).all() as AnyRecord[];

    const missionsByUser = new Map<number, number[]>();
    for (const row of missionRows) {
        const userId = Number(row.user_id);
        const missionId = Number(row.mission_id);
        const list = missionsByUser.get(userId) ?? [];
        list.push(missionId);
        missionsByUser.set(userId, list);
    }

    for (const row of userRows) {
        const id = Number(row.id);
        const stats = statsByUser.get(id) ?? {};
        state.users[String(id)] = {
            id,
            name: String(row.name ?? "کاربر"),
            username: row.username == null ? undefined : String(row.username),
            coins: asNumber(row.coins),
            xp: asNumber(row.xp),
            activeGameId: asOptionalString(row.active_game_id),
            stats: {
                wins: asNumber(stats.wins),
                losses: asNumber(stats.losses),
                draws: asNumber(stats.draws),
                games: asNumber(stats.games),
                winStreak: asNumber(stats.win_streak),
                bestStreak: asNumber(stats.best_streak),
                xp: asNumber(stats.xp),
                coinflipWins: asNumber(stats.coinflip_wins),
                rpsWins: asNumber(stats.rps_wins),
                tttWins: asNumber(stats.ttt_wins),
                diceWins: asNumber(stats.dice_wins),
                dartWins: asNumber(stats.dart_wins),
                guessWins: asNumber(stats.guess_wins),
                casinoWins: asNumber(stats.casino_wins),
                bowlingWins: asNumber(stats.bowling_wins)
            },
            createdAt: asNumber(row.created_at),
            updatedAt: asNumber(row.updated_at),
            lastWheelDay: asOptionalString(row.last_wheel_day),
            claimedMissions: missionsByUser.get(id) ?? [],
            referredBy: asOptionalNumber(row.referred_by)
        };
    }

    /* ---------- ادمین‌ها ---------- */
    const adminRows = sqlite.prepare(`SELECT user_id FROM admins ORDER BY user_id`).all() as AnyRecord[];
    state.admins = adminRows.map(row => Number(row.user_id)).filter(Number.isSafeInteger);

    /* ---------- totals ---------- */
    const totals = sqlite.prepare(`SELECT games, coins_paid FROM totals WHERE id = 1`).get() as AnyRecord | undefined;
    if (totals) {
        state.totals.games = asNumber(totals.games);
        state.totals.coinsPaid = asNumber(totals.coins_paid);
    }

    /* ---------- تراکنش‌ها ---------- */
    const transactionRows = sqlite.prepare(`
        SELECT id, from_user_id, to_user_id, amount, type, note, created_at
        FROM transactions
        ORDER BY created_at ASC, rowid ASC
    `).all() as AnyRecord[];

    state.transactions = transactionRows.map(row => ({
        id: String(row.id),
        fromUserId: row.from_user_id == null ? undefined : Number(row.from_user_id),
        toUserId: row.to_user_id == null ? undefined : Number(row.to_user_id),
        amount: asNumber(row.amount),
        type: String(row.type),
        note: row.note == null ? undefined : String(row.note),
        createdAt: asNumber(row.created_at)
    }));

    /* ---------- رفرال‌ها ---------- */
    const referralRows = sqlite.prepare(`
        SELECT invitee_id, inviter_id, invitee_name, created_at,
               group_joined, channel_joined, rewarded, rewarded_at
        FROM referrals
    `).all() as AnyRecord[];

    for (const row of referralRows) {
        const inviteeId = Number(row.invitee_id);
        state.referrals[String(inviteeId)] = {
            inviterId: Number(row.inviter_id),
            inviteeId,
            inviteeName: String(row.invitee_name ?? "کاربر"),
            createdAt: asNumber(row.created_at),
            groupJoined: Boolean(row.group_joined),
            channelJoined: Boolean(row.channel_joined),
            rewarded: Boolean(row.rewarded),
            rewardedAt: row.rewarded_at == null ? undefined : Number(row.rewarded_at)
        };
    }

    /* ---------- بازی‌ها ---------- */
    const gameRows = sqlite.prepare(`
        SELECT id, data_json FROM game_records ORDER BY created_at ASC, id ASC
    `).all() as AnyRecord[];

    for (const row of gameRows) {
        try {
            const game = JSON.parse(String(row.data_json));
            if (game && typeof game === "object" && typeof game.id === "string") {
                state.games[game.id] = game;
            }
        } catch (error) {
            console.error(`خطا در خواندن بازی ${String(row.id)} از SQLite:`, error);
        }
    }

    return state as T;
}

export function saveDatabase<T extends AnyRecord>(database: T) {
    const save = sqlite.transaction((state: AnyRecord) => {
        sqlite.exec(`
            DELETE FROM claimed_missions;
            DELETE FROM user_stats;
            DELETE FROM users;
            DELETE FROM admins;
            DELETE FROM transactions;
            DELETE FROM referrals;
            DELETE FROM game_records;
        `);

        const insertUser = sqlite.prepare(`
            INSERT INTO users (
                id, name, username, coins, xp, active_game_id,
                created_at, updated_at, last_wheel_day, referred_by
            ) VALUES (
                @id, @name, @username, @coins_val, @xp_val, @active_game_id,
                @created_at, @updated_at, @last_wheel_day, @referred_by
            )
        `);

        const insertStats = sqlite.prepare(`
            INSERT INTO user_stats (
                user_id, wins, losses, draws, games, win_streak, best_streak, xp,
                coinflip_wins, rps_wins, ttt_wins, dice_wins, dart_wins,
                guess_wins, casino_wins, bowling_wins
            ) VALUES (
                @user_id, @wins, @losses, @draws, @games, @win_streak, @best_streak, @xp,
                @coinflip_wins, @rps_wins, @ttt_wins, @dice_wins, @dart_wins,
                @guess_wins, @casino_wins, @bowling_wins
            )
        `);

        const insertMission = sqlite.prepare(`
            INSERT INTO claimed_missions (user_id, mission_id) VALUES (?, ?)
        `);

        for (const user of Object.values((state.users ?? {}) as AnyRecord)) {
            insertUser.run({
                id: Number(user.id),
                name: String(user.name ?? "کاربر"),
                username: user.username ?? null,
                coins_val: Number(user.coins ?? 0),
                xp_val: Number(user.xp ?? 0),
                active_game_id: user.activeGameId ?? null,
                created_at: Number(user.createdAt ?? Date.now()),
                updated_at: Number(user.updatedAt ?? Date.now()),
                last_wheel_day: user.lastWheelDay ?? null,
                referred_by: user.referredBy ?? null
            });

            const stats = user.stats ?? {};
            insertStats.run({
                user_id: Number(user.id),
                wins: Number(stats.wins ?? 0),
                losses: Number(stats.losses ?? 0),
                draws: Number(stats.draws ?? 0),
                games: Number(stats.games ?? 0),
                win_streak: Number(stats.winStreak ?? 0),
                best_streak: Number(stats.bestStreak ?? 0),
                xp: Number(stats.xp ?? 0),
                coinflip_wins: Number(stats.coinflipWins ?? 0),
                rps_wins: Number(stats.rpsWins ?? 0),
                ttt_wins: Number(stats.tttWins ?? 0),
                dice_wins: Number(stats.diceWins ?? 0),
                dart_wins: Number(stats.dartWins ?? 0),
                guess_wins: Number(stats.guessWins ?? 0),
                casino_wins: Number(stats.casinoWins ?? 0),
                bowling_wins: Number(stats.bowlingWins ?? 0)
            });

            for (const missionId of (user.claimedMissions ?? [])) {
                insertMission.run(Number(user.id), Number(missionId));
            }
        }

        const insertAdmin = sqlite.prepare(`INSERT INTO admins (user_id) VALUES (?)`);
        for (const id of state.admins ?? []) insertAdmin.run(Number(id));

        sqlite.prepare(`
            INSERT INTO totals (id, games, coins_paid) VALUES (1, ?, ?)
            ON CONFLICT(id) DO UPDATE SET games = excluded.games, coins_paid = excluded.coins_paid
        `).run(
            Number(state.totals?.games ?? 0),
            Number(state.totals?.coinsPaid ?? 0)
        );

        const insertTransaction = sqlite.prepare(`
            INSERT INTO transactions (
                id, from_user_id, to_user_id, amount, type, note, created_at
            ) VALUES (
                @id, @from_user_id, @to_user_id, @amount, @type, @note, @created_at
            )
        `);

        for (const tx of state.transactions ?? []) {
            insertTransaction.run({
                id: String(tx.id),
                from_user_id: tx.fromUserId == null ? null : Number(tx.fromUserId),
                to_user_id: tx.toUserId == null ? null : Number(tx.toUserId),
                amount: Number(tx.amount ?? 0),
                type: String(tx.type ?? "unknown"),
                note: tx.note ?? null,
                created_at: Number(tx.createdAt ?? Date.now())
            });
        }

        const insertReferral = sqlite.prepare(`
            INSERT INTO referrals (
                invitee_id, inviter_id, invitee_name, created_at,
                group_joined, channel_joined, rewarded, rewarded_at
            ) VALUES (
                @invitee_id, @inviter_id, @invitee_name, @created_at,
                @group_joined, @channel_joined, @rewarded, @rewarded_at
            )
        `);

        for (const ref of Object.values((state.referrals ?? {}) as AnyRecord)) {
            insertReferral.run({
                invitee_id: Number(ref.inviteeId),
                inviter_id: Number(ref.inviterId),
                invitee_name: String(ref.inviteeName ?? "کاربر"),
                created_at: Number(ref.createdAt ?? Date.now()),
                group_joined: ref.groupJoined ? 1 : 0,
                channel_joined: ref.channelJoined ? 1 : 0,
                rewarded: ref.rewarded ? 1 : 0,
                rewarded_at: ref.rewardedAt ?? null
            });
        }

        const insertGame = sqlite.prepare(`
            INSERT INTO game_records (id, status, created_at, data_json)
            VALUES (?, ?, ?, ?)
        `);

        for (const game of Object.values((state.games ?? {}) as AnyRecord)) {
            insertGame.run(
                String(game.id),
                String(game.status ?? "finished"),
                Number(game.createdAt ?? Date.now()),
                JSON.stringify(game)
            );
        }
    });

    save(database);
}