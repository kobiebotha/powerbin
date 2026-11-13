import { expect, open, test } from "nsh/test";

test("Rust pushes snapshots and keeps one controller when all clients remount", async () => {
  const app = await open("./tests/bridge.tsx");
  await app.waitFor("Snapshot received");
  await app.press("Change draft");
  await app.waitFor("Main: Retained across remount");
  await app.waitFor("Observer: Retained across remount");
  await app.press("Unmount clients");
  expect(app.shows("Snapshot received")).toBe(false);
  await app.press("Mount clients");
  await app.waitFor("Main: Retained across remount");
  await app.waitFor("Observer: Retained across remount");
});

test("unsubscribe stops one listener while other subscribers still receive Rust changes", async () => {
  const app = await open("./tests/bridge.tsx");
  await app.waitFor("Snapshot received");
  await app.press("Change draft");
  await app.waitFor("Observer: Retained across remount");
  await app.press("Stop observer");
  await app.press("Change again");
  await app.waitFor("Main: Changed after unsubscribe");
  expect(app.shows("Observer: Retained across remount")).toBe(true);
  expect(app.shows("Observer: Changed after unsubscribe")).toBe(false);
});
