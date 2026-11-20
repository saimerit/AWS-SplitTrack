import test from "node:test";
import assert from "node:assert/strict";
import { SplitTrackService } from "../src/core/service.js";
import { MemoryRepository } from "./support/memoryRepository.js";

const alice = { uid: "brandAlice", name: "Brand Alice", email: "brand-alice@example.invalid" };
const bob = { uid: "brandBob", name: "Brand Bob", email: "brand-bob@example.invalid" };
let sequence = 0;
const request = () => `receiving_brand_${++sequence}`;
const receivingFields = profile => Object.fromEntries(
  ["upiId", "paymentName", "receivingProvider", "receivingBankBrand"].map(key => [key, profile[key]]),
);
const gpay = { title: "Alice GPay HDFC", kind: "upi", provider: "gpay", bankBrand: "hdfc", upiId: "alice@okhdfcbank", isDefault: true };

async function setup() {
  const repo = new MemoryRepository(), app = new SplitTrackService(repo);
  for (const user of [alice, bob]) {
    await app.bootstrap(user);
    await app.updateProfile(user, request(), { displayName: user.name, username: `brand_${user.uid.toLowerCase()}` });
  }
  await app.saveEntity(alice, request(), "accounts", "gpay-hdfc", gpay);
  await app.saveEntity(bob, request(), "friends", alice.uid, { userId: alice.uid });
  return { repo, app };
}

test("own and linked receiver snapshots retain the same payment identity and app branding", async () => {
  const { app } = await setup();
  const own = await app.profile(alice);
  const ownState = await app.snapshot(alice.uid);
  const peerState = await app.snapshot(bob.uid);
  const expected = { upiId: gpay.upiId, paymentName: gpay.title, receivingProvider: "gpay", receivingBankBrand: "hdfc" };
  assert.deepEqual(receivingFields(own), expected);
  assert.deepEqual(receivingFields(ownState.profile), expected);
  assert.deepEqual(receivingFields(peerState.friends.find(friend => friend.id === alice.uid)), expected);
  assert.equal(peerState.accounts.length, 0, "linked members never receive another user's account list");
});

test("selecting a card retains UPI branding and changing a receiver updates both snapshot views", async () => {
  const { app } = await setup();
  await app.saveEntity(alice, request(), "accounts", "credit-card", { title: "Private Card", kind: "credit", provider: "bank", bankBrand: "icici", cardNumber: "•••• 1234", isDefault: true });
  assert.equal((await app.profile(alice)).receivingProvider, "gpay");
  assert.equal((await app.profile(alice)).upiId, gpay.upiId);
  const update = { title: "Alice PhonePe", provider: "phonepe", bankBrand: "", upiId: "alice@ibl" };
  await app.saveEntity(alice, request(), "accounts", "gpay-hdfc", update);
  const own = receivingFields(await app.profile(alice));
  assert.deepEqual(own, { upiId: "alice@ibl", paymentName: "Alice PhonePe", receivingProvider: "phonepe", receivingBankBrand: undefined });
  assert.deepEqual(receivingFields((await app.snapshot(bob.uid)).friends[0]), own);
});

test("a receiver converted to a card falls back to UPI and removal clears stale branding", async () => {
  const { app, repo } = await setup();
  await app.saveEntity(alice, request(), "accounts", "bank-upi", { title: "Alice Bank", kind: "upi", provider: "bank", bankBrand: "icici", upiId: "alice@icici" });
  await app.saveEntity(alice, request(), "accounts", "gpay-hdfc", { kind: "credit", cardNumber: "•••• 1234", upiId: "" });
  assert.deepEqual(receivingFields(await app.profile(alice)), { upiId: "alice@icici", paymentName: "Alice Bank", receivingProvider: "bank", receivingBankBrand: "icici" });
  await app.deleteEntity(alice, request(), "accounts", "bank-upi");
  const cleared = { upiId: undefined, paymentName: undefined, receivingProvider: undefined, receivingBankBrand: undefined };
  assert.deepEqual(receivingFields(await app.profile(alice)), cleared);
  assert.deepEqual(receivingFields((await app.snapshot(bob.uid)).friends[0]), cleared);
  const stored = await repo.get("data", { userId: `USER#${alice.uid}`, recordId: "PROFILE" });
  for (const key of Object.keys(cleared)) assert.equal(stored[key], "");
  assert.equal((await app.snapshot(alice.uid)).settings.receivingAccountId, "");
});

test("search remains private even for linked members with a published receiver", async () => {
  const { app } = await setup();
  for (const query of ["@brand_brandalice", "Brand Alice"]) {
    const results = await app.search(query, bob.uid);
    assert.ok(results.some(profile => profile.id === alice.uid));
    for (const profile of results) {
      for (const key of ["upiId", "paymentName", "receivingProvider", "receivingBankBrand", "accounts", "email", "cardNumber"])
        assert.equal(profile[key], undefined, `${key} must stay out of public search`);
    }
  }
});
