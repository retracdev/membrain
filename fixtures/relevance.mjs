// Fixed, competing memories. No model, network, or developer data is involved.
export const memories = [
  {
    key: 'language',
    content:
      'I generally prefer TypeScript over JavaScript for Node.js, Next.js, and React development, unless a project has a good reason to use another language.',
  },
  {
    key: 'appearance',
    content: 'I like using dark mode when writing applications.',
  },
  {
    key: 'database',
    content:
      'Use PostgreSQL for the application database and retain reviewed migration scripts.',
  },
  { key: 'pronouns', content: 'I do what I can when I have the time.' },
  {
    key: 'cache',
    content: 'Atlas invalidates build artifacts when dependency hashes change.',
    tags: ['build-cache'],
  },
  {
    key: 'cache-mention',
    content:
      'A scratch note mentions build cache during a wider discussion of a temporary local experiment.',
    tags: ['scratch'],
  },
  {
    key: 'cache-tag',
    content: 'Reuse compiled artifacts until their inputs change.',
    tags: ['build', 'cache'],
  },
  {
    key: 'unicode',
    content: 'Café Zürich 日本語 documentation is kept beside the source.',
  },
  {
    key: 'identifier',
    content:
      'AtlasWorker42 handles background jobs for the example application.',
  },
  { key: 'sql', content: 'Use SQL WHERE EXISTS to test for related rows.' },
  {
    key: 'other-project',
    content: 'Borealis stores its image assets in a separate package.',
  },
  {
    key: 'release-tags',
    content:
      'Owner approval and completed validation are required before distributing any public package.',
    tags: ['release', 'checklist'],
  },
  {
    key: 'release-mention',
    content:
      'A draft release checklist was mentioned while discussing a temporary documentation experiment.',
  },
];

export const cases = [
  { query: 'How can I do database migrations?', expected: 'database' },
  { query: 'release checklist', expected: 'release-tags' },
  {
    query: 'Which database do I use for the application?',
    expected: 'database',
  },
  { query: 'Which language TypeScript do I prefer?', expected: 'language' },
  { query: 'dark mode', expected: 'appearance' },
  { query: 'build cache', expected: 'cache' },
  { query: 'AtlasWorker42', expected: 'identifier' },
  { query: 'Café', expected: 'unicode' },
  { query: '日本語', expected: 'unicode' },
  { query: 'WHERE EXISTS', literal: true, expected: 'sql' },
  { query: 'Borealis', expected: 'other-project' },
];

// This intent has no lexical connection to the language memory. Keep the miss
// visible rather than teaching an example-specific synonym to the engine.
export const semanticGap = {
  query: 'Which technology do I like writing applications in?',
  desired: 'language',
};
