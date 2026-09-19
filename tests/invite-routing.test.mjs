import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const inviteHTML = await readFile(new URL("../invite.html", import.meta.url), "utf8");

test("ordinary match invitations keep invitation copy", () => {
  assert.match(inviteHTML, /id="route-title">A friend invited you to play\.<\/h1>/);
  assert.match(inviteHTML, /load this exact game and its rules/);
});

test("reusable package links replace match copy while preserving the exact route", () => {
  assert.match(inviteHTML, /get\('intent'\) === 'shareGame'/);
  assert.match(inviteHTML, /A friend shared a Jottly game\./);
  assert.match(inviteHTML, /play it solo, save it, share it, or remix the rules/);
  assert.match(inviteHTML, /location\.pathname \+ location\.search/);
  assert.match(inviteHTML, /'jotto:\/\/' \+ location\.pathname/);
});
