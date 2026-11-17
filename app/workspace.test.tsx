import { expect, open, test } from "nsh/test";

const pairingPrompt = "Pair another device to start sending.";

test("a lone device prompts pairing before composing and cannot send", async () => {
  const app = await open("./tests/workspace.tsx", { height: 1600 });
  expect(app.shows(pairingPrompt)).toBe(true);
  expect(app.shows("text:https://my-relay.example.test/powerbin/")).toBe(true);
  expect(app.shows("Pairing code")).toBe(true);
  expect(app.enabled("Copy pairing URL")).toBe(true);
  expect(app.enabled("Find device")).toBe(true);
  expect(app.enabled("text:Send")).toBe(false);
  await expect(app.press("text:Send")).rejects.toMatchObject({ code: "ERR_NSH_TEST_DISABLED" });
  expect(app.enabled("Save for later")).toBe(true);
  expect(app.enabled("Create one-time link")).toBe(true);
  expect(app.texts().indexOf(pairingPrompt)).toBeLessThan(app.texts().indexOf("Send"));

  await app.press("Clear synced devices");
  expect(app.shows(pairingPrompt)).toBe(true);
  expect(app.enabled("text:Send")).toBe(false);
});

test("trusted peers enable sending and losing the last peer restores pairing without clearing the draft", async () => {
  const app = await open("./tests/workspace.tsx", { height: 1600 });
  await app.press("Prepare draft");
  expect(app.value("label:Snippet")).toBe("Keep this draft while pairing");
  await app.press("Add trusted peer");
  expect(app.shows(pairingPrompt)).toBe(false);
  expect(app.shows("My phone")).toBe(true);
  expect(app.enabled("text:Send")).toBe(true);
  expect(app.value("label:Snippet")).toBe("Keep this draft while pairing");

  await app.press("Remove trusted peer");
  expect(app.shows(pairingPrompt)).toBe(true);
  expect(app.enabled("text:Send")).toBe(false);
  expect(app.value("label:Snippet")).toBe("Keep this draft while pairing");
});

test("pairing begun from Send can be verified in place", async () => {
  const app = await open("./tests/workspace.tsx", { height: 1600 });
  await app.press("Show pairing confirmation");
  expect(app.shows("ABCDE-12345")).toBe(true);
  expect(app.shows("Compare this entire fingerprint with My phone before pairing.")).toBe(true);
  expect(app.shows("01234567 89ABCDEF")).toBe(true);
  expect(app.shows("Fingerprints match · Pair")).toBe(true);
  expect(app.shows("Find device")).toBe(false);
  expect(app.enabled("text:Send")).toBe(false);
});

test("an unavailable web address does not offer an empty pairing link", async () => {
  const app = await open("./tests/workspace.tsx", { height: 1600 });
  await app.press("Clear web address");
  expect(app.shows(pairingPrompt)).toBe(true);
  expect(app.shows("Copy pairing URL")).toBe(false);
  expect(app.shows("text:https://my-relay.example.test/powerbin/")).toBe(false);
  expect(app.enabled("Find device")).toBe(true);
});

test("the Devices tab offers the same site URL for adding further devices", async () => {
  const app = await open("./tests/workspace.tsx", { height: 1600 });
  await app.press("Add trusted peer");
  await app.press("Show devices");
  expect(app.shows("Trusted devices.")).toBe(true);
  expect(app.shows("text:https://my-relay.example.test/powerbin/")).toBe(true);
  expect(app.enabled("Copy pairing URL")).toBe(true);
  expect(app.enabled("Find device")).toBe(true);
});
