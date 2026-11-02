/**
 * Leaderboard score policy — SINGLE SOURCE OF TRUTH.
 *
 * Loaded by:
 *   - firebase-functions/scores.js          (server-side validation)
 *   - admin/reset_cheated_scores.js         (cleanup of impossible existing scores)
 *
 * The rules in firestore.rules no longer accept client writes to any
 * `leaderboard_*` collection, so this file is what decides whether a claimed
 * score is believable. Everything the browser sends is untrusted.
 *
 * Per field:
 *   min / max   absolute hard bounds the value can never leave.
 *   dir         'higher' = bigger is better (points, wins, age)
 *               'lower'  = smaller is better (moves, seconds)
 *   rate        maximum believable gain per SECOND of real time since the game
 *               was opened ("run"). Tune this to ~2-4x a very good human
 *               points-per-second so honest players are never rejected, while
 *               reaching `max` still takes hours of elapsed play.
 *   base        allowance for a brand-new entry only (it does NOT stack on
 *               every run — otherwise reloading the page would farm it).
 *   float       true for values that are legitimately fractional (trivia %).
 *
 * `opaque` lists free-form state blobs (wordle/spellbound save data). They are
 * stored as-is but size-limited and never influence ranking.
 *
 * IMPORTANT: raising a `max` here is a product decision; raising `rate` makes
 * cheating easier. Keep `max` close to the best score a human can realistically
 * reach, and `rate` far above a human's points-per-second.
 */

const OPAQUE_MAX_BYTES = 200000;

const COLLECTIONS = {
    leaderboard_tetris: {
        game: 'tetris',
        fields: { score: { min: 0, max: 10000000, dir: 'higher', rate: 1000, base: 5000 } }
    },
    leaderboard_snake: {
        game: 'snake',
        fields: { score: { min: 0, max: 1000000, dir: 'higher', rate: 150, base: 5000 } }
    },
    leaderboard_pacman: {
        // Arcade world record is 3,333,360 — anything above that is fabricated.
        game: 'pacman',
        fields: { score: { min: 0, max: 3333360, dir: 'higher', rate: 250, base: 5000 } }
    },
    leaderboard_wordle: {
        game: 'wordle',
        fields: { score: { min: 0, max: 100000, dir: 'higher', rate: 5, base: 5000 } },
        opaque: ['stats']
    },
    leaderboard_spellingbee: {
        game: 'spellingbee',
        fields: { score: { min: 0, max: 200000, dir: 'higher', rate: 20, base: 5000 } },
        opaque: ['stats', 'daily', 'unlimited', 'savedDate']
    },
    leaderboard_dino_v1: {
        game: 'dino',
        fields: { score: { min: 0, max: 1000000, dir: 'higher', rate: 100, base: 5000 } }
    },
    leaderboard_maze: {
        game: 'maze',
        fields: { score: { min: 0, max: 1000000, dir: 'higher', rate: 100, base: 5000 } }
    },
    leaderboard_hanoi_3: {
        game: 'hanoi',
        fields: { moves: { min: 7, max: 100000, dir: 'lower' } }
    },
    leaderboard_hanoi_4: {
        game: 'hanoi',
        fields: { moves: { min: 15, max: 100000, dir: 'lower' } }
    },
    leaderboard_hanoi_5: {
        game: 'hanoi',
        fields: { moves: { min: 31, max: 100000, dir: 'lower' } }
    },
    leaderboard_hanoi_6: {
        game: 'hanoi',
        fields: { moves: { min: 63, max: 100000, dir: 'lower' } }
    },
    leaderboard_hanoi_7: {
        game: 'hanoi',
        fields: { moves: { min: 127, max: 100000, dir: 'lower' } }
    },
    leaderboard_lightsout_3: {
        game: 'lightsout',
        fields: { moves: { min: 1, max: 100000, dir: 'lower' } }
    },
    leaderboard_lightsout_4: {
        game: 'lightsout',
        fields: { moves: { min: 1, max: 100000, dir: 'lower' } }
    },
    leaderboard_lightsout_5: {
        game: 'lightsout',
        fields: { moves: { min: 1, max: 100000, dir: 'lower' } }
    },
    leaderboard_trivia: {
        game: 'trivia',
        fields: {
            // Sum of per-game correct fractions — grows by <1 per game.
            totalPercent: { min: 0, max: 1000000, dir: 'higher', rate: 0.1, base: 1, float: true },
            gameCount: { min: 0, max: 1000000, dir: 'higher', rate: 0.1, base: 1 }
        }
    },
    leaderboard_solitaire: {
        game: 'solitaire',
        fields: { moves: { min: 40, max: 100000, dir: 'lower' } }
    },
    leaderboard_blockblast: {
        game: 'blockblast',
        fields: { score: { min: 0, max: 10000000, dir: 'higher', rate: 500, base: 5000 } }
    },
    leaderboard_pet_v1: {
        // "score" is the pet's age in days (labelled years) — it grows with real
        // time, not play, and real accounts already sit at 100-400+. Do not
        // tighten this without checking the live collection first.
        game: 'pet',
        fields: { score: { min: 0, max: 100000, dir: 'higher', rate: 1, base: 500, float: true } }
    },
    leaderboard_mario: {
        game: 'mario',
        fields: {
            score: { min: 0, max: 10000000, dir: 'higher', rate: 500, base: 5000 },
            dist: { min: 0, max: 100, dir: 'higher', rate: 2, base: 100, float: true },
            coins: { min: 0, max: 100000, dir: 'higher', rate: 50, base: 5000 },
            time: { min: 5, max: 100000, dir: 'lower', float: true }
        }
    },
    leaderboard_yahtzee: {
        game: 'yahtzee',
        fields: { score: { min: 0, max: 100000, dir: 'higher', rate: 20, base: 5000 } }
    },
    leaderboard_circle: {
        game: 'circle',
        fields: { score: { min: 0, max: 1000000, dir: 'higher', rate: 200, base: 5000 } }
    },
    leaderboard_crossy: {
        game: 'crossy',
        fields: { score: { min: 0, max: 1000000, dir: 'higher', rate: 100, base: 5000 } }
    },
    leaderboard_surfer: {
        game: 'surfer',
        fields: { score: { min: 0, max: 5000000, dir: 'higher', rate: 400, base: 5000 } }
    },
    leaderboard_jumpy: {
        game: 'jumpy',
        fields: { score: { min: 0, max: 1000000, dir: 'higher', rate: 50, base: 5000 } }
    },
    leaderboard_oregontrail: {
        // One completed journey: survivors, supplies, cash and an early-arrival
        // bonus, multiplied by the profession factor (x1..x3). A perfect
        // farmer run tops out around 13k; a ~25 minute journey can bank ~45k.
        game: 'oregontrail',
        fields: { score: { min: 0, max: 50000, dir: 'higher', rate: 25, base: 5000 } }
    }
};

// Usernames used for display. Same character set as the old isValidActionUsername.
const USERNAME_RE = /^[a-zA-Z0-9_.-]{1,40}$/;

function isValidUsername(name) {
    return typeof name === 'string' && USERNAME_RE.test(name);
}

module.exports = {
    COLLECTIONS,
    OPAQUE_MAX_BYTES,
    isValidUsername
};
