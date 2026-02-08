const updateChatPanelTestHooks = (ChatPanelComponent, values = {}) => {
  if (!ChatPanelComponent?.__testHooks) {
    return;
  }

  const {
    handleStartAutopilot,
    handleChangeDirectionPrompt,
    handleUndoLastChangePrompt,
    handleAutopilotMessage,
    handleAutopilotControl,
    runAgentRequestStream,
    handleAgentResult,
    appendStreamingChunk,
    autopilotResumeAttemptedRef,
    autoFixCancelRef,
    isMessagesScrolledToBottom,
    messagesRef,
    messagesContainerRef,
    scrollMessagesToBottom,
    streamingMessageIdRef,
    streamingTextRef,
    refreshAutopilotStatus,
    stopAutopilotPoller,
    setAutopilotSession,
    setAutopilotEvents,
    clearStoredAutopilotSession,
    persistAutopilotSession,
    loadStoredAutopilotSession,
    applyAutopilotSummary,
    persistChat,
    readStoredChat
  } = values;

  // Surface critical autopilot handlers so tests can exercise guard rails.
  ChatPanelComponent.__testHooks.handlers = {
    startAutopilot: handleStartAutopilot,
    changeDirectionPrompt: handleChangeDirectionPrompt,
    undoLastChangePrompt: handleUndoLastChangePrompt,
    autopilotMessage: handleAutopilotMessage,
    autopilotControl: handleAutopilotControl,
    runAgentRequestStream,
    handleAgentResult,
    appendStreamingChunk
  };

  ChatPanelComponent.__testHooks.latestInstance = {
    autopilotResumeAttemptedRef,
    autoFixCancelRef,
    isMessagesScrolledToBottom,
    messagesRef,
    messagesContainerRef,
    scrollMessagesToBottom,
    streamingMessageIdRef,
    streamingTextRef,
    refreshAutopilotStatus,
    stopAutopilotPoller,
    setAutopilotSession,
    setAutopilotEvents
  };

  ChatPanelComponent.__testHooks.storage = {
    clearStoredAutopilotSession,
    persistAutopilotSession,
    loadStoredAutopilotSession,
    applyAutopilotSummary,
    stopAutopilotPoller
  };

  ChatPanelComponent.__testHooks.chatStorage = {
    persistChat,
    readStoredChat
  };
};

export { updateChatPanelTestHooks };
