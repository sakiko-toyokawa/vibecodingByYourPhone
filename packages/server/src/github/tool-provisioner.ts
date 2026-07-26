import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";

const DEFAULT_GH_VERSION = "2.64.0";
const DEFAULT_GITHUB_TOOL_PROXY = "http://127.0.0.1:7897";

export interface GitHubToolStatus {
  installed: boolean;
  path: string;
  version: string;
}

type SupportedPlatform = NodeJS.Platform;
type SupportedArch = NodeJS.Architecture;

export interface GitHubToolProvisionerOptions {
  dataDir: string;
  version?: string;
  platform?: SupportedPlatform;
  arch?: SupportedArch;
  pathExists?: (filePath: string) => Promise<boolean>;
  downloadAndExtract?: (url: string, destination: string) => Promise<void>;
}

function assetSuffix(platform: SupportedPlatform, arch: SupportedArch): string {
  const mappedArch =
    arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (!mappedArch) {
    throw new Error(`Unsupported GitHub CLI architecture: ${arch}`);
  }
  switch (platform) {
    case "win32":
      return `windows_${mappedArch}.zip`;
    case "darwin":
      return `macOS_${mappedArch}.zip`;
    case "linux":
      return `linux_${mappedArch}.tar.gz`;
    default:
      throw new Error(`Unsupported GitHub CLI platform: ${platform}`);
  }
}

function assetRoot(
  version: string,
  platform: SupportedPlatform,
  arch: SupportedArch,
): string {
  return `gh_${version}_${assetSuffix(platform, arch).replace(/\.tar\.gz$|\.zip$/, "")}`;
}

export class GitHubToolProvisioner {
  private readonly dataDir: string;
  private readonly version: string;
  private readonly platform: SupportedPlatform;
  private readonly arch: SupportedArch;
  private readonly pathExists: (filePath: string) => Promise<boolean>;
  private readonly downloadAndExtract: (
    url: string,
    destination: string,
  ) => Promise<void>;

  constructor(options: GitHubToolProvisionerOptions) {
    this.dataDir = options.dataDir;
    this.version = options.version ?? DEFAULT_GH_VERSION;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.pathExists = options.pathExists ?? defaultPathExists;
    this.downloadAndExtract =
      options.downloadAndExtract ?? defaultDownloadAndExtract;
  }

  getGhPath(): string {
    const binary = this.platform === "win32" ? "gh.exe" : "gh";
    return path.join(
      this.dataDir,
      "tools",
      "gh",
      this.version,
      assetRoot(this.version, this.platform, this.arch),
      "bin",
      binary,
    );
  }

  async ensureGh(): Promise<GitHubToolStatus> {
    const ghPath = this.getGhPath();
    if (!(await this.pathExists(ghPath))) {
      const destination = path.join(this.dataDir, "tools", "gh", this.version);
      await fs.mkdir(destination, { recursive: true });
      await this.downloadAndExtract(this.downloadUrl(), destination);
    }
    return { installed: true, path: ghPath, version: this.version };
  }

  private downloadUrl(): string {
    const suffix = assetSuffix(this.platform, this.arch);
    return `https://github.com/cli/cli/releases/download/v${this.version}/gh_${this.version}_${suffix}`;
  }
}

async function defaultPathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function defaultDownloadAndExtract(
  url: string,
  destination: string,
): Promise<void> {
  const archive = path.join(destination, path.basename(url));
  await fs.writeFile(archive, await downloadBytes(url));
  if (archive.endsWith(".zip")) {
    await runExtractCommand(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        archive,
        "-DestinationPath",
        destination,
        "-Force",
      ],
      destination,
    );
    return;
  }
  await runExtractCommand(
    "tar",
    ["-xzf", archive, "-C", destination],
    destination,
  );
}

function configuredProxyUrl(): string | null {
  const value =
    process.env.GITHUB_TOOL_PROXY ??
    process.env.HTTPS_PROXY ??
    process.env.HTTP_PROXY ??
    DEFAULT_GITHUB_TOOL_PROXY;
  if (!value || /^(0|false|none|direct)$/i.test(value.trim())) {
    return null;
  }
  return value.trim();
}

async function downloadBytes(url: string): Promise<Uint8Array> {
  const proxyUrl = configuredProxyUrl();
  if (proxyUrl) {
    try {
      return await requestBytes(url, proxyUrl);
    } catch (error) {
      const proxyMessage =
        error instanceof Error ? error.message : String(error);
      try {
        return await requestBytes(url, null);
      } catch (directError) {
        const directMessage =
          directError instanceof Error
            ? directError.message
            : String(directError);
        throw new Error(
          `Failed to download GitHub CLI via proxy ${proxyUrl}: ${proxyMessage}; direct fallback failed: ${directMessage}`,
        );
      }
    }
  }
  return await requestBytes(url, null);
}

async function requestBytes(
  rawUrl: string,
  proxyUrl: string | null,
  redirects = 0,
): Promise<Uint8Array> {
  if (redirects > 5) {
    throw new Error("too many redirects");
  }
  const url = new URL(rawUrl);
  const response = await rawRequest(url, proxyUrl);
  if (
    response.statusCode &&
    [301, 302, 303, 307, 308].includes(response.statusCode)
  ) {
    const location = response.headers.location;
    if (!location) {
      throw new Error(`HTTP ${response.statusCode} redirect without location`);
    }
    const nextUrl = new URL(location, url).toString();
    return await requestBytes(nextUrl, proxyUrl, redirects + 1);
  }
  if (
    !response.statusCode ||
    response.statusCode < 200 ||
    response.statusCode >= 300
  ) {
    throw new Error(`HTTP ${response.statusCode ?? "unknown"}`);
  }
  return response.body;
}

function rawRequest(
  url: URL,
  proxyUrl: string | null,
): Promise<{
  statusCode?: number;
  headers: http.IncomingHttpHeaders;
  body: Uint8Array;
}> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const requestOptions: https.RequestOptions = {
      method: "GET",
      headers: {
        "User-Agent": "yep-anywhere-gh-provisioner",
        Accept: "application/octet-stream",
      },
    };
    if (proxyUrl && url.protocol === "https:") {
      requestOptions.agent = new HttpsConnectProxyAgent(proxyUrl);
    }
    const client = url.protocol === "http:" ? http : https;
    const request = client.request(url, requestOptions, (response) => {
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("error", reject);
      response.on("end", () => {
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

class HttpsConnectProxyAgent extends https.Agent {
  private readonly proxy: URL;

  constructor(proxyUrl: string) {
    super();
    this.proxy = new URL(proxyUrl);
  }

  override createConnection(
    options: http.ClientRequestArgs,
    callback?: (error: Error | null, socket: Duplex) => void,
  ): Duplex | null {
    const targetHost = String(options.host ?? options.hostname ?? "");
    const targetPort = Number(options.port ?? 443);
    const proxyRequest = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: {
        Host: `${targetHost}:${targetPort}`,
      },
    });

    proxyRequest.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback?.(
          new Error(`proxy CONNECT failed with HTTP ${response.statusCode}`),
          socket,
        );
        return;
      }
      const tlsSocket = tls.connect({
        socket,
        servername: targetHost,
      });
      tlsSocket.once("secureConnect", () => callback?.(null, tlsSocket));
      tlsSocket.once("error", (error) => callback?.(error, tlsSocket));
    });
    proxyRequest.once("error", (error) =>
      callback?.(error, undefined as unknown as Duplex),
    );
    proxyRequest.end();
    return null;
  }
}

async function runExtractCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: process.platform === "win32",
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${command} exited with ${code}`));
      }
    });
  });
}
