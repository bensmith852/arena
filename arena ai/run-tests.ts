// @ts-nocheck
import { memoryStore } from "@/lib/store/memoryStore";
import { removeUndefined } from "@/lib/store/persistence";
import { priceStore } from "@/lib/market/priceStore";
import { triggerManualTrade, runBotTick } from "@/lib/engine/bot";
import { buildArenaState } from "@/lib/state";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, message: string) {
  if (condition) {
    passed++;
    console.log(`✅ ${name}`);
  } else {
    failed++;
    console.error(`❌ ${name}: ${message}`);
  }
}

function clearStore() {
  (memoryStore as any).users.clear();
  (memoryStore as any).usersByEmail.clear();
  (memoryStore as any).pendingCodes.clear();
  (memoryStore as any).sessions.clear();
  (memoryStore as any).adminSessions.clear();
  (memoryStore as any).accounts.clear();
  (memoryStore as any).positions.clear();
  (memoryStore as any).trades = [];
  (memoryStore as any).events = [];
  (memoryStore as any).botSettingsByAccount.clear();
  (memoryStore as any).walletAddresses.clear();
  (memoryStore as any).transactions.clear();

  (priceStore as any).state.clear();
  (priceStore as any).symbols.clear();
}

async function makeUser(balance = 100_000) {
  const ts = Date.now();
  const created = memoryStore.createUser(`test+${ts}@arena.com`, "1234567890");
  if (!created.ok) throw new Error("createUser failed");
  const account = memoryStore.getOrCreateAccount(created.user.id);
  account.balance = balance;
  const settings = memoryStore.getOrCreateBotSettings(created.user.id);
  settings.maxOpenPositions = 0; // tests drive opening manually
  settings.nextTradeFinalBalance = 105_000;
  settings.tradeDurationMs = 60_000;
  memoryStore.addToken(created.user.id, 0);
  return created.user;
}

function seed(symbol: string, price: number, historyLen = 30) {
  (priceStore as any).symbols.add(symbol);
  (priceStore as any).state.set(symbol, {
    symbol,
    price,
    prevPrice: price,
    history: Array.from({ length: historyLen }, (_, index) => price * (0.99 + (0.01 * index) / Math.max(1, historyLen - 1))),
    candles: [],
    updatedAt: Date.now(),
  });
}

async function main() {
  console.log("\n🧪 Running Arena tests\n");

  // --- 1. Admin target final balance ---
  clearStore();
  {
    const user = await makeUser(100_000);
    const settings = memoryStore.getOrCreateBotSettings(user.id);
    settings.enabledSymbols = "BTCUSDT";
    settings.nextTradeFinalBalance = 105_000;
    settings.tradeDurationMs = 2_000;

    seed("BTCUSDT", 64_000);
    const result = await triggerManualTrade(user.id, "BTCUSDT");
    assert(
      "admin target: trade opens",
      result.opened,
      result.reason ?? "unknown"
    );

    const position = memoryStore.listOpenPositions(user.id)[0];
    assert(
      "admin target: position.targetFinalBalance is captured",
      position && position.targetFinalBalance === 105_000,
      `got ${position?.targetFinalBalance}`
    );
    assert(
      "admin target: position.tradeDurationMs is captured",
      position && position.tradeDurationMs === 2_000,
      `got ${position?.tradeDurationMs}`
    );
    assert(
      "admin target: bot settings consumed",
      memoryStore.getOrCreateBotSettings(user.id).nextTradeFinalBalance === 0,
      "nextTradeFinalBalance not reset"
    );

    const account = memoryStore.getOrCreateAccount(user.id);
    const margin = position.margin;
    const clampedTarget = Math.max(
      account.balance,
      Math.min(account.balance + margin * 10, position.targetFinalBalance)
    );
    const fixedPnl = clampedTarget - account.balance - margin;
    const settle = memoryStore.settlePositionWithPnl(
      position.id,
      fixedPnl,
      64_000
    );
    assert("admin target: settle succeeds", settle.ok, settle.error ?? "");
    assert(
      "admin target: final balance matches admin target",
      memoryStore.getOrCreateAccount(user.id).balance === 105_000,
      `got ${memoryStore.getOrCreateAccount(user.id).balance}`
    );
    assert(
      "admin target: PnL is correct",
      settle.pnl === 5_000,
      `got ${settle.pnl}`
    );
  }

  // --- 2. Admin target: bot ignores TP/SL, only settles at duration ---
  clearStore();
  {
    const user = await makeUser(100_000);
    const settings = memoryStore.getOrCreateBotSettings(user.id);
    settings.enabledSymbols = "BTCUSDT";

    seed("BTCUSDT", 64_000);
    const result = await triggerManualTrade(user.id, "BTCUSDT");
    assert("bot target: trade opens", result.opened, result.reason ?? "");

    const position = memoryStore.listOpenPositions(user.id)[0];

    // Move price past take-profit — the bot must NOT close it
    const tpPrice =
      position.side === "LONG"
        ? position.takeProfitPrice + 1
        : position.takeProfitPrice - 1;
    seed("BTCUSDT", tpPrice, 30);
    await runBotTick();

    const stillOpen = memoryStore.listOpenPositions(user.id).length === 1;
    const trades = memoryStore.trades.filter((t) => t.accountId === user.id);
    assert(
      "bot target: bot does not TP-close an admin-target trade",
      stillOpen && trades.length === 0,
      "position was closed by TP/SL"
    );
  }

  // --- 3. Admin target: bot ignores liquidation price ---
  clearStore();
  {
    const user = await makeUser(100_000);
    const settings = memoryStore.getOrCreateBotSettings(user.id);
    settings.enabledSymbols = "BTCUSDT";

    seed("BTCUSDT", 64_000);
    const result = await triggerManualTrade(user.id, "BTCUSDT");
    assert("bot target liq: trade opens", result.opened, result.reason ?? "");

    const position = memoryStore.listOpenPositions(user.id)[0];
    const before = memoryStore.getOrCreateAccount(user.id).balance;

    const hitPrice =
      position.side === "LONG"
        ? position.liquidationPrice - 1
        : position.liquidationPrice + 1;
    seed("BTCUSDT", hitPrice, 30);
    await runBotTick();

    const trades = memoryStore.trades.filter((t) => t.accountId === user.id);
    assert(
      "bot target liq: bot does not liquidate an admin-target trade",
      memoryStore.listOpenPositions(user.id).length === 1 && trades.length === 0,
      `closeReason was ${trades[0]?.closeReason}`
    );
    assert(
      "bot target liq: balance unchanged",
      memoryStore.getOrCreateAccount(user.id).balance === before,
      `got ${memoryStore.getOrCreateAccount(user.id).balance}`
    );
  }

  // --- 4. Admin target too high (clamp) ---
  clearStore();
  {
    const user = await makeUser(100_000);
    const account = memoryStore.getOrCreateAccount(user.id);
    const settings = memoryStore.getOrCreateBotSettings(user.id);
    settings.enabledSymbols = "BTCUSDT";
    settings.nextTradeFinalBalance = 1_000_000;

    seed("BTCUSDT", 64_000);
    const result = await triggerManualTrade(user.id, "BTCUSDT");
    assert("clamp high: trade opens", result.opened, result.reason ?? "");

    const position = memoryStore.listOpenPositions(user.id)[0];
    const fixedPnl = position.targetFinalBalance - account.balance - position.margin;
    const settle = memoryStore.settlePositionWithPnl(
      position.id,
      fixedPnl,
      64_000
    );
    assert("high target: settle succeeds", settle.ok, settle.error ?? "");
    assert(
      "high target: final balance reaches exact admin target",
      memoryStore.getOrCreateAccount(user.id).balance === position.targetFinalBalance,
      `got ${memoryStore.getOrCreateAccount(user.id).balance}, expected ${position.targetFinalBalance}`
    );
  }

  // --- 5. Admin target very low (large loss) ---
  clearStore();
  {
    const user = await makeUser(100_000);
    const account = memoryStore.getOrCreateAccount(user.id);
    const settings = memoryStore.getOrCreateBotSettings(user.id);
    settings.enabledSymbols = "BTCUSDT";
    settings.nextTradeFinalBalance = 1_000;

    seed("BTCUSDT", 64_000);
    const result = await triggerManualTrade(user.id, "BTCUSDT");
    assert("low target: trade opens", result.opened, result.reason ?? "");

    const position = memoryStore.listOpenPositions(user.id)[0];
    const fixedPnl = position.targetFinalBalance - account.balance - position.margin;
    const settle = memoryStore.settlePositionWithPnl(
      position.id,
      fixedPnl,
      64_000
    );
    assert("low target: settle succeeds", settle.ok, settle.error ?? "");
    assert(
      "low target: final balance reaches exact admin target",
      memoryStore.getOrCreateAccount(user.id).balance === position.targetFinalBalance,
      `got ${memoryStore.getOrCreateAccount(user.id).balance}, expected ${position.targetFinalBalance}`
    );
    assert(
      "low target: PnL reflects full target loss",
      settle.pnl === position.targetFinalBalance - 100_000,
      `got ${settle.pnl}`
    );
  }

  // --- 6. Only one trade at a time ---
  clearStore();
  {
    const user = await makeUser(100_000);
    const settings = memoryStore.getOrCreateBotSettings(user.id);
    settings.enabledSymbols = "BTCUSDT";

    seed("BTCUSDT", 64_000);
    const first = await triggerManualTrade(user.id, "BTCUSDT");
    const second = await triggerManualTrade(user.id, "BTCUSDT");
    assert("one-at-a-time: first opens", first.opened, first.reason ?? "");
    assert(
      "one-at-a-time: second rejected",
      !second.opened,
      "second trade should not open"
    );
  }

  // --- 7. Auth: request + verify code ---
  clearStore();
  {
    const user = await makeUser();
    const code = memoryStore.requestLoginCode(user.email);
    const bad = memoryStore.verifyLoginCode(user.email, "0000");
    const good = memoryStore.verifyLoginCode(user.email, code);
    assert(
      "auth: wrong code rejected",
      !bad.ok,
      "wrong code was accepted"
    );
    assert("auth: phone code accepted", good.ok, good.error ?? "");

    const signupEmail = `signup+${Date.now()}@arena.com`;
    const signupCode = memoryStore.requestLoginCode(signupEmail, "Arena", "Trader");
    const signup = memoryStore.verifyLoginCode(signupEmail, signupCode);
    assert("auth: new user requires KYC", signup.ok && signup.user.kycStatus === "required", signup.ok ? signup.user.kycStatus : signup.error);
    if (signup.ok) {
      const submitted = memoryStore.submitKyc(signup.user.id, "Arena", "Trader", "+1234567890");
      assert("kyc: submission starts verification", submitted.ok && signup.user.kycStatus === "verifying", submitted.ok ? signup.user.kycStatus : submitted.error);
      signup.user.kycVerificationEndsAt = Date.now() - 1;
      assert("kyc: completed timer verifies user", memoryStore.getKycStatus(signup.user) === "verified", signup.user.kycStatus);
    }
  }

  clearStore();
  {
    const cleaned = removeUndefined({ user: { email: "funded@arena.com", name: undefined }, values: [1, undefined, 2] }) as any;
    assert("persistence: undefined fields are removed", !("name" in cleaned.user) && cleaned.values.length === 2, "undefined value remained in snapshot");
    const email = `invited+${Date.now()}@arena.com`;
    const invalidBalance = memoryStore.createUser(`invalid+${Date.now()}@arena.com`, "", Number.NaN, undefined, undefined, undefined, true);
    assert("admin invite: invalid starting balance is rejected", !invalidBalance.ok, "invalid balance was accepted");
    const invited = memoryStore.createUser(email, "", 45_800, undefined, undefined, undefined, true);
    assert("admin invite: user is created with KYC required", invited.ok && invited.user.kycStatus === "required", invited.ok ? invited.user.kycStatus : invited.error);
    if (invited.ok) {
      memoryStore.addTokens(invited.user.id, 5, 9_160);
      const duplicate = memoryStore.createUser(`  ${email.toUpperCase()}  `, "", 1);
      assert("admin invite: normalized duplicate email is rejected", !duplicate.ok, "duplicate email was accepted");
      const code = memoryStore.requestLoginCode(email);
      const verified = memoryStore.verifyLoginCode(email, code);
      const account = memoryStore.getOrCreateAccount(invited.user.id);
      assert("admin invite: email verification uses existing account", verified.ok && verified.user.id === invited.user.id, verified.ok ? "wrong account" : verified.error);
      assert("admin invite: funding survives first login", account.balance === 45_800 && account.tokens.length === 5 && account.tokens.every((token) => token.unitPrice === 9_160), `balance ${account.balance}, tokens ${account.tokens.length}`);
      assert("admin invite: first login still requires KYC", invited.user.kycStatus === "required", invited.user.kycStatus);
      const settings = memoryStore.getOrCreateBotSettings(invited.user.id);
      settings.enabledSymbols = "BTCUSDT";
      settings.nextTradeFinalBalance = 50_000;
      settings.tradeDurationMs = 60_000;
      const submitted = memoryStore.submitKyc(invited.user.id, "Funded", "Trader", "+1234567890");
      if (submitted.ok) invited.user.kycVerificationEndsAt = Date.now() - 1;
      seed("BTCUSDT", 64_000);
      const trade = await triggerManualTrade(invited.user.id);
      assert("admin invite: verified funded user can open first trade", submitted.ok && memoryStore.getKycStatus(invited.user) === "verified" && trade.opened, trade.reason ?? "trade did not open");
    }
  }

  clearStore();
  {
    const user = await makeUser(1_000);
    const withdrawal = memoryStore.createWithdrawal(user.id, "BTC", "Bitcoin", 400, "bc1qtestaddress");
    assert("wallet: withdrawal starts pending", withdrawal.ok && memoryStore.getPendingWithdrawalTotal(user.id) === 400, withdrawal.ok ? "wrong pending total" : withdrawal.error);
    assert("wallet: pending withdrawal does not deduct balance", memoryStore.getOrCreateAccount(user.id).balance === 1_000, "pending withdrawal changed balance");
    if (withdrawal.ok) {
      const confirmed = memoryStore.confirmWithdrawal(withdrawal.transaction.id);
      assert("wallet: confirmation deducts once", confirmed.ok && memoryStore.getOrCreateAccount(user.id).balance === 600, confirmed.ok ? "wrong confirmed balance" : confirmed.error);
      const duplicate = memoryStore.confirmWithdrawal(withdrawal.transaction.id);
      assert("wallet: duplicate confirmation rejected", !duplicate.ok && memoryStore.getOrCreateAccount(user.id).balance === 600, "duplicate confirmation changed balance");
    }
    const canceledWithdrawal = memoryStore.createWithdrawal(user.id, "ETH", "Ethereum", 200, "0xtestaddress");
    if (canceledWithdrawal.ok) memoryStore.cancelWithdrawal(canceledWithdrawal.transaction.id);
    assert("wallet: cancellation preserves balance", memoryStore.getOrCreateAccount(user.id).balance === 600, "cancellation changed balance");
    const balanceBeforeIssuedDeposit = memoryStore.getOrCreateAccount(user.id).balance;
    const issuedDeposit = memoryStore.recordIssuedDeposit(user.id, 250);
    const issuedTransaction = memoryStore.getTransactions(user.id).find((transaction) => transaction.id === (issuedDeposit.ok ? issuedDeposit.transaction.id : ""));
    assert("wallet: issued deposit is recorded", issuedDeposit.ok && issuedTransaction?.type === "DEPOSIT" && issuedTransaction.crypto === "USD" && issuedTransaction.network === "Arena Account" && issuedTransaction.address === "" && issuedTransaction.status === "CONFIRMED" && issuedTransaction.balanceCredited, "issued deposit transaction is incorrect");
    assert("wallet: issued deposit does not double-credit", memoryStore.getOrCreateAccount(user.id).balance === balanceBeforeIssuedDeposit, "issued deposit changed balance");
  }

  // --- 8. buildArenaState reflects positions and prices ---
  clearStore();
  {
    const user = await makeUser(100_000);
    const settings = memoryStore.getOrCreateBotSettings(user.id);
    settings.enabledSymbols = "BTCUSDT";

    seed("BTCUSDT", 64_000);
    const result = await triggerManualTrade(user.id, "BTCUSDT");
    assert("state: trade opens", result.opened, result.reason ?? "");

    const state = await buildArenaState(user.id);
    assert(
      "state: has 1 open position",
      state.positions.length === 1,
      `got ${state.positions.length}`
    );
    assert(
      "state: BTC price present",
      state.prices["BTCUSDT"]?.price === 64_000,
      `got ${state.prices["BTCUSDT"]?.price}`
    );
    assert(
      "state: account balance matches",
      state.account.balance === memoryStore.getOrCreateAccount(user.id).balance,
      `got ${state.account.balance}`
    );
    assert(
      "state: settings in state",
      state.settings.nextTradeFinalBalance === 0,
      `got ${state.settings.nextTradeFinalBalance}`
    );
  }

  console.log("\n" + (failed === 0 ? "🎉" : "⚠️") + ` ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n💥 Test runner crashed:", err);
  process.exit(1);
});
