/**
 * Re-exports for the five reference coordination configurations.
 * Pre-registered as the falsifiable hypothesis set in paper §3.5.
 */

export { IndependentEnsemble } from './independent-ensemble.js';
export { PeerCritiqueDebate } from './peer-critique-debate.js';
export { OrchestratorSpecialist } from './orchestrator-specialist.js';
export { SequentialPipeline } from './sequential-pipeline.js';
export { ConsensusAlignment } from './consensus-alignment.js';

import type { CoordinationConfig } from '../types.js';
import { IndependentEnsemble } from './independent-ensemble.js';
import { PeerCritiqueDebate } from './peer-critique-debate.js';
import { OrchestratorSpecialist } from './orchestrator-specialist.js';
import { SequentialPipeline } from './sequential-pipeline.js';
import { ConsensusAlignment } from './consensus-alignment.js';

/** Instantiate one of each reference configuration in pre-registered order. */
export function allConfigurations(): CoordinationConfig[] {
  return [
    new IndependentEnsemble(),
    new PeerCritiqueDebate(),
    new OrchestratorSpecialist(),
    new SequentialPipeline(),
    new ConsensusAlignment(),
  ];
}
