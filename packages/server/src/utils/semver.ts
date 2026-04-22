export function isNewerSemver(current: string, latest: string): boolean {
  if (current === "unknown" || !latest) return false;

  const parseVersion = (value: string) => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!match || !match[1] || !match[2] || !match[3]) return null;
    return {
      major: Number.parseInt(match[1], 10),
      minor: Number.parseInt(match[2], 10),
      patch: Number.parseInt(match[3], 10),
    };
  };

  const currentParsed = parseVersion(current);
  const latestParsed = parseVersion(latest);

  if (!currentParsed || !latestParsed) return false;

  if (latestParsed.major > currentParsed.major) return true;
  if (latestParsed.major < currentParsed.major) return false;

  if (latestParsed.minor > currentParsed.minor) return true;
  if (latestParsed.minor < currentParsed.minor) return false;

  return latestParsed.patch > currentParsed.patch;
}
