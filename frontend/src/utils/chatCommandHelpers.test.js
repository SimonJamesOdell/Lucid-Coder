import { describe, test, expect } from 'vitest';
import {
  isNaturalLanguageCancel,
  isNaturalLanguagePause,
  isNaturalLanguageResume,
  handleChatCommand
} from './chatCommandHelpers';

describe('chatCommandHelpers', () => {
  describe('isNaturalLanguageCancel', () => {
    test('detects "cancel" command', () => {
      expect(isNaturalLanguageCancel('cancel')).toBe(true);
      expect(isNaturalLanguageCancel('Cancel')).toBe(true);
      expect(isNaturalLanguageCancel('  CANCEL  ')).toBe(true);
    });

    test('detects "stop" command', () => {
      expect(isNaturalLanguageCancel('stop')).toBe(true);
      expect(isNaturalLanguageCancel('Stop')).toBe(true);
      expect(isNaturalLanguageCancel('  STOP  ')).toBe(true);
    });

    test('returns false for non-cancel commands', () => {
      expect(isNaturalLanguageCancel('pause')).toBe(false);
      expect(isNaturalLanguageCancel('resume')).toBe(false);
      expect(isNaturalLanguageCancel('cancel please')).toBe(false);
      expect(isNaturalLanguageCancel('stopping')).toBe(false);
      expect(isNaturalLanguageCancel('')).toBe(false);
    });
  });

  describe('isNaturalLanguagePause', () => {
    test('detects "pause" command', () => {
      expect(isNaturalLanguagePause('pause')).toBe(true);
      expect(isNaturalLanguagePause('Pause')).toBe(true);
      expect(isNaturalLanguagePause('  PAUSE  ')).toBe(true);
    });

    test('returns false for non-pause commands', () => {
      expect(isNaturalLanguagePause('stop')).toBe(false);
      expect(isNaturalLanguagePause('resume')).toBe(false);
      expect(isNaturalLanguagePause('pause please')).toBe(false);
      expect(isNaturalLanguagePause('pausing')).toBe(false);
      expect(isNaturalLanguagePause('')).toBe(false);
    });
  });

  describe('isNaturalLanguageResume', () => {
    test('detects "resume" command', () => {
      expect(isNaturalLanguageResume('resume')).toBe(true);
      expect(isNaturalLanguageResume('Resume')).toBe(true);
      expect(isNaturalLanguageResume('  RESUME  ')).toBe(true);
    });

    test('detects "continue" command', () => {
      expect(isNaturalLanguageResume('continue')).toBe(true);
      expect(isNaturalLanguageResume('Continue')).toBe(true);
      expect(isNaturalLanguageResume('  CONTINUE  ')).toBe(true);
    });

    test('returns false for non-resume commands', () => {
      expect(isNaturalLanguageResume('stop')).toBe(false);
      expect(isNaturalLanguageResume('pause')).toBe(false);
      expect(isNaturalLanguageResume('resume please')).toBe(false);
      expect(isNaturalLanguageResume('continuing')).toBe(false);
      expect(isNaturalLanguageResume('')).toBe(false);
    });
  });

  describe('handleChatCommand', () => {
    test('handles /cancel command', () => {
      expect(handleChatCommand('/cancel')).toEqual({ handled: true, action: 'cancel' });
      expect(handleChatCommand('/Cancel')).toEqual({ handled: true, action: 'cancel' });
      expect(handleChatCommand('  /CANCEL  ')).toEqual({ handled: true, action: 'cancel' });
    });

    test('handles /stop command', () => {
      expect(handleChatCommand('/stop')).toEqual({ handled: true, action: 'cancel' });
      expect(handleChatCommand('/Stop')).toEqual({ handled: true, action: 'cancel' });
    });

    test('handles /help command', () => {
      expect(handleChatCommand('/help')).toEqual({ handled: true, action: 'help' });
      expect(handleChatCommand('/Help')).toEqual({ handled: true, action: 'help' });
    });

    test('ignores non-commands', () => {
      expect(handleChatCommand('hello')).toEqual({ handled: false });
      expect(handleChatCommand('cancel')).toEqual({ handled: false });
      expect(handleChatCommand('just some text')).toEqual({ handled: false });
    });

    test('ignores unknown commands', () => {
      expect(handleChatCommand('/unknown')).toEqual({ handled: false });
      expect(handleChatCommand('/pause')).toEqual({ handled: false });
    });

    test('handles commands with arguments', () => {
      expect(handleChatCommand('/cancel arg1 arg2')).toEqual({ handled: true, action: 'cancel' });
      expect(handleChatCommand('/help something')).toEqual({ handled: true, action: 'help' });
    });
  });
});
