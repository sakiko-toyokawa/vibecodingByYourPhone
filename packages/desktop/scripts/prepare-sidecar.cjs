#!/usr/bin/env node
/**
 * Cross-platform prepare-sidecar script.
 * Downloads the Bun binary for the current (or target) platform into src-tauri/binaries/.
 *
 * Replaces the bash-only prepare-sidecar.sh to support Windows builds
 * without requiring Git Bash or WSL.
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const os = require("os");

const BUN_VERSION = "1.2.17";
const SCRIPT_DIR = path.resolve(__dirname);
const BIN_DIR = path.join(SCRIPT_DIR, "..", "src-tauri", "binaries");

/** Map Node.js platform/arch to Rust target triple. */
function getTargetTriple() {
	const platform = os.platform();
	const arch = os.arch();

	if (platform === "darwin") {
		return arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
	}
	if (platform === "win32") {
		return "x86_64-pc-windows-msvc";
	}
	if (platform === "linux") {
		return arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
	}
	throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

/** Map target triple to Bun release asset name. */
function getBunAsset(triple) {
	switch (triple) {
		case "aarch64-apple-darwin":
			return "bun-darwin-aarch64";
		case "x86_64-apple-darwin":
			return "bun-darwin-x64-baseline";
		case "x86_64-pc-windows-msvc":
			return "bun-windows-x64";
		case "x86_64-unknown-linux-gnu":
			return "bun-linux-x64";
		case "aarch64-unknown-linux-gnu":
			return "bun-linux-aarch64";
		default:
			throw new Error(`Unsupported triple: ${triple}`);
	}
}

/** Download a file from URL to dest path. */
function downloadFile(url, dest) {
	return new Promise((resolve, reject) => {
		const file = fs.createWriteStream(dest);
		https
			.get(url, (response) => {
				if (response.statusCode === 302 || response.statusCode === 301) {
					// Follow redirect
					https
						.get(response.headers.location, (res2) => {
							res2.pipe(file);
							file.on("finish", () => {
								file.close();
								resolve();
							});
						})
						.on("error", reject);
				} else if (response.statusCode === 200) {
					response.pipe(file);
					file.on("finish", () => {
						file.close();
						resolve();
					});
				} else {
					reject(new Error(`Download failed with status ${response.statusCode}`));
				}
			})
			.on("error", reject);
	});
}

async function main() {
	const triple = process.env.TARGET_TRIPLE || getTargetTriple();
	const bunAsset = getBunAsset(triple);

	const binName = os.platform() === "win32" ? `bun-${triple}.exe` : `bun-${triple}`;
	const bunBin = path.join(BIN_DIR, binName);

	// Skip if already downloaded
	if (fs.existsSync(bunBin)) {
		console.log(`Bun already present for ${triple}`);
		return;
	}

	fs.mkdirSync(BIN_DIR, { recursive: true });

	const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${bunAsset}.zip`;
	console.log(`Downloading Bun ${BUN_VERSION} for ${triple}...`);

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bun-download-"));
	const zipPath = path.join(tmpDir, "bun.zip");

	try {
		await downloadFile(url, zipPath);

		// Extract
		if (os.platform() === "win32") {
			execSync(
				`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`,
				{ stdio: "inherit" },
			);
		} else {
			execSync(`unzip -q "${zipPath}" -d "${tmpDir}"`, { stdio: "inherit" });
		}

		const extractedName = os.platform() === "win32" ? "bun.exe" : "bun";
		const extracted = path.join(tmpDir, bunAsset, extractedName);
		fs.copyFileSync(extracted, bunBin);

		if (os.platform() !== "win32") {
			fs.chmodSync(bunBin, 0o755);
		}

		// macOS: re-sign after copy (cp sets com.apple.provenance which invalidates ad-hoc signature)
		if (os.platform() === "darwin") {
			execSync(`codesign -fs - "${bunBin}"`, { stdio: "inherit" });
		}

		console.log(`Bun ${BUN_VERSION} ready for ${triple} → ${bunBin}`);
	} finally {
		// Cleanup temp dir
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
