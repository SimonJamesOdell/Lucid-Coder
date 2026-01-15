import { ensureBranch } from './goalAutomation/ensureBranch';
import { processGoal } from './goalAutomation/processGoal';
import { processGoals, handlePlanOnlyFeature, handleRegularFeature } from './goalAutomation/goalHandlers';
import {
  extractJsonObject,
  tryParseLooseJson,
  parseEditsFromLLM,
  buildEditsPrompt,
  applyEdits,
  buildRewriteFilePrompt,
  tryRewriteFileWithLLM,
  buildRelevantFilesContext,
  normalizeMentionPath,
  buildReplacementRetryContext
} from './goalAutomation/automationUtils';

export { ensureBranch, processGoal, processGoals, handlePlanOnlyFeature, handleRegularFeature };

export const __testOnly = {
  extractJsonObject,
  tryParseLooseJson,
  parseEditsFromLLM,
  buildEditsPrompt,
  applyEdits,
  buildRewriteFilePrompt,
  tryRewriteFileWithLLM,
  buildRelevantFilesContext,
  normalizeMentionPath,
  buildReplacementRetryContext
};
