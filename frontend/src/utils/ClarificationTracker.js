/**
 * Clarification Deduplication Utility
 * 
 * Tracks clarification questions per branch/goal to prevent asking the same
 * question twice with different wording.
 * 
 * Usage:
 *   const tracker = new ClarificationTracker()
 *   if (!tracker.hasAsked(category, intent)) {
 *     const answer = await askUser(question)
 *     tracker.record(category, intent, question, answer)
 *   } else {
 *     const cachedAnswer = tracker.getAnswer(category, intent)
 *   }
 */

export class ClarificationTracker {
  constructor() {
    // Map: category -> Map(intentHash -> { question, answer, timestamp })
    this.responses = new Map();
    this.sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  /**
   * Generate a normalized hash for intent-based deduplication
   * 
   * Examples:
   *   "react-router usage" -> "router_usage"
   *   "should we use react-router-dom" -> "router_usage"
   */
  static hashIntent(intent) {
    // Extract key intent keywords (router, auth, styling, etc.)
    const normalized = String(intent || '')
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .trim();

    // Map common patterns to categories
    const patterns = [
      { regex: /router|routing|navigation|link/, key: 'router_usage' },
      { regex: /auth|login|permission/, key: 'auth_pattern' },
      { regex: /style|css|color|design/, key: 'styling_approach' },
      { regex: /form|input|validation/, key: 'form_approach' },
      { regex: /data|fetch|api|call/, key: 'data_fetching' },
      { regex: /test|coverage/, key: 'testing_approach' }
    ];

    for (const p of patterns) {
      if (p.regex.test(normalized)) return p.key;
    }

    // Fallback: use first two significant words
    const words = normalized.split(/\s+/).filter(w => w.length > 3);
    if (words.length >= 2) {
      return words.slice(0, 2).join('_');
    }
    if (!normalized) {
      return 'intent_empty';
    }
    return `intent_${Math.abs(
      normalized.split('').reduce((a, c) => (a << 5) - a + c.charCodeAt(0), 0)
    ).toString(36)}`;
  }

  /**
   * Check if a clarification for this intent has already been asked
   */
  hasAsked(category, intent) {
    const hash = ClarificationTracker.hashIntent(intent);
    const categoryMap = this.responses.get(category);
    return categoryMap ? categoryMap.has(hash) : false;
  }

  /**
   * Record a clarification response
   */
  record(category, intent, question, answer) {
    const hash = ClarificationTracker.hashIntent(intent);
    if (!this.responses.has(category)) {
      this.responses.set(category, new Map());
    }
    this.responses.get(category).set(hash, {
      question,
      answer,
      timestamp: Date.now(),
      intent
    });
  }

  /**
   * Retrieve a cached answer for this intent
   */
  getAnswer(category, intent) {
    const hash = ClarificationTracker.hashIntent(intent);
    const categoryMap = this.responses.get(category);
    if (!categoryMap) return null;
    const entry = categoryMap.get(hash);
    return entry ? entry.answer : null;
  }

  /**
   * Get all recorded clarifications for review/logging
   */
  getAll(category) {
    const categoryMap = this.responses.get(category);
    if (!categoryMap) return [];
    return Array.from(categoryMap.values());
  }

  /**
   * Clear clarifications for a category (e.g., new goal/branch)
   */
  clear(category) {
    if (category) {
      this.responses.delete(category);
    } else {
      this.responses.clear();
    }
  }

  /**
   * Export state (for persistent storage if needed)
   */
  export() {
    const exported = {};
    for (const [category, map] of this.responses.entries()) {
      exported[category] = Object.fromEntries(map.entries());
    }
    return { sessionId: this.sessionId, responses: exported };
  }

  /**
   * Import state (restore from persistent storage)
   */
  import(state) {
    this.sessionId = state.sessionId || this.sessionId;
    for (const [category, entries] of Object.entries(state.responses || {})) {
      const map = new Map(Object.entries(entries));
      this.responses.set(category, map);
    }
  }

  /**
   * Diagnostic report: show how duplicate questions are prevented
   * This validates failure prevention #1: Duplicate Clarifications
   */
  getDuplicatePrevention() {
    const report = {
      sessionId: this.sessionId,
      categories: Array.from(this.responses.keys()),
      totalAsked: Array.from(this.responses.values()).reduce((sum, map) => sum + map.size, 0),
      questionsTracked: []
    };

    for (const [category, map] of this.responses.entries()) {
      for (const [intentHash, entry] of map.entries()) {
        report.questionsTracked.push({
          category,
          intentHash,
          question: entry.question,
          answer: entry.answer,
          timestamp: new Date(entry.timestamp).toISOString(),
          intent: entry.intent,
          preventsDuplicate: `Future questions matching "${entry.intent}" will use cached answer`
        });
      }
    }

    return report;
  }
}

/* c8 ignore start */
// Example usage
const isNodeRuntime = typeof process !== 'undefined' && !!process?.argv;
const nodeEntryArg = isNodeRuntime ? process.argv[1] : '';
if (isNodeRuntime && nodeEntryArg && import.meta.url.endsWith(nodeEntryArg)) {
  const tracker = new ClarificationTracker();

  // Simulate first question
  if (!tracker.hasAsked('navbar', 'should we use react-router for navigation?')) {
    console.log('[NEW] Asking about router usage');
    tracker.record('navbar', 'should we use react-router for navigation?', 'Use router?', 'yes');
  }

  // Try asking a similar question
  if (!tracker.hasAsked('navbar', 'do you want react-router-dom for links?')) {
    console.log('[NEW] Asking about router usage again (different wording)');
  } else {
    console.log('[CACHED] Already asked about router usage. Prior answer:', 
      tracker.getAnswer('navbar', 'do you want react-router-dom for links?'));
  }

  // List all recorded clarifications
  console.log('\nRecorded clarifications:', tracker.getAll('navbar'));
}
/* c8 ignore end */
