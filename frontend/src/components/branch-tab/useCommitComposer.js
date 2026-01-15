import { useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { useAppState } from '../../context/AppStateContext';
import {
  COMMIT_SYSTEM_PROMPT,
  extractLLMText,
  extractCommitCandidateFromText,
  isDescriptiveCommitMessage
} from './commitMessageUtils';

const EMPTY_DRAFT = { subject: '', body: '' };
const MAX_AUTOFILL_ATTEMPTS = 2;

const buildDraftStorageKey = (projectId) => (projectId ? `commitMessageDrafts:${projectId}` : null);

const normalizeDraftValue = (draft) => {
  if (!draft) {
    return { ...EMPTY_DRAFT };
  }
  if (typeof draft === 'string') {
    return {
      subject: draft,
      body: ''
    };
  }
  const subject = typeof draft.subject === 'string' ? draft.subject : '';
  const body = typeof draft.body === 'string' ? draft.body : '';
  return { subject, body };
};

const normalizeDraftMap = (rawDrafts = {}) => {
  if (!rawDrafts || typeof rawDrafts !== 'object') {
    return {};
  }
  return Object.entries(rawDrafts).reduce((acc, [branchName, draft]) => {
    const normalized = normalizeDraftValue(draft);
    if (normalized.subject || normalized.body) {
      acc[branchName] = normalized;
    }
    return acc;
  }, {});
};

const loadDraftsFromStorage = (projectId) => {
  if (typeof window === 'undefined') {
    return {};
  }
  const storageKey = buildDraftStorageKey(projectId);
  if (!storageKey) {
    return {};
  }
  try {
    const raw = localStorage.getItem(storageKey);
    return raw ? normalizeDraftMap(JSON.parse(raw)) : {};
  } catch (error) {
    console.warn('Failed to parse commit message drafts from storage', error);
    return {};
  }
};

const persistDraftsToStorage = (projectId, drafts) => {
  if (typeof window === 'undefined') {
    return;
  }
  const storageKey = buildDraftStorageKey(projectId);
  if (!storageKey) {
    return;
  }
  try {
    const normalized = normalizeDraftMap(drafts);
    if (!Object.keys(normalized).length) {
      localStorage.removeItem(storageKey);
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(normalized));
  } catch (error) {
    console.warn('Failed to persist commit message drafts', error);
  }
};

const composeCommitMessage = (draft = EMPTY_DRAFT) => {
  const subject = draft.subject?.trim();
  const body = draft.body?.trim();
  if (subject && body) {
    return `${subject}\n\n${body}`;
  }
  return subject || body || '';
};

const parseCommitText = (text = '') => {
  if (!text) {
    return { ...EMPTY_DRAFT };
  }
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) {
    return { ...EMPTY_DRAFT };
  }
  const [firstLine = '', ...rest] = normalized.split('\n');
  const remaining = [...rest];
  while (remaining.length && !remaining[0].trim()) {
    remaining.shift();
  }
  return {
    subject: firstLine.slice(0, 72).trim(),
    body: remaining.join('\n').trim()
  };
};

let commitTextParser = parseCommitText;

const buildDiffExcerpt = (commitContext, files) => {
  const fileBullets = files.map((file) => `- ${file.path}`).join('\n');
  const summaryBlock = commitContext?.summaryText?.trim() || fileBullets || 'No staged files listed.';
  const diffSegments = [];
  if (commitContext?.aggregateDiff?.trim()) {
    diffSegments.push(commitContext.aggregateDiff.trim());
  }
  if (!commitContext?.aggregateDiff && Array.isArray(commitContext?.files)) {
    const perFile = commitContext.files
      .map((file) => (file.diff ? `File: ${file.path}\n${file.diff}` : ''))
      .filter(Boolean)
      .join('\n\n');
    if (perFile.trim()) {
      diffSegments.push(perFile.trim());
    }
  }
  let diffBlock = diffSegments.join('\n\n');
  const MAX_PROMPT_DIFF_CHARS = 8000;
  if (diffBlock.length > MAX_PROMPT_DIFF_CHARS) {
    diffBlock = `${diffBlock.slice(0, MAX_PROMPT_DIFF_CHARS)}\n…diff truncated…`;
  }
  return { summaryBlock, diffBlock };
};

export const fetchCommitContextForProject = async (projectId, branchName) => {
  if (!projectId || !branchName) {
    return null;
  }
  try {
    const response = await axios.get(
      `/api/projects/${projectId}/branches/${encodeURIComponent(branchName)}/commit-context`
    );
    if (response.data?.success) {
      return response.data.context;
    }
    return response.data?.context || null;
  } catch (err) {
    console.warn('Failed to load commit context', err);
    return null;
  }
};

export const useCommitComposer = ({ project }) => {
  const { isLLMConfigured } = useAppState();
  const projectId = project?.id;
  const projectName = project?.name || 'workspace';
  const [commitMessageDrafts, setCommitMessageDrafts] = useState(() => loadDraftsFromStorage(projectId));
  const [commitMessageRequest, setCommitMessageRequest] = useState(null);
  const [commitMessageError, setCommitMessageError] = useState(null);

  const getDraftForBranch = useCallback((branchName) => {
    if (!branchName) {
      return { ...EMPTY_DRAFT };
    }
    return normalizeDraftValue(commitMessageDrafts[branchName]);
  }, [commitMessageDrafts]);

  const getCommitSubjectForBranch = useCallback((branchName) => (
    getDraftForBranch(branchName).subject
  ), [getDraftForBranch]);

  const getCommitBodyForBranch = useCallback((branchName) => (
    getDraftForBranch(branchName).body
  ), [getDraftForBranch]);

  const getCommitMessageForBranch = useCallback((branchName) => (
    composeCommitMessage(getDraftForBranch(branchName))
  ), [getDraftForBranch]);

  const handleCommitMessageChange = useCallback((branchName, updates = {}) => {
    if (!branchName || !updates || typeof updates !== 'object') {
      return;
    }
    setCommitMessageError(null);
    setCommitMessageDrafts((prev) => {
      const previous = normalizeDraftValue(prev?.[branchName]);
      const nextDraft = {
        subject: Object.prototype.hasOwnProperty.call(updates, 'subject')
          ? (typeof updates.subject === 'string' ? updates.subject : '')
          : previous.subject,
        body: Object.prototype.hasOwnProperty.call(updates, 'body')
          ? (typeof updates.body === 'string' ? updates.body : '')
          : previous.body
      };

      if (!nextDraft.subject && !nextDraft.body) {
        if (!prev || !prev[branchName]) {
          return prev;
        }
        const { [branchName]: _removed, ...rest } = prev;
        return rest;
      }

      return {
        ...prev,
        [branchName]: nextDraft
      };
    });
  }, []);

  const clearCommitMessageForBranch = useCallback((branchName) => {
    if (!branchName) {
      return;
    }
    setCommitMessageDrafts((prev) => {
      if (!prev[branchName]) {
        return prev;
      }
      const next = { ...prev };
      delete next[branchName];
      return next;
    });
  }, []);

  useEffect(() => {
    setCommitMessageDrafts(loadDraftsFromStorage(projectId));
  }, [projectId]);

  useEffect(() => {
    persistDraftsToStorage(projectId, commitMessageDrafts);
  }, [projectId, commitMessageDrafts]);

  const fetchCommitContext = useCallback(
    (branchName) => fetchCommitContextForProject(projectId, branchName),
    [projectId]
  );

  const handleCommitMessageAutofill = useCallback(async (branchName, files = []) => {
    if (
      !projectId
      || !branchName
      || !files.length
      || commitMessageRequest === branchName
      || !isLLMConfigured
    ) {
      return;
    }

    try {
      setCommitMessageError(null);
      setCommitMessageRequest(branchName);
      const commitContext = await fetchCommitContext(branchName);
      const { summaryBlock, diffBlock } = buildDiffExcerpt(commitContext, files);
      const noteLines = [];
      if (commitContext && commitContext.isGitAvailable === false) {
        noteLines.push('Git diff unavailable; rely on file summaries.');
      }
      if (commitContext?.truncated) {
        noteLines.push('Some diff excerpts were truncated for brevity.');
      }
      const promptSections = [
        `Project: ${projectName}`,
        `Branch: ${branchName}`,
        `Staged files summary:\n${summaryBlock}`
      ];
      if (diffBlock) {
        promptSections.push(`Diff excerpts:\n${diffBlock}`);
      }
      if (noteLines.length) {
        promptSections.push(`Notes: ${noteLines.join(' ')}`);
      }
      promptSections.push(
        'Write a git commit message with a short imperative subject line (≤72 characters), followed by a blank line and optional body lines (each ≤72 characters) describing the purpose or impact. Mention key files when useful and avoid meta commentary or instructions. IMPORTANT: Only describe changes that are supported by the staged files summary and diff excerpts above; do not invent extra files, features, or refactors. If the diff is unclear, keep the message generic.'
      );

      const buildPrompt = (attempt, previousSuggestion) => {
        if (attempt === 1 || !previousSuggestion) {
          return promptSections.join('\n\n');
        }
        return [
          ...promptSections,
          `Previous attempt was unusable:\n${previousSuggestion}`,
          'Respond again with only the git commit message (subject line ≤72 characters plus optional body lines ≤72 characters). Avoid instructions, bullet lists, or commentary.'
        ].join('\n\n');
      };

      let finalError = 'AI response did not include a usable commit message. Please edit manually.';
      let previousSuggestion = '';

      for (let attempt = 1; attempt <= MAX_AUTOFILL_ATTEMPTS; attempt += 1) {
        const summaryPrompt = buildPrompt(attempt, previousSuggestion);
        const llmPayload = {
          messages: [
            { role: 'system', content: COMMIT_SYSTEM_PROMPT },
            { role: 'user', content: summaryPrompt }
          ],
          max_tokens: 220,
          temperature: 0.2
        };
        console.log('[CommitComposer] Sending LLM summary payload', {
          attempt,
          hasDiff: Boolean(diffBlock),
          promptLength: summaryPrompt.length
        });
        const summaryResponse = await axios.post('/api/llm/generate', llmPayload);

        const suggestion = extractLLMText(summaryResponse.data?.response || summaryResponse.data)?.trim();
        previousSuggestion = suggestion || '';
        if (!suggestion) {
          finalError = 'AI response did not include a usable commit message. Please edit manually.';
          continue;
        }
        if (suggestion.toUpperCase() === 'NO_COMMIT') {
          setCommitMessageError('AI could not produce a commit message. Please write one manually.');
          return;
        }
        const candidate = extractCommitCandidateFromText(suggestion)
          .replace(/^["'\s]+/, '')
          .replace(/["'\s]+$/, '');
        const looksLikeListItem = /^[-*•]\s+/i.test(candidate);
        if (candidate && !looksLikeListItem && isDescriptiveCommitMessage(candidate)) {
          const parsedDraft = commitTextParser(candidate);
          if (!parsedDraft.subject) {
            finalError = 'AI response did not include a subject line. Please edit manually.';
            continue;
          }
          handleCommitMessageChange(branchName, parsedDraft);
          return;
        }
        if (candidate && looksLikeListItem) {
          finalError = 'AI response looked like a bullet list. Please edit manually.';
        } else if (candidate) {
          finalError = 'AI response was too vague to use as a commit message. Please edit manually.';
        } else {
          finalError = 'AI response did not include a usable commit message. Please edit manually.';
        }
      }

      setCommitMessageError(finalError);
    } catch (err) {
      console.error('Failed to generate commit message:', err);
      setCommitMessageError(err.response?.data?.error || 'Failed to generate commit message');
    } finally {
      setCommitMessageRequest(null);
    }
  }, [
    projectId,
    projectName,
    commitMessageRequest,
    isLLMConfigured,
    fetchCommitContext,
    handleCommitMessageChange
  ]);

  return {
    commitMessageDrafts,
    commitMessageRequest,
    commitMessageError,
    getCommitMessageForBranch,
    getCommitSubjectForBranch,
    getCommitBodyForBranch,
    clearCommitMessageForBranch,
    handleCommitMessageChange,
    handleCommitMessageAutofill,
    isLLMConfigured
  };
};

useCommitComposer.__testHooks = useCommitComposer.__testHooks || {};
Object.assign(useCommitComposer.__testHooks, {
  setCommitTextParser: (parser) => {
    commitTextParser = typeof parser === 'function' ? parser : parseCommitText;
  },
  resetCommitTextParser: () => {
    commitTextParser = parseCommitText;
  },
  loadDraftsFromStorage,
  persistDraftsToStorage,
  parseCommitText,
  buildDiffExcerpt,
  normalizeDraftValue,
  normalizeDraftMap
});
