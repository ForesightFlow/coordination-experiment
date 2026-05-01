# Contributing a new coordination configuration

Adding a configuration means implementing `CoordinationConfig` from `src/types.ts`.
The entire change fits in **four files**.

## Step 1 — Write the config

Create `src/configs/my-new-config.ts`:

```typescript
import type { CoordinationConfig, PredictArgs, PredictResult } from '../types.js';
import { TraceLedger } from './base.js';
import { buildPrompt } from '../prompts.js';
import { parseFinalProbability } from '../parsing.js';

export class MyNewConfig implements CoordinationConfig {
  name = 'my_new_config';

  async predict({ market, tools, llm, params }: PredictArgs): Promise<PredictResult> {
    const ledger = new TraceLedger(this.name);

    const response = await llm.generate(
      buildPrompt('researcher', market, tools),
      // Note: buildPrompt returns a GenerateRequest; token budget comes from params.
    );
    ledger.record('researcher', 0, response);

    const probability = parseFinalProbability(response.text);
    return { probability, trace: ledger.toTrace() };
  }
}
```

Architectural invariants you must not break:

- Use `buildPrompt` from `src/prompts.ts` — do not write system prompts inline.
  Only `roleInstructions` should differ between your config and the others.
- Use the `llm` and `tools` passed in — never import a client directly.
- Respect `params.maxTokensPerMarket` as a budget across all calls.

## Step 2 — Export from `src/configs/index.ts`

```typescript
export { MyNewConfig } from './my-new-config.js';
```

## Step 3 — Register in `allConfigurations()`

In `src/index.ts`, add `new MyNewConfig()` to the array returned by
`allConfigurations()`. The runner and analysis pipeline pick up all
registered configs automatically.

## Step 4 — Add a test

Add `tests/my-new-config.test.ts` using `node:test`. Use `MockLLMClient`
and `MockAgentTools` from `src/tools.ts`. At minimum test:

- A single successful predict call returns probability in [0, 1].
- A model response that omits `FINAL_PROBABILITY:` triggers the 0.5 fallback
  in the runner (this is the runner's responsibility, but your config should
  not catch `ParseError` silently).

Run `npm test` to confirm all 33+ existing tests still pass.

## Methodological note

New configurations are **not pre-registered** and cannot be compared to the
five paper configurations in the primary Phase 0.5 / Phase 1A analysis. They
can be evaluated in separate supplementary runs. If you believe a new config
challenges a pre-registered prediction, open an issue with a protocol
description before running any markets.
