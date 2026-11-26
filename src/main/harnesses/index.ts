import { antigravity } from './antigravity'
import { claude } from './claude'
import { pi } from './pi'
import type { Harness } from './types'

/** Registered harnesses. The first one is the default for new boards. */
export const harnesses: Harness[] = [claude, antigravity, pi]
