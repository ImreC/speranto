import type { LLMInterface } from './interface'
export type {
  TableConfig,
  DatabaseConfig,
  FileConfig,
  Config as BaseConfig,
} from './config'
import type { Config as BaseConfig } from './config'

export interface Config extends BaseConfig {
  llm?: LLMInterface
}
