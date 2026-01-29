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

    let applied = 0;
    let skipped = 0;

    for (const edit of edits) {
      const rawPath = edit?.path;
      const type = edit?.type;
      const normalizedPath = normalizeRepoPath(rawPath);

      if (!normalizedPath) {
        skipped += 1;
        automationLog('skipping edit (missing/invalid path)', { type, path: rawPath });
        continue;
      }

      if (type === 'modify') {
        const original = await applyEditsDeps.readProjectFile({ projectId, filePath: normalizedPath });
        if (original === null) {
          throw new Error('File not found');
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
            path: normalizedPath,
            stage,
            message: replacementError.message,
            searchSnippet: replacementPreview[0]?.searchPreview || null
          };

          automationLog('applyEdits:modify:replacementError', {
            path: normalizedPath,
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
              filePath: normalizedPath,
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
                filePath: normalizedPath,
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
        if (updated === original) {
          skipped += 1;
          automationLog('skipping edit (no-op modify)', { type, path: normalizedPath });
          continue;
        }

        await applyEditsDeps.upsertProjectFile({
          projectId,
          filePath: normalizedPath,
          content: updated,
          knownPathsSet: useKnownPaths ? knownPathsSet : undefined
        });
        const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath: normalizedPath, source });
        if (typeof syncBranchOverview === 'function' && stagePayload?.overview) {
          syncBranchOverview(projectId, stagePayload.overview);
        }
        if (typeof onFileApplied === 'function') {
          await onFileApplied(normalizedPath, { type: 'modify' });
        }
        applied += 1;
        continue;
      }

      if (type === 'delete') {
        await applyEditsDeps.deleteProjectPath({
          projectId,
          targetPath: normalizedPath,
          recursive: edit?.recursive === true
        });
        const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath: normalizedPath, source });
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

      await applyEditsDeps.upsertProjectFile({
        projectId,
        filePath: normalizedPath,
        content,
        knownPathsSet: useKnownPaths ? knownPathsSet : undefined
      });
      const stagePayload = await applyEditsDeps.stageProjectFile({ projectId, filePath: normalizedPath, source });
      if (typeof syncBranchOverview === 'function' && stagePayload?.overview) {
        syncBranchOverview(projectId, stagePayload.overview);
      }
      if (typeof onFileApplied === 'function') {
        await onFileApplied(normalizedPath, { type: 'upsert' });
      }
      applied += 1;
    }

    return { applied, skipped };
  };

  return {
    applyEdits,
    __setApplyEditsTestDeps
  };
};
