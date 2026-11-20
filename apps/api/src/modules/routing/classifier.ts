// Rules-based task classifier — NO LLM call per request.
// Heuristics only: keyword / length / tool-presence / vision markers.
// An optional LLM classifier flag exists but is OFF by default and is
// intentionally not implemented here (would need a gateway call); callers
// may pass `llmClassify` to override the result externally.
import type { NormalizedChatRequestLike, TaskCategory } from './types.js';

export interface Classification {
  category: TaskCategory;
  confidence: number; // 0..1
  matchedRule: string;
}

interface Rule {
  category: TaskCategory;
  patterns: RegExp[];
  minLength?: number;
  maxLength?: number;
  label: string;
  weight: number;
}

const RULES: Rule[] = [
  { category: 'TOOL_CALLING', patterns: [/tool/i], label: 'tools-present', weight: 1 },
  { category: 'VISION', patterns: [/\[image\]|\bimage\b.*\b(describe|analyse|analyze|read|ocr)\b/i, /\bdescribe (this|the) (image|photo|picture|screenshot)\b/i], label: 'vision-marker', weight: 1 },
  { category: 'COMPLEX_DEBUGGING', patterns: [/\bstack trace\b/i, /\bdebug(ging)?\b/i, /\berror\b.{0,40}\b(fix|why|caus)/i, /\b(exception|traceback|segfault|panic)\b/i], label: 'debugging-keywords', weight: 0.95 },
  { category: 'ARCHITECTURE', patterns: [/\barchitect(ure)?\b/i, /\bsystem design\b/i, /\bdesign (a|the) (system|architecture|schema)\b/i, /\bmicroservice/i], label: 'architecture-keywords', weight: 0.95 },
  { category: 'PLANNING', patterns: [/\b(plan|roadmap|milestone|sprint|break (down|this) into steps)\b/i, /\bhow (should|do) (i|we) (plan|approach|structure)\b/i], label: 'planning-keywords', weight: 0.85 },
  { category: 'DATA_ANALYSIS', patterns: [/\b(csv|spreadsheet|dataset|dataframe)\b/i, /\banaly[sz]e (the|this|these) data\b/i, /\bstatistics?\b/i], label: 'data-keywords', weight: 0.9 },
  { category: 'CODE_GENERATION', patterns: [/```[\s\S]{20,}/, /\b(write|implement|create|build|generate) (a|an|the)? ?(function|class|component|api|script|program|code)\b/i, /\bcode (for|to|that)\b/i], label: 'code-keywords', weight: 0.9 },
  { category: 'SMALL_CODE_FIX', patterns: [/\bfix (this|the|a) (bug|typo|line|function)\b/i, /\bquick fix\b/i, /\bone[- ]line(r)?\b/i], label: 'small-fix-keywords', weight: 0.85 },
  { category: 'REASONING', patterns: [/\bwhy\b.{0,30}\?/i, /\breason(ing)?\b/i, /\blogic(al)? puzzle\b/i, /\bprove\b/i, /\bexplain why\b/i], label: 'reasoning-keywords', weight: 0.8 },
  { category: 'LONG_CONTEXT', patterns: [], label: 'long-input', weight: 0.9, minLength: 8000 },
  { category: 'SIMPLE_QUESTION', patterns: [/\?$/, /\b(what|who|when|where|how many|define)\b/i], label: 'short-question', weight: 0.7, maxLength: 300 },
];

export interface ClassifierOptions {
  /** Reserved: LLM classifier is OFF by default; if true the caller must
   *  supply `llmClassify` — this module never calls an LLM itself. */
  useLlmClassifier?: boolean;
  llmClassify?: (text: string) => Promise<TaskCategory | null>;
  longContextChars?: number;
}

/** Classify a request without any LLM call. Pure function — easy to test. */
export async function classifyRequest(
  req: NormalizedChatRequestLike,
  opts: ClassifierOptions = {},
): Promise<Classification> {
  // Explicit category from the client wins (manual hint, not classification).
  if (req.taskCategory) {
    return { category: req.taskCategory, confidence: 1, matchedRule: 'explicit-taskCategory' };
  }
  const text = req.messages.map((m) => m.content).join('\n');
  const hasTools = Boolean(req.tools && req.tools.length > 0) ||
    req.messages.some((m) => Boolean(m.toolCalls && m.toolCalls.length));
  const longAt = opts.longContextChars ?? 8000;

  if (hasTools) return { category: 'TOOL_CALLING', confidence: 1, matchedRule: 'tools-present' };
  if (/\[image\]|\bimage_url\b/i.test(text)) {
    return { category: 'VISION', confidence: 0.95, matchedRule: 'vision-marker' };
  }
  if (text.length >= longAt) {
    return { category: 'LONG_CONTEXT', confidence: 0.9, matchedRule: 'long-input' };
  }
  for (const rule of RULES) {
    if (rule.category === 'TOOL_CALLING' || rule.category === 'VISION' || rule.category === 'LONG_CONTEXT') continue;
    if (rule.minLength !== undefined && text.length < rule.minLength) continue;
    if (rule.maxLength !== undefined && text.length > rule.maxLength) continue;
    if (rule.patterns.some((p) => p.test(text))) {
      return { category: rule.category, confidence: rule.weight, matchedRule: rule.label };
    }
  }
  if (opts.useLlmClassifier && opts.llmClassify) {
    const llm = await opts.llmClassify(text);
    if (llm) return { category: llm, confidence: 0.6, matchedRule: 'llm-classifier' };
  }
  return { category: 'GENERAL', confidence: 0.5, matchedRule: 'default-general' };
}
