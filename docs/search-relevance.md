# Search relevance and limits

Membrain uses local SQLite FTS5 with BM25, without an AI model, embedding
service, account, network dependency, or generative query expansion.

Queries are NFC-normalized and lowercased, split into Unicode letter/number/mark
tokens, deduplicated, quoted, and OR-combined. The 2,048-character/64-token
bounds remain. FTS operators supplied by the caller are treated as words;
punctuation is a separator. FTS5 `unicode61` folds diacritics; there is no
stemming or substring/fuzzy matching. `Next.js` becomes `next` and `js`;
`AtlasWorker42` stays one token. These are token matches, not source-code parser
or punctuation-exact matches.

Phase 6 removes a fixed set of English grammatical function words from mixed
queries. This prevents pronouns and auxiliary verbs from overwhelming actual
subject keywords. If every token is a stopword, the tokens are retained. Use
`--literal` to retain every token in technical queries such as `WHERE EXISTS` or
project names containing English function words. Stopwords affect queries only;
source content and the indexed vocabulary are unchanged. Non-English queries are
not translated or given language-specific normalization.

Ranking weights content at 1.0 and deliberate tags at 2.0 (previously 0.5),
using `bm25(fts,1.0,2.0)`, ascending score then binary memory UUID. This gives
curated subject labels more influence. It is a modest relevance heuristic, not a
guarantee that a tagged result wins. `--tag` still requires exact tag values;
tag filtering does not recompute corpus statistics. Only active, non-conflicting
heads in the selected scopes contribute to the combined corpus. There are no
implicit recency, scope, or provider boosts. Ranking changes do not require
rewriting records or migrating configuration.

## Reproducible comparisons

Run `npm run benchmark:relevance` after `npm ci`. It generates an isolated
competing-memory corpus from `fixtures/relevance.mjs`, runs real engine queries,
and compares the previous all-token/content-1/tag-0.5 scoring with Phase 6. The
report includes each query, previous top hit, new top hit, desired hit, and an
explicitly labeled semantic limitation. Unit tests use the same corpus and check
identifiers, literal SQL, Unicode, tag weighting, natural questions, and bounded
query handling. No developer memory is read.

## The technology question remains semantic

The supplied question, "Which technology do I like writing applications in?",
contains none of the specific language/framework terms in the TypeScript
preference. "Writing applications" overlaps with the dark-mode memory. A lexical
engine cannot reliably infer that the intended answer is a programming language
instead of an appearance preference. Both the previous and Phase 6 ranker return
the appearance memory first in the regression report; this is explicitly **not
solved**.

Use concrete terms (`TypeScript`, `language`, `Node.js`) and relevant tags, or
rephrase the question. No example-specific synonym or silent semantic claim was
added. A future optional local semantic index would need separate evaluation of
model size, latency, offline installation, licenses, and mixed lexical/ semantic
scoring. It is not part of this release work.
