// POST /api/wallet/withdraw — rewritten handler.

'use strict';

const MAX_WITHDRAW_MINOR = 10_000_000_00;
const MIN_WITHDRAW_MINOR = 100;

const DAILY_LIMIT_MINOR = 2_000_00;
const IST_OFFSET_MS = 330 * 60 * 1000;

function istDay(date) {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istDayEnd(day) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000 - IST_OFFSET_MS);
}

function dailyLimitError() {
  const err = new Error('daily withdrawal limit exceeded');
  err.code = 'DAILY_LIMIT';
  return err;
}


async function reserveDailyQuota(Daily, { userId, day, amountMinor, session }) {
  let doc;
  try {
    doc = await Daily.findOneAndUpdate(
      { userId, day, totalMinor: { $lte: DAILY_LIMIT_MINOR - amountMinor } },
      {
        $inc: { totalMinor: amountMinor },
        $setOnInsert: { expireAt: new Date(istDayEnd(day).getTime() + 3 * 86_400_000) },
      },
      { upsert: true, returnDocument: 'after', session }
    );
  } catch (e) {
    if (e.code === 11000) throw dailyLimitError();
    throw e;
  }
  if (!doc) throw dailyLimitError();
  return doc;
}

function parseAmountMinor(raw) {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) return null;
  if (raw < MIN_WITHDRAW_MINOR || raw > MAX_WITHDRAW_MINOR) return null;
  return raw;
}

async function withdraw(req, res) {
  const userId = req.user && req.user.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const amountMinor = parseAmountMinor(req.body && req.body.amount);
  if (amountMinor === null) {
    return res.status(400).json({ error: 'invalid amount' });
  }

  const idempotencyKey = req.get('Idempotency-Key') || null;
  const { Users, Wallets, Payouts, Ledger, DailyWithdrawals, session } = req.db;

  const day = istDay(req.now ? req.now() : new Date());
  const limitResponse = async () => {
    const used = await DailyWithdrawals.findOne({ userId, day });
    const usedMinor = used ? used.totalMinor : 0;

    return res.status(422).json({
      error: 'daily withdrawal limit exceeded',
      code: 'DAILY_LIMIT_EXCEEDED',
      limitMinor: DAILY_LIMIT_MINOR,
      remainingMinor: Math.max(0, DAILY_LIMIT_MINOR - usedMinor),
      resetsAt: istDayEnd(day).toISOString(),
    });
  };

  if (amountMinor > DAILY_LIMIT_MINOR) return limitResponse();

  if (idempotencyKey) {
    const existing = await Payouts.findOne({ idempotencyKey });
    if (existing) {
      return res.status(200).json({
        ok: true,
        payoutId: existing._id,
        status: existing.status,
        replayed: true,
      });
    }
  }

  const user = await Users.findOne({ _id: userId }, { projection: { bankAccount: 1 } });
  if (!user || !user.bankAccount) {
    return res.status(404).json({ error: 'user not found' });
  }

  const sessionClient = session(); 
  let payout;
  try {
    payout = await sessionClient.withTransaction(async () => {
      await reserveDailyQuota(DailyWithdrawals, {
        userId, day, amountMinor, session: sessionClient,
      });

      const debited = await Wallets.findOneAndUpdate(
        { userId, balance: { $gte: amountMinor } },
        { $inc: { balance: -amountMinor } },
        { returnDocument: 'after', session: sessionClient }
      );
      if (!debited) {
        const err = new Error('insufficient balance');
        err.code = 'INSUFFICIENT';
        throw err;
      }

      const doc = {
        userId,
        amountMinor,
        currency: 'INR',
        destinationAccount: user.bankAccount,
        idempotencyKey,
        limitDay: day, // which IST day's quota this payout consumed (for reversal)
        gatewayReference: null,
        status: 'pending',
        balanceAfterMinor: debited.balance,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const inserted = await Payouts.insertOne(doc, { session: sessionClient });
      doc._id = inserted.insertedId;

      await Payouts.updateOne(
        { _id: doc._id },
        { $set: { gatewayReference: `wd_${doc._id}` } },
        { session: sessionClient }
      );

      await Ledger.insertOne({
        userId,
        payoutId: doc._id,
        type: 'withdrawal_pending',
        amountMinor,
        balanceAfterMinor: debited.balance,
        createdAt: new Date(),
      }, { session: sessionClient });

      return doc;
    });
  } catch (e) {
    if (e.code === 'DAILY_LIMIT') {
      return limitResponse();
    }
    if (e.code === 'INSUFFICIENT') {
      return res.status(400).json({ error: 'insufficient balance' });
    }
    if (e.code === 11000) {
      const winner = await Payouts.findOne({ idempotencyKey });
      if (winner) {
        return res.status(200).json({
          ok: true, payoutId: winner._id, status: winner.status, replayed: true,
        });
      }
    }
    req.log.error({ err: e, userId }, 'withdraw transaction failed');
    return res.status(500).json({ error: 'withdrawal failed' });
  }

  await enqueuePayoutSubmission(payout._id, req.db); // PSEUDO: outbox/queue

  return res.status(202).json({
    ok: true,
    payoutId: payout._id,
    status: 'pending',
  });
}


async function enqueuePayoutSubmission(payoutId, db) {
  if (db && db.Outbox) {
    await db.Outbox.insertOne({
      payoutId,
      type: 'submit_payout',
      createdAt: new Date(),
    });
  }
}

async function submitPayoutToGateway(payoutId, deps) {
  const { Payouts, Ledger, gateway } = deps;

  const claimed = await Payouts.findOneAndUpdate(
    { _id: payoutId, status: 'pending' },
    { $set: { status: 'submitted', updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (!claimed) return;

  try {
    const result = await gateway.createPayout({
      account: claimed.destinationAccount,
      amountMinor: claimed.amountMinor,
      currency: claimed.currency,
      reference: claimed.gatewayReference, 
      idempotencyKey: claimed.gatewayReference,
    });

    await Payouts.updateOne(
      { _id: payoutId },
      { $set: { status: 'succeeded', gatewayPayoutId: result.id, updatedAt: new Date() } }
    );

    await Ledger.insertOne({
      userId: claimed.userId,
      payoutId: claimed._id,
      type: 'withdrawal',
      amountMinor: claimed.amountMinor,
      gatewayPayoutId: result.id,
      createdAt: new Date(),
    });
  } catch (e) {
    deps.log && deps.log.error({ err: e.message, payoutId }, 'gateway submission failed');

    if (isRetriable(e)) {
      await Payouts.updateOne(
        { _id: payoutId },
        { $set: { status: 'pending', updatedAt: new Date(), lastError: String(e) } }
      );
      throw e;
    }

    await reversePayout(payoutId, deps);
  }
}

async function reversePayout(payoutId, deps) {
  const { Payouts, Wallets, Ledger, DailyWithdrawals, session } = deps;
  const s = session();
  await s.withTransaction(async () => {
    const p = await Payouts.findOneAndUpdate(
      { _id: payoutId, status: { $in: ['pending', 'submitted'] } },
      { $set: { status: 'failed', updatedAt: new Date() } },
      { returnDocument: 'after', session: s }
    );
    if (!p) return;

    await Wallets.updateOne(
      { userId: p.userId },
      { $inc: { balance: p.amountMinor } },
      { session: s }
    );

    if (p.limitDay) {
      await DailyWithdrawals.updateOne(
        { userId: p.userId, day: p.limitDay },
        { $inc: { totalMinor: -p.amountMinor } },
        { session: s }
      );
    }

    await Ledger.insertOne({
      userId: p.userId,
      payoutId: p._id,
      type: 'withdrawal_reversal',
      amountMinor: p.amountMinor,
      reason: 'gateway_rejected',
      createdAt: new Date(),
    }, { session: s });
  });
}

// GET /api/wallet/history — paginated. Needs Ledger index { userId: 1, createdAt: -1 }.
async function walletHistory(req, res) {
  const userId = req.user && req.user.id;
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });

  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  const cursor = req.query.cursor || null;

  const filter = { userId };
  if (cursor) filter.createdAt = { $lt: new Date(cursor) };

  const history = await req.db.Ledger.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .toArray();

  const page = history.slice(0, limit);
  const nextCursor = history.length > limit ? page[page.length - 1].createdAt : null;

  return res.json({ history: page, nextCursor });
}

function isRetriable(e) {
  return !e.status || e.status >= 500 || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
}

module.exports = {
  withdraw,
  submitPayoutToGateway,
  reversePayout,
  walletHistory,
  parseAmountMinor,
  istDay,
  istDayEnd,
  DAILY_LIMIT_MINOR,
};

