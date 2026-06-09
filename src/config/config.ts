import * as dotenv from 'dotenv';

dotenv.config();

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Env var ${key} must be an integer, got "${v}"`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

/**
 * Typed, validated view over the environment. Built once at boot. Keeping all
 * env access here means provider selection and the dimension contract live in
 * one place.
 */
export interface CerebroConfig {
  port: number;
  databaseUrl: string;

  embedding: {
    provider: 'fake' | 'azure-openai' | 'openai-compatible';
    dim: number;
    azure: { endpoint: string; apiKey: string; apiVersion: string; deployment: string };
    openaiCompatible: { baseUrl: string; model: string; apiKey: string };
  };

  llm: {
    provider: 'fake' | 'azure-openai' | 'openai-compatible';
    azure: { endpoint: string; apiKey: string; apiVersion: string; deployment: string };
    openaiCompatible: { baseUrl: string; model: string; apiKey: string };
  };

  retrieval: {
    topK: number;
    candidates: number;
    rrfK: number;
    ftsConfig: string;
    /** HNSW search breadth. Higher = better recall, slower. */
    efSearch: number;
    /** pgvector 0.8+ iterative scan: keeps recall under selective ACL/metadata
     *  filters (post-filtering would otherwise return far fewer than k results). */
    iterativeScan: boolean;
  };

  acl: {
    enforced: boolean;
    publicPrincipal: string;
  };
}

export function loadConfig(): CerebroConfig {
  return {
    port: int('PORT', 3000),
    databaseUrl: str('DATABASE_URL', 'postgres://cerebro:cerebro@localhost:5433/cerebro'),

    embedding: {
      provider: str('EMBEDDING_PROVIDER', 'fake') as CerebroConfig['embedding']['provider'],
      dim: int('EMBEDDING_DIM', 1024),
      azure: {
        endpoint: str('AZURE_OPENAI_ENDPOINT', ''),
        apiKey: str('AZURE_OPENAI_API_KEY', ''),
        apiVersion: str('AZURE_OPENAI_API_VERSION', '2024-10-21'),
        deployment: str('AZURE_OPENAI_EMBEDDING_DEPLOYMENT', 'text-embedding-3-large'),
      },
      openaiCompatible: {
        baseUrl: str('EMBEDDING_BASE_URL', 'http://localhost:8080/v1'),
        model: str('EMBEDDING_MODEL', 'bge-m3'),
        apiKey: str('EMBEDDING_API_KEY', ''),
      },
    },

    llm: {
      provider: str('LLM_PROVIDER', 'fake') as CerebroConfig['llm']['provider'],
      azure: {
        endpoint: str('AZURE_OPENAI_ENDPOINT', ''),
        apiKey: str('AZURE_OPENAI_API_KEY', ''),
        apiVersion: str('AZURE_OPENAI_API_VERSION', '2024-10-21'),
        deployment: str('AZURE_OPENAI_CHAT_DEPLOYMENT', 'gpt-4o'),
      },
      openaiCompatible: {
        baseUrl: str('LLM_BASE_URL', 'http://localhost:8081/v1'),
        model: str('LLM_MODEL', ''),
        apiKey: str('LLM_API_KEY', ''),
      },
    },

    retrieval: {
      topK: int('RETRIEVAL_TOP_K', 8),
      candidates: int('RETRIEVAL_CANDIDATES', 40),
      rrfK: int('RRF_K', 60),
      ftsConfig: str('FTS_CONFIG', 'simple'),
      efSearch: int('HNSW_EF_SEARCH', 100),
      iterativeScan: bool('HNSW_ITERATIVE_SCAN', true),
    },

    acl: {
      enforced: bool('ACL_ENFORCED', true),
      publicPrincipal: str('PUBLIC_PRINCIPAL', 'public'),
    },
  };
}

export const CONFIG = Symbol('CEREBRO_CONFIG');
