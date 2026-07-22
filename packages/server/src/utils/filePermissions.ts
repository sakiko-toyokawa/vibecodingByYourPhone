import * as fs from "node:fs/promises";

export const OWNER_READ_WRITE_FILE_MODE = 0o600;

/**
 * Enforce owner read/write file permissions on POSIX platforms.
 * No-op on Windows.
 */
export async function enforceOwnerReadWriteFilePermissions(
  filePath: string,
  logPrefix: string,
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }

  try {
    await fs.chmod(filePath, OWNER_READ_WRITE_FILE_MODE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    console.warn(
      `${logPrefix} Failed to enforce 0600 permissions on ${filePath}:`,
      error,
    );
  }
}
