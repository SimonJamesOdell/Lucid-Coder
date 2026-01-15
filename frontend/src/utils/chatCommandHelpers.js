/**
 * Chat command and natural language detection helpers
 */

/**
 * Check if a message is a natural language cancel/stop command
 */
export function isNaturalLanguageCancel(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  return /^(cancel|stop)$/i.test(trimmed);
}

/**
 * Check if a message is a natural language pause command
 */
export function isNaturalLanguagePause(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  return /^pause$/i.test(trimmed);
}

/**
 * Check if a message is a natural language resume command
 */
export function isNaturalLanguageResume(value) {
  const trimmed = String(value || '').trim().toLowerCase();
  return /^(resume|continue)$/i.test(trimmed);
}

/**
 * Parse and handle chat commands (like /cancel, /help, etc.)
 * Returns an object with {handled: boolean, action?: string}
 */
export function handleChatCommand(trimmed) {
  const command = trimmed.trim();
  if (!command.startsWith('/')) {
    return { handled: false };
  }

  const [rawName, ...rawArgs] = command.slice(1).split(/\s+/);
  const name = String(rawName).toLowerCase();
  const args = rawArgs.map((arg) => arg.toLowerCase());

  if (name === 'cancel' || name === 'stop') {
    return { handled: true, action: 'cancel' };
  }

  if (name === 'help') {
    return { handled: true, action: 'help' };
  }

  return { handled: false };
}
