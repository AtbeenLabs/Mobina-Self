import path from "node:path";
import Database from "better-sqlite3";

const DB_FILE = path.join(process.cwd(), "mabina.sqlite");

const sqlite = new Database(DB_FILE);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

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
    last_wheel_day TEXT
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

-- Internal SQLite representation for the exact in-memory game objects.
-- The bot's game logic is unchanged; only persistence moves to SQLite.
CREATE TABLE IF NOT EXISTS game_records (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    data_json TEXT NOT NULL
);

INSERT OR IGNORE INTO totals (id, games, coins_paid) VALUES (1, 0, 0);
`);

console.log(`🗄️ SQLite database: ${DB_FILE}`);

type AnyRecord = Record<string, any>;

function asNumber(value: unknown, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function asOptionalString(value: unknown) {
    return value == null ? undefined : String(value);
}

export function loadDatabase<T extends AnyRecord>(): T {
    const state: AnyRecord = {
        version: 11,
        users: {},
        games: {},
        admins: [],
        totals: { games: 0, coinsPaid: 0 },
        transactions: []
    };

    const userRows = sqlite.prepare(`
        SELECT id, name, username, coins, xp, active_game_id, created_at, updated_at, last_wheel_day
        FROM users
        ORDER BY id
    `).all() as AnyRecord[];

    const statsRows = sqlite.prepare(`
        SELECT user_id, wins, losses, draws, games, win_streak, best_streak, xp,
               coinflip_wins, rps_wins, ttt_wins, dice_wins, dart_wins,
               guess_wins, casino_wins
        FROM user_stats
    `).all() as AnyRecord[];

    const statsByUser = new Map<number, AnyRecord>();
    for (const row of statsRows) statsByUser.set(Number(row.user_id), row);

    const missionRows = sqlite.prepare(`
        SELECT user_id, mission_id
        FROM claimed_missions
        ORDER BY user_id, mission_id
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
                casinoWins: asNumber(stats.casino_wins)
            },
            createdAt: asNumber(row.created_at),
            updatedAt: asNumber(row.updated_at),
            lastWheelDay: asOptionalString(row.last_wheel_day),
            claimedMissions: missionsByUser.get(id) ?? []
        };
    }

    const adminRows = sqlite.prepare(`SELECT user_id FROM admins ORDER BY user_id`).all() as AnyRecord[];
    state.admins = adminRows.map(row => Number(row.user_id)).filter(Number.isSafeInteger);

    const totals = sqlite.prepare(`SELECT games, coins_paid FROM totals WHERE id = 1`).get() as AnyRecord | undefined;
    if (totals) {
        state.totals.games = asNumber(totals.games);
        state.totals.coinsPaid = asNumber(totals.coins_paid);
    }

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

    const gameRows = sqlite.prepare(`
        SELECT id, data_json
        FROM game_records
        ORDER BY created_at ASC, id ASC
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
            DELETE FROM game_records;
        `);

        const insertUser = sqlite.prepare(`
            INSERT INTO users (
                id, name, username, coins, xp, active_game_id,
                created_at, updated_at, last_wheel_day
            ) VALUES (
                @id, @name, @username, @xp_coins, @xp, @active_game_id,
                @created_at, @updated_at, @last_wheel_day
            )
        `);

        const insertStats = sqlite.prepare(`
            INSERT INTO user_stats (
                user_id, wins, losses, draws, games, win_streak, best_streak, xp,
                coinflip_wins, rps_wins, ttt_wins, dice_wins, dart_wins,
                guess_wins, casino_wins
            ) VALUES (
                @user_id, @wins, @losses, @draws, @games, @win_streak, @best_streak, @xp,
                @coinflip_wins, @rps_wins, @ttt_wins, @dice_wins, @dart_wins,
                @guess_wins, @casino_wins
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
                xp_coins: Number(user.coins ?? 0),
                xp: Number(user.xp ?? 0),
                active_game_id: user.activeGameId ?? null,
                created_at: Number(user.createdAt ?? Date.now()),
                updated_at: Number(user.updatedAt ?? Date.now()),
                last_wheel_day: user.lastWheelDay ?? null
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
                casino_wins: Number(stats.casinoWins ?? 0)
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
