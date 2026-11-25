import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_STYLE_REL = join('references', 'user-style-v1', 'example-01-original.png');

export const IMAGE_MODEL = 'cx/gpt-image-2.6-flare';
export const IMAGE_SIZE = '1024x1536';
export const IMAGE_OUTPUT_FORMAT = 'jpeg';
export const IMAGE_ENDPOINT = 'http://localhost:20128/v1/images/generations?response_format=binary';

export const MIN_SLIDES = 1;
export const MAX_SLIDES = 35;
export const MAX_REFS = 10;
export const MAX_IMAGE_BYTES = 49_000_000;
export const MAX_TOTAL_REF_BYTES = 64 * 1024 * 1024;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_EPISODE_JSON_BYTES = 128 * 1024;
export const MAX_ATTEMPTS_PER_SLIDE = 5;

export const OUTPUT_WIDTH = 1080;
export const OUTPUT_HEIGHT = 1440;
export const OUTPUT_QUALITY = 95;
export const OUTPUT_SAMPLING = '4:4:4';

export const PROMPT_TEMPLATE_VERSION = 2;
export const CHECKPOINT_SCHEMA_VERSION = 2;

export const VALID_MODES = ['original', 'adaptation', 'verbatim'];
export const VALID_SCENE_TYPES = ['event', 'simile', 'concept'];
export const VALID_SLIDE_ROLES = ['cover', 'quote', 'commentary', 'closing'];

export const UNRESOLVED_STATES = new Set(['in_flight', 'unknown', 'received', 'normalize_failed']);
export const RECONCILED_STATES = new Set(['reconciled_failed', 'reconciled_superseded']);

export const INTERNAL_PATTERNS = [
  /\bbản bạn cung cấp\b/i,
  /\btheo yêu cầu của bạn\b/i,
  /\bbản nháp\b/i,
  /\bđã kiểm tra\b/i,
  /\bready_for_review\b/i,
  /^\s*Tập\s+\d+\s*[-–:]/i,
  /^\s*Phần\s+\d+(\.\d+)?\s*[-–:]/i,
];
