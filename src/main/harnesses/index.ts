import { antigravity } from './antigravity'
import type { Harness } from './types'

/** Registered harnesses. The first one is the default for new boards. */
export const harnesses: Harness[] = [antigravity]
