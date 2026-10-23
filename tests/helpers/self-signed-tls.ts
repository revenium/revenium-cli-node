import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SelfSignedCertificate {
  key: string;
  cert: string;
  certPath: string;
  dispose(): void;
}

export function isOpensslAvailable(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function createSelfSignedCertificate(host = "127.0.0.1"): SelfSignedCertificate {
  if (!isOpensslAvailable()) {
    throw new Error("openssl is required to build the self-signed certificate used by this test");
  }

  const dir = mkdtempSync(join(tmpdir(), "revenium-tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");

  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      `/CN=${host}`,
      "-addext",
      `subjectAltName=IP:${host}`,
    ],
    { stdio: "pipe" },
  );

  return {
    key: readFileSync(keyPath, "utf-8"),
    cert: readFileSync(certPath, "utf-8"),
    certPath,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
