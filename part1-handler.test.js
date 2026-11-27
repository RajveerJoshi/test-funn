'use strict';

// Run: node --test part1-handler.test.js

const test = require('node:test');
const assert = require('node:assert');
const {
  withdraw, reversePayout, parseAmountMinor, istDay, DAILY_LIMIT_MINOR,
} = require('./part1-handler');

function dupKey() {
  const e = new Error('dup key');
  e.code = 11000;
  return e;
}

function makeDb() {
  const state = {
    users: new Map(), wallets: new Map(), payouts: new Map(),
    ledger: [], idemKeys: new Set(), daily: new Map(),
  };
  const undo = (opts, fn) => opts && opts.session && opts.session.undo.push(fn);

  const session = () => {
    const s = { undo: [] };
    s.withTransaction = async (fn) => {
      try {
        return await fn();
      } catch (e) {
        for (const u of s.undo.reverse()) u();
        s.undo = [];
        throw e;
      }
    };
    return s;
  };

  const Wallets = {
    async findOneAndUpdate(filter, update, opts) {
      const w = state.wallets.get(filter.userId);
      if (!w) return null;
      if (filter.balance && w.balance < filter.balance.$gte) return null;
      w.balance += update.$inc.balance;
      undo(opts, () => { w.balance -= update.$inc.balance; });
      return { ...w };
    },
    async updateOne(q, u, opts) {
      const w = state.wallets.get(q.userId);
      w.balance += u.$inc.balance;
      undo(opts, () => { w.balance -= u.$inc.balance; });
      return { modifiedCount: 1 };
    },
  };

  const Daily = {
    async findOne(q) {
      const d = state.daily.get(`${q.userId}|${q.day}`);
      return d ? { ...d } : null;
    },
    async findOneAndUpdate(filter, update, opts = {}) {
      const k = `${filter.userId}|${filter.day}`;
      let d = state.daily.get(k);
      const inc = update.$inc.totalMinor;
      if (d) {
        if (filter.totalMinor && d.totalMinor > filter.totalMinor.$lte) {
          if (opts.upsert) throw dupKey(); // upsert falls through to INSERT
          return null;
        }
        d.totalMinor += inc;
        undo(opts, () => { d.totalMinor -= inc; });
      } else {
        if (!opts.upsert) return null;
        // An upsert INSERT ignores the range predicate (as real MongoDB does).
        d = { userId: filter.userId, day: filter.day, totalMinor: inc, ...update.$setOnInsert };
        state.daily.set(k, d);
        undo(opts, () => { state.daily.delete(k); });
      }
      return { ...d };
    },
    async updateOne(q, u, opts) {
      const d = state.daily.get(`${q.userId}|${q.day}`);
      d.totalMinor += u.$inc.totalMinor;
      undo(opts, () => { d.totalMinor -= u.$inc.totalMinor; });
      return { modifiedCount: 1 };
    },
  };

  const Payouts = {
    async findOne(q) {
      for (const p of state.payouts.values()) {
        if (q._id && String(p._id) !== String(q._id)) continue;
        if (q.idempotencyKey !== undefined && p.idempotencyKey !== q.idempotencyKey) continue;
        return { ...p };
      }
      return null;
    },
    async insertOne(doc, opts) {
      if (doc.idempotencyKey && state.idemKeys.has(doc.idempotencyKey)) throw dupKey();
      const _id = `po_${state.payouts.size + 1}`;
      state.payouts.set(_id, { ...doc, _id });
      if (doc.idempotencyKey) state.idemKeys.add(doc.idempotencyKey);
      undo(opts, () => {
        state.payouts.delete(_id);
        if (doc.idempotencyKey) state.idemKeys.delete(doc.idempotencyKey);
      });
      return { insertedId: _id };
    },
    async updateOne(q, u, opts) {
      const p = state.payouts.get(String(q._id));
      if (p) {
        const prev = { ...p };
        Object.assign(p, u.$set);
        undo(opts, () => Object.assign(p, prev));
      }
      return { modifiedCount: p ? 1 : 0 };
    },
    async findOneAndUpdate(q, u, opts) {
      const p = state.payouts.get(String(q._id));
      if (!p) return null;
      if (q.status && q.status.$in && !q.status.$in.includes(p.status)) return null;
      if (typeof q.status === 'string' && p.status !== q.status) return null;
      const prev = { ...p };
      Object.assign(p, u.$set);
      undo(opts, () => Object.assign(p, prev));
      return { ...p };
    },
  };

  const Ledger = {
    async insertOne(doc, opts) {
      const entry = { ...doc };
      state.ledger.push(entry);
      undo(opts, () => state.ledger.splice(state.ledger.indexOf(entry), 1));
      return { insertedId: state.ledger.length };
    },
  };

  const Users = {
    async findOne(q) {
      const u = state.users.get(String(q._id));
      return u ? { ...u } : null;
    },
  };

  return { state, db: { Users, Wallets, Payouts, Ledger, DailyWithdrawals: Daily, session } };
}

function seed({ balance = 500000, users = ['u1'] } = {}) {
  const env = makeDb();
  for (const id of users) {
    env.state.users.set(id, { _id: id, bankAccount: { account: `acct_${id}` } });
    env.state.wallets.set(id, { userId: id, balance });
  }
  return env;
}

function reqRes(user = { id: 'u1' }, body = {}, headers = {}, now = null) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const req = {
    user, body, db: null, log: { error: () => {} }, query: {},
    get: (k) => lower[k.toLowerCase()],
    now: now ? () => new Date(now) : undefined,
  };
  const res = {
    statusCode: 200, payload: null,
    status(c) { this.statusCode = c; return this; },
    json(p) { this.payload = p; return this; },
  };
  return { req, res };
}

async function call(env, body, { user = { id: 'u1' }, headers = {}, now = null } = {}) {
  const { req, res } = reqRes(user, body, headers, now);
  req.db = env.db;
  await withdraw(req, res);
  return res;
}

const dayTotal = (env, id, day) => {
  const d = env.state.daily.get(`${id}|${day}`);
  return d ? d.totalMinor : 0;
};

// ───────────────────────── existing money-safety tests ─────────────────────────

test('parseAmountMinor rejects junk', () => {
  assert.equal(parseAmountMinor(5000), 5000);
  assert.equal(parseAmountMinor(-5), null);
  assert.equal(parseAmountMinor(0), null);
  assert.equal(parseAmountMinor(1.5), null);
  assert.equal(parseAmountMinor('5000'), null);
  assert.equal(parseAmountMinor(NaN), null);
  assert.equal(parseAmountMinor(Number.MAX_SAFE_INTEGER + 1), null);
});

test('insufficient balance → 400, no payout, no ledger, NO quota consumed', async () => {
  const env = seed({ balance: 100 });
  const res = await call(env, { amount: 50000 });
  assert.equal(res.statusCode, 400);
  assert.equal(env.state.payouts.size, 0);
  assert.equal(env.state.wallets.get('u1').balance, 100);
  assert.equal(env.state.ledger.length, 0);
  assert.equal(env.state.daily.size, 0); // reservation rolled back with the txn
});

test('concurrent identical withdrawals cannot double-spend', async () => {
  const env = seed({ balance: 60000 });
  const results = await Promise.all([0, 1, 2].map(() => call(env, { amount: 50000 })));
  const codes = results.map((r) => r.statusCode);
  assert.equal(codes.filter((s) => s === 202).length, 1);
  assert.equal(codes.filter((s) => s === 400).length, 2);
  assert.equal(env.state.wallets.get('u1').balance, 10000);
  assert.equal(env.state.payouts.size, 1);
  assert.equal(dayTotal(env, 'u1', istDay(new Date())), 50000); // failures left no quota behind
});

test('idempotent replay returns same payout, no second debit, no second quota', async () => {
  const env = seed({ balance: 100000 });
  const headers = { 'Idempotency-Key': 'key-abc' };
  const r1 = await call(env, { amount: 40000 }, { headers });
  assert.equal(r1.statusCode, 202);
  const r2 = await call(env, { amount: 40000 }, { headers });
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.payload.payoutId, r1.payload.payoutId);
  assert.equal(r2.payload.replayed, true);
  assert.equal(env.state.wallets.get('u1').balance, 60000);
  assert.equal(dayTotal(env, 'u1', istDay(new Date())), 40000);
});

test('replay of an already-counted withdrawal still works when the day is full', async () => {
  const env = seed();
  const headers = { 'Idempotency-Key': 'full-day' };
  const r1 = await call(env, { amount: DAILY_LIMIT_MINOR }, { headers });
  assert.equal(r1.statusCode, 202);
  const r2 = await call(env, { amount: DAILY_LIMIT_MINOR }, { headers });
  assert.equal(r2.statusCode, 200); // replay, not 422
  assert.equal(r2.payload.replayed, true);
});

test('userId comes from auth, not body', async () => {
  const env = seed({ balance: 100000, users: ['u1', 'u2'] });
  const res = await call(env, { amount: 10000, userId: 'u2' });
  assert.equal(res.statusCode, 202);
  assert.equal(env.state.payouts.get(res.payload.payoutId).userId, 'u1');
});

test('unauthenticated → 401; negative amount cannot credit wallet', async () => {
  const env = seed({ balance: 1000 });
  assert.equal((await call(env, { amount: 1000 }, { user: null })).statusCode, 401);
  assert.equal((await call(env, { amount: -500000 })).statusCode, 400);
  assert.equal(env.state.wallets.get('u1').balance, 1000);
});

test('payout intent snapshots bank account; ledger has real post-debit balance', async () => {
  const env = seed({ balance: 100000 });
  const res = await call(env, { amount: 25000 });
  const p = env.state.payouts.get(res.payload.payoutId);
  assert.equal(p.status, 'pending');
  assert.equal(p.gatewayReference, `wd_${p._id}`);
  assert.equal(p.destinationAccount.account, 'acct_u1');
  assert.equal(env.state.ledger.at(-1).balanceAfterMinor, 75000);
});

// ───────────────────────── daily limit tests ─────────────────────────

test('limit is ₹2,000 = 200000 minor', () => {
  assert.equal(DAILY_LIMIT_MINOR, 200000);
});

test('exactly the limit is allowed; one more minimum unit is rejected', async () => {
  const env = seed();
  assert.equal((await call(env, { amount: 120000 })).statusCode, 202);
  assert.equal((await call(env, { amount: 80000 })).statusCode, 202); // total == 200000
  const over = await call(env, { amount: 100 });
  assert.equal(over.statusCode, 422);
  assert.equal(over.payload.code, 'DAILY_LIMIT_EXCEEDED');
  assert.equal(over.payload.remainingMinor, 0);
  assert.equal(env.state.wallets.get('u1').balance, 300000);
});

test('single request above the limit is rejected without creating a counter', async () => {
  const env = seed();
  const res = await call(env, { amount: 250000 });
  assert.equal(res.statusCode, 422);
  assert.equal(env.state.daily.size, 0);
  assert.equal(env.state.payouts.size, 0);
});

test('CONCURRENT: 5 × ₹500 in parallel → exactly 4 succeed', async () => {
  const env = seed({ balance: 500000 });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => call(env, { amount: 50000 })));
  const codes = results.map((r) => r.statusCode);
  assert.equal(codes.filter((c) => c === 202).length, 4);
  assert.equal(codes.filter((c) => c === 422).length, 1);
  assert.equal(dayTotal(env, 'u1', istDay(new Date())), 200000);
  assert.equal(env.state.wallets.get('u1').balance, 300000);
  assert.equal(env.state.payouts.size, 4);
});

test('CONCURRENT: 3 × ₹900 in parallel → 2 succeed (1800), third would make 2700', async () => {
  const env = seed({ balance: 500000 });
  const results = await Promise.all([1, 2, 3].map(() => call(env, { amount: 90000 })));
  assert.equal(results.filter((r) => r.statusCode === 202).length, 2);
  assert.equal(dayTotal(env, 'u1', istDay(new Date())), 180000);
});

test('CONCURRENT first-of-day race: only one upsert-insert wins, total never exceeds cap', async () => {
  const env = seed({ balance: 5_000_000 });
  const results = await Promise.all(
    Array.from({ length: 20 }, () => call(env, { amount: 150000 }))
  );
  assert.equal(results.filter((r) => r.statusCode === 202).length, 1);
  assert.ok(dayTotal(env, 'u1', istDay(new Date())) <= DAILY_LIMIT_MINOR);
});

test('limit is per user — one user hitting the cap does not affect another', async () => {
  const env = seed({ users: ['u1', 'u2'] });
  assert.equal((await call(env, { amount: 200000 })).statusCode, 202);
  assert.equal((await call(env, { amount: 100 })).statusCode, 422);
  assert.equal((await call(env, { amount: 200000 }, { user: { id: 'u2' } })).statusCode, 202);
});

test('IST day boundary: 23:59:59 IST and 00:00:00 IST are different days (not UTC midnight)', async () => {
  assert.equal(istDay(new Date('2026-11-27T18:29:59Z')), '2026-11-27');
  assert.equal(istDay(new Date('2026-11-27T18:30:00Z')), '2026-11-28');
  // UTC midnight is NOT the boundary: 00:00Z is already 05:30 IST on the same IST date.
  assert.equal(istDay(new Date('2026-11-27T00:00:00Z')), '2026-11-27');
  assert.equal(istDay(new Date('2026-11-27T23:00:00Z')), '2026-11-28');

  const env = seed();
  const before = '2026-11-27T18:29:59Z';
  const after = '2026-11-27T18:30:00Z';
  assert.equal((await call(env, { amount: 200000 }, { now: before })).statusCode, 202);
  const blocked = await call(env, { amount: 100 }, { now: before });
  assert.equal(blocked.statusCode, 422);
  assert.equal(blocked.payload.resetsAt, '2026-11-27T18:30:00.000Z');
  assert.equal((await call(env, { amount: 100000 }, { now: after })).statusCode, 202);
});

test('a reversed (gateway-failed) payout returns its quota to the day it was booked against', async () => {
  const env = seed();
  const day1 = '2026-11-27T10:00:00Z';
  const res = await call(env, { amount: 150000 }, { now: day1 });
  assert.equal(res.statusCode, 202);
  assert.equal((await call(env, { amount: 100000 }, { now: day1 })).statusCode, 422);

  await reversePayout(res.payload.payoutId, { ...env.db });
  assert.equal(env.state.wallets.get('u1').balance, 500000);
  assert.equal(dayTotal(env, 'u1', '2026-11-27'), 0);
  assert.equal((await call(env, { amount: 200000 }, { now: day1 })).statusCode, 202);
});

test('reversal is idempotent: a second reverse does not refund quota twice', async () => {
  const env = seed();
  const res = await call(env, { amount: 100000 });
  await reversePayout(res.payload.payoutId, { ...env.db });
  await reversePayout(res.payload.payoutId, { ...env.db });
  assert.equal(dayTotal(env, 'u1', istDay(new Date())), 0);
  assert.equal(env.state.wallets.get('u1').balance, 500000);
});