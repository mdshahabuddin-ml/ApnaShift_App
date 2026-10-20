// Semantic version helpers (strict x.y.z — Android versionName convention).
// Parsers return null / NaN for garbage input so callers can choose to ignore
// (never punish a client for an unparseable version header).
export function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

// -1 (a<b), 0 (equal), 1 (a>b); NaN if either side is not strict semver.
export function cmpSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

// true iff `version` is strictly lower than `reference`.
export function isOlderThan(version, reference) {
  const c = cmpSemver(version, reference);
  return Number.isNaN(c) ? false : c < 0;
}
