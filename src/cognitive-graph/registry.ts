import type { CognitiveLayer } from '@/types/enums.js';
import type { ModuleDescriptor } from './types.js';

/**
 * Catálogo central de módulos cognitivos. Imutável após registro: dois descriptors
 * com mesmo `name` lançam erro (defesa contra mismatch de versão silencioso).
 *
 * Não há lista global hardcoded — composição é responsabilidade de quem monta
 * o grafo (`preturn-graph.ts`, `postturn-graph.ts`). O registry só armazena.
 */
export class ModuleRegistry {
  private descriptors = new Map<string, ModuleDescriptor<unknown, unknown>>();

  register<TIn, TOut>(d: ModuleDescriptor<TIn, TOut>): void {
    if (this.descriptors.has(d.name)) {
      throw new Error(`cognitive-graph: duplicate module name '${d.name}'`);
    }
    this.descriptors.set(d.name, d as unknown as ModuleDescriptor<unknown, unknown>);
  }

  get(name: string): ModuleDescriptor<unknown, unknown> | undefined {
    return this.descriptors.get(name);
  }

  listByLayer(layer: CognitiveLayer): ModuleDescriptor<unknown, unknown>[] {
    return Array.from(this.descriptors.values()).filter((d) => d.layer === layer);
  }

  /** Para acceptance gate: lista todos os módulos conhecidos. */
  listAll(): ModuleDescriptor<unknown, unknown>[] {
    return Array.from(this.descriptors.values());
  }
}
