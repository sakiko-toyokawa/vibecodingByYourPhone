import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const HTTPS_DIR_NAME = "https";
const CERT_FILE_NAME = "self-signed-cert.pem";
const KEY_FILE_NAME = "self-signed-key.pem";
const OPENSSL_CONFIG_FILE_NAME = "openssl-self-signed.cnf";

export interface SelfSignedCertificateOptions {
  dataDir: string;
  host: string;
}

export interface SelfSignedCertificateResult {
  certPath: string;
  keyPath: string;
  cert: Buffer;
  key: Buffer;
  generated: boolean;
}

function isIPv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4) return false;
  return octets.every((octet) => {
    if (!/^\d{1,3}$/.test(octet)) return false;
    const num = Number.parseInt(octet, 10);
    return num >= 0 && num <= 255;
  });
}

function isUsefulHostName(host: string): boolean {
  return host !== "" && host !== "0.0.0.0" && host !== "::";
}

function collectSubjectAltNames(host: string): string[] {
  const dnsNames = new Set<string>(["localhost"]);
  const ipAddresses = new Set<string>(["127.0.0.1"]);

  const normalizedHost = host.trim();
  if (isUsefulHostName(normalizedHost)) {
    if (isIPv4(normalizedHost)) {
      ipAddresses.add(normalizedHost);
    } else {
      dnsNames.add(normalizedHost);
    }
  }

  const interfaces = os.networkInterfaces();
  for (const details of Object.values(interfaces)) {
    if (!details) continue;
    for (const detail of details) {
      if (detail.family !== "IPv4" || detail.internal) continue;
      if (!isIPv4(detail.address)) continue;
      ipAddresses.add(detail.address);
    }
  }

  const dnsEntries = Array.from(dnsNames).map((name) => `DNS:${name}`);
  const ipEntries = Array.from(ipAddresses).map((ip) => `IP:${ip}`);
  return [...dnsEntries, ...ipEntries];
}

function buildOpenSslConfig(host: string): string {
  const commonName =
    isUsefulHostName(host) && !isIPv4(host) ? host.trim() : "localhost";
  const subjectAltName = collectSubjectAltNames(host).join(",");

  return [
    "[req]",
    "distinguished_name=req_distinguished_name",
    "prompt=no",
    "x509_extensions=v3_req",
    "",
    "[req_distinguished_name]",
    `CN=${commonName}`,
    "",
    "[v3_req]",
    `subjectAltName=${subjectAltName}`,
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "",
  ].join("\n");
}

function ensureOpenSslAvailable(): void {
  const result = spawnSync("openssl", ["version"], {
    encoding: "utf8",
  });

  if (result.error) {
    throw new Error(
      "HTTPS self-signed mode requires 'openssl', but it was not found in PATH.",
    );
  }

  if (result.status !== 0) {
    const details = (result.stderr || result.stdout || "")
      .trim()
      .replace(/\s+/g, " ");
    throw new Error(
      `HTTPS self-signed mode requires a working 'openssl' binary. Command failed with status ${result.status}${details ? `: ${details}` : ""}`,
    );
  }
}

export function ensureSelfSignedCertificate(
  options: SelfSignedCertificateOptions,
): SelfSignedCertificateResult {
  const certDir = path.join(options.dataDir, HTTPS_DIR_NAME);
  const certPath = path.join(certDir, CERT_FILE_NAME);
  const keyPath = path.join(certDir, KEY_FILE_NAME);

  fs.mkdirSync(certDir, { recursive: true });

  const hasCert = fs.existsSync(certPath);
  const hasKey = fs.existsSync(keyPath);
  if (hasCert && hasKey) {
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    if (cert.length > 0 && key.length > 0) {
      return {
        certPath,
        keyPath,
        cert,
        key,
        generated: false,
      };
    }

    fs.rmSync(certPath, { force: true });
    fs.rmSync(keyPath, { force: true });
  }

  if (hasCert && !hasKey) fs.rmSync(certPath, { force: true });
  if (hasKey && !hasCert) fs.rmSync(keyPath, { force: true });

  ensureOpenSslAvailable();

  const configPath = path.join(certDir, OPENSSL_CONFIG_FILE_NAME);
  fs.writeFileSync(configPath, buildOpenSslConfig(options.host), {
    mode: 0o600,
  });

  try {
    const generateResult = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-nodes",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "825",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-config",
        configPath,
      ],
      {
        encoding: "utf8",
      },
    );

    if (generateResult.error) {
      throw new Error(
        `Failed to generate self-signed certificate: ${generateResult.error.message}`,
      );
    }

    if (generateResult.status !== 0) {
      const details = (generateResult.stderr || generateResult.stdout || "")
        .trim()
        .replace(/\s+/g, " ");
      throw new Error(
        `Failed to generate self-signed certificate with openssl (status ${generateResult.status})${details ? `: ${details}` : ""}`,
      );
    }
  } catch (error) {
    fs.rmSync(certPath, { force: true });
    fs.rmSync(keyPath, { force: true });
    throw error;
  } finally {
    fs.rmSync(configPath, { force: true });
  }

  fs.chmodSync(keyPath, 0o600);

  return {
    certPath,
    keyPath,
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    generated: true,
  };
}
