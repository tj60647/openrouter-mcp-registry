import { sql } from '@vercel/postgres';

const SEED_MODELS = [
  {
    id: 'openrouter/auto',
    provider: 'openrouter',
    display_name: 'Auto (OpenRouter)',
    context_length: 200000,
  },
  {
    id: 'anthropic/claude-sonnet-4-5',
    provider: 'anthropic',
    display_name: 'Claude Sonnet 4.5',
    context_length: 200000,
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    provider: 'anthropic',
    display_name: 'Claude Haiku 4.5',
    context_length: 200000,
  },
  {
    id: 'openai/gpt-4o',
    provider: 'openai',
    display_name: 'GPT-4o',
    context_length: 128000,
  },
  {
    id: 'openai/gpt-4',
    provider: 'openai',
    display_name: 'GPT-4',
    context_length: 8192,
  },
  {
    id: 'google/gemini-pro-1.5',
    provider: 'google',
    display_name: 'Gemini Pro 1.5',
    context_length: 2000000,
  },
  {
    id: 'mistralai/mistral-large',
    provider: 'mistralai',
    display_name: 'Mistral Large',
    context_length: 128000,
  },
];

const SEED_ALIASES = [
  { alias: 'auto', model_id: 'openrouter/auto' },
  { alias: 'sonnet', model_id: 'anthropic/claude-sonnet-4-5' },
  { alias: 'haiku', model_id: 'anthropic/claude-haiku-4-5' },
  { alias: 'fast-general', model_id: 'anthropic/claude-haiku-4-5' },
  { alias: 'best-general', model_id: 'anthropic/claude-sonnet-4-5' },
  { alias: 'gpt-4o', model_id: 'openai/gpt-4o' },
  { alias: 'gemini', model_id: 'google/gemini-pro-1.5' },
  { alias: 'mistral', model_id: 'mistralai/mistral-large' },
];

async function seed() {
  console.log('Seeding database...');

  for (const model of SEED_MODELS) {
    await sql`
      INSERT INTO models (id, provider, display_name, context_length, metadata)
      VALUES (
        ${model.id},
        ${model.provider},
        ${model.display_name},
        ${model.context_length ?? null},
        '{}'
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

  for (const alias of SEED_ALIASES) {
    await sql`
      INSERT INTO aliases (alias, model_id, scope)
      VALUES (${alias.alias}, ${alias.model_id}, 'system')
      ON CONFLICT (alias) DO NOTHING
    `;
  }

  console.log('Seeding complete.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
