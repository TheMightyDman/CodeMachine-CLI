import type { EngineModule } from '../../core/base.js';
import { metadata } from './metadata.js';
import * as auth from './auth.js';
import { runKimi } from './execution/index.js';

export * from './execution/index.js';
export * from './auth.js';
export { metadata };

export default {
  metadata,
  auth,
  run: runKimi,
} satisfies EngineModule;
