import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

test("live fallback check rejects a non-200 page even when its body matches", async () => {
  const bin = await mkdtemp(join(tmpdir(), "jottly-fallback-status-"));
  const fakeCurl = join(bin, "curl");
  await writeFile(fakeCurl, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const url = new URL(args.at(-1));
const route = url.pathname.startsWith("/join/") ? "/join" : url.pathname;
const files = {
  "/.well-known/apple-app-site-association": ".well-known/apple-app-site-association",
  "/apple-app-site-association": "apple-app-site-association",
  "/daily": "daily.html",
  "/solo": "solo.html",
  "/join": "invite.html",
};
const file = files[route];
const status = route === "/solo" ? process.env.JOTTLY_FAKE_SOLO_STATUS : file ? "200" : "404";
fs.writeFileSync(args[args.indexOf("-o") + 1], file
  ? fs.readFileSync(path.join(process.env.JOTTLY_FAKE_SITE_ROOT, file))
  : "Not found");
const contentType = route.includes("apple-app-site-association") ? "application/json" : "text/html";
process.stdout.write(args[args.indexOf("-w") + 1]
  .replaceAll("%{http_code}", status)
  .replaceAll("%{content_type}", contentType));
`);
  await chmod(fakeCurl, 0o755);

  const run = async (soloStatus) => {
    try {
      const { stdout } = await execFileAsync("bash", ["verify-fallbacks.sh", "--live"], {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          JOTTLY_FAKE_SITE_ROOT: root,
          JOTTLY_FAKE_SOLO_STATUS: soloStatus,
        },
      });
      return { status: 0, output: stdout };
    } catch (error) {
      return { status: error.code, output: error.stdout };
    }
  };

  try {
    const healthy = await run("200");
    assert.equal(healthy.status, 0, healthy.output);

    const unavailable = await run("503");
    assert.equal(unavailable.status, 1);
    assert.match(unavailable.output, /\/solo -> HTTP 503 \(want 200\)/);
    assert.doesNotMatch(unavailable.output, /All fallback contracts hold, local and live/);
  } finally {
    await rm(bin, { recursive: true, force: true });
  }
});
