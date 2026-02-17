export const createApplyEditsModule = ({
  readProjectFile,
  applyReplacements,
  tryRepairModifyEdit,
  tryRewriteFileWithLLM,
  upsertProjectFile,
  deleteProjectPath,
  stageProjectFile,
  automationLog,
  normalizeRepoPath,
  isReplacementResolutionError
}) => {
  const applyEditsDeps = {
    readProjectFile,
    applyReplacements,
    tryRepairModifyEdit,
    tryRewriteFileWithLLM,
    upsertProjectFile,
    deleteProjectPath,
    stageProjectFile
  };

  const isPackageJsonPath = (filePath) => typeof filePath === 'string' && /(^|\/)package\.json$/i.test(filePath);

  const buildFileOpFailure = ({ path, message, status, operation }) => {
    const error = new Error(message || 'File operation failed');
    error.__lucidcoderFileOpFailure = {
      path,
      status: typeof status === 'number' ? status : null,
      message: message || error.message,
      operation: operation || null
    };
    return error;
  };

  const normalizePackageJsonContent = (content) => {
    if (typeof content !== 'string') {
      return content;
    }
    try {
      const parsed = JSON.parse(content);
      return `${JSON.stringify(parsed, null, 2)}\n`;
    } catch {
      return content;
    }
  };

  const __setApplyEditsTestDeps = (overrides = {}) => {
    const restore = {};
    Object.entries(overrides).forEach(([key, value]) => {
      if (typeof value === 'function' && applyEditsDeps[key]) {
        restore[key] = applyEditsDeps[key];
        applyEditsDeps[key] = value;
      }
    });
    return () => {
      Object.entries(restore).forEach(([key, value]) => {
        applyEditsDeps[key] = value;
      });
    };
  };

  const applyEdits = async ({
    projectId,
    edits,
    source = 'ai',
    knownPathsSet,
    goalPrompt,
    stage,
    onFileApplied,
    syncBranchOverview
  }) => {
    if (!projectId || !Array.isArray(edits) || edits.length === 0) {
      return { applied: 0, skipped: 0 };
    }

    const useKnownPaths = knownPathsSet instanceof Set && knownPathsSet.size > 0;

    const resolveKnownPath = (filePath) => {
      if (!useKnownPaths || !filePath) {
        return filePath;
      }
      if (knownPathsSet.has(filePath)) {
        return filePath;
      }

      let candidate = null;
      for (const knownPath of knownPathsSet) {
        if (!knownPath) {
          continue;
        }
        if (knownPath.endsWith(`/${filePath}`) || filePath.endsWith(`/${knownPath}`)) {
          if (candidate && candidate !== knownPath) {
            return filePath;
          }
          candidate = knownPath;
        }
      }

      const backendSrcFallback = filePath.replace(/^backend\/src\//, 'backend/');
      if (backendSrcFallback !== filePath && knownPathsSet.has(backendSrcFallback)) {
        return backendSrcFallback;
      }

      return candidate || filePath;
    };

    let applied = 0;
    let skipped = 0;

    for (const edit of edits) {
      const rawPath = edit?.path;
      const type = edit?.type;
      const normalizedPath = normalizeRepoPath(rawPath);
      const resolvedPath = resolveKnownPath(normalizedPath);

      if (!resolvedPath) {
        skipped += 1;
        automationLog('skipping edit (missing/invalid path)', { type, path: rawPath });
        continue;
      }

      if (resolvedPath !== normalizedPath) {
        automationLog('applyEdits:resolvedPath', { from: normalizedPath, to: resolvedPath });
      }

      const filePath = resolvedPath;

      if (type === 'modify') {
        const original = await applyEditsDeps.readProjectFile({ projectId, filePath });
        if (original === null) {
          throw buildFileOpFailure({
            path: filePath,
            status: 404,
            operation: 'read',
            message: `File not found: ${filePath}`
          });
        }

        let updated;
        try {
          updated = applyEditsDeps.applyReplacements(original, edit?.replacements);
        } catch (error) {
          const fallbackMessage =
            typeof error?.message === 'string' && error.message.trim().length > 0
              ? error.message
              : String(error || 'Replacement failed');
          const replacementError = error instanceof Error ? error : new Error(fallbackMessage);
          if (replacementError && !replacementError.message) {
            replacementError.message = fallbackMessage;
          }
          const replacementPreview = []
            .concat(edit?.replacements)
            .filter((r) => r && typeof r === 'object')
            .slice(0, 2)
            .map((r) => ({
              searchPreview: typeof r?.search === 'string' ? r.search.slice(0, 160) : null
            }));

          replacementError.__lucidcoderReplacementFailure = {
            path: filePath,
            stage,
            message: replacementError.message,
            searchSnippet: replacementPreview[0]?.searchPreview || null
          };

          automationLog('applyEdits:modify:replacementError', {
            path: filePath,
            message: replacementError?.message,
            preview: replacementPreview
          });

          if (
            isReplacementResolutionError(replacementError) &&
            typeof goalPrompt === 'string' &&
            goalPrompt.trim().length > 0
          ) {
            const repaired = await applyEditsDeps.tryRepairModifyEdit({
              projectId,
              goalPrompt,
              stage,
              filePath,
              originalContent: original,
              failedEdit: edit,
              error: replacementError
            });

            if (repaired?.type === 'modify' && repaired?.replacements) {
              try {
                updated = applyEditsDeps.applyReplacements(original, repaired.replacements);
                edit.replacements = repaired.replacements;
              } catch (repairApplyError) {
                automationLog('applyEdits:modify:repair:applyError', {
                  path: normalizedPath,
                  message: repairApplyError?.message
                });
                throw replacementError;
              }
            } else if (repaired?.type === 'upsert' && typeof repaired?.content === 'string') {
              updated = repaired.content;
            } else {
              const rewriteEdit = await applyEditsDeps.tryRewriteFileWithLLM({
                goalPrompt,
                stage,
                filePath,
                originalContent: original,
                errorMessage: replacementError?.message || 'Unknown replacement failure'
              });

              if (rewriteEdit?.type === 'upsert' && typeof rewriteEdit?.content === 'string') {
                updated = rewriteEdit.content;
                edit.replacements = undefined;
              } else if (rewriteEdit?.type === 'modify' && rewriteEdit?.replacements) {
                try {
                  updated = applyEditsDeps.applyReplacements(original, rewriteEdit.replacements);
                  edit.replacements = rewriteEdit.replacements;
                } catch (rewriteApplyError) {
                  automationLog('applyEdits:modify:rewrite:applyError', {
                    path: normalizedPath,
                    message: rewriteApplyError?.message
                  });
                  throw replacementError;
                }
              } else {
                throw replacementError;
              }
            }
          } else {
            throw replacementError;
          }
        }
        if (isPackageJsonPath(filePath)) {
          const normalizedOriginal = normalizePackageJsonContent(original);
          const normalizedUpdated = normalizePackageJsonContent(updated);
          if (normalizedUpdated === normalizedOriginal) {
            skipped += 1;
            automationLog('skipping edit (no-op modify)', { type, path: filePath });
            continue;
          }
          updated = normalizedUpdated;
        } else if (updated === original) {
          skipped += 1;
          automationLog('skipping edit (no-op modify)', { type, path: filePath });
          continue;
        }

        try {
          await applyEditsDeps.upsertProjectFile({
            projectId,
            filePath,
            content: updated,
            knownPathsSet: useKnownPaths ? knownPathsSet : undefined
          });
        } catch (error) {
          if (error?.__lucidcoderFileOpFailure) {
            throw error;
          }
          const status = error?.response?.status;
          if (status === 404 || status === 400) {
            throw buildFileOpFailure({
              path: filePath,
              status,
              operation: 'upsert',
              message: `Failed to write file: ${filePath}`
            });
          }
          throw error;
        }
        const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath, source });
        if (typeof syncBranchOverview === 'function' && stagePayload?.overview) {
          syncBranchOverview(projectId, stagePayload.overview);
        }
        if (typeof onFileApplied === 'function') {
          await onFileApplied(filePath, { type: 'modify' });
        }
        applied += 1;
        continue;
      }

      if (type === 'delete') {
        await applyEditsDeps.deleteProjectPath({
          projectId,
          targetPath: filePath,
          recursive: edit?.recursive === true
        });
        const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath, source });
        if (typeof syncBranchOverview === 'function' && stagePayload?.overview) {
          syncBranchOverview(projectId, stagePayload.overview);
        }
        applied += 1;
        continue;
      }

      const content = edit?.content;
      if (typeof content !== 'string') {
        skipped += 1;
        automationLog('skipping edit (upsert content not a string)', { type, path: normalizedPath });
        continue;
      }

      const normalizedContent = isPackageJsonPath(filePath)
        ? normalizePackageJsonContent(content)
        : content;

      const existingContent = await applyEditsDeps.readProjectFile({ projectId, filePath });
      const comparableExisting = isPackageJsonPath(filePath)
        ? normalizePackageJsonContent(existingContent)
        : existingContent;

      if (typeof comparableExisting === 'string' && comparableExisting === normalizedContent) {
        skipped += 1;
        automationLog('skipping edit (no-op upsert)', { type, path: filePath });
        continue;
      }

      try {
        await applyEditsDeps.upsertProjectFile({
          projectId,
          filePath,
          content: normalizedContent,
          knownPathsSet: useKnownPaths ? knownPathsSet : undefined
        });
      } catch (error) {
        if (error?.__lucidcoderFileOpFailure) {
          throw error;
        }
        const status = error?.response?.status;
        if (status === 404 || status === 400) {
          throw buildFileOpFailure({
            path: filePath,
            status,
            operation: 'upsert',
            message: `Failed to write file: ${filePath}`
          });
        }
        throw error;
      }
      const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath, source });
      if (typeof syncBranchOverview === 'function' && stagePayload?.overview) {
        syncBranchOverview(projectId, stagePayload.overview);
      }
      if (typeof onFileApplied === 'function') {
        await onFileApplied(filePath, { type: 'upsert' });
      }
      applied += 1;
    }

    return { applied, skipped };
  };

  return {
    applyEdits,
    __setApplyEditsTestDeps,
    __testHooks: { buildFileOpFailure }
  };
};
