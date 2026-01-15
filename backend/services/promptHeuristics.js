const normalizePrompt = (prompt = '') => String(prompt || '').trim().toLowerCase();

export const isStyleOnlyPrompt = (prompt = '') => {
  const text = normalizePrompt(prompt);
  if (!text) return false;

  // Positive signals for style-only changes.
  // Require a "core" styling keyword (css/color/background/etc) so generic UI nouns
  // like "button" or "header" don't get misclassified as style-only.
  const coreStyleSignals = [
    /\bcss\b/, /\bstyle\b/, /\bstyling\b/, /\btheme\b/, /\bcolor\b/, /\bbackground\b/, /\bfont\b/, /\btypography\b/,
    /\bspacing\b/, /\bmargin\b/, /\bpadding\b/, /\bborder\b/, /\bradius\b/, /\bshadow\b/, /\blayout\b/
  ];
  const hasCoreStyleSignal = coreStyleSignals.some((re) => re.test(text));
  if (!hasCoreStyleSignal) return false;

  // Negative signals that suggest more than styling.
  const nonStyleSignals = [
    /\bapi\b/, /\bendpoint\b/, /\bdatabase\b/, /\bsql\b/, /\bschema\b/, /\bauth\b/, /\blogin\b/, /\btoken\b/,
    /\bserver\b/, /\bbackend\b/, /\bexpress\b/, /\broute\b/, /\bcontroller\b/, /\bservice\b/, /\bworkflow\b/,
    /\brefactor\b/, /\bperformance\b/, /\boptimi[sz]e\b/, /\bfix\b/, /\bbug\b/, /\bcrash\b/, /\berror\b/,
    /\bunit test\b/, /\bintegration test\b/, /\bcoverage\b/, /\bvitest\b/, /\bj(e)?st\b/
  ];
  if (nonStyleSignals.some((re) => re.test(text))) {
    return false;
  }

  return true;
};

const COLOR_NAMES = [
  'black',
  'white',
  'gray',
  'grey',
  'red',
  'green',
  'blue',
  'yellow',
  'orange',
  'purple',
  'violet',
  'indigo',
  'pink',
  'magenta',
  'maroon',
  'navy',
  'teal',
  'cyan',
  'aqua',
  'turquoise',
  'gold',
  'silver',
  'beige',
  'brown',
  'lavender',
  'mint',
  'olive'
];

const COLOR_ADJECTIVES = ['light', 'dark', 'bright', 'deep', 'soft', 'muted', 'vibrant', 'pale', 'rich', 'warm', 'cool'];

const COLOR_NAME_PATTERN = COLOR_NAMES.join('|');
const COLOR_ADJECTIVE_PATTERN = COLOR_ADJECTIVES.join('|');
const COLOR_PHRASE_REGEX = new RegExp(
  `\\b(?:(${COLOR_ADJECTIVE_PATTERN})\\s+)?(${COLOR_NAME_PATTERN})\\b`,
  'i'
);

export const extractStyleColor = (prompt = '') => {
  const raw = String(prompt || '');
  const text = normalizePrompt(raw);
  if (!text) {
    return null;
  }

  const hexMatch = text.match(/#(?:[0-9a-f]{3}|[0-9a-f]{6})\b/i);
  if (hexMatch) {
    return hexMatch[0].toLowerCase();
  }

  const rgbMatch = raw.match(/rgb[a]?\([^)]*\)/i);
  if (rgbMatch) {
    return rgbMatch[0];
  }

  const colorMatch = raw.match(COLOR_PHRASE_REGEX);
  if (colorMatch) {
    const [, rawAdjective = '', rawColor = ''] = colorMatch;
    const adjective = rawAdjective.trim().toLowerCase();
    const color = rawColor.trim().toLowerCase();
    return `${adjective ? `${adjective} ` : ''}${color}`.trim();
  }

  return null;
};

export default {
  isStyleOnlyPrompt,
  extractStyleColor
};
