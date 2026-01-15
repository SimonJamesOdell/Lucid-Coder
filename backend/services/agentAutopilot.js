// This module provides a stub for autopilot functionality.
// All execution features have been removed - only planning is supported.

import { planGoalFromPrompt } from './agentOrchestrator.js';

/**
 * Handles a feature request by creating a goal plan without execution.
 * @param {Object} options - Request options
 * @param {number} options.projectId - Project ID
 * @param {string} options.prompt - User's feature request
 * @returns {Promise<Object>} Result with success status
 */
export const autopilotFeatureRequest = async ({ projectId, prompt }) => {
  // Create a goal plan without executing it
  await planGoalFromPrompt(projectId, prompt);
  
  return {
    success: true,
    message: 'Plan created successfully. Execution not implemented.'
  };
};

export default {
  autopilotFeatureRequest
};
