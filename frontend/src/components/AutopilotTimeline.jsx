import React from 'react';
import './AutopilotTimeline.css';

const FRIENDLY_EVENT_LABELS = {
  plan: 'Plan',
  'step:start': 'Step started',
  'step:done': 'Step completed',
  'edit:patch': 'Files updated',
  'test:run': 'Tests run',
  'coverage:run': 'Coverage checked',
  'rollback:planned': 'Rollback planned',
  'rollback:applied': 'Rollback applied',
  'rollback:complete': 'Rollback complete',
  lifecycle: 'Status',
  error: 'Error',
  'user:message': 'User message'
};

const safeJson = (value) => {
  if (value == null) {
    return null;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '[unavailable]';
  }
};

const normalizeEvent = (evt) => {
  if (!evt || typeof evt !== 'object') {
    return null;
  }

  const id = Number(evt.id);
  if (!Number.isFinite(id)) {
    return null;
  }

  const type = typeof evt.type === 'string' && evt.type.trim() ? evt.type.trim() : 'event';
  const message = typeof evt.message === 'string' && evt.message.trim() ? evt.message.trim() : null;

  const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : null;
  const meta = evt.meta && typeof evt.meta === 'object' ? evt.meta : null;

  const createdAt = Number(evt.createdAt);

  return {
    id,
    type,
    message,
    payload,
    meta,
    createdAt: Number.isFinite(createdAt) ? createdAt : null
  };
};

const formatCreatedAt = (createdAt) => {
  if (!createdAt) {
    return null;
  }

  try {
    return new Date(createdAt).toLocaleTimeString();
  } catch {
    return null;
  }
};

const getStepOrdinal = ({ plannedSteps, prompt }) => {
  if (!prompt || !Array.isArray(plannedSteps) || plannedSteps.length === 0) {
    return null;
  }

  const index = plannedSteps.indexOf(prompt);
  if (index < 0) {
    return null;
  }

  return {
    index,
    number: index + 1,
    total: plannedSteps.length
  };
};

const buildPrimaryLabel = ({ evt, plannedSteps }) => {
  if (!evt || typeof evt !== 'object') {
    return null;
  }

  if (evt.type === 'step:start' || evt.type === 'step:done') {
    const prompt = typeof evt.payload?.prompt === 'string' ? evt.payload.prompt.trim() : '';
    if (!prompt) {
      return null;
    }

    const ord = getStepOrdinal({ plannedSteps, prompt });
    const ordinalLabel = ord ? `Step ${ord.number}/${ord.total}` : 'Step';
    const verb = evt.type === 'step:done' ? 'completed' : 'started';
    return `${ordinalLabel} ${verb}: ${prompt}`;
  }

  return null;
};

const AutopilotTimeline = ({ events }) => {
  const normalized = Array.isArray(events)
    ? events.map(normalizeEvent).filter(Boolean).sort((a, b) => a.id - b.id)
    : [];

  const changedFiles = (() => {
    const files = new Map();

    for (const evt of normalized) {
      if (evt.type !== 'edit:patch') {
        continue;
      }

      const list = Array.isArray(evt.payload?.files) ? evt.payload.files : [];
      for (const entry of list) {
        const path = typeof entry?.path === 'string' ? entry.path.trim() : '';
        if (!path) {
          continue;
        }
        const charsRaw = entry?.chars;
        const chars = Number.isFinite(Number(charsRaw)) ? Number(charsRaw) : null;
        files.set(path, { path, chars });
      }
    }

    return Array.from(files.values());
  })();

  const plannedSteps = (() => {
    const steps = [];

    for (const evt of normalized) {
      if (evt.type !== 'plan') {
        continue;
      }

      const rawSteps = Array.isArray(evt.payload?.steps) ? evt.payload.steps : null;
      const rawAdds = Array.isArray(evt.payload?.addedPrompts) ? evt.payload.addedPrompts : null;

      if (rawSteps) {
        steps.length = 0;
        for (const entry of rawSteps) {
          const value = typeof entry === 'string' ? entry.trim() : '';
          if (value) {
            steps.push(value);
          }
        }
        continue;
      }

      if (rawAdds) {
        for (const entry of rawAdds) {
          const value = typeof entry === 'string' ? entry.trim() : '';
          if (value) {
            steps.push(value);
          }
        }
      }
    }

    return steps;
  })();

  const workingGoal = (() => {
    for (let idx = normalized.length - 1; idx >= 0; idx -= 1) {
      const evt = normalized[idx];
      if (evt.type !== 'plan') {
        continue;
      }
      const prompt = typeof evt.payload?.prompt === 'string' ? evt.payload.prompt.trim() : '';
      if (prompt) {
        return prompt;
      }
    }
    return null;
  })();

  const planSummary = (() => {
    for (let idx = normalized.length - 1; idx >= 0; idx -= 1) {
      const evt = normalized[idx];
      if (evt.type !== 'plan') {
        continue;
      }

      const summary = typeof evt.payload?.summary === 'string' ? evt.payload.summary.trim() : '';
      if (summary) {
        return summary;
      }
    }
    return null;
  })();

  const completed = (() => {
    const prompts = new Set();
    for (const evt of normalized) {
      if (evt.type !== 'step:done') {
        continue;
      }
      const prompt = typeof evt.payload?.prompt === 'string' ? evt.payload.prompt.trim() : '';
      if (prompt) {
        prompts.add(prompt);
      }
    }
    return prompts;
  })();

  const currentStep = (() => {
    for (let idx = normalized.length - 1; idx >= 0; idx -= 1) {
      const evt = normalized[idx];
      if (evt.type !== 'step:start') {
        continue;
      }
      const prompt = typeof evt.payload?.prompt === 'string' ? evt.payload.prompt.trim() : '';
      if (!prompt) {
        continue;
      }
      if (completed.has(prompt)) {
        return null;
      }
      return prompt;
    }
    return null;
  })();

  const nextStep = (() => {
    if (!plannedSteps.length) {
      return null;
    }

    const startIdx = currentStep ? plannedSteps.indexOf(currentStep) + 1 : 0;
    for (let idx = Math.max(0, startIdx); idx < plannedSteps.length; idx += 1) {
      const candidate = plannedSteps[idx];
      if (candidate && !completed.has(candidate)) {
        return candidate;
      }
    }
    return null;
  })();

  return (
    <div className="autopilot-timeline" data-testid="autopilot-timeline">
      <div className="autopilot-timeline__title">Timeline</div>

      {(workingGoal || planSummary || currentStep || nextStep || changedFiles.length > 0) && (
        <div className="autopilot-timeline__summary">
          {workingGoal && (
            <div className="autopilot-timeline__summary-row" data-testid="autopilot-working-goal">
              Working on: {workingGoal}
            </div>
          )}
          {planSummary && (
            <div className="autopilot-timeline__summary-row" data-testid="autopilot-plan-summary">
              <pre className="autopilot-timeline__details-pre">{planSummary}</pre>
            </div>
          )}
          {currentStep && (
            <div className="autopilot-timeline__summary-row" data-testid="autopilot-current-step">
              Current step: {currentStep}
            </div>
          )}
          {nextStep && (
            <div className="autopilot-timeline__summary-row" data-testid="autopilot-next-step">
              Next step: {nextStep}
            </div>
          )}

          {changedFiles.length > 0 && (
            <div className="autopilot-timeline__summary-row" data-testid="autopilot-changed-files">
              <div>What changed:</div>
              <ul style={{ margin: '6px 0 0 18px' }}>
                {changedFiles.map((file) => {
                  const suffix = Number.isFinite(file.chars) ? ` (${file.chars} chars)` : '';
                  return (
                    <li key={`changed-file-${file.path}`}>{file.path}{suffix}</li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {normalized.length === 0 ? (
        <div className="autopilot-timeline__empty">No events yet.</div>
      ) : (
        <ol className="autopilot-timeline__list">
          {normalized.map((evt) => {
            const createdAtLabel = formatCreatedAt(evt.createdAt);
            const payloadText = safeJson(evt.payload);
            const metaText = safeJson(evt.meta);

            const primaryLabel = buildPrimaryLabel({ evt, plannedSteps });
            const friendlyLabel = primaryLabel || FRIENDLY_EVENT_LABELS[evt.type] || null;

            const isGenericStepMessage =
              Boolean(primaryLabel) &&
              evt.type === 'step:start' &&
              evt.message === 'Starting step';

            const isGenericStepDoneMessage =
              Boolean(primaryLabel) &&
              evt.type === 'step:done' &&
              (evt.message === 'Step done' || evt.message === 'Step completed');

            const hasDetails = Boolean(createdAtLabel || payloadText || metaText);

            return (
              <li key={`autopilot-event-${evt.id}`} className="autopilot-timeline__event">
                <div className="autopilot-timeline__event-header">
                  <span className="autopilot-timeline__event-type">{evt.type}</span>
                  {friendlyLabel ? (
                    <span className="autopilot-timeline__event-message">{friendlyLabel}</span>
                  ) : null}
                  {evt.message &&
                  evt.message !== friendlyLabel &&
                  !isGenericStepMessage &&
                  !isGenericStepDoneMessage ? (
                    <span className="autopilot-timeline__event-message">{evt.message}</span>
                  ) : null}
                  {createdAtLabel ? (
                    <span className="autopilot-timeline__event-time">{createdAtLabel}</span>
                  ) : null}
                </div>

                {hasDetails ? (
                  <details className="autopilot-timeline__details">
                    <summary className="autopilot-timeline__details-summary">Details</summary>
                    {payloadText ? (
                      <div className="autopilot-timeline__details-block">
                        <div className="autopilot-timeline__details-label">payload</div>
                        <pre className="autopilot-timeline__details-pre">{payloadText}</pre>
                      </div>
                    ) : null}
                    {metaText ? (
                      <div className="autopilot-timeline__details-block">
                        <div className="autopilot-timeline__details-label">meta</div>
                        <pre className="autopilot-timeline__details-pre">{metaText}</pre>
                      </div>
                    ) : null}
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};

export const __testHooks = {
  safeJson,
  normalizeEvent,
  formatCreatedAt,
  getStepOrdinal,
  buildPrimaryLabel
};

export default AutopilotTimeline;
