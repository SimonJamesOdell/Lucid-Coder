export const resolveChangedPaths = async ({
  options,
  context,
  branch,
  listBranchChangedPaths,
  parseStagedFiles
}) => {
  const explicit = options?.changedFiles ?? options?.changedPaths;
  if (Array.isArray(explicit)) {
    return explicit.map((entry) => String(entry || '').trim()).filter(Boolean);
  }

  if (context?.gitReady) {
    try {
      const changed = await listBranchChangedPaths(context, { baseRef: 'main', branchRef: branch?.name });
      if (Array.isArray(changed) && changed.length) {
        return changed;
      }
    } catch {
      // ignore git diff failures
    }
  }

  const stagedFiles = parseStagedFiles(branch?.staged_files);
  if (Array.isArray(stagedFiles) && stagedFiles.length) {
    return stagedFiles
      .map((entry) => String(entry?.path || '').trim())
      .filter(Boolean);
  }

  return [];
};
