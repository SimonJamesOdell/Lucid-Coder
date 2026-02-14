const resolveNodeMajor = (version = process.versions.node) => {
  const [majorToken] = String(version).split('.');
  const major = Number(majorToken);
  return Number.isInteger(major) && major > 0 ? major : 0;
};

export const resolveCoverageProvider = (version = process.versions.node) => {
  return resolveNodeMajor(version) >= 19 ? 'v8' : 'istanbul';
};
