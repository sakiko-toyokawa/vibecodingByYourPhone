import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSelfSignedCertificate } from "../../src/https/self-signed.js";

const opensslVersionCheck = spawnSync("openssl", ["version"], {
  encoding: "utf8",
});
const hasOpenSsl =
  !opensslVersionCheck.error && opensslVersionCheck.status === 0;

const describeIfOpenSsl = hasOpenSsl ? describe : describe.skip;

describeIfOpenSsl("self-signed certificate generation", () => {
  const testDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      testDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    testDirs.length = 0;
  });

  it("generates then reuses a self-signed certificate", async () => {
    const dataDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "self-signed-cert-test-"),
    );
    testDirs.push(dataDir);

    const first = ensureSelfSignedCertificate({
      dataDir,
      host: "192.168.1.139",
    });
    expect(first.generated).toBe(true);
    expect(first.cert.length).toBeGreaterThan(0);
    expect(first.key.length).toBeGreaterThan(0);

    const second = ensureSelfSignedCertificate({
      dataDir,
      host: "192.168.1.139",
    });
    expect(second.generated).toBe(false);
    expect(second.certPath).toBe(first.certPath);
    expect(second.keyPath).toBe(first.keyPath);
    expect(second.cert.equals(first.cert)).toBe(true);
    expect(second.key.equals(first.key)).toBe(true);
  });
});
